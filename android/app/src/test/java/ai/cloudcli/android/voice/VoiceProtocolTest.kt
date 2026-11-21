package ai.cloudcli.android.voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceProtocolTest {
    @Test fun preferredSessionUsesOnlyTheCurrentSameOriginRoute() {
        val origin = "https://cloudcli.example"
        assertEquals("a b", webSessionId(origin, "$origin/session/a%20b?tab=chat#bottom"))
        assertEquals("a", webSessionId(origin, "https://CLOUDCLI.example:443/session/a"))
        assertNull(webSessionId(origin, "$origin/"))
        assertNull(webSessionId(origin, "$origin/session/a/extra"))
        assertNull(webSessionId(origin, "https://cloudcli.example:444/session/a"))
        assertNull(webSessionId(origin, "https://other.example/session/a"))
        assertNull(webSessionId(origin, null))
    }

    @Test fun recentSelectorPaginatesAcrossOtherProviders() {
        val current = JSONObject("""{"conversations":[{"sessionId":"x","provider":"dsh"}],"hasMore":true}""")
        assertEquals(RecentVoiceChoices(emptyList(), 41), RecentVoiceChoices.read(current, 40))
        val next = JSONObject("""{"conversations":[{"sessionId":"c","provider":"codex","sessionTitle":"Title"}],"hasMore":false}""")
        assertEquals(RecentVoiceChoices(listOf(VoiceChoice("c", "Title")), null), RecentVoiceChoices.read(next, 41))
    }

    @Test fun routesRequireNativeStateAndAnEmptyQueueForImmediateDelivery() {
        fun state(runtime: String, phase: String, turn: String? = null) = VoiceState.read(JSONObject()
            .put("runtime", runtime).put("phase", phase).put("turnId", turn))
        val idle = state("app-server", "idle")
        val running = state("app-server", "running", "turn-1")

        assertEquals(SendRoute.DIRECT, sendRoute(idle, processing = false, queueEmpty = true, enqueue = false))
        assertNull(sendRoute(idle, processing = true, queueEmpty = true, enqueue = false))
        assertNull(sendRoute(idle, processing = false, queueEmpty = false, enqueue = false))
        assertEquals(SendRoute.STEER, sendRoute(running, processing = true, queueEmpty = true, enqueue = false))
        assertNull(sendRoute(running.copy(turnId = null), processing = true, queueEmpty = true, enqueue = false))
        assertNull(sendRoute(running.copy(phase = "stopping"), processing = true, queueEmpty = true, enqueue = false))
        assertNull(sendRoute(running, processing = true, queueEmpty = false, enqueue = false))
        assertEquals(SendRoute.QUEUE, sendRoute(running, processing = true, queueEmpty = false, enqueue = true))
        assertNull(sendRoute(state("sdk", "idle"), processing = false, queueEmpty = true, enqueue = true))
        assertNull(sendRoute(idle.copy(modelRequired = true), processing = false, queueEmpty = true, enqueue = false))
    }

    @Test fun matchingWordsAndDifferentIdentitiesDoNotConfirmDelivery() {
        val ticket = VoiceSubmission("same words", "client", "turn").apply {
            queueId = "queue-ticket"
            steerId = "steer-request"
        }
        val unrelated = VoiceRow("old", "user", "same words", "unrelated")
        assertFalse(ticket.matchesEcho(unrelated))
        assertFalse(ticket.matchesEcho(unrelated.copy(id = "client")))
        assertFalse(ticket.matchesEcho(unrelated.copy(id = "queue-ticket", clientId = null)))
        assertTrue(ticket.matchesEcho(unrelated.copy(id = "client", clientId = null)))
        assertTrue(ticket.matchesEcho(unrelated.copy(clientId = "client", content = "normalized words")))
        assertTrue(ticket.matchesEcho(unrelated.copy(clientId = "steer-request")))
    }

    @Test fun lostAppendCanBeVerifiedByClientIdWhileSteerStillNeedsItsReceipt() {
        val ticket = VoiceSubmission("same words", "ours", "turn")
        val queue = VoiceQueue.read(JSONObject("""{"drafts":[
            {"scope":"other","queuedMessages":[{"id":"ignore"}]},
            {"scope":"current","queuedMessages":[{"id":"server-ticket","content":"same words","options":{"clientMessageId":"ours"}}],
            "queuedDelivery":{"status":"unknown","requestId":"steer-request"}}]}
        """), "current")
        assertTrue(queue.contains(ticket))
        assertFalse(queue.contains(VoiceSubmission("same words", "another", "turn")))
        assertFalse(queue.deliveryUnclear(ticket))
        ticket.steerId = "steer-request"
        assertTrue(queue.deliveryUnclear(ticket))
        ticket.queueId = "server-ticket"
        assertTrue(queue.copy(entries = listOf(QueueEntry("server-ticket", null))).contains(ticket))
    }

    @Test fun replayWatermarkUsesSequenceAndExecutionEvenAcrossCompactedGaps() {
        val cursor = VoiceSequence()
        fun event(run: String, seq: Int) = JSONObject().put("executionId", run).put("seq", seq)
        cursor.subscribe(event("one", 0).put("lastSeq", 10).put("isProcessing", true))
        assertEquals(FrameAge.REPLAY, cursor.accept(event("one", 1)))
        assertEquals(FrameAge.REPLAY, cursor.accept(event("one", 8)))
        assertEquals(FrameAge.DUPLICATE, cursor.accept(event("one", 8)))
        assertEquals(FrameAge.LIVE, cursor.accept(event("one", 11)))
        cursor.subscribe(event("one", 0).put("lastSeq", 19).put("isProcessing", true))
        assertEquals(FrameAge.DUPLICATE, cursor.accept(event("one", 11)))
        assertEquals(FrameAge.REPLAY, cursor.accept(event("one", 19)))
        assertEquals(FrameAge.LIVE, cursor.accept(event("two", 1)))
        assertEquals(FrameAge.DUPLICATE, cursor.accept(event("one", 20)))
    }
}
