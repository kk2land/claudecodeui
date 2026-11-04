package ai.cloudcli.android

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject

/**
 * WebView bridge host (contract §3.2-§3.6). Installs the document-start script and the
 * main-frame-only web message listener for the configured origin, then serves the 12 public
 * methods plus the transfer control messages.
 */
class BridgeHost(
    private val activity: Activity,
    private val webView: WebView,
    private val host: Host,
) : AppRuntime.Listener, WebViewCompat.WebMessageListener {

    interface Host {
        fun notificationPermissionGranted(): Boolean
        fun requestNotificationPermission(onResult: (Boolean) -> Unit)
        fun pickDocuments(multiple: Boolean, onResult: (List<Uri>?) -> Unit)
        fun createDocument(name: String, mimeType: String, onResult: (Uri?) -> Unit)
    }

    private data class FileMeta(val uri: Uri, val name: String, val mimeType: String, val size: Long)

    private val main = Handler(Looper.getMainLooper())
    private val transfers = Transfers(
        sendBinary = { bytes -> postBinary(bytes) },
        sendJson = { json -> postJson(json) },
        deleteDocument = { uri -> activity.contentResolver.delete(uri, null, null) },
    )

    private var origin: String = ""
    private var installed = false
    private var destroyed = false
    private var scriptHandler: ScriptHandler? = null
    private var replyProxy: JavaScriptReplyProxy? = null
    private var pendingPermissionRequest: String? = null

    /** Returns false when the WebView does not support the required features; nothing is exposed. */
    fun install(siteOrigin: String): Boolean {
        if (installed) return true
        val unsupported = listOf(
            "DOCUMENT_START_SCRIPT" to WebViewFeature.DOCUMENT_START_SCRIPT,
            "WEB_MESSAGE_LISTENER" to WebViewFeature.WEB_MESSAGE_LISTENER,
            "WEB_MESSAGE_ARRAY_BUFFER" to WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER,
        ).filterNot { (_, feature) -> WebViewFeature.isFeatureSupported(feature) }
        if (unsupported.isNotEmpty()) {
            Log.w(LOG_TAG, "bridge disabled, unsupported WebView features: " + unsupported.map { it.first })
            return false
        }
        val script = try {
            activity.assets.open(BRIDGE_ASSET).bufferedReader().use { it.readText() }
        } catch (e: IOException) {
            Log.w(LOG_TAG, "bridge disabled, cannot read $BRIDGE_ASSET", e)
            return false
        }
        origin = siteOrigin
        val rendered = script.replace("__CLOUDCLI_ORIGIN__", JSONObject.quote(siteOrigin))
        scriptHandler = WebViewCompat.addDocumentStartJavaScript(webView, rendered, setOf(siteOrigin))
        WebViewCompat.addWebMessageListener(webView, JS_OBJECT, setOf(siteOrigin), this)
        AppRuntime.listener = this
        installed = true
        return true
    }

    fun destroy() {
        destroyed = true
        if (AppRuntime.listener === this) AppRuntime.listener = null
        transfers.destroy()
        if (installed) {
            runCatching { WebViewCompat.removeWebMessageListener(webView, JS_OBJECT) }
        }
        scriptHandler?.remove()
        scriptHandler = null
        replyProxy = null
    }

    // ---------------------------------------------------------------- web messages

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (destroyed || !isMainFrame) return
        if (sourceOrigin.toString() != origin) return
        this.replyProxy = replyProxy
        when (message.type) {
            WebMessageCompat.TYPE_ARRAY_BUFFER -> message.arrayBuffer?.let { transfers.onBinary(it) }
            WebMessageCompat.TYPE_STRING -> message.data?.let { handleJson(it) }
        }
    }

    private fun handleJson(text: String) {
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (json.optString("type")) {
            "transfer.ack" -> {
                transfers.onAck(json.optString("transferId"), json.optInt("nextOffset", -1))
                return
            }
            "transfer.abort" -> {
                transfers.abort(json.optString("transferId"))
                return
            }
        }
        val id = json.optString("id")
        val method = json.optString("method")
        if (id.isEmpty() || method.isEmpty()) return
        val params = json.optJSONObject("params") ?: JSONObject()
        AppRuntime.markWebBridgeReady()
        when (method) {
            "getState" -> respond(id, AppRuntime.state().toJson())
            "notify" -> handleNotify(id, params)
            "setNotificationsEnabled" -> handleSetNotificationsEnabled(id, params)
            "getSession" -> handleGetSession(id)
            "saveSession" -> handleSaveSession(id, params)
            "clearSession" -> {
                AppRuntime.clearSession()
                respond(id, null)
            }
            "listShares" -> respond(id, AppRuntime.sharesJson())
            "share.content" -> handleShareContent(id, params)
            "consumeShare" -> handleRemoveShare(id, params)
            "discardShare" -> handleRemoveShare(id, params)
            "file.pick" -> handlePickFiles(id, params)
            "file.save" -> handleSaveFile(id, params)
            "transfer.finish" -> handleFinishTransfer(id, params)
            else -> respondError(id, BridgeErrorCode.UNAVAILABLE, "Unknown method")
        }
    }

    // ---------------------------------------------------------------- notifications

    private fun handleNotify(id: String, params: JSONObject) {
        val title = params.optString("title")
        val body = params.optString("body")
        if (title.isBlank() && body.isBlank()) {
            respondError(id, BridgeErrorCode.INVALID_ARGUMENT, "title or body required")
            return
        }
        val sessionId = if (params.isNull("sessionId")) null else params.optString("sessionId").ifEmpty { null }
        val tag = if (params.isNull("tag") || params.optString("tag").isEmpty()) {
            id
        } else {
            params.optString("tag")
        }
        val shown = Notifications.postEvent(
            activity,
            tag,
            title.ifEmpty { "CloudCLI" },
            body,
            sessionId,
        )
        respond(id, JSONObject().put("shown", shown))
    }

    private fun handleSetNotificationsEnabled(id: String, params: JSONObject) {
        if (!params.optBoolean("enabled", false)) {
            AppRuntime.prefs.notificationsEnabled = false
            AppRuntime.requestStopNotificationService()
            AppRuntime.setLastError(null)
            AppRuntime.notifyState()
            respond(id, AppRuntime.state().toJson())
            return
        }
        val state = AppRuntime.state()
        if (!state.webBridgeReady) {
            AppRuntime.setLastError(BridgeLastError.WEB_BRIDGE_NOT_READY)
            respond(id, AppRuntime.state().toJson())
            return
        }
        if (!state.signedIn) {
            AppRuntime.setLastError(BridgeLastError.NOT_SIGNED_IN)
            respond(id, AppRuntime.state().toJson())
            return
        }
        if (host.notificationPermissionGranted()) {
            applyNotificationsEnabled(id)
            return
        }
        if (pendingPermissionRequest != null) {
            respondError(id, BridgeErrorCode.UNAVAILABLE, "permission request already pending")
            return
        }
        pendingPermissionRequest = id
        host.requestNotificationPermission { granted ->
            val requestId = pendingPermissionRequest
            pendingPermissionRequest = null
            if (requestId == null) return@requestNotificationPermission
            if (granted) {
                applyNotificationsEnabled(requestId)
            } else {
                AppRuntime.prefs.notificationsEnabled = false
                AppRuntime.setLastError(BridgeLastError.PERMISSION_DENIED)
                respond(requestId, AppRuntime.state().toJson())
            }
        }
    }

    private fun applyNotificationsEnabled(id: String) {
        AppRuntime.prefs.notificationsEnabled = true
        AppRuntime.setLastError(null)
        AppRuntime.startNotificationService()
        AppRuntime.notifyState()
        respond(id, AppRuntime.state().toJson())
    }

    // ---------------------------------------------------------------- session

    private fun handleGetSession(id: String) {
        val token = AppRuntime.prefs.token()
        if (token != null && Jwt.isUsable(token)) {
            respond(id, JSONObject().put("token", token))
            // The web bootstrap's first getSession is the handshake on every (cold) app open: if the
            // user previously enabled notifications, resume the connection now (no boot/watchdog).
            if (AppRuntime.prefs.notificationsEnabled && NotificationService.current() == null) {
                AppRuntime.startNotificationService()
            }
        } else {
            respond(id, null)
        }
    }

    private fun handleSaveSession(id: String, params: JSONObject) {
        val token = params.optString("token")
        if (token.isBlank() || Jwt.claims(token) == null) {
            respond(
                id,
                JSONObject().put("accepted", false).put("reason", BridgeErrorCode.INVALID_TOKEN),
            )
            return
        }
        if (!Jwt.isUsable(token)) {
            respond(
                id,
                JSONObject().put("accepted", false).put("reason", "EXPIRED_TOKEN"),
            )
            return
        }
        AppRuntime.storeSession(token)
        respond(id, JSONObject().put("accepted", true))
    }

    // ---------------------------------------------------------------- shares

    private fun handleShareContent(id: String, params: JSONObject) {
        val shareId = params.optString("id")
        val item = AppRuntime.shares.get(shareId)
        if (item == null) {
            respondError(id, BridgeErrorCode.SHARE_NOT_FOUND, "Unknown share")
            return
        }
        if (item.kind != "image" && item.kind != "file") {
            respondError(id, BridgeErrorCode.SHARE_NOT_FILE, "Share has no file content")
            return
        }
        val file = AppRuntime.shares.fileFor(item)
        val size = item.size ?: file?.length() ?: 0L
        if (file == null) {
            respondError(id, BridgeErrorCode.SHARE_NOT_FOUND, "Share content is gone")
            return
        }
        val transferId = transfers.beginOutbound(
            item.name ?: file.name,
            item.mimeType ?: "application/octet-stream",
            size,
        ) { file.inputStream() }
        respond(
            id,
            JSONObject()
                .put("transferId", transferId)
                .put("name", item.name ?: file.name)
                .put("mimeType", item.mimeType ?: "application/octet-stream")
                .put("size", size),
        )
        transfers.start(transferId)
    }

    private fun handleRemoveShare(id: String, params: JSONObject) {
        val removed = AppRuntime.shares.remove(params.optString("id"))
        if (removed != null) AppRuntime.emitSharesChanged()
        respond(id, null)
    }

    // ---------------------------------------------------------------- files

    private fun handlePickFiles(id: String, params: JSONObject) {
        val multiple = params.optBoolean("multiple", false)
        val maxFiles = params.optInt("maxFiles", if (multiple) 10 else 1)
        val maxBytes = params.optLong("maxBytes", DEFAULT_MAX_BYTES)
        host.pickDocuments(multiple) { uris ->
            if (uris.isNullOrEmpty()) {
                respond(id, JSONObject().put("files", JSONArray()))
                return@pickDocuments
            }
            AppRuntime.io.execute {
                if (uris.size > maxFiles) {
                    respondError(id, BridgeErrorCode.TOO_MANY_FILES, "Too many files selected")
                    return@execute
                }
                val metas = uris.mapNotNull { resolveMeta(it) }
                if (metas.size != uris.size) {
                    respondError(id, BridgeErrorCode.INVALID_ARGUMENT, "Unreadable file selection")
                    return@execute
                }
                if (metas.any { it.size > maxBytes }) {
                    respondError(id, BridgeErrorCode.FILE_TOO_LARGE, "File exceeds the size limit")
                    return@execute
                }
                val files = JSONArray()
                val started = mutableListOf<String>()
                metas.forEach { meta ->
                    val transferId = transfers.beginOutbound(meta.name, meta.mimeType, meta.size) {
                        activity.contentResolver.openInputStream(meta.uri)
                            ?: throw IOException("unreadable")
                    }
                    files.put(
                        JSONObject()
                            .put("transferId", transferId)
                            .put("name", meta.name)
                            .put("mimeType", meta.mimeType)
                            .put("size", meta.size),
                    )
                    started += transferId
                }
                respond(id, JSONObject().put("files", files))
                started.forEach { transfers.start(it) }
            }
        }
    }

    private fun handleSaveFile(id: String, params: JSONObject) {
        val name = sanitizeName(params.optString("name"))
        val mimeType = params.optString("mimeType").ifEmpty { "application/octet-stream" }
        val size = params.optLong("size", -1L)
        if (size < 0L || size > Int.MAX_VALUE) {
            respondError(id, BridgeErrorCode.INVALID_ARGUMENT, "Invalid size")
            return
        }
        host.createDocument(name, mimeType) { uri ->
            if (uri == null) {
                respondError(id, BridgeErrorCode.CANCELLED, "Save cancelled")
                return@createDocument
            }
            AppRuntime.io.execute {
                val transferId = transfers.beginInbound(name, mimeType, size, uri) {
                    activity.contentResolver.openOutputStream(uri) ?: throw IOException("unwritable")
                }
                respond(id, JSONObject().put("transferId", transferId))
            }
        }
    }

    private fun handleFinishTransfer(id: String, params: JSONObject) {
        when (val result = transfers.finish(params.optString("transferId"))) {
            is Transfers.FinishResult.Ok -> respond(id, JSONObject().put("saved", result.saved))
            is Transfers.FinishResult.Failure ->
                respondError(id, result.code, "Transfer failed")
        }
    }

    private fun resolveMeta(uri: Uri): FileMeta? {
        var name: String? = null
        var size: Long = -1L
        try {
            activity.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.getString(0)
                    if (!cursor.isNull(1)) size = cursor.getLong(1)
                }
            }
        } catch (_: Exception) {
            return null
        }
        if (size < 0L) {
            size = try {
                activity.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
            } catch (_: IOException) {
                -1L
            }
        }
        if (size < 0L || size > Int.MAX_VALUE) return null
        val mimeType = activity.contentResolver.getType(uri) ?: "application/octet-stream"
        return FileMeta(uri, name?.takeIf { it.isNotBlank() } ?: "file", mimeType, size)
    }

    private fun sanitizeName(raw: String): String {
        val cleaned = raw.replace('/', '_').replace('\\', '_').trim()
        return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "download" else cleaned
    }

    // ---------------------------------------------------------------- runtime events

    override fun onStateChanged(state: BridgeState) {
        postJson(JSONObject().put("v", 1).put("event", "state").put("data", state.toJson()))
    }

    override fun onEvent(name: String, data: JSONObject) {
        postJson(JSONObject().put("v", 1).put("event", name).put("data", data))
    }

    // ---------------------------------------------------------------- posting

    private fun respond(id: String, result: Any?) {
        postJson(
            JSONObject()
                .put("v", 1)
                .put("id", id)
                .put("ok", true)
                .put("result", result ?: JSONObject.NULL),
        )
    }

    private fun respondError(id: String, code: String, message: String) {
        postJson(
            JSONObject()
                .put("v", 1)
                .put("id", id)
                .put("ok", false)
                .put("error", JSONObject().put("code", code).put("message", message)),
        )
    }

    private fun postJson(json: JSONObject) {
        main.post {
            if (!destroyed) replyProxy?.postMessage(json.toString())
        }
    }

    private fun postBinary(bytes: ByteArray) {
        main.post {
            if (!destroyed) replyProxy?.postMessage(bytes)
        }
    }

    private companion object {
        const val JS_OBJECT = "cloudcliAndroidNative"
        const val BRIDGE_ASSET = "bridge.js"
        const val DEFAULT_MAX_BYTES = 10L * 1024 * 1024
        const val LOG_TAG = "CloudCLIBridge"
    }
}
