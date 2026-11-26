package ai.cloudcli.android.voice

import android.content.Context
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

internal data class OutboxEntry(val id: String, val text: String)

/**
 * A batch is the only thing the sender may put in flight. Once the server may have accepted it,
 * the same id and content are retried verbatim; only an explicit rejection lets the head merge again.
 */
internal data class OutboxBatch(
    val id: String,
    val entryIds: List<String>,
    val content: String,
    val unknown: Boolean,
    val merged: Boolean,
)

internal data class OutboxState(
    val entries: List<OutboxEntry> = emptyList(),
    val batch: OutboxBatch? = null,
    val mergeOnNext: Boolean = false,
    /** Accepted batches kept for reconciliation; they are never sent again. */
    val sent: List<OutboxEntry> = emptyList(),
    /** Wall-clock ms before which no attempt may start, including after a restart. */
    val retryAt: Long = 0,
)

internal enum class OutboxFailure { REJECTED, NOT_FOUND, UNKNOWN }

/** Explicit 4xx rejection (except timeout) proves nothing was queued; everything else is unknown. */
internal fun outboxFailure(error: Throwable): OutboxFailure = when {
    error !is VoiceHttpError -> OutboxFailure.UNKNOWN
    // Auth/route refusals must not recycle the ticket into a new id.
    error.status in setOf(401, 403, 404) -> OutboxFailure.NOT_FOUND
    error.status == 408 -> OutboxFailure.UNKNOWN
    error.status in 400..499 -> OutboxFailure.REJECTED
    else -> OutboxFailure.UNKNOWN
}

internal interface OutboxStore {
    fun read(key: String): String?
    fun write(key: String, value: String)
}

internal class OutboxPrefs(context: Context) : OutboxStore {
    private val prefs = context.getSharedPreferences("cloudcli-voice-outbox", Context.MODE_PRIVATE)
    override fun read(key: String): String? = prefs.getString(key, null)
    override fun write(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }
}

/** Local, persistent, strictly ordered voice queue for one origin/account/session destination. */
internal class VoiceOutbox(
    val destination: String,
    private val store: OutboxStore,
    private val changed: () -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
    private val idFactory: () -> String = { UUID.randomUUID().toString() },
) {
    private var state: OutboxState = read()

    val entries: List<OutboxEntry> get() = snapshot().entries
    val count: Int get() = snapshot().entries.size
    val batch: OutboxBatch? get() = snapshot().batch
    val sent: List<OutboxEntry> get() = snapshot().sent
    val retrying: Boolean get() = snapshot().batch?.unknown == true

    /** No enqueue, check or refresh may shorten or clear this window. */
    fun retryRemaining(): Long = maxOf(0L, snapshot().retryAt - clock())

    /**
     * A closed call keeps its own instance while the reopened call has already created another.
     * Both read the same destination, so every read/modify starts from the persisted snapshot and
     * a late final utterance from the old instance is merged instead of overwritten.
     */
    private fun snapshot(): OutboxState {
        state = read()
        return state
    }

    private fun read(): OutboxState = store.read(destination)?.let(::decode) ?: OutboxState()

    /** Notifies for every write to this destination, including writes from another instance. */
    fun observe(listener: () -> Unit) {
        synchronized(observers) { observers.getOrPut(destination) { mutableListOf() }.add(listener) }
    }

    fun unobserve(listener: () -> Unit) {
        synchronized(observers) {
            val list = observers[destination] ?: return
            list.removeAll { it === listener }
            if (list.isEmpty()) observers.remove(destination)
        }
    }

    /** A failed or unconfirmed attempt starts the 5 s window, persisted with the destination. */
    fun hold() {
        update(snapshot().copy(retryAt = clock() + RETRY_DELAY_MS))
    }

    fun enqueue(text: String): OutboxEntry? {
        val value = text.trim()
        if (value.isEmpty()) return null
        val entry = OutboxEntry(idFactory(), value)
        val current = snapshot()
        update(current.copy(entries = current.entries + entry))
        return entry
    }

    /** Never starts a new batch while one is unresolved or the retry window is open. */
    fun take(): OutboxBatch? {
        val current = snapshot()
        if (maxOf(0L, current.retryAt - clock()) > 0) return null
        current.batch?.let { return it }
        if (current.entries.isEmpty()) return null
        val picked = if (current.mergeOnNext) current.entries.take(MAX_BATCH) else current.entries.take(1)
        val batch = OutboxBatch(
            id = idFactory(),
            entryIds = picked.map { it.id },
            content = picked.joinToString(" ") { it.text }.trim(),
            unknown = false,
            merged = current.mergeOnNext,
        )
        update(current.copy(batch = batch, mergeOnNext = false))
        return batch
    }

    /** A matching receipt removes only this batch and keeps its text for reconciliation. */
    fun confirm(batch: OutboxBatch): Boolean {
        val current = snapshot()
        if (current.batch?.id != batch.id) return false
        val sent = batch.entryIds.toSet()
        update(
            current.copy(
                entries = current.entries.filterNot { it.id in sent },
                batch = null,
                sent = current.sent.filterNot { it.id == batch.id } + OutboxEntry(batch.id, batch.content),
            ),
        )
        return true
    }

    /** The server explicitly refused the batch, so its text may be merged into the next attempt. */
    fun reject(batch: OutboxBatch): Boolean {
        val current = snapshot()
        if (current.batch?.id != batch.id) return false
        update(current.copy(batch = null, mergeOnNext = true))
        return true
    }

    /** Unknown receipts keep the persisted batch and its id for a verbatim retry. */
    fun markUnknown(batch: OutboxBatch): Boolean {
        val current = snapshot()
        if (current.batch?.id != batch.id) return false
        update(current.copy(batch = batch.copy(unknown = true)))
        return true
    }

    /** Ordinary delete: one pending entry that is not part of a frozen (taken) batch. */
    fun drop(entryId: String): Boolean {
        val current = snapshot()
        if (current.batch?.entryIds?.contains(entryId) == true) return false
        if (current.entries.none { it.id == entryId }) return false
        update(current.copy(entries = current.entries.filterNot { it.id == entryId }))
        return true
    }

    /**
     * Explicit whole-batch delete for an unresolved request that is not in flight. Later entries
     * never take its place silently; the caller only calls this after the user confirms the batch.
     */
    fun dropBatch(batchId: String): Boolean {
        val current = snapshot()
        val batch = current.batch ?: return false
        if (batch.id != batchId) return false
        val ids = batch.entryIds.toSet()
        update(current.copy(entries = current.entries.filterNot { it.id in ids }, batch = null))
        return true
    }

    private fun update(next: OutboxState) {
        state = next
        store.write(destination, encode(next))
        changed()
        synchronized(observers) { observers[destination]?.toList() }.orEmpty().forEach { it() }
    }

    internal companion object {
        const val MAX_BATCH = 20
        const val RETRY_DELAY_MS = 5_000L

        /** Shared only by the process, so a reopened call hears a closed call's last write. */
        private val observers = mutableMapOf<String, MutableList<() -> Unit>>()

        fun destination(origin: String, userId: String, sessionId: String): String =
            JSONArray().put(origin).put(userId).put(sessionId).toString()

        fun encode(state: OutboxState): String = JSONObject()
            .put("entries", state.entries.array())
            .put("mergeOnNext", state.mergeOnNext)
            .put("sent", state.sent.array())
            .put("retryAt", state.retryAt)
            .put("batch", state.batch?.let {
                JSONObject()
                    .put("id", it.id)
                    .put("entryIds", JSONArray(it.entryIds))
                    .put("content", it.content)
                    .put("unknown", it.unknown)
                    .put("merged", it.merged)
            })
            .toString()

        private fun List<OutboxEntry>.array(): JSONArray = JSONArray().apply {
            forEach { put(JSONObject().put("id", it.id).put("text", it.text)) }
        }

        fun decode(raw: String): OutboxState? = runCatching {
            val json = JSONObject(raw)
            val batch = json.optJSONObject("batch")?.let { row ->
                val id = row.string("id") ?: return@let null
                val content = row.string("content") ?: return@let null
                OutboxBatch(
                    id = id,
                    entryIds = row.optJSONArray("entryIds")?.let { ids ->
                        (0 until ids.length()).mapNotNull { index -> ids.optString(index).takeIf(String::isNotBlank) }
                    }.orEmpty(),
                    content = content,
                    unknown = row.optBoolean("unknown"),
                    merged = row.optBoolean("merged"),
                )
            }
            OutboxState(
                entries = json.optJSONArray("entries").entries(),
                batch = batch,
                mergeOnNext = json.optBoolean("mergeOnNext"),
                sent = json.optJSONArray("sent").entries(),
                retryAt = json.optLong("retryAt"),
            )
        }.getOrNull()

        private fun JSONArray?.entries(): List<OutboxEntry> = objects().mapNotNull { row ->
            val id = row.string("id") ?: return@mapNotNull null
            val text = row.string("text") ?: return@mapNotNull null
            OutboxEntry(id, text)
        }
    }
}
