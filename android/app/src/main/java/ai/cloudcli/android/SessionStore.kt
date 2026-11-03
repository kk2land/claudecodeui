package ai.cloudcli.android

import android.content.Context

/**
 * Private native state (contract §3.8): token bound to the configured origin, the notification
 * preference and the stable device id. `allowBackup=false` keeps this out of cloud backups.
 */
class SessionStore(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences("cloudcli-native", Context.MODE_PRIVATE)

    var siteOrigin: String?
        get() = prefs.getString(KEY_SITE_ORIGIN, null)
        set(value) {
            prefs.edit().putString(KEY_SITE_ORIGIN, value).apply()
        }

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATIONS_ENABLED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_NOTIFICATIONS_ENABLED, value).apply()
        }

    /** Stable across service restarts and reconnects. */
    val deviceId: String
        get() {
            synchronized(this) {
                val existing = prefs.getString(KEY_DEVICE_ID, null)
                if (!existing.isNullOrBlank()) return existing
                val generated = java.util.UUID.randomUUID().toString()
                prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
                return generated
            }
        }

    /** Token is only valid for the origin it was stored for. */
    fun token(): String? {
        val origin = siteOrigin ?: return null
        if (prefs.getString(KEY_TOKEN_ORIGIN, null) != origin) return null
        return prefs.getString(KEY_TOKEN, null)
    }

    fun setToken(token: String) {
        val origin = siteOrigin ?: return
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_TOKEN_ORIGIN, origin)
            .apply()
    }

    fun clearToken() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_TOKEN_ORIGIN).apply()
    }

    fun signedIn(): Boolean = token()?.let { Jwt.isUsable(it) } == true

    /** Origin change: clear the native token, keep the notification preference untouched here. */
    fun changeOrigin(origin: String) {
        clearToken()
        siteOrigin = origin
    }

    private companion object {
        const val KEY_SITE_ORIGIN = "site_origin"
        const val KEY_NOTIFICATIONS_ENABLED = "notifications_enabled"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_TOKEN = "auth_token"
        const val KEY_TOKEN_ORIGIN = "auth_token_origin"
    }
}
