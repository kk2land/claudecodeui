package ai.cloudcli.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.ContextCompat
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Process-wide native state shared by the activity bridge and the foreground service.
 * Every field change is pushed to the WebView through [Listener].
 */
object AppRuntime {

    interface Listener {
        fun onStateChanged(state: BridgeState)
        fun onEvent(name: String, data: JSONObject)
    }

    /** Single background thread for share import, file metadata and transfer IO. */
    val io: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "cloudcli-io").apply { isDaemon = true }
    }

    private var appContext: Context? = null
    private var store: SessionStore? = null
    private var shareStore: ShareStore? = null

    @Volatile
    var listener: Listener? = null

    @Volatile
    private var webBridgeReady = false

    @Volatile
    private var connected = false

    @Volatile
    private var serviceRunning = false

    @Volatile
    private var lastError: String? = null

    val prefs: SessionStore
        get() = store ?: error("AppRuntime.init() was not called")

    val shares: ShareStore
        get() = shareStore ?: error("AppRuntime.init() was not called")

    fun init(context: Context) {
        synchronized(this) {
            if (appContext == null) {
                val app = context.applicationContext
                appContext = app
                store = SessionStore(app)
                shareStore = ShareStore(app)
            }
        }
    }

    fun state(): BridgeState {
        val store = store ?: return BridgeState(
            siteOrigin = "",
            webBridgeReady = false,
            signedIn = false,
            notificationsEnabled = false,
            serviceRunning = false,
            connected = false,
            lastError = lastError,
            pendingShareCount = 0,
        )
        return BridgeState(
            siteOrigin = store.siteOrigin.orEmpty(),
            webBridgeReady = webBridgeReady,
            signedIn = store.signedIn(),
            notificationsEnabled = store.notificationsEnabled,
            serviceRunning = serviceRunning,
            connected = connected,
            lastError = lastError,
            pendingShareCount = shareStore?.count() ?: 0,
        )
    }

    fun notifyState() {
        val current = listener ?: return
        current.onStateChanged(state())
    }

    fun markWebBridgeReady() {
        if (webBridgeReady) return
        webBridgeReady = true
        notifyState()
    }

    fun setConnected(value: Boolean) {
        if (connected == value) return
        connected = value
        notifyState()
    }

    fun setServiceRunning(value: Boolean) {
        if (serviceRunning == value) {
            if (!value) setConnected(false)
            return
        }
        serviceRunning = value
        if (!value) connected = false
        notifyState()
    }

    fun setLastError(value: String?) {
        if (lastError == value) return
        lastError = value
        if (value == BridgeLastError.PERMISSION_DENIED) {
            // Keep the preference untouched: enabling failed, the setting stays false.
            store?.notificationsEnabled = false
        }
        notifyState()
    }

    fun emitEvent(name: String, data: JSONObject) {
        listener?.onEvent(name, data)
    }

    fun emitSharesChanged() {
        val count = shareStore?.count() ?: 0
        emitEvent("shares-changed", JSONObject().put("count", count))
        notifyState()
    }

    // ---------------------------------------------------------------- session

    /** Stores a token already validated at the bridge boundary; persistence does not re-validate. */
    fun storeSession(token: String) {
        prefs.setToken(token)
        if (prefs.notificationsEnabled) startNotificationService()
        notifyState()
    }

    /** Service-side background refresh result; emits `session` so the web updates its storage. */
    fun storeRefreshedToken(token: String) {
        prefs.setToken(token)
        emitEvent("session", JSONObject().put("token", token))
        notifyState()
    }

    fun clearSession() {
        prefs.clearToken()
        stopNotificationServiceConnection()
        setConnected(false)
        notifyState()
    }

    /** Native refresh/registration hit a 401: token is cleared and the service stops. */
    fun expireSession() {
        prefs.clearToken()
        stopNotificationServiceConnection()
        setConnected(false)
        lastError = BridgeLastError.AUTH_EXPIRED
        emitEvent("session-expired", JSONObject())
        notifyState()
    }

    // ---------------------------------------------------------------- service

    fun startNotificationService() {
        val context = appContext ?: return
        Notifications.ensureChannels(context)
        try {
            ContextCompat.startForegroundService(
                context,
                Intent(context, NotificationService::class.java).setAction(NotificationService.ACTION_ENABLE),
            )
        } catch (_: Exception) {
            setLastError(BridgeLastError.REGISTER_FAILED)
        }
    }

    /**
     * Stops the connection without starting a service: the running instance is asked to shut down
     * synchronously, otherwise there is nothing to stop. Logout/token expiry keep the preference.
     */
    fun stopNotificationServiceConnection(disableEndpoint: Boolean = false) {
        val context = appContext ?: return
        val running = NotificationService.current()
        if (running != null) {
            running.shutdownNow(disableEndpoint)
            return
        }
        context.stopService(Intent(context, NotificationService::class.java))
        setServiceRunning(false)
        setConnected(false)
    }

    /** User-facing disable: stops immediately and PATCHes the endpoint as a detached best effort. */
    fun requestStopNotificationService() {
        stopNotificationServiceConnection(disableEndpoint = true)
    }

    // ---------------------------------------------------------------- shares

    /** Must be called on [io]. Copies bytes into app-private storage before returning. */
    fun importShareIntent(intent: Intent): ShareStore.ImportSummary {
        val store = shares
        var imported = 0
        val skipped = mutableListOf<String>()
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (!text.isNullOrBlank()) {
            if (store.addText(text) != null) imported += 1
        }
        val uris = collectStreamUris(intent)
        var fileCount = 0
        for (uri in uris) {
            if (fileCount >= ShareStore.MAX_FILES_PER_INTENT) {
                skipped += "${uri.lastPathSegment ?: "attachment"} (over the 10 file limit)"
                continue
            }
            when (val result = store.importFile(uri)) {
                is ShareStore.FileImport.Copied -> {
                    fileCount += 1
                    imported += 1
                }
                is ShareStore.FileImport.Skipped -> skipped += "${result.name} (${result.reason})"
            }
        }
        if (imported > 0) emitSharesChanged()
        return ShareStore.ImportSummary(imported, skipped)
    }

    private fun collectStreamUris(intent: Intent): List<Uri> {
        val uris = mutableListOf<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            // The standard ACTION_SEND_MULTIPLE payload is ParcelableArrayList<Uri>.
            val list = if (android.os.Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            }
            list?.forEach { uri -> if (uri != null && !uris.contains(uri)) uris += uri }
        } else {
            val single = if (android.os.Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }
            if (single != null) uris += single
        }
        val clip = intent.clipData
        if (clip != null) {
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index).uri?.let { if (!uris.contains(it)) uris += it }
            }
        }
        return uris
    }

    // ---------------------------------------------------------------- helpers

    fun sharesJson(): JSONArray {
        val array = JSONArray()
        shares.list().forEach { array.put(it.toJson()) }
        return array
    }

    /** Notification click target from a session id, or the site root. */
    fun deeplinkFor(origin: String, sessionId: String?): String {
        if (sessionId.isNullOrBlank()) return "$origin/"
        return "$origin/session/" + Uri.encode(sessionId)
    }
}
