package ai.cloudcli.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JwtTest {

    private fun token(iatSeconds: Long, expSeconds: Long): String {
        val encoder = java.util.Base64.getUrlEncoder().withoutPadding()
        val header = encoder.encodeToString("""{"alg":"HS256","typ":"JWT"}""".toByteArray())
        val payload = encoder.encodeToString("""{"iat":$iatSeconds,"exp":$expSeconds}""".toByteArray())
        return "$header.$payload.signature"
    }

    @Test
    fun parsesIssuedAndExpiry() {
        val claims = Jwt.claims(token(1_000, 2_000))
        assertEquals(1_000_000L, claims?.issuedAtMs)
        assertEquals(2_000_000L, claims?.expiresAtMs)
        assertEquals(1_500_000L, claims?.halfLifeAtMs)
    }

    @Test
    fun rejectsMalformedTokens() {
        assertNull(Jwt.claims(""))
        assertNull(Jwt.claims("a.b"))
        assertNull(Jwt.claims("a.!!!.c"))
        assertFalse(Jwt.isUsable("not-a-token"))
    }

    @Test
    fun usableUntilExpirySkew() {
        val token = token(1_000, 2_000)
        assertTrue(Jwt.isUsable(token, nowMs = 1_900_000L))
        // Inside the 60 s skew the token is no longer usable.
        assertFalse(Jwt.isUsable(token, nowMs = 1_950_000L))
        assertFalse(Jwt.isUsable(token, nowMs = 2_000_000L))
    }

    @Test
    fun halfLifeCheck() {
        val token = token(1_000, 2_000)
        assertFalse(Jwt.isPastHalfLife(token, nowMs = 1_400_000L))
        assertTrue(Jwt.isPastHalfLife(token, nowMs = 1_500_000L))
        assertEquals(1_500_000L, Jwt.refreshAtMs(token))
    }
}
