package ai.cloudcli.android

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileOutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * App-private pending share index (contract §3.7). Bytes are copied immediately so a share
 * survives process death and can stay pending while signed out.
 */
class ShareStore(context: Context) {

    data class Item(
        val id: String,
        val kind: String,
        val text: String?,
        val name: String?,
        val mimeType: String?,
        val size: Long?,
        val fileName: String?,
        val createdAt: Long,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("id", id)
            .put("kind", kind)
            .put("text", text ?: JSONObject.NULL)
            .put("name", name ?: JSONObject.NULL)
            .put("mimeType", mimeType ?: JSONObject.NULL)
            .put("size", size ?: JSONObject.NULL)
            .put("createdAt", createdAt)
    }

    sealed interface FileImport {
        data class Copied(val item: Item) : FileImport
        data class Skipped(val name: String, val reason: String) : FileImport
    }

    data class ImportSummary(val imported: Int, val skipped: List<String>)

    private val appContext = context.applicationContext
    private val dir = File(appContext.filesDir, "shares").apply { mkdirs() }
    private val indexFile = File(dir, "index.json")
    private val lock = Any()

    fun list(): List<Item> = synchronized(lock) { readIndex() }

    fun count(): Int = list().size

    fun get(id: String): Item? = synchronized(lock) { readIndex().firstOrNull { it.id == id } }

    fun fileFor(item: Item): File? {
        val name = item.fileName ?: return null
        val file = File(dir, name)
        return if (file.isFile) file else null
    }

    fun addText(text: String): Item? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        val kind = if (SiteOrigin.isSingleHttpUrl(trimmed)) "link" else "text"
        val item = Item(
            id = java.util.UUID.randomUUID().toString(),
            kind = kind,
            text = trimmed,
            name = null,
            mimeType = null,
            size = null,
            fileName = null,
            createdAt = System.currentTimeMillis(),
        )
        synchronized(lock) {
            writeIndex(readIndex() + item)
        }
        return item
    }

    /** Copies the URI into app-private storage; enforces the attachment boundary before copying. */
    fun importFile(uri: Uri): FileImport {
        val resolver = appContext.contentResolver
        val displayName = queryName(uri) ?: "shared-file"
        val mimeType = resolver.getType(uri) ?: "application/octet-stream"
        val declaredSize = querySize(uri)
        if (declaredSize != null && declaredSize > MAX_BYTES) {
            return FileImport.Skipped(displayName, "over the 10 MiB limit")
        }
        val id = java.util.UUID.randomUUID().toString()
        val storedName = "$id.bin"
        val target = File(dir, storedName)
        var copied = 0L
        try {
            resolver.openInputStream(uri).use { input ->
                if (input == null) return FileImport.Skipped(displayName, "unreadable")
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        copied += read
                        if (copied > MAX_BYTES) {
                            output.close()
                            target.delete()
                            return FileImport.Skipped(displayName, "over the 10 MiB limit")
                        }
                        output.write(buffer, 0, read)
                    }
                }
            }
        } catch (e: Exception) {
            target.delete()
            return FileImport.Skipped(displayName, "unreadable")
        }
        val kind = if (mimeType.startsWith("image/")) "image" else "file"
        val item = Item(
            id = id,
            kind = kind,
            text = null,
            name = displayName,
            mimeType = mimeType,
            size = copied,
            fileName = storedName,
            createdAt = System.currentTimeMillis(),
        )
        synchronized(lock) {
            writeIndex(readIndex() + item)
        }
        return FileImport.Copied(item)
    }

    fun remove(id: String): Item? {
        var removed: Item? = null
        synchronized(lock) {
            val items = readIndex()
            removed = items.firstOrNull { it.id == id }
            if (removed != null) writeIndex(items.filterNot { it.id == id })
        }
        removed?.fileName?.let { File(dir, it).delete() }
        return removed
    }

    private fun readIndex(): List<Item> {
        if (!indexFile.isFile) return emptyList()
        return try {
            val array = JSONArray(indexFile.readText())
            (0 until array.length()).map { i ->
                val json = array.getJSONObject(i)
                Item(
                    id = json.getString("id"),
                    kind = json.optString("kind", "file"),
                    text = if (json.isNull("text")) null else json.optString("text"),
                    name = if (json.isNull("name")) null else json.optString("name"),
                    mimeType = if (json.isNull("mimeType")) null else json.optString("mimeType"),
                    size = if (json.isNull("size")) null else json.optLong("size"),
                    fileName = if (json.isNull("fileName")) null else json.optString("fileName"),
                    createdAt = json.optLong("createdAt", 0L),
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeIndex(items: List<Item>) {
        val array = JSONArray()
        items.forEach { item ->
            array.put(
                item.toJson().apply {
                    put("fileName", item.fileName ?: JSONObject.NULL)
                },
            )
        }
        val tmp = File(dir, "index.json.tmp")
        tmp.writeText(array.toString())
        if (!tmp.renameTo(indexFile)) {
            indexFile.writeText(array.toString())
            tmp.delete()
        }
    }

    private fun queryName(uri: Uri): String? = try {
        appContext.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }

    private fun querySize(uri: Uri): Long? = try {
        appContext.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
        }
    } catch (_: Exception) {
        null
    }

    companion object {
        const val MAX_FILES_PER_INTENT = 10
        const val MAX_BYTES = 10L * 1024 * 1024
    }
}
