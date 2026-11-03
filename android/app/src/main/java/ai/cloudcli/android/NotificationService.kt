package ai.cloudcli.android

import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Foreground (`specialUse`) notification connection (contract §2/§3.8).
 *
 * One live connection per service: `ACTION_ENABLE` while a socket exists (or a connect is in
 * flight) keeps that connection and only the next handshake picks up a newer token. Every socket
 * callback is bound to the attempt that created it, so a replaced socket cannot start or stop the
 * current one.
 */
class NotificationService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "cloudcli-notifications").apply { isDaemon = true }
    }
    private val reconnect = ReconnectPolicy()
    private lateinit var client: OkHttpClient

    @Volatile
    private var webSocket: WebSocket? = null

    @Volatile
    private var stopping = false

    @Volatile
    private var connecting = false

    @Volatile
    private var attempt = 0

    private val reconnectRunnable = Runnable {
        if (!stopping) connect()
    }

    private val refreshRunnable = Runnable {
        if (stopping) return@Runnable
        worker.execute { performRefresh() }
    }

    override fun onCreate() {
        super.onCreate()
        AppRuntime.init(this)
        Notifications.ensureChannels(this)
        client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(SOCKET_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
        instance = this
        startForeground(Notifications.foregroundNotificationId(), Notifications.foregroundNotification(this))
        AppRuntime.setServiceRunning(true)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISABLE -> shutdownNow(disableEndpoint = true)
            ACTION_STOP -> shutdownNow(disableEndpoint = false)
            else -> {
                if (!AppRuntime.prefs.notificationsEnabled) {
                    shutdownNow(disableEndpoint = false)
                    return START_NOT_STICKY
                }
                stopping = false
                // A newer token may have been saved while connected; move the single refresh timer
                // to the token that is current now instead of leaving the old schedule behind.
                scheduleRefreshForCurrentSession()
                connect()
            }
        }
        // Never auto-restart: the connection is only alive while the user keeps it enabled.
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopping = true
        attempt += 1
        main.removeCallbacksAndMessages(null)
        webSocket?.cancel()
        webSocket = null
        AppRuntime.setConnected(false)
        AppRuntime.setServiceRunning(false)
        worker.shutdownNow()
        if (instance === this) instance = null
        super.onDestroy()
    }

    /**
     * Immediate local stop: state is flipped, the socket invalidated, the foreground notification
     * removed and the service stopped without waiting for any network call. The endpoint PATCH is a
     * detached best-effort request.
     */
    fun shutdownNow(disableEndpoint: Boolean) {
        if (disableEndpoint) {
            AppRuntime.prefs.notificationsEnabled = false
        }
        stopping = true
        attempt += 1
        connecting = false
        main.removeCallbacksAndMessages(null)
        val socket = webSocket
        webSocket = null
        socket?.close(1000, if (disableEndpoint) "disabled" else "stopped")
        AppRuntime.setConnected(false)
        AppRuntime.setServiceRunning(false)
        if (disableEndpoint) {
            Thread({ disableEndpointBestEffort() }, "cloudcli-disable-endpoint").start()
        }
        val stop = Runnable {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            stop.run()
        } else {
            main.post(stop)
        }
    }

    // ---------------------------------------------------------------- connect

    private fun connect() {
        if (stopping) return
        if (webSocket != null || connecting) return
        connecting = true
        worker.execute {
            if (stopping) {
                connecting = false
                return@execute
            }
            val captured = capture()
            if (captured == null) {
                connecting = false
                AppRuntime.setLastError(BridgeLastError.NOT_SIGNED_IN)
                shutdownNow(disableEndpoint = false)
                return@execute
            }
            if (!Jwt.isUsable(captured.token)) {
                connecting = false
                AppRuntime.expireSession()
                shutdownNow(disableEndpoint = false)
                return@execute
            }
            var current = captured
            if (Jwt.isPastHalfLife(current.token)) {
                refreshCaptured(current)
                if (stopping) {
                    connecting = false
                    return@execute
                }
                // The web may have saved a newer token while the refresh was in flight.
                current = capture() ?: run {
                    connecting = false
                    AppRuntime.setLastError(BridgeLastError.NOT_SIGNED_IN)
                    shutdownNow(disableEndpoint = false)
                    return@execute
                }
                if (!Jwt.isUsable(current.token)) {
                    connecting = false
                    AppRuntime.expireSession()
                    shutdownNow(disableEndpoint = false)
                    return@execute
                }
            }
            scheduleRefresh(current.token)
            if (stopping) {
                connecting = false
                return@execute
            }
            if (!registerEndpoint(current.origin, current.token)) {
                connecting = false
                if (!stopping) scheduleReconnect()
                return@execute
            }
            // The origin or token may have changed while registering; never open a socket for them.
            if (AppRuntime.prefs.siteOrigin != current.origin || AppRuntime.prefs.token() != current.token) {
                connecting = false
                main.post { if (!stopping) connect() }
                return@execute
            }
            openSocket(current.origin, current.token)
        }
    }

    private fun openSocket(origin: String, token: String) {
        if (stopping) {
            connecting = false
            return
        }
        val attemptId = ++attempt
        val request = Request.Builder()
            .url(SiteOrigin.wsOrigin(origin) + WS_PATH)
            .header("Authorization", "Bearer $token")
            .build()
        webSocket = client.newWebSocket(request, socketListener(attemptId))
        connecting = false
    }

    private fun isCurrent(attemptId: Int): Boolean = attemptId == attempt && !stopping

    private fun registerEndpoint(origin: String, token: String): Boolean {
        val body = JSONObject()
            .put("channel", "android")
            .put("endpointId", AppRuntime.prefs.deviceId)
            .put("label", LABEL)
            .put("metadata", JSONObject().put("platform", "android").put("appVersion", BuildConfig.VERSION_NAME))
            .put("enabled", true)
            .toString()
            .toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url("$origin/api/notifications/endpoints/current")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                when {
                    response.isSuccessful -> true
                    response.code == 401 -> {
                        AppRuntime.expireSession()
                        shutdownNow(disableEndpoint = false)
                        false
                    }
                    response.code == 404 -> {
                        AppRuntime.setLastError(BridgeLastError.UNSUPPORTED_SERVER)
                        shutdownNow(disableEndpoint = false)
                        false
                    }
                    else -> {
                        AppRuntime.setLastError(BridgeLastError.REGISTER_FAILED)
                        false
                    }
                }
            }
        } catch (_: IOException) {
            AppRuntime.setLastError(BridgeLastError.NETWORK_ERROR)
            false
        }
    }

    private fun disableEndpointBestEffort() {
        val captured = capture() ?: return
        val request = Request.Builder()
            .url("${captured.origin}/api/notifications/endpoints/android/${AppRuntime.prefs.deviceId}")
            .header("Authorization", "Bearer ${captured.token}")
            .patch(JSONObject().put("enabled", false).toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val shortClient = client.newBuilder()
            .callTimeout(10, TimeUnit.SECONDS)
            .build()
        try {
            shortClient.newCall(request).execute().close()
        } catch (_: IOException) {
            // Best effort only.
        }
    }

    private fun scheduleReconnect() {
        if (stopping) return
        AppRuntime.setConnected(false)
        val delay = reconnect.onAttemptFailed()
        main.removeCallbacks(reconnectRunnable)
        main.postDelayed(reconnectRunnable, delay)
    }

    // ---------------------------------------------------------------- websocket

    private fun socketListener(attemptId: Int) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!isCurrent(attemptId)) return
            val register = JSONObject()
                .put("type", "register")
                .put("deviceId", AppRuntime.prefs.deviceId)
                .put("label", LABEL)
                .put("platform", "android")
                .put("appVersion", BuildConfig.VERSION_NAME)
            webSocket.send(register.toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isCurrent(attemptId)) return
            handleServerMessage(webSocket, text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            if (!isCurrent(attemptId)) return
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!isCurrent(attemptId)) return
            this@NotificationService.webSocket = null
            handleSocketEnd(code)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!isCurrent(attemptId)) return
            this@NotificationService.webSocket = null
            when (response?.code) {
                401 -> {
                    AppRuntime.expireSession()
                    shutdownNow(disableEndpoint = false)
                }
                404 -> {
                    AppRuntime.setLastError(BridgeLastError.UNSUPPORTED_SERVER)
                    shutdownNow(disableEndpoint = false)
                }
                else -> {
                    AppRuntime.setLastError(
                        if (t is java.net.SocketTimeoutException) {
                            BridgeLastError.SOCKET_CLOSED
                        } else {
                            BridgeLastError.NETWORK_ERROR
                        },
                    )
                    scheduleReconnect()
                }
            }
        }
    }

    private fun handleServerMessage(webSocket: WebSocket, text: String) {
        if (stopping) return
        val message = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (message.optString("type")) {
            "registered" -> {
                reconnect.onRegistered()
                AppRuntime.setLastError(null)
                AppRuntime.setConnected(true)
            }
            "notification" -> {
                if (stopping) return
                val payload = message.optJSONObject("payload") ?: JSONObject()
                val data = payload.optJSONObject("data")
                val sessionId = if (data != null && !data.isNull("sessionId")) {
                    data.optString("sessionId")
                } else {
                    null
                }
                val messageId = message.optString("id")
                val tag = if (data != null && !data.isNull("tag") && data.optString("tag").isNotEmpty()) {
                    data.optString("tag")
                } else {
                    messageId.ifEmpty { System.currentTimeMillis().toString() }
                }
                val shown = Notifications.postEvent(
                    this,
                    tag,
                    payload.optString("title").ifEmpty { "CloudCLI" },
                    payload.optString("body"),
                    sessionId,
                )
                val ack = JSONObject()
                    .put("type", "notification_ack")
                    .put("id", messageId)
                    .put("action", if (shown) "shown" else "suppressed")
                webSocket.send(ack.toString())
            }
            "error" -> {
                val code = message.optString("code")
                if (code == "UNSUPPORTED_SERVER" || code == "NOT_IMPLEMENTED") {
                    AppRuntime.setLastError(BridgeLastError.UNSUPPORTED_SERVER)
                } else {
                    AppRuntime.setLastError(BridgeLastError.REGISTER_FAILED)
                }
                shutdownNow(disableEndpoint = false)
            }
        }
    }

    private fun handleSocketEnd(code: Int) {
        if (stopping) return
        AppRuntime.setConnected(false)
        when (code) {
            4000 -> {
                // A newer socket for this device replaced this one: reconnect immediately.
                reconnect.reset()
                main.removeCallbacks(reconnectRunnable)
                main.post { if (!stopping) connect() }
            }
            1008, 1011 -> {
                AppRuntime.setLastError(BridgeLastError.REGISTER_FAILED)
                shutdownNow(disableEndpoint = false)
            }
            else -> {
                AppRuntime.setLastError(BridgeLastError.SOCKET_CLOSED)
                scheduleReconnect()
            }
        }
    }

    // ---------------------------------------------------------------- token refresh

    private data class Captured(val origin: String, val token: String)

    private fun capture(): Captured? {
        val origin = AppRuntime.prefs.siteOrigin ?: return null
        val token = AppRuntime.prefs.token() ?: return null
        return Captured(origin, token)
    }

    private fun owns(captured: Captured): Boolean = RefreshGuard.isOwner(
        capturedOrigin = captured.origin,
        capturedToken = captured.token,
        currentOrigin = AppRuntime.prefs.siteOrigin,
        currentToken = AppRuntime.prefs.token(),
    )

    private fun scheduleRefresh(token: String) {
        val at = Jwt.refreshAtMs(token) ?: return
        val target = if (at <= System.currentTimeMillis()) System.currentTimeMillis() + REFRESH_RETRY_MS else at
        scheduleRefreshAt(target)
    }

    private fun scheduleRefreshAt(atMs: Long) {
        main.removeCallbacks(refreshRunnable)
        main.postDelayed(refreshRunnable, (atMs - System.currentTimeMillis()).coerceAtLeast(0L))
    }

    /**
     * Runs one half-life refresh for the captured credentials. A response is only applied while the
     * captured origin+token are still current; when the web saved a newer token meanwhile, the
     * *current* token takes over the single refresh schedule instead of losing it.
     */
    private fun refreshCaptured(captured: Captured) {
        when (val result = requestRefresh(captured.origin, captured.token)) {
            is RefreshResult.Refreshed -> {
                if (owns(captured)) {
                    AppRuntime.storeRefreshedToken(result.token)
                    scheduleRefresh(result.token)
                } else {
                    scheduleRefreshForCurrentSession()
                }
            }
            RefreshResult.AuthExpired -> {
                if (owns(captured)) {
                    AppRuntime.expireSession()
                    shutdownNow(disableEndpoint = false)
                } else {
                    scheduleRefreshForCurrentSession()
                }
            }
            RefreshResult.Failed -> {
                if (owns(captured)) {
                    // One retry chain: 60 s out, never an immediate half-life loop.
                    scheduleRefreshAt(System.currentTimeMillis() + REFRESH_RETRY_MS)
                } else {
                    scheduleRefreshForCurrentSession()
                }
            }
        }
    }

    /** Gives the token that is current now its next refresh, without touching logout/site change. */
    private fun scheduleRefreshForCurrentSession() {
        if (stopping) return
        val current = capture() ?: return
        if (!Jwt.isUsable(current.token)) return
        scheduleRefresh(current.token)
    }

    private fun performRefresh() {
        if (stopping) return
        val captured = capture() ?: return
        if (!Jwt.isUsable(captured.token)) {
            if (owns(captured)) {
                AppRuntime.expireSession()
                shutdownNow(disableEndpoint = false)
            }
            return
        }
        refreshCaptured(captured)
    }

    private sealed interface RefreshResult {
        data class Refreshed(val token: String) : RefreshResult
        data object AuthExpired : RefreshResult
        data object Failed : RefreshResult
    }

    private fun requestRefresh(origin: String, token: String): RefreshResult {
        val request = Request.Builder()
            .url("$origin/api/auth/refresh")
            .header("Authorization", "Bearer $token")
            .post(EMPTY_JSON.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                when {
                    response.isSuccessful -> {
                        val body = response.body?.string().orEmpty()
                        val refreshed = try {
                            JSONObject(body).optString("token")
                        } catch (_: Exception) {
                            ""
                        }
                        if (refreshed.isEmpty() || !Jwt.isUsable(refreshed)) {
                            RefreshResult.Failed
                        } else {
                            RefreshResult.Refreshed(refreshed)
                        }
                    }
                    response.code == 401 -> RefreshResult.AuthExpired
                    else -> RefreshResult.Failed
                }
            }
        } catch (_: IOException) {
            RefreshResult.Failed
        }
    }

    companion object {
        const val ACTION_ENABLE = "ai.cloudcli.android.action.ENABLE_NOTIFICATIONS"
        const val ACTION_DISABLE = "ai.cloudcli.android.action.DISABLE_NOTIFICATIONS"
        const val ACTION_STOP = "ai.cloudcli.android.action.STOP_NOTIFICATIONS"

        private const val WS_PATH = "/android-notifications"
        private const val LABEL = "Android"
        private const val REFRESH_RETRY_MS = 60_000L
        private const val SOCKET_READ_TIMEOUT_SECONDS = 90L
        private const val EMPTY_JSON = "{}"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        @Volatile
        private var instance: NotificationService? = null

        /** The running service, if any; lets the app stop it without starting a foreground service. */
        fun current(): NotificationService? = instance
    }
}
