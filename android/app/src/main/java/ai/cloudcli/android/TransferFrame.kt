package ai.cloudcli.android

import java.nio.ByteBuffer
import org.json.JSONObject

/**
 * Binary transfer frame (contract §3.6):
 *
 * ```
 * +------------------+-------------------------+--------------------+
 * | u32 BE headerLen | UTF-8 JSON header       | raw payload bytes  |
 * +------------------+-------------------------+--------------------+
 * ```
 */
object TransferFrame {

    const val CHUNK_SIZE = 262144
    private const val HEADER_LENGTH_BYTES = 4
    private const val MAX_HEADER_BYTES = 4096

    class ProtocolException(message: String) : Exception(message)

    data class Frame(val transferId: String, val offset: Int, val payload: ByteArray) {
        val length: Int get() = payload.size
    }

    fun encode(transferId: String, offset: Int, payload: ByteArray): ByteArray {
        require(offset >= 0) { "offset must be >= 0" }
        require(payload.size <= CHUNK_SIZE) { "chunk exceeds CHUNK_SIZE" }
        val header = JSONObject()
            .put("transferId", transferId)
            .put("offset", offset)
            .put("length", payload.size)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val out = ByteBuffer.allocate(HEADER_LENGTH_BYTES + header.size + payload.size)
        out.putInt(header.size)
        out.put(header)
        out.put(payload)
        return out.array()
    }

    fun decode(bytes: ByteArray): Frame {
        if (bytes.size < HEADER_LENGTH_BYTES) throw ProtocolException("frame shorter than header length")
        val buffer = ByteBuffer.wrap(bytes)
        val headerLength = buffer.int.toLong() and 0xffffffffL
        if (headerLength <= 0L || headerLength > MAX_HEADER_BYTES) {
            throw ProtocolException("invalid header length")
        }
        if (HEADER_LENGTH_BYTES + headerLength > bytes.size) throw ProtocolException("truncated header")
        val header = String(
            bytes,
            HEADER_LENGTH_BYTES,
            headerLength.toInt(),
            Charsets.UTF_8,
        )
        val json = try {
            JSONObject(header)
        } catch (e: Exception) {
            throw ProtocolException("malformed header json")
        }
        val transferId = json.optString("transferId", "")
        if (transferId.isBlank()) throw ProtocolException("missing transferId")
        val offset = json.optInt("offset", -1)
        if (offset < 0) throw ProtocolException("missing offset")
        val length = json.optInt("length", -1)
        if (length < 0) throw ProtocolException("missing length")
        if (length > CHUNK_SIZE) throw ProtocolException("chunk exceeds CHUNK_SIZE")
        val payloadStart = HEADER_LENGTH_BYTES + headerLength.toInt()
        if (payloadStart + length != bytes.size) throw ProtocolException("payload length mismatch")
        return Frame(transferId, offset, bytes.copyOfRange(payloadStart, bytes.size))
    }
}
