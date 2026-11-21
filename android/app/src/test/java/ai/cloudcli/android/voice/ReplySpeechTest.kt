package ai.cloudcli.android.voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplySpeechTest {
    private val transcript = VoiceTranscript()
    private val speech = ReplySpeech()

    private fun frame(kind: String, id: String, content: String) = JSONObject().put("kind", kind).put("id", id)
        .put("content", content).put("executionId", "run").put("turnId", "turn")

    private fun text(content: String, streaming: Boolean = false, live: Boolean = true, id: String = "codex:turn:item"): List<String> {
        val change = transcript.accept(frame("text", id, content).put("role", "assistant")
            .put("isStreaming", streaming))!!
        return speech.accept(change, live)
    }

    @Test fun gateReadsOnlyNewTextAfterEchoAndClosesOnBargeIn() {
        assertTrue(text("Old text. ", streaming = true).isEmpty())
        speech.open("run", "turn")
        assertEquals(listOf("New text."), text("Old text. New text. ", streaming = true))
        speech.close()
        assertTrue(text("Old text. New text. Do not speak this.").isEmpty())
    }

    @Test fun reconnectReplayAndHistoryRowsAreSilent() {
        transcript.mergeHistory(listOf(VoiceRow("codex:turn:item", "assistant", "Persisted. ")))
        speech.open("run", "turn")
        assertTrue(text("Persisted. Replayed. ", streaming = true, live = false).isEmpty())
        assertEquals(listOf("Live only."), text("Persisted. Replayed. Live only."))
        assertEquals(1, transcript.rows().size)
    }

    @Test fun bargeInSkipsTheUnfinishedNativeItemAfterTheOwnedEcho() {
        speech.open("run", null)
        assertEquals(listOf("First sentence."), text("First sentence. ", streaming = true, id = "codex:starting:item"))
        speech.interrupt(transcript.streamingReplies())
        assertTrue(text("First sentence. Still talking.", streaming = true).isEmpty())
        speech.open("run", "turn")
        assertTrue(text("First sentence. Still talking. Old ending.").isEmpty())
        assertEquals(listOf("Fresh answer."), text("Fresh answer.", id = "codex:turn:fresh"))
    }

    @Test fun bargeInAlsoSkipsDeltasAndTheirFinalSnapshotAcrossTheUserEcho() {
        val initial = transcript.accept(frame("stream_delta", "delta1", "Interrupted. "))!!
        speech.open("run", "turn")
        assertEquals(listOf("Interrupted."), speech.accept(initial, live = true))
        speech.interrupt(transcript.streamingReplies())
        transcript.accept(frame("text", "echo", "New prompt").put("role", "user"))
        speech.open("run", "turn")
        val continuation = transcript.accept(frame("stream_delta", "delta2", "Old ending. "))!!
        assertTrue(speech.accept(continuation, live = true).isEmpty())
        assertTrue(text("Interrupted. Old ending. Extra old text.").isEmpty())
        assertEquals(listOf("Fresh answer."), text("Fresh answer.", id = "codex:turn:fresh"))
    }

    @Test fun streamingFencesAndToolsNeverReachSpeech() {
        speech.open("run", "turn")
        assertEquals(listOf("Before."), text("Before.\n``", streaming = true))
        assertTrue(text("Before.\n```bash\nExplosive punctuation! Never speak this.\n", streaming = true).isEmpty())
        assertEquals(listOf("After."), text("Before.\n```bash\nCode! Never speak this.\n```\n\n    printf example\n\nAfter."))
        assertNull(transcript.accept(frame("tool_use", "tool", "tool text").put("role", "assistant")))
        assertNull(transcript.accept(frame("text", "compaction", "summary").put("role", "assistant").put("isCompactSummary", true)))
    }

    @Test fun liveAndFoldedHistoryToolOutputShareOneSilentTextRow() {
        speech.open("run", "turn")
        val output = "Tool stdout.\n```sh\nprintf example\n```"
        val live = transcript.accept(frame("tool_result", "codex:turn:item:result", output).put("toolId", "item"))!!
        assertTrue(speech.accept(live, live = true).isEmpty())
        assertEquals(output, transcript.rows().single().content)
        val saved = VoiceRow.read(frame("tool_use", "rest-row", "").put("toolId", "item")
            .put("toolResult", JSONObject().put("content", output)))!!
        transcript.mergeHistory(listOf(saved))
        assertEquals(listOf(saved), transcript.rows())
    }

    @Test fun deltaAndFinalWholeRowDoNotSpeakOrDisplayTwice() {
        speech.open("run", "turn")
        val first = transcript.accept(frame("stream_delta", "delta1", "Hello. "))!!
        assertEquals(listOf("Hello."), speech.accept(first, live = true))
        val second = transcript.accept(frame("stream_delta", "delta2", "Almost done"))!!
        assertTrue(speech.accept(second, live = true).isEmpty())
        assertEquals(listOf("Almost done."), text("Hello. Almost done."))
        assertTrue(text("Hello. Almost done.").isEmpty())
        assertEquals(listOf("Hello. Almost done."), transcript.rows().map { it.content })
    }

    @Test fun aDifferentExecutionOrTurnCannotSpeakOnTheOldGate() {
        speech.open("previous-run", "turn")
        assertTrue(text("A new run.").isEmpty())
        speech.open("run", "previous-turn")
        assertTrue(text("A new turn.").isEmpty())
    }

    @Test fun persistedReplacementUsesClientAndItemIds() {
        val user = frame("text", "live-row", "Same words").put("role", "user").put("clientMessageId", "client-id")
        transcript.accept(user)
        text("Partial", streaming = true)
        transcript.mergeHistory(listOf(VoiceRow("saved-row", "user", "Same words", "client-id"),
            VoiceRow("codex:turn:item", "assistant", "Partial and final")))
        assertEquals(listOf("saved-row", "codex:turn:item"), transcript.rows().map { it.id })
        assertEquals("Partial and final", transcript.rows().last().content)
    }
}
