package ai.cloudcli.android

/** Capped reconnect delay from the contract: 1, 2, 4, 8, 16, then 30 seconds. */
class ReconnectPolicy {
    var nextDelayMs: Long = INITIAL_DELAY_MS
        private set

    fun current(): Long = nextDelayMs

    fun onAttemptFailed(): Long {
        val delay = nextDelayMs
        nextDelayMs = (nextDelayMs * 2).coerceAtMost(MAX_DELAY_MS)
        return delay
    }

    /** Called when the server acknowledged `register`; the next failure starts at 1 s again. */
    fun onRegistered() {
        nextDelayMs = INITIAL_DELAY_MS
    }

    fun reset() {
        nextDelayMs = INITIAL_DELAY_MS
    }

    companion object {
        const val INITIAL_DELAY_MS = 1_000L
        const val MAX_DELAY_MS = 30_000L
    }
}
