package ai.cloudcli.android

import android.net.Uri
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import org.json.JSONObject

/**
 * Chunked binary transfers (contract §3.6). Chunks travel as ArrayBuffer frames in both
 * directions; no base64 and no JSON byte arrays.
 */
class Transfers(
    private val sendBinary: (ByteArray) -> Unit,
    private val sendJson: (JSONObject) -> Unit,
    private val deleteDocument: (Uri) -> Unit,
) {

    sealed interface FinishResult {
        data class Ok(val saved: Boolean) : FinishResult
        data class Failure(val code: String) : FinishResult
    }

    private class Outbound(
        val id: String,
        val name: String,
        val mimeType: String,
        val size: Long,
        val open: () -> InputStream,
    ) {
        var nextOffset: Long = 0
        var inFlight = false
        var completed = false
        var failed = false
        var zeroChunkSent = false
        var input: InputStream? = null
    }

    private class Inbound(
        val id: String,
        val name: String,
        val mimeType: String,
        val size: Long,
        val target: Uri,
        val open: () -> OutputStream,
    ) {
        var received: Long = 0
        var output: OutputStream? = null
        var closed = false
    }

    private val lock = Any()
    private val outbound = HashMap<String, Outbound>()
    private val inbound = HashMap<String, Inbound>()

    fun beginOutbound(name: String, mimeType: String, size: Long, open: () -> InputStream): String {
        val id = java.util.UUID.randomUUID().toString()
        synchronized(lock) {
            outbound[id] = Outbound(id, name, mimeType, size, open)
        }
        return id
    }

    /** Starts streaming chunk 0; call only after the response carrying the transferId was posted. */
    fun start(transferId: String) {
        sendNextChunk(transferId)
    }

    fun beginInbound(name: String, mimeType: String, size: Long, target: Uri, open: () -> OutputStream): String {
        val id = java.util.UUID.randomUUID().toString()
        synchronized(lock) {
            inbound[id] = Inbound(id, name, mimeType, size, target, open)
        }
        return id
    }

    fun onAck(transferId: String, nextOffset: Int) {
        val transfer = synchronized(lock) { outbound[transferId] } ?: return
        if (transfer.size > Int.MAX_VALUE) {
            failOutbound(transfer, "file too large")
            return
        }
        if (nextOffset.toLong() >= transfer.size) {
            transfer.completed = true
            closeQuietly(transfer)
            return
        }
        if (nextOffset.toLong() != transfer.nextOffset) {
            failOutbound(transfer, "unexpected ack offset")
            return
        }
        transfer.inFlight = false
        sendNextChunk(transferId)
    }

    fun onBinary(bytes: ByteArray) {
        val frame = try {
            TransferFrame.decode(bytes)
        } catch (_: TransferFrame.ProtocolException) {
            return
        }
        val transfer = synchronized(lock) { inbound[frame.transferId] }
        if (transfer == null) {
            sendAbort(frame.transferId, BridgeErrorCode.TRANSFER_FAILED)
            return
        }
        AppRuntime.io.execute {
            if (frame.offset.toLong() != transfer.received ||
                transfer.received + frame.length > transfer.size
            ) {
                failInbound(transfer, "unexpected chunk offset")
                return@execute
            }
            try {
                val output = transfer.output ?: transfer.open().also { transfer.output = it }
                output.write(frame.payload)
                output.flush()
            } catch (e: IOException) {
                failInbound(transfer, "write failed")
                return@execute
            }
            transfer.received += frame.length
            sendJson(
                JSONObject()
                    .put("v", 1)
                    .put("type", "transfer.ack")
                    .put("transferId", transfer.id)
                    .put("nextOffset", transfer.received),
            )
        }
    }

    fun finish(transferId: String): FinishResult {
        val outboundTransfer = synchronized(lock) { outbound[transferId] }
        if (outboundTransfer != null) {
            closeQuietly(outboundTransfer)
            synchronized(lock) { outbound.remove(transferId) }
            return FinishResult.Ok(saved = false)
        }
        val inboundTransfer = synchronized(lock) { inbound[transferId] }
            ?: return FinishResult.Failure(BridgeErrorCode.TRANSFER_FAILED)
        synchronized(lock) { inbound.remove(transferId) }
        val sizeMatches = inboundTransfer.received == inboundTransfer.size
        inboundTransfer.closed = true
        try {
            inboundTransfer.output?.close()
        } catch (_: IOException) {
            // ignored; reported below when the byte count does not match
        }
        if (!sizeMatches) {
            deleteDocument(inboundTransfer.target)
            return FinishResult.Failure(BridgeErrorCode.TRANSFER_FAILED)
        }
        return FinishResult.Ok(saved = true)
    }

    fun abort(transferId: String) {
        val outboundTransfer = synchronized(lock) { outbound.remove(transferId) }
        if (outboundTransfer != null) closeQuietly(outboundTransfer)
        val inboundTransfer = synchronized(lock) { inbound.remove(transferId) }
        if (inboundTransfer != null) {
            try {
                inboundTransfer.output?.close()
            } catch (_: IOException) {
                // ignore
            }
            deleteDocument(inboundTransfer.target)
        }
    }

    fun destroy() {
        synchronized(lock) {
            outbound.values.forEach { closeQuietly(it) }
            outbound.clear()
            inbound.values.forEach { transfer ->
                try {
                    transfer.output?.close()
                } catch (_: IOException) {
                    // ignore
                }
            }
            inbound.clear()
        }
    }

    private fun sendNextChunk(transferId: String) {
        val transfer = synchronized(lock) { outbound[transferId] } ?: return
        if (transfer.inFlight || transfer.completed || transfer.failed) return
        if (transfer.size == 0L) {
            // Zero-byte file: one empty chunk is what lets the web wrapper finish the transfer.
            if (transfer.zeroChunkSent) return
            transfer.zeroChunkSent = true
            transfer.inFlight = true
            sendBinary(TransferFrame.encode(transfer.id, 0, ByteArray(0)))
            return
        }
        if (transfer.nextOffset >= transfer.size) {
            transfer.completed = true
            return
        }
        transfer.inFlight = true
        AppRuntime.io.execute {
            val offset = transfer.nextOffset
            val length = minOf(TransferFrame.CHUNK_SIZE.toLong(), transfer.size - offset).toInt()
            val payload = ByteArray(length)
            try {
                val input = transfer.input ?: transfer.open().also { transfer.input = it }
                var read = 0
                while (read < length) {
                    val count = input.read(payload, read, length - read)
                    if (count <= 0) break
                    read += count
                }
                if (read != length) {
                    failOutbound(transfer, "short read")
                    return@execute
                }
            } catch (e: IOException) {
                failOutbound(transfer, "read failed")
                return@execute
            }
            transfer.nextOffset = offset + length
            sendBinary(TransferFrame.encode(transfer.id, offset.toInt(), payload))
        }
    }

    private fun failOutbound(transfer: Outbound, reason: String) {
        transfer.failed = true
        closeQuietly(transfer)
        synchronized(lock) { outbound.remove(transfer.id) }
        sendAbort(transfer.id, reason)
    }

    private fun failInbound(transfer: Inbound, reason: String) {
        synchronized(lock) { inbound.remove(transfer.id) }
        try {
            transfer.output?.close()
        } catch (_: IOException) {
            // ignore
        }
        transfer.closed = true
        deleteDocument(transfer.target)
        sendAbort(transfer.id, reason)
    }

    private fun sendAbort(transferId: String, reason: String) {
        sendJson(
            JSONObject()
                .put("v", 1)
                .put("type", "transfer.abort")
                .put("transferId", transferId)
                .put("reason", reason),
        )
    }

    private fun closeQuietly(transfer: Outbound) {
        try {
            transfer.input?.close()
        } catch (_: IOException) {
            // ignore
        }
        transfer.input = null
    }
}
