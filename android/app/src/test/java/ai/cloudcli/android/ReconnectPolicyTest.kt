package ai.cloudcli.android

import org.junit.Assert.assertEquals
import org.junit.Test

class ReconnectPolicyTest {

    @Test
    fun backsOffToThirtySecondsAndStaysThere() {
        val policy = ReconnectPolicy()
        assertEquals(1_000L, policy.onAttemptFailed())
        assertEquals(2_000L, policy.onAttemptFailed())
        assertEquals(4_000L, policy.onAttemptFailed())
        assertEquals(8_000L, policy.onAttemptFailed())
        assertEquals(16_000L, policy.onAttemptFailed())
        assertEquals(30_000L, policy.onAttemptFailed())
        assertEquals(30_000L, policy.onAttemptFailed())
    }

    @Test
    fun registeredResetsBackoff() {
        val policy = ReconnectPolicy()
        repeat(4) { policy.onAttemptFailed() }
        policy.onRegistered()
        assertEquals(1_000L, policy.current())
        assertEquals(1_000L, policy.onAttemptFailed())
    }

    @Test
    fun resetRestartsBackoff() {
        val policy = ReconnectPolicy()
        repeat(6) { policy.onAttemptFailed() }
        policy.reset()
        assertEquals(1_000L, policy.onAttemptFailed())
    }
}
