package ai.cloudcli.android.voice

import ai.cloudcli.android.Jwt
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceOutboxTest {

    private class FakeStore : OutboxStore {
        val values = mutableMapOf<String, String>()
        var writes = 0
        override fun read(key: String): String? = values[key]
        override fun write(key: String, value: String) {
            values[key] = value
            writes++
        }
    }

    private var ids = 0
    private fun outbox(
        store: OutboxStore = FakeStore(),
        destination: String = "site",
        clock: () -> Long = System::currentTimeMillis,
    ) = VoiceOutbox(destination, store, clock = clock, idFactory = { "id-${++ids}" })

    @Test
    fun autoSendsOneAtATimeInOrder() {
        val queue = outbox()
        queue.enqueue("one")
        queue.enqueue("two")
        val first = queue.take()!!
        assertEquals(listOf("one"), queue.entries.filter { it.id in first.entryIds }.map { it.text })
        assertEquals("one", first.content)
        assertFalse(first.merged)
        assertEquals(first, queue.take()) // the in-flight batch is never replaced
        assertTrue(queue.confirm(first))
        assertEquals("two", queue.take()!!.content)
    }

    @Test
    fun explicitRejectionMergesHeadUpToTwentyInOrder() {
        val queue = outbox()
        repeat(25) { queue.enqueue("line $it") }
        val head = queue.take()!!
        assertTrue(queue.reject(head))
        val merged = queue.take()!!
        assertTrue(merged.merged)
        assertEquals(20, merged.entryIds.size)
        assertEquals((0 until 20).joinToString(" ") { "line $it" }, merged.content)
        assertTrue(queue.confirm(merged))
        val rest = queue.take()!!
        assertEquals("line 20", rest.content)
        assertEquals(5, queue.entries.size)
    }

    @Test
    fun unknownReceiptRetriesSameBatchVerbatim() {
        val queue = outbox()
        queue.enqueue("one")
        queue.enqueue("two")
        val batch = queue.take()!!
        assertFalse(batch.unknown)
        queue.enqueue("three")
        assertTrue(queue.markUnknown(batch))
        val retry = queue.take()!!
        assertEquals(batch.id, retry.id)
        assertEquals(batch.content, retry.content)
        assertEquals(batch.entryIds, retry.entryIds)
        assertTrue(queue.confirm(retry))
        assertEquals(listOf("two", "three"), queue.entries.map { it.text })
    }

    @Test
    fun failedAttemptsCannotAdvanceDuringTheFirstFiveSeconds() {
        var now = 1_000_000L
        val queue = outbox(clock = { now })
        repeat(3) { queue.enqueue("line $it") }
        val head = queue.take()!!
        assertTrue(queue.reject(head))
        queue.hold()
        // Every enqueue/check/refresh path funnels through take(), so none may bypass the gate.
        assertNull(queue.take())
        queue.enqueue("later")
        assertNull(queue.take())
        now += VoiceOutbox.RETRY_DELAY_MS - 1
        assertNull(queue.take())
        now += 1
        val merged = queue.take()!!
        assertTrue(merged.merged)
        assertEquals(listOf("line 0", "line 1", "line 2", "later"), queue.entries.map { it.text })
        assertEquals("line 0 line 1 line 2 later", merged.content)
    }

    @Test
    fun retryWindowSurvivesRestartForTheSameDestination() {
        var now = 5_000_000L
        val store = FakeStore()
        val queue = outbox(store, clock = { now })
        repeat(3) { queue.enqueue("line $it") }
        val head = queue.take()!!
        queue.markUnknown(head)
        queue.hold()
        val restored = outbox(store, clock = { now })
        assertNull(restored.take())
        now += VoiceOutbox.RETRY_DELAY_MS
        val retry = restored.take()!!
        assertEquals(head.id, retry.id)
        assertEquals(head.content, retry.content)
    }

    @Test
    fun confirmKeepsTheAcceptedBatchAsSentAndRestoresIt() {
        val store = FakeStore()
        val queue = outbox(store)
        queue.enqueue("one")
        queue.enqueue("two")
        val batch = queue.take()!!
        assertTrue(queue.confirm(batch))
        assertEquals(listOf("one"), queue.sent.map { it.text })
        assertEquals(batch.id, queue.sent.single().id)
        assertEquals(listOf("two"), queue.entries.map { it.text })
        val restored = outbox(store)
        assertEquals(listOf("one"), restored.sent.map { it.text })
        assertEquals("two", restored.take()!!.content)
    }

    @Test
    fun sentHistoryIsNotCappedAtTwenty() {
        val queue = outbox()
        repeat(22) { index ->
            queue.enqueue("m$index")
            assertTrue(queue.confirm(queue.take()!!))
        }
        assertEquals(22, queue.sent.size)
        assertEquals("m0", queue.sent.first().text)
        assertEquals("m21", queue.sent.last().text)
    }

    @Test
    fun confirmRemovesOnlyItsBatch() {
        val queue = outbox()
        repeat(3) { queue.enqueue("line $it") }
        val batch = queue.take()!!
        queue.confirm(batch)
        assertEquals(listOf("line 1", "line 2"), queue.entries.map { it.text })
        assertEquals(1, queue.sent.size)
    }

    @Test
    fun ordinaryDeleteRemovesExactlyOneEntry() {
        val queue = outbox()
        queue.enqueue("one")
        queue.enqueue("two")
        queue.enqueue("three")
        val first = queue.entries.first().id
        assertTrue(queue.drop(first))
        assertEquals(listOf("two", "three"), queue.entries.map { it.text })
        assertFalse(queue.drop("missing"))
        assertFalse(queue.drop(first))
    }

    @Test
    fun ordinaryDeleteCannotRemoveFrozenBatchEntries() {
        val queue = outbox()
        repeat(3) { queue.enqueue("line $it") }
        val batch = queue.take()!!
        // The UI aggregates a taken batch; a single delete must not shrink the ticket.
        assertFalse(queue.drop(batch.entryIds.first()))
        assertEquals(listOf("line 0", "line 1", "line 2"), queue.entries.map { it.text })
        assertEquals(batch, queue.take())
        assertNotNull(queue.batch)
    }

    @Test
    fun batchDeleteRemovesItsWholeRangeAndNothingElse() {
        val queue = outbox()
        repeat(3) { queue.enqueue("line $it") }
        val head = queue.take()!!
        queue.reject(head)
        val merged = queue.take()!!
        queue.enqueue("line 3")
        assertFalse(queue.dropBatch("other"))
        assertTrue(queue.dropBatch(merged.id))
        assertNull(queue.batch)
        assertEquals(listOf("line 3"), queue.entries.map { it.text })
        assertEquals("line 3", queue.take()!!.content)
        assertFalse(queue.dropBatch(merged.id))
    }

    @Test
    fun sentRecordsAreKeptAndNotDeletable() {
        val queue = outbox()
        queue.enqueue("one")
        val batch = queue.take()!!
        queue.confirm(batch)
        assertEquals(1, queue.sent.size)
        assertFalse(queue.drop(batch.id))
        assertEquals(batch.id, queue.sent.single().id)
        assertTrue(queue.entries.isEmpty())
    }

    @Test
    fun reopenedCallKeepsTheClosedCallsFinalUtterance() {
        // The reopened call creates its instance before the old AudioListener flushes its tail.
        val store = FakeStore()
        val reopened = outbox(store)
        val closing = outbox(store)
        closing.enqueue("最后一句")
        reopened.enqueue("下一句")
        assertEquals(listOf("最后一句", "下一句"), reopened.entries.map { it.text })
        assertEquals(listOf("最后一句", "下一句"), outbox(store).entries.map { it.text })
        // The old write must not be replaced by the new instance's snapshot.
        assertEquals("最后一句", reopened.take()!!.content)
        assertTrue(reopened.confirm(reopened.batch!!))
        assertEquals("下一句", reopened.take()!!.content)
    }

    @Test
    fun otherInstanceWritesNotifyTheLiveDestination() {
        val store = FakeStore()
        val reopened = outbox(store)
        val closing = outbox(store)
        var notified = 0
        val listener: () -> Unit = { notified++ }
        reopened.observe(listener)
        try {
            closing.enqueue("最后一句")
            assertEquals(1, notified)
            // Another destination is isolated from this call.
            outbox(store, "other").enqueue("别的会话")
            assertEquals(1, notified)
        } finally {
            reopened.unobserve(listener)
        }
    }

    @Test
    fun restoresPendingBatchAndEntriesFromDisk() {
        val store = FakeStore()
        val queue = outbox(store)
        repeat(22) { queue.enqueue("line $it") }
        val head = queue.take()!!
        queue.reject(head)
        val merged = queue.take()!!
        val restored = outbox(store)
        val retry = restored.take()!!
        assertEquals(merged.id, retry.id)
        assertEquals(merged.content, retry.content)
        assertEquals(merged.entryIds, retry.entryIds)
        assertTrue(restored.confirm(retry))
        assertEquals("line 20", restored.take()!!.content)
    }

    @Test
    fun destinationsNeverShareEntries() {
        val store = FakeStore()
        val first = outbox(store, VoiceOutbox.destination("https://a", "user-1", "session"))
        val second = outbox(store, VoiceOutbox.destination("https://a", "user-2", "session"))
        first.enqueue("private to user one")
        assertTrue(second.entries.isEmpty())
        assertEquals(1, outbox(store, VoiceOutbox.destination("https://a", "user-1", "session")).entries.size)
    }

    @Test
    fun classifiesFailuresByServerContract() {
        assertEquals(OutboxFailure.REJECTED, outboxFailure(VoiceHttpError(400, "CONTENT_REQUIRED", "no")))
        assertEquals(OutboxFailure.REJECTED, outboxFailure(VoiceHttpError(409, "QUEUE_BUSY", "busy")))
        assertEquals(OutboxFailure.NOT_FOUND, outboxFailure(VoiceHttpError(404, null, "missing")))
        assertEquals(OutboxFailure.NOT_FOUND, outboxFailure(VoiceHttpError(401, "UNAUTHORIZED", "auth")))
        assertEquals(OutboxFailure.NOT_FOUND, outboxFailure(VoiceHttpError(403, "FORBIDDEN", "denied")))
        assertEquals(OutboxFailure.UNKNOWN, outboxFailure(VoiceHttpError(408, null, "timeout")))
        assertEquals(OutboxFailure.UNKNOWN, outboxFailure(VoiceHttpError(500, null, "down")))
        assertEquals(OutboxFailure.UNKNOWN, outboxFailure(IOException("offline")))
    }

    @Test
    fun jwtExposesAccountUserId() {
        val encoder = java.util.Base64.getUrlEncoder().withoutPadding()
        val header = encoder.encodeToString("""{"alg":"HS256"}""".toByteArray())
        val payload = encoder.encodeToString("""{"userId":"user-42"}""".toByteArray())
        assertEquals("user-42", Jwt.userId("$header.$payload.signature"))
        assertNull(Jwt.userId("a.b"))
        assertNotNull(Jwt.userId("$header.${encoder.encodeToString("""{"userId":7}""".toByteArray())}.x"))
    }
}
