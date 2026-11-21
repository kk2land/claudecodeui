package ai.cloudcli.android.voice

import org.json.JSONObject

internal data class VoiceRow(
    val id: String,
    val role: String,
    val content: String,
    val clientId: String? = null,
    val turnId: String? = null,
    val executionId: String? = null,
    val streaming: Boolean = false,
    val toolId: String? = null,
) {
    val key: String get() = "$role:${clientId ?: toolId ?: id}"

    companion object {
        fun read(frame: JSONObject): VoiceRow? {
            val id = frame.string("id") ?: return null
            val run = frame.string("executionId")
            val kind = frame.string("kind")
            return when (kind) {
                "tool_result", "tool_use" -> {
                    // The history endpoint folds each result into its tool call.
                    val output = if (kind == "tool_result") frame.string("content")
                        else frame.optJSONObject("toolResult")?.string("content")
                    VoiceRow(id, "tool", output ?: return null, executionId = run, toolId = frame.string("toolId"))
                }
                "text" -> {
                    if (frame.optBoolean("isCompactSummary") || frame.optBoolean("isLocalCommand") ||
                        frame.optBoolean("isLocalCommandStdout")) return null
                    val role = frame.string("role")?.takeIf { it == "user" || it == "assistant" } ?: return null
                    VoiceRow(id, role, frame.opt("content") as? String ?: "", frame.string("clientMessageId"),
                        frame.string("turnId")?.takeUnless { it == "starting" } ?: frame.string("transcriptAnchorId"),
                        run, frame.optBoolean("isStreaming"))
                }
                else -> null
            }
        }
    }
}

internal data class TranscriptChange(val row: VoiceRow, val previous: VoiceRow?)

/** Persisted app-server rows use the same user client IDs and Codex turn/item IDs as live rows. */
internal class VoiceTranscript {
    private var history = emptyList<VoiceRow>()
    private val live = linkedMapOf<String, VoiceRow>()
    private var delta: VoiceRow? = null

    fun rows(): List<VoiceRow> = (history.map { live[it.key] ?: it } +
        live.values.filter { row -> history.none { it.key == row.key } }).filter { it.content.isNotBlank() }

    fun streamingReplies(): List<VoiceRow> = live.values.filter { it.role == "assistant" && it.streaming }

    fun mergeHistory(rows: List<VoiceRow>) {
        history = rows.distinctBy { it.key }
        for (row in history) {
            val current = live[row.key] ?: continue
            if (!current.streaming || row.content.length >= current.content.length) live.remove(row.key)
        }
    }

    fun accept(frame: JSONObject): TranscriptChange? {
        val run = frame.string("executionId")
        if (run != null && delta?.executionId != run) delta = null
        val previousDelta = delta
        return when (frame.string("kind")) {
            "stream_delta" -> {
                val content = (frame.opt("content") as? String)?.takeIf { it.isNotEmpty() } ?: return null
                val ongoing = previousDelta?.takeIf { it.streaming }
                val id = ongoing?.id ?: frame.string("id") ?: return null
                val row = VoiceRow(id, "assistant", ongoing?.content.orEmpty() + content,
                    turnId = frame.string("turnId") ?: ongoing?.turnId, executionId = run, streaming = true)
                delta = row
                live[row.key] = row
                TranscriptChange(row, ongoing)
            }
            "stream_end", "complete" -> previousDelta?.let {
                it.copy(streaming = false).also { row ->
                    delta = row.takeIf { frame.string("kind") == "stream_end" }
                    live[row.key] = row
                }.let { row -> TranscriptChange(row, it) }
            }
            "text", "tool_result", "tool_use" -> {
                val row = VoiceRow.read(frame) ?: return null
                val replaced = previousDelta?.takeIf {
                    row.role == "assistant" && (it.turnId == null || row.turnId == null || it.turnId == row.turnId) &&
                        row.content.startsWith(it.content)
                }
                val saved = history.find { it.key == row.key }
                val previous = if (replaced != null) live.remove(replaced.key) else live[row.key] ?: saved
                if (row.role == "assistant") delta = null
                if (!row.streaming || saved == null || row.content.length > saved.content.length) live[row.key] = row
                TranscriptChange(row, previous)
            }
            else -> null
        }
    }

    fun truncate(anchor: String) {
        val index = history.indexOfFirst { it.turnId == anchor || it.id == anchor }
        if (index >= 0) history = history.take(index)
        live.clear()
        delta = null
    }
}

/** A gate is opened only by the owning prompt's echo. Track how much of each row is already past it. */
internal class ReplySpeech {
    private var executionId: String? = null
    private var turnId: String? = null
    private val consumed = mutableMapOf<String, String>()
    private val interrupted = mutableSetOf<Pair<String?, String>>()
    val open: Boolean get() = executionId != null

    fun open(executionId: String, turnId: String?) {
        close()
        interrupted.removeAll { it.first != executionId }
        this.executionId = executionId
        this.turnId = turnId
    }

    fun close() {
        executionId = null
        turnId = null
        consumed.clear()
    }

    fun interrupt(streaming: List<VoiceRow>) {
        close()
        streaming.mapTo(interrupted, ::replyId)
    }

    // Native snapshots can replace the temporary `starting` turn with the real ID.
    private fun replyId(row: VoiceRow): Pair<String?, String> = row.executionId to
        if (row.id.startsWith("codex:")) row.id.substringAfter(':').substringAfter(':', row.id) else row.id

    fun accept(change: TranscriptChange, live: Boolean): List<String> {
        val (row, previous) = change
        if (row.role != "assistant") return emptyList()
        val identity = replyId(row)
        if (identity in interrupted || previous != null && previous.executionId == row.executionId && replyId(previous) in interrupted) {
            interrupted.add(identity)
            return emptyList()
        }
        if (!open || row.executionId != executionId ||
            (turnId != null && row.turnId != null && row.turnId != turnId)) return emptyList()

        val text = prose(row.content)
        val baseline = consumed[row.key] ?: previous?.let { consumed.remove(it.key) ?: prose(it.content) }.orEmpty()
        if (text.length < baseline.length && baseline.startsWith(text)) return emptyList()
        if (!live || !text.startsWith(baseline)) {
            consumed[row.key] = text
            return emptyList()
        }

        val chunks = mutableListOf<String>()
        var start = baseline.length
        for (boundary in SENTENCE_END.findAll(text, start)) {
            val end = boundary.range.last + 1
            if (row.streaming && end == text.length && boundary.value.first() in ".!?") break
            val chunk = text.substring(start, end).trim()
            if (chunk.any { it.isLetterOrDigit() }) chunks.add(chunk)
            start = end
        }
        if (!row.streaming) {
            val tail = text.substring(start).trim()
            if (tail.any { it.isLetterOrDigit() }) chunks.add(tail)
            start = text.length
        }
        consumed[row.key] = text.substring(0, start)
        return chunks
    }

    private fun prose(raw: String): String = buildString {
        var fence = ' '
        var length = 0
        for ((i, line) in raw.split('\n').withIndex()) {
            if (length == 0 && (line.startsWith("    ") || line.startsWith('\t'))) continue
            var trimmed = line.trimStart()
            while (trimmed.startsWith('>')) trimmed = trimmed.drop(1).trimStart()
            if (length == 0) trimmed = LIST_MARKER.replaceFirst(trimmed, "")
            val marker = trimmed.firstOrNull()
            val count = if (marker == '`' || marker == '~') trimmed.takeWhile { it == marker }.length else 0
            if (length > 0) {
                if (marker == fence && count >= length && trimmed.drop(count).isBlank()) length = 0
            } else if (count >= 3) {
                fence = marker!!
                length = count
            } else {
                if (i > 0) append('\n')
                append(line.replace("`", ""))
            }
        }
    }

    private companion object {
        val SENTENCE_END = Regex("""[。！？]+|[.!?]+["'”’)]*(?=\s|$)|\n{2,}""")
        val LIST_MARKER = Regex("""^(?:[-+*]|\d{1,9}[.)])\s+""")
    }
}
