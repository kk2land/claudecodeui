package ai.cloudcli.android.voice

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/** Only the current WebView route supplies a preferred session. The socket confirms its runtime. */
internal fun webSessionId(origin: String?, url: String?): String? {
    val site = origin?.toHttpUrlOrNull() ?: return null
    val page = url?.toHttpUrlOrNull() ?: return null
    if (site.scheme != page.scheme || site.host != page.host || site.port != page.port) return null
    val path = page.pathSegments
    return path.getOrNull(1)?.takeIf { it.isNotBlank() && path[0] == "session" && path.size == 2 }
}

internal fun JSONObject.string(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotBlank() }

internal fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else List(length()) { optJSONObject(it) }.filterNotNull()

internal data class VoiceChoice(val id: String, val title: String?, val project: String? = null)

internal data class RecentVoiceChoices(val choices: List<VoiceChoice>, val nextOffset: Int?) {
    companion object {
        fun read(data: JSONObject, offset: Int): RecentVoiceChoices {
            val all = data.getJSONArray("conversations").objects()
            val choices = all.mapNotNull { row ->
                val id = row.string("sessionId") ?: return@mapNotNull null
                if (row.string("provider") != "codex") return@mapNotNull null
                VoiceChoice(id, row.string("sessionTitle") ?: id, row.string("projectDisplayName"))
            }
            return RecentVoiceChoices(choices, (offset + all.size).takeIf { all.isNotEmpty() && data.optBoolean("hasMore") })
        }
    }
}

internal data class VoiceState(
    val runtime: String?,
    val phase: String?,
    val turnId: String?,
    val model: String?,
    val modelRequired: Boolean,
    val goalActive: Boolean,
    val questionPending: Boolean,
    val queueHeld: Boolean,
    val error: String?,
) {
    companion object {
        fun read(json: JSONObject): VoiceState {
            val selection = json.optJSONObject("modelSelection")
            return VoiceState(
                runtime = json.string("runtime"),
                phase = json.string("phase"),
                turnId = json.string("turnId"),
                model = selection?.string("model") ?: json.optJSONObject("activeModelSelection")?.string("model"),
                modelRequired = selection?.isNull("model") == true,
                goalActive = json.optJSONObject("goal")?.string("status") == "active",
                questionPending = json.optJSONArray("questions").objects().any { it.optBoolean("isBlocking", true) },
                queueHeld = json.optBoolean("queueHeld"),
                error = json.string("error"),
            )
        }
    }
}

internal enum class SendRoute { DIRECT, STEER, QUEUE }

internal fun sendRoute(state: VoiceState?, processing: Boolean, queueEmpty: Boolean, enqueue: Boolean): SendRoute? {
    if (state?.runtime != "app-server" || state.modelRequired) return null
    if (enqueue) return SendRoute.QUEUE
    if (!queueEmpty) return null
    return when {
        state.phase == "running" && state.turnId != null -> SendRoute.STEER
        state.phase == "idle" && !processing && !state.goalActive -> SendRoute.DIRECT
        else -> null
    }
}

internal data class VoiceSubmission(val text: String, val clientId: String, val expectedTurnId: String?) {
    var queueId: String? = null
    var steerId: String? = null

    fun matchesEcho(row: VoiceRow): Boolean {
        val identity = row.clientId ?: row.id
        return row.role == "user" && (identity == clientId || identity == steerId)
    }
}

internal data class QueueEntry(val id: String?, val clientId: String?)

internal data class VoiceQueue(val entries: List<QueueEntry>, val status: String?, val requestId: String?) {
    val empty: Boolean get() = entries.isEmpty()

    fun contains(message: VoiceSubmission): Boolean = entries.any {
        it.clientId == message.clientId || message.queueId != null && it.id == message.queueId
    }

    fun deliveryUnclear(message: VoiceSubmission): Boolean =
        message.steerId != null && requestId == message.steerId && status in setOf("steering", "unknown")

    companion object {
        fun read(body: JSONObject, scope: String): VoiceQueue {
            val draft = body.getJSONArray("drafts").objects().firstOrNull { it.string("scope") == scope }
            val entries = draft?.optJSONArray("queuedMessages")?.objects()
                ?: listOfNotNull(draft?.optJSONObject("queuedMessage"))
            val delivery = draft?.optJSONObject("queuedDelivery")
            return VoiceQueue(entries.map { QueueEntry(it.string("id"), it.optJSONObject("options")?.string("clientMessageId")) },
                delivery?.string("status"), delivery?.string("requestId"))
        }
    }
}

internal enum class FrameAge { DUPLICATE, REPLAY, LIVE, UNSEQUENCED }

/** `lastSeq` in the subscribe ack is the end of replay, including compacted snapshot gaps. */
internal class VoiceSequence {
    var executionId: String? = null
        private set
    var lastSeq = 0L
        private set
    private var replayThrough = 0L
    private val retired = mutableSetOf<String>()

    fun subscribe(ack: JSONObject) {
        switchTo(ack.string("executionId"))
        replayThrough = ack.optLong("lastSeq")
        if (!ack.optBoolean("isProcessing")) lastSeq = maxOf(lastSeq, replayThrough)
    }

    fun accept(frame: JSONObject): FrameAge {
        val run = frame.string("executionId") ?: return FrameAge.UNSEQUENCED
        val seq = frame.optLong("seq")
        if (seq <= 0) return FrameAge.UNSEQUENCED
        if (run in retired) return FrameAge.DUPLICATE
        switchTo(run)
        if (seq <= lastSeq) return FrameAge.DUPLICATE
        lastSeq = seq
        return if (seq <= replayThrough) FrameAge.REPLAY else FrameAge.LIVE
    }

    private fun switchTo(run: String?) {
        if (run == executionId) return
        executionId?.let { retired.add(it) }
        if (run != null) retired.remove(run)
        executionId = run
        lastSeq = 0
        replayThrough = 0
    }
}
