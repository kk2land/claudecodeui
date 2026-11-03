package ai.cloudcli.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RefreshGuardTest {

    @Test
    fun ownerStillCurrent() {
        assertTrue(
            RefreshGuard.isOwner(
                capturedOrigin = "https://cloud.example.com",
                capturedToken = "token-a",
                currentOrigin = "https://cloud.example.com",
                currentToken = "token-a",
            ),
        )
    }

    @Test
    fun supersededByNewLogin() {
        assertFalse(
            RefreshGuard.isOwner(
                capturedOrigin = "https://cloud.example.com",
                capturedToken = "token-a",
                currentOrigin = "https://cloud.example.com",
                currentToken = "token-b",
            ),
        )
    }

    @Test
    fun supersededByLogout() {
        assertFalse(
            RefreshGuard.isOwner(
                capturedOrigin = "https://cloud.example.com",
                capturedToken = "token-a",
                currentOrigin = "https://cloud.example.com",
                currentToken = null,
            ),
        )
    }

    @Test
    fun supersededBySiteChange() {
        assertFalse(
            RefreshGuard.isOwner(
                capturedOrigin = "https://old.example.com",
                capturedToken = "token-a",
                currentOrigin = "https://new.example.com",
                currentToken = "token-a",
            ),
        )
    }

    @Test
    fun rejectsEmptyCapture() {
        assertFalse(RefreshGuard.isOwner(null, null, null, null))
        assertFalse(RefreshGuard.isOwner("", "", "https://cloud.example.com", "token-a"))
    }
}
