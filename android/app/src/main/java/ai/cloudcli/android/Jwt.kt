package ai.cloudcli.android

import java.util.Base64
import org.json.JSONObject

/** Local JWT inspection. The server remains the authority; no signature check is performed here. */
object Jwt {

    /** Same skew as `src/shared/authToken.ts`. */
    const val EXPIRY_SKEW_MS = 60_000L

    data class Claims(val issuedAtMs: Long, val expiresAtMs: Long) {
        val lifetimeMs: Long get() = expiresAtMs - issuedAtMs
        val halfLifeAtMs: Long get() = issuedAtMs + lifetimeMs / 2
    }

    fun claims(token: String): Claims? {
        val parts = token.split('.')
        if (parts.size != 3) return null
        val payload = try {
            String(Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)
        } catch (_: Exception) {
            return null
        }
        return try {
            val json = JSONObject(payload)
            if (!json.has("exp") || !json.has("iat")) return null
            val exp = json.optLong("exp", -1L)
            val iat = json.optLong("iat", -1L)
            if (exp <= 0L || iat <= 0L) return null
            Claims(issuedAtMs = iat * 1000L, expiresAtMs = exp * 1000L)
        } catch (_: Exception) {
            null
        }
    }

    /** Valid means: parseable `iat`/`exp` and not inside the 60 s expiry skew. */
    fun isUsable(token: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        val claims = claims(token) ?: return false
        return claims.expiresAtMs - EXPIRY_SKEW_MS > nowMs
    }

    fun isPastHalfLife(token: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        val claims = claims(token) ?: return true
        return nowMs >= claims.halfLifeAtMs
    }

    /** Next refresh point: `iat + (exp - iat) / 2`, matching the web client. */
    fun refreshAtMs(token: String): Long? = claims(token)?.halfLifeAtMs
}
