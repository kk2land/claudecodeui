package ai.cloudcli.android

/**
 * Ownership check for a refresh response: a token may only be applied (or a session expired) while
 * the captured origin and token are still the current ones. Logging out, switching site or logging
 * in again in the meantime supersedes the in-flight refresh.
 */
object RefreshGuard {
    fun isOwner(
        capturedOrigin: String?,
        capturedToken: String?,
        currentOrigin: String?,
        currentToken: String?,
    ): Boolean {
        if (capturedOrigin.isNullOrEmpty() || capturedToken.isNullOrEmpty()) return false
        return capturedOrigin == currentOrigin && capturedToken == currentToken
    }
}
