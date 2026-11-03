package ai.cloudcli.android

import java.net.URI

/**
 * Parses the configured site root into a normalized origin (`scheme://host[:port]`).
 *
 * Uses a real URI parser: the explicit origin string is what the bridge and WebView are locked to.
 * Rejects credentials, paths (other than `/`), queries, fragments, non-HTTP schemes and missing hosts.
 */
object SiteOrigin {

    fun normalize(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val uri = try {
            URI(trimmed)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (!uri.rawUserInfo.isNullOrEmpty()) return null
        val host = uri.host ?: return null
        if (host.isBlank()) return null
        val path = uri.rawPath
        if (!path.isNullOrEmpty() && path != "/") return null
        if (uri.rawQuery != null || uri.rawFragment != null) return null
        val port = uri.port
        if (port != -1 && (port < 1 || port > 65535)) return null
        val defaultPort = if (scheme == "http") 80 else 443
        val hostPart = host.lowercase()
        return if (port == -1 || port == defaultPort) {
            "$scheme://$hostPart"
        } else {
            "$scheme://$hostPart:$port"
        }
    }

    /** True when the whole trimmed value is a single absolute http(s) URL. */
    fun isSingleHttpUrl(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return false
        val uri = try {
            URI(trimmed)
        } catch (_: Exception) {
            return false
        }
        return (uri.scheme?.lowercase() == "http" || uri.scheme?.lowercase() == "https") &&
            !uri.host.isNullOrBlank()
    }

    fun wsOrigin(origin: String): String = when {
        origin.startsWith("https://") -> "wss://" + origin.removePrefix("https://")
        origin.startsWith("http://") -> "ws://" + origin.removePrefix("http://")
        else -> origin
    }
}
