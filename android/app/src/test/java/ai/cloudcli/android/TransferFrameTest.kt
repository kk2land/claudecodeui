package ai.cloudcli.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class TransferFrameTest {

    @Test
    fun roundTripsChunk() {
        val payload = ByteArray(1024) { (it % 251).toByte() }
        val frame = TransferFrame.encode("t-1", 262144, payload)
        val decoded = TransferFrame.decode(frame)
        assertEquals("t-1", decoded.transferId)
        assertEquals(262144, decoded.offset)
        assertEquals(payload.size, decoded.length)
        assertArrayEquals(payload, decoded.payload)
    }

    @Test
    fun headerLengthIsBigEndian() {
        val frame = TransferFrame.encode("t", 0, ByteArray(1))
        assertEquals(
            frame.size - 4 - 1,
            ((frame[0].toInt() and 0xff) shl 24) or
                ((frame[1].toInt() and 0xff) shl 16) or
                ((frame[2].toInt() and 0xff) shl 8) or
                (frame[3].toInt() and 0xff),
        )
    }

    @Test
    fun acceptsLargestChunk() {
        val payload = ByteArray(TransferFrame.CHUNK_SIZE)
        assertEquals(TransferFrame.CHUNK_SIZE, TransferFrame.decode(TransferFrame.encode("t", 0, payload)).length)
    }

    @Test
    fun acceptsEmptyFinalPayload() {
        val decoded = TransferFrame.decode(TransferFrame.encode("t", 0, ByteArray(0)))
        assertEquals(0, decoded.length)
    }

    @Test
    fun rejectsChunkOverLimit() {
        assertThrows(IllegalArgumentException::class.java) {
            TransferFrame.encode("t", 0, ByteArray(TransferFrame.CHUNK_SIZE + 1))
        }
    }

    @Test
    fun rejectsTruncatedFrame() {
        val frame = TransferFrame.encode("t", 0, ByteArray(10))
        assertThrows(TransferFrame.ProtocolException::class.java) {
            TransferFrame.decode(frame.copyOfRange(0, frame.size - 1))
        }
        assertThrows(TransferFrame.ProtocolException::class.java) {
            TransferFrame.decode(ByteArray(2))
        }
    }

    @Test
    fun rejectsLengthMismatch() {
        val header = """{"transferId":"t","offset":0,"length":99}""".toByteArray()
        val frame = ByteArray(4 + header.size + 1)
        frame[0] = ((header.size shr 24) and 0xff).toByte()
        frame[1] = ((header.size shr 16) and 0xff).toByte()
        frame[2] = ((header.size shr 8) and 0xff).toByte()
        frame[3] = (header.size and 0xff).toByte()
        header.copyInto(frame, 4)
        assertThrows(TransferFrame.ProtocolException::class.java) { TransferFrame.decode(frame) }
    }

    @Test
    fun rejectsMissingFieldsAndOversizedHeaders() {
        val bad = """{"offset":0,"length":1}""".toByteArray()
        val frame = ByteArray(4 + bad.size + 1)
        frame[3] = bad.size.toByte()
        bad.copyInto(frame, 4)
        assertThrows(TransferFrame.ProtocolException::class.java) { TransferFrame.decode(frame) }

        val oversized = ByteArray(64) { 0xff.toByte() }
        oversized[0] = 0
        oversized[1] = 0
        oversized[2] = 0
        oversized[3] = 32
        assertThrows(TransferFrame.ProtocolException::class.java) { TransferFrame.decode(oversized) }
    }
}
