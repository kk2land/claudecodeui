package ai.cloudcli.android

import org.json.JSONObject

/** `AndroidBridgeState` from contract §3.4; `toJson` is what the web receives. */
data class BridgeState(
    val version: Int = 1,
    val siteOrigin: String,
    val webBridgeReady: Boolean,
    val signedIn: Boolean,
    val notificationsEnabled: Boolean,
    val serviceRunning: Boolean,
    val connected: Boolean,
    val lastError: String?,
    val pendingShareCount: Int,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("version", version)
        .put("siteOrigin", siteOrigin)
        .put("webBridgeReady", webBridgeReady)
        .put("signedIn", signedIn)
        .put("notificationsEnabled", notificationsEnabled)
        .put("serviceRunning", serviceRunning)
        .put("connected", connected)
        .put("lastError", lastError ?: JSONObject.NULL)
        .put("pendingShareCount", pendingShareCount)
}

/** Error codes from contract §3.4. */
object BridgeErrorCode {
    const val UNAVAILABLE = "UNAVAILABLE"
    const val CANCELLED = "CANCELLED"
    const val INVALID_ARGUMENT = "INVALID_ARGUMENT"
    const val FILE_TOO_LARGE = "FILE_TOO_LARGE"
    const val TOO_MANY_FILES = "TOO_MANY_FILES"
    const val SHARE_NOT_FOUND = "SHARE_NOT_FOUND"
    const val SHARE_NOT_FILE = "SHARE_NOT_FILE"
    const val TRANSFER_FAILED = "TRANSFER_FAILED"
    const val INVALID_TOKEN = "INVALID_TOKEN"
    const val NOT_SIGNED_IN = "NOT_SIGNED_IN"
    const val PERMISSION_DENIED = "PERMISSION_DENIED"
    const val WEB_BRIDGE_NOT_READY = "WEB_BRIDGE_NOT_READY"
}

/** `lastError` values from contract §3.4. */
object BridgeLastError {
    const val NETWORK_ERROR = "NETWORK_ERROR"
    const val SOCKET_CLOSED = "SOCKET_CLOSED"
    const val REGISTER_FAILED = "REGISTER_FAILED"
    const val AUTH_EXPIRED = "AUTH_EXPIRED"
    const val PERMISSION_DENIED = "PERMISSION_DENIED"
    const val NOT_SIGNED_IN = "NOT_SIGNED_IN"
    const val WEB_BRIDGE_NOT_READY = "WEB_BRIDGE_NOT_READY"
    const val UNSUPPORTED_SERVER = "UNSUPPORTED_SERVER"
}
