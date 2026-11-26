package ai.cloudcli.android.voice

import ai.cloudcli.android.R
import ai.cloudcli.android.ReconnectPolicy
import android.content.res.Resources
import android.os.Handler
import android.os.Looper
import java.util.UUID
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

internal enum class VoiceConnection { CONNECTING, CONNECTED, RECONNECTING, SIGN_IN, UNSUPPORTED }

/** The session, pending submission and audio decisions are all owned by the main thread. */
internal class VoiceSession(
    private val api: VoiceApi,
    val choice: VoiceChoice,
    private val strings: Resources,
    private val changed: () -> Unit,
    private val unsupported: () -> Unit,
    private val returnDraft: (String) -> Unit,
    private val play: (String) -> Unit,
    private val stopPlayback: () -> Unit,
    private val outbox: VoiceOutbox? = null,
    private val requestPermissions: (((String?) -> Unit) -> Unit)? = null,
    restored: VoiceSubmission? = null,
) {
    private enum class Stage { PREPARING, SENDING, APPENDING, STEERING, UNKNOWN }
    private data class Pending(val message: VoiceSubmission, var stage: Stage, var sentDirectly: Boolean = false)

    private val main = Handler(Looper.getMainLooper())
    private val reconnect = ReconnectPolicy()
    private val sequence = VoiceSequence()
    private val transcript = VoiceTranscript()
    private val speech = ReplySpeech()
    private val permissions = mutableSetOf<String>()
    private val id = choice.id
    private var active = false
    private var closed = false
    private var socket: WebSocket? = null
    private var stateRequest: Pair<String, (VoiceState?) -> Unit>? = null
    private var state: VoiceState? = null
    private var processing = false
    private var queue: VoiceQueue? = null
    private var queueRead = 0
    private var historyRead = 0
    private var pending: Pending? = restored?.let { Pending(it, Stage.UNKNOWN) }
    private var speechTicket: VoiceSubmission? = null
    var opened = restored != null
        private set
    private var historyMessage: String? = null
    private var queueMessage: String? = null
    private var deliveryMessage: String? = restored?.let { strings.getString(R.string.voice_delivery_checking) }
    private var draftIssue: String? = null
    private var outboxStatus: String? = null
    private var outboxInFlight: OutboxBatch? = null
    private var outboxRetryAt = 0L
    private val outboxRetry = Runnable {
        outboxRetryAt = 0L
        if (closed || !active || !connected) return@Runnable
        val outbox = outbox ?: return@Runnable
        if (outbox.count == 0) return@Runnable
        // A held or blocked snapshot must be re-read, not replayed from the cached state.
        refreshOutboxSnapshot()
    }
    private val outboxChanged: () -> Unit = {
        main.post {
            if (!closed) {
                changed()
                drainOutbox()
            }
        }
    }

    init {
        outbox?.observe(outboxChanged)
    }

    var connection = VoiceConnection.CONNECTING
        private set
    private val connected: Boolean get() = connection == VoiceConnection.CONNECTED
    private val waitingForWeb: Boolean get() = permissions.isNotEmpty() || state?.questionPending == true
    val rows: List<VoiceRow> get() = transcript.rows()
    val pendingText: String? get() = pending?.message?.text
    val unconfirmed: VoiceSubmission? get() = pending?.takeUnless { it.stage == Stage.PREPARING }?.message
    val unknown: Boolean get() = pending?.stage == Stage.UNKNOWN
    val queueUnavailable: Boolean get() = connected && queueMessage != null
    val generating: Boolean get() = processing || state?.phase == "starting" ||
        state?.phase == "running" || state?.goalActive == true
    val queuedCount: Int get() = queue?.entries?.size ?: 0
    val outboxEntries: List<OutboxEntry> get() = outbox?.entries.orEmpty()
    val outboxSent: List<OutboxEntry> get() = outbox?.sent.orEmpty()
    val outboxBatch: OutboxBatch? get() = outboxInFlight ?: outbox?.batch
    val outboxSending: Boolean get() = outboxInFlight != null
    val outboxCount: Int get() = outbox?.count ?: 0
    val outboxRetrying: Boolean get() = outbox?.retrying == true
    val outboxNote: String? get() = outboxStatus
    val outboxWaiting: Boolean get() = outbox?.count != 0
    val note: String? get() = deliveryMessage ?: historyMessage ?: queueMessage ?: state?.error
    // This labels Send while the queue snapshot may be out of date.
    val route: SendRoute? get() = sendRoute(state, processing, queueEmpty = true, enqueue = false)
    val canQueue: Boolean get() = connected && pending == null && state?.modelRequired != true
    val canSend: Boolean get() = canQueue && !waitingForWeb
    val canAutoSubmit: Boolean get() = canSend && route != null && queue?.empty == true &&
        state?.queueHeld != true && queue?.status != "held"
    val webReason: Int? get() = when {
        !connected -> null
        waitingForWeb -> R.string.voice_web_input
        state?.modelRequired == true -> R.string.voice_web_model
        queue?.status == "unknown" -> R.string.voice_web_delivery
        queue?.status == "steering" -> R.string.voice_delivery_queue_busy
        state?.queueHeld == true || queue?.status == "held" -> R.string.voice_web_queue
        state?.error != null -> R.string.voice_web_error
        else -> null
    }
    val draftNotice: String? get() = when {
        !connected -> null
        unknown -> strings.getString(R.string.voice_delivery_verify_web)
        pending != null -> deliveryMessage
        waitingForWeb -> strings.getString(R.string.voice_hint_web_input)
        queueUnavailable -> strings.getString(R.string.voice_hint_queue_retry)
        draftIssue != null -> draftIssue
        webReason != null -> null
        queuedCount > 0 -> strings.getString(R.string.voice_delivery_queue_occupied)
        route == null -> strings.getString(R.string.voice_delivery_busy)
        else -> null
    }

    private val retry = Runnable { connect() }
    private val handshakeDeadline = Runnable { disconnect(VoiceConnection.RECONNECTING) }
    private val deliveryDeadline = Runnable {
        if (pending?.stage == Stage.PREPARING) settle(strings.getString(R.string.voice_delivery_settings_timeout), restore = true)
        else uncertain(strings.getString(R.string.voice_delivery_checking), refresh = true)
    }

    fun start() {
        active = true
        connect()
    }

    fun pause() {
        active = false
        disconnect(VoiceConnection.RECONNECTING)
    }

    fun close() {
        closed = true
        outbox?.unobserve(outboxChanged)
        pause()
    }

    fun silence() {
        speechTicket = null
        speech.close()
    }

    /** The audio engine has already cancelled playback. Fence off the unfinished replies. */
    fun bargeIn() {
        speechTicket = null
        speech.interrupt(transcript.streamingReplies())
    }

    fun check() {
        val ws = socket
        if (ws == null) connect()
        else if (connected && stateRequest == null && pending?.stage != Stage.PREPARING) subscribe(ws)
        drainOutbox()
    }

    /** An ordinary delete removes one entry; a taken request is never cancelled silently. */
    fun dropOutbox(entryId: String) {
        val queue = outbox ?: return
        if (!queue.drop(entryId)) return
        outboxStatus = strings.getString(R.string.voice_outbox_removed)
        changed()
        drainOutbox()
    }

    /** Explicit whole-batch delete is only possible while no request is in flight. */
    fun dropOutboxBatch(batchId: String) {
        val queue = outbox ?: return
        if (outboxInFlight != null) return
        if (!queue.dropBatch(batchId)) return
        outboxStatus = strings.getString(R.string.voice_outbox_removed)
        changed()
        drainOutbox()
    }

    private fun connect() {
        if (!active || closed || socket != null) return
        main.removeCallbacks(retry)
        connection = VoiceConnection.CONNECTING
        socket = api.socket(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onSocket(webSocket) {
                subscribe(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) = onSocket(webSocket) {
                val frame = runCatching { JSONObject(text) }.getOrNull() ?: return@onSocket
                receive(frame)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = onSocket(webSocket) {
                disconnect(VoiceConnection.RECONNECTING)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onSocket(webSocket) {
                val auth = response?.code == 401 || response?.code == 403
                disconnect(if (auth) VoiceConnection.SIGN_IN else VoiceConnection.RECONNECTING)
            }
        })
        if (socket == null) {
            connection = VoiceConnection.SIGN_IN
        } else {
            main.postDelayed(handshakeDeadline, 20_000)
        }
        changed()
    }

    private fun onSocket(ws: WebSocket, action: () -> Unit) {
        main.post { if (socket === ws && !closed) action() }
    }

    private fun disconnect(next: VoiceConnection) {
        main.removeCallbacks(this.retry)
        main.removeCallbacks(handshakeDeadline)
        socket?.cancel()
        socket = null
        stateRequest = null
        connection = next
        queue = null
        permissions.clear()
        speech.close()
        stopPlayback()
        when (pending?.stage) {
            Stage.PREPARING -> settle(strings.getString(R.string.voice_delivery_connection_lost), restore = true)
            Stage.SENDING, Stage.STEERING -> uncertain(strings.getString(R.string.voice_delivery_reconnect))
            else -> Unit // A POST may still return its queue ticket, even after the socket closes.
        }
        if (active && next == VoiceConnection.RECONNECTING) main.postDelayed(retry, reconnect.onAttemptFailed())
        if (!closed) changed()
    }

    private fun control(request: String, action: JSONObject): JSONObject = JSONObject().put("type", "chat.control")
        .put("sessionId", id).put("requestId", request).put("control", action)

    private fun subscribe(ws: WebSocket) {
        // State attaches the socket even while idle, so the next detached turn is visible.
        readState(ws) { native ->
            if (native?.runtime != "app-server") unavailable()
            else {
                state = native
                val target = JSONObject().put("sessionId", id).put("executionId", sequence.executionId).put("lastSeq", sequence.lastSeq)
                if (!ws.send(JSONObject().put("type", "chat.subscribe").put("sessions", JSONArray().put(target)).toString())) {
                    disconnect(VoiceConnection.RECONNECTING)
                }
            }
        }
    }

    private fun readState(ws: WebSocket, receive: (VoiceState?) -> Unit) {
        val request = UUID.randomUUID().toString()
        stateRequest = request to receive
        if (!ws.send(control(request, JSONObject().put("action", "state")).toString())) {
            disconnect(VoiceConnection.RECONNECTING)
        }
    }

    private fun receive(frame: JSONObject) {
        if (frame.string("sessionId") != id) return
        val kind = frame.string("kind")
        val native = frame.optJSONObject("codexState")?.let(VoiceState::read)
        val request = stateRequest
        if (kind == "control_result" && request != null && frame.string("requestId") == request.first) {
            stateRequest = null
            request.second(native.takeIf { frame.optBoolean("ok") })
            return
        }
        if (kind == "chat_subscribed") {
            if (native?.runtime != "app-server") {
                unavailable()
                return
            }
            state = native
            sequence.subscribe(frame)
            processing = frame.optBoolean("isProcessing")
            permissions.clear()
            permissions.addAll(frame.optJSONArray("pendingPermissions").objects().mapNotNull { it.string("requestId") })
            connection = VoiceConnection.CONNECTED
            opened = true
            reconnect.onRegistered()
            main.removeCallbacks(handshakeDeadline)
            refresh()
            drainOutbox()
            changed()
            return
        }

        val previousRun = sequence.executionId
        val age = sequence.accept(frame)
        if (age == FrameAge.DUPLICATE) return
        if (sequence.executionId != previousRun) speech.close()
        val live = connected && age == FrameAge.LIVE
        if (age != FrameAge.REPLAY && native != null) {
            if (connected && native.runtime != "app-server") {
                unavailable()
                return
            }
            state = native
            if (native.phase in setOf("starting", "running")) processing = true
        }

        transcript.accept(frame)?.let { change ->
            if (change.row.role == "user") observeUser(change, live || age == FrameAge.REPLAY)
            else speech.accept(change, live).forEach(play)
        }
        when (kind) {
            "complete" -> if (live) {
                processing = false
                if (speech.open) silence()
                if (pending?.stage == Stage.SENDING) uncertain(strings.getString(R.string.voice_delivery_checking))
                refresh()
            }
            "permission_request" -> if (live) frame.string("requestId")?.let(permissions::add)
            "permission_resolved" -> if (live) frame.string("requestId")?.let(permissions::remove)
            "history_truncated" -> if (live) frame.string("anchorId")?.let {
                transcript.truncate(it)
                silence()
                stopPlayback()
                refresh()
            }
            "chat_queued" -> pending?.takeIf { it.message.clientId == frame.string("clientMessageId") }?.let {
                it.message.queueId = frame.string("messageId")
                settle(strings.getString(R.string.voice_delivery_queued))
                refreshQueue()
            }
            "control_result" -> steerResult(frame)
            "protocol_error" -> protocolError(frame)
        }
        if (connected) {
            changed()
            // A real frame may have lifted a hold without producing a new turn or completion.
            drainOutbox()
        }
    }

    private fun unavailable() {
        if (!opened) unsupported()
        else disconnect(VoiceConnection.UNSUPPORTED)
    }

    private fun observeUser(change: TranscriptChange, sequenced: Boolean) {
        val row = change.row
        if (pending?.message?.matchesEcho(row) == true) {
            settle(strings.getString(R.string.voice_delivery_sent))
            refreshQueue()
        }
        val ticket = speechTicket
        val queuedEcho = row.role == "user" && row.clientId?.let { id ->
            outbox?.sent?.any { it.id == id } == true || outbox?.batch?.id == id
        } == true
        if (ticket?.matchesEcho(row) == true || queuedEcho) {
            if (sequenced && !speech.open && row.executionId != null) speech.open(row.executionId, row.turnId)
        } else if (speech.open && change.previous == null) {
            silence()
            stopPlayback()
        }
    }

    private fun refresh() {
        val ws = socket?.takeIf { connected } ?: return
        val request = ++historyRead
        api.history(id) { result ->
            if (socket !== ws || historyRead != request) return@history
            val rows = result.getOrNull()
            historyMessage = result.exceptionOrNull()?.let { strings.getString(R.string.voice_history_unavailable, it.message.orEmpty()) }
            if (rows != null) {
                transcript.mergeHistory(rows)
                if (pending?.message?.let { ticket -> rows.any(ticket::matchesEcho) } == true) {
                    settle(strings.getString(R.string.voice_delivery_history))
                }
                val ticket = speechTicket
                val lastUser = rows.lastOrNull { it.role == "user" }
                val matched = lastUser != null && (ticket?.matchesEcho(lastUser) == true ||
                    lastUser.clientId?.let { id ->
                        outbox?.sent?.any { it.id == id } == true || outbox?.batch?.id == id
                    } == true)
                val echoTurn = lastUser?.turnId ?: ticket?.expectedTurnId?.takeIf { lastUser?.clientId == ticket.steerId && ticket.steerId != null }
                val run = sequence.executionId
                if (!speech.open && lastUser != null && matched &&
                    echoTurn != null && echoTurn == state?.turnId && state?.phase == "running" && run != null) {
                    speech.open(run, echoTurn)
                }
            }
            changed()
        }
        refreshQueue()
    }

    private fun refreshQueue() {
        val ws = socket?.takeIf { connected } ?: return
        if (pending?.stage == Stage.PREPARING) return // Submission reads the queue before choosing a route.
        val request = ++queueRead
        api.queue(id) { result ->
            if (socket !== ws || queueRead != request) return@queue
            queue = result.getOrNull()
            pending?.takeIf { it.stage == Stage.UNKNOWN }?.let { staged ->
                val snapshot = queue
                if (snapshot?.contains(staged.message) == true && !snapshot.deliveryUnclear(staged.message)) {
                    val held = snapshot.status == "held" || state?.queueHeld == true
                    settle(strings.getString(if (held) R.string.voice_delivery_held else R.string.voice_delivery_verified_queue))
                }
            }
            if (unknown) deliveryMessage = strings.getString(R.string.voice_delivery_verify_web)
            queueMessage = result.exceptionOrNull()?.let { strings.getString(R.string.voice_queue_unavailable, it.message.orEmpty()) }
            changed()
            drainOutbox()
        }
    }

    /** Captured speech enters the local queue only; the queue decides when the server may see it. */
    fun enqueueVoice(text: String): Boolean {
        val outbox = outbox ?: return false
        if (outbox.enqueue(text) == null) return false
        outboxStatus = strings.getString(R.string.voice_outbox_pending)
        if (closed) return true // The final utterance still belongs to this destination; persist it.
        changed()
        drainOutbox()
        return true
    }

    fun submit(text: String, enqueue: Boolean, automatic: Boolean, permissions: ((String?) -> Unit) -> Unit): Boolean {
        if (outbox?.count != 0) return false
        val allowed = when {
            enqueue -> canQueue
            automatic -> canAutoSubmit
            else -> canSend
        }
        if (!allowed) return false
        val ws = socket?.takeIf { connected } ?: return false
        val target = state?.turnId.takeIf { !enqueue && route == SendRoute.STEER }
        val message = VoiceSubmission(text, UUID.randomUUID().toString(), target)
        val staged = Pending(message, Stage.PREPARING)
        pending = staged
        silence()
        stopPlayback()
        speechTicket = message
        deliveryMessage = strings.getString(R.string.voice_delivery_preparing)
        main.postDelayed(deliveryDeadline, 40_000)
        changed()

        permissions permission@{ mode ->
            if (pending !== staged || socket !== ws) return@permission
            if (mode == null) {
                settle(strings.getString(R.string.voice_delivery_permission_settings), restore = true)
                return@permission
            }
            api.model(id) { result ->
                if (pending !== staged || socket !== ws) return@model
                val model = result.getOrElse {
                    settle(strings.getString(R.string.voice_model_unavailable, it.message.orEmpty()), restore = true)
                    return@model
                }
                readState(ws) read@{ native ->
                    if (pending !== staged || socket !== ws) return@read
                    if (native == null) {
                        settle(strings.getString(R.string.voice_delivery_state_unavailable), restore = true)
                        return@read
                    }
                    if (native.runtime != "app-server") {
                        unavailable()
                        return@read
                    }
                    state = native
                    val options = JSONObject().put("clientMessageId", message.clientId).put("permissionMode", mode)
                        .put("model", native.model ?: model.string("model")).put("effort", model.string("effort"))
                    checkQueueBeforeSend(staged, ws, options, enqueue, automatic)
                }
            }
        }
        return true
    }

    private fun checkQueueBeforeSend(staged: Pending, ws: WebSocket, options: JSONObject, enqueue: Boolean, automatic: Boolean) {
        ++queueRead
        api.queue(id) { result ->
            if (pending !== staged || socket !== ws) return@queue
            queue = result.getOrNull()
            queueMessage = result.exceptionOrNull()?.let { strings.getString(R.string.voice_queue_unavailable, it.message.orEmpty()) }
            val snapshot = queue ?: run {
                settle(strings.getString(R.string.voice_hint_queue_retry), restore = true)
                return@queue
            }
            val target = staged.message.expectedTurnId
            val native = state
            val route = sendRoute(native, processing, snapshot.empty, enqueue)
            val reason = when {
                !enqueue && waitingForWeb -> R.string.voice_hint_web_input
                native?.modelRequired == true -> R.string.voice_web_model
                snapshot.status == "unknown" -> R.string.voice_web_delivery
                snapshot.status == "steering" -> R.string.voice_delivery_queue_busy
                snapshot.status == "held" -> R.string.voice_web_queue
                !enqueue && !snapshot.empty -> R.string.voice_delivery_queue_occupied
                (automatic || target != null) && native?.queueHeld == true -> R.string.voice_web_queue
                // A manual send may start the next turn. A steer stays tied to the selected turn.
                route == SendRoute.STEER && native?.turnId != target ||
                    route == SendRoute.DIRECT && automatic && target != null -> R.string.voice_delivery_turn_changed
                else -> null
            }
            if (reason != null) {
                settle(strings.getString(reason), restore = true)
                return@queue
            }
            when (route) {
                SendRoute.DIRECT -> send(staged, ws, options)
                SendRoute.STEER, SendRoute.QUEUE -> append(staged, ws, options)
                null -> settle(strings.getString(R.string.voice_delivery_busy), restore = true)
            }
        }
    }

    private fun send(staged: Pending, ws: WebSocket, options: JSONObject) {
        val frame = JSONObject().put("type", "chat.send").put("sessionId", id)
            .put("content", staged.message.text).put("options", options)
        if (ws.send(frame.toString())) {
            staged.sentDirectly = true
            awaitEcho(staged, Stage.SENDING)
        } else settle(strings.getString(R.string.voice_delivery_connection_lost), restore = true)
    }

    private fun append(staged: Pending, ws: WebSocket, options: JSONObject) {
        val message = staged.message
        val target = message.expectedTurnId
        staged.stage = Stage.APPENDING
        main.removeCallbacks(deliveryDeadline)
        deliveryMessage = strings.getString(R.string.voice_delivery_saving_queue)
        changed()
        api.append(id, message.text, options, ifEmpty = target != null) { result ->
            if (closed || pending !== staged) return@append
            val receipt = result.getOrElse {
                if (it is VoiceHttpError && it.status in 400..499 && it.status != 408) {
                    val error = when (it.code) {
                        "QUEUE_NOT_EMPTY" -> strings.getString(R.string.voice_delivery_queue_occupied)
                        "QUEUE_BUSY" -> strings.getString(R.string.voice_delivery_queue_busy)
                        else -> it.message.orEmpty()
                    }
                    settle(error, restore = true)
                    refreshQueue()
                } else uncertain(strings.getString(R.string.voice_delivery_checking), refresh = connected)
                return@append
            }
            message.queueId = receipt.id
            if (target == null || receipt.appended || socket !== ws || waitingForWeb || state?.queueHeld == true ||
                state?.phase != "running" || state?.turnId != target) {
                settle(strings.getString(if (state?.queueHeld == true) R.string.voice_delivery_held else R.string.voice_delivery_queued))
                refreshQueue()
                return@append
            }
            val request = UUID.randomUUID().toString()
            message.steerId = request
            val action = JSONObject().put("action", "steer").put("messageId", receipt.id)
                .put("expectedTurnId", target).put("queueIfTurnEnded", true)
            if (ws.send(control(request, action).toString())) awaitEcho(staged, Stage.STEERING)
            else {
                settle(strings.getString(R.string.voice_delivery_queued))
                refreshQueue()
            }
        }
    }

    private fun awaitEcho(staged: Pending, stage: Stage) {
        staged.stage = stage
        deliveryMessage = strings.getString(if (stage == Stage.SENDING) R.string.voice_delivery_awaiting else R.string.voice_delivery_steering)
        main.removeCallbacks(deliveryDeadline)
        main.postDelayed(deliveryDeadline, 40_000)
        changed()
    }

    private fun steerResult(frame: JSONObject) {
        val staged = pending?.takeIf { it.message.steerId != null && it.message.steerId == frame.string("requestId") } ?: return
        val delivery = frame.string("delivery")
        when {
            frame.optBoolean("ok") && delivery == "accepted" -> {
                // Acceptance is a receipt. Only its separate echoed user row opens speech.
                settle(strings.getString(R.string.voice_delivery_accepted))
                refreshQueue()
            }
            delivery == "rejected" && frame.string("code") == "STALE_TURN" ->
                uncertain(strings.getString(R.string.voice_delivery_checking), refresh = true)
            delivery == "rejected" -> {
                settle(listOfNotNull(strings.getString(R.string.voice_delivery_held), frame.string("error")).joinToString(" "))
                refreshQueue()
            }
            else -> uncertain(strings.getString(R.string.voice_delivery_checking), refresh = staged.stage != Stage.UNKNOWN)
        }
    }

    private fun protocolError(frame: JSONObject) {
        val staged = pending?.takeIf { it.sentDirectly && (it.stage == Stage.SENDING || it.stage == Stage.UNKNOWN) } ?: return
        val client = frame.string("clientMessageId")
        if (client != null && client != staged.message.clientId) return
        val error = when (frame.string("code")) {
            "MESSAGE_ALREADY_SENT" -> {
                uncertain(strings.getString(R.string.voice_delivery_checking), refresh = true)
                return
            }
            "RUN_IN_PROGRESS" -> strings.getString(R.string.voice_delivery_busy)
            "CODEX_MODEL_REQUIRED" -> strings.getString(R.string.voice_web_model)
            "QUEUE_BUSY" -> strings.getString(R.string.voice_delivery_queue_busy)
            "SESSION_NOT_FOUND", "UNSUPPORTED_PROVIDER", "QUEUE_REJECTED", "QUEUE_LIMIT_REACHED", "CONTENT_REQUIRED",
            "INVALID_TODO_IDS" -> frame.string("error") ?: strings.getString(R.string.voice_delivery_refused)
            else -> return
        }
        settle(error, restore = true)
        refreshQueue()
    }

    private fun settle(message: String, restore: Boolean = false) {
        val staged = pending ?: return
        main.removeCallbacks(deliveryDeadline)
        pending = null
        deliveryMessage = message
        draftIssue = message.takeIf { restore }
        if (restore) {
            if (speechTicket === staged.message) silence()
            returnDraft(staged.message.text)
        }
        if (!closed) changed()
        drainOutbox()
    }

    private fun uncertain(message: String, refresh: Boolean = false) {
        main.removeCallbacks(deliveryDeadline)
        pending?.stage = Stage.UNKNOWN
        deliveryMessage = message
        if (refresh) refresh()
        if (!closed) changed()
    }

    /**
     * One persisted batch at a time. The local head is only replaced after confirmation (200)
     * or an explicit rejection; unknown receipts keep the same id and content for a verbatim retry.
     * The persisted 5 s window gates every caller, including enqueue, check and refresh.
     */
    private fun drainOutbox() {
        val outbox = outbox ?: return
        if (closed || !active || !connected || pending != null || waitingForWeb || outboxInFlight != null) return
        val native = state ?: return
        if (native.modelRequired == true || native.queueHeld == true) {
            scheduleOutboxRetry()
            return
        }
        if (this.queue == null) {
            // Missing snapshot: keep re-reading until the server supplies one.
            scheduleOutboxRetry()
            return
        }
        if (this.queue?.status?.let { it in BLOCKING_QUEUE_STATUS } == true) {
            scheduleOutboxRetry()
            return
        }
        val wait = outbox.retryRemaining()
        if (wait > 0) {
            scheduleOutboxRetry(wait)
            return
        }
        val batch = outbox.take() ?: return
        outboxInFlight = batch
        outboxStatus = strings.getString(if (batch.unknown) R.string.voice_outbox_retry else R.string.voice_outbox_sending)
        changed()
        val permissions = requestPermissions
        if (permissions == null) {
            retryOutbox(batch, strings.getString(R.string.voice_outbox_retry))
            return
        }
        permissions permission@{ mode ->
            if (closed || outboxInFlight !== batch) return@permission
            if (mode == null) {
                retryOutbox(batch, strings.getString(R.string.voice_outbox_permission))
                return@permission
            }
            api.model(id) { result ->
                if (closed || outboxInFlight !== batch) return@model
                val model = result.getOrElse {
                    retryOutbox(batch, strings.getString(R.string.voice_outbox_retry))
                    return@model
                }
                val current = state
                if (current == null) {
                    retryOutbox(batch, strings.getString(R.string.voice_outbox_retry))
                    return@model
                }
                // Persist that the server may see this ticket before the request can leave.
                outbox.markUnknown(batch)
                // The literal marker is the only source of the server's voice cue; the
                // batch id, permissions, model and effort stay ordinary queue options.
                val options = JSONObject()
                    .put("clientMessageId", batch.id)
                    .put("permissionMode", mode)
                    .put("model", current.model ?: model.string("model"))
                    .put("effort", model.string("effort"))
                    .put("inputSource", "voice")
                api.appendIdempotent(id, batch.id, batch.content, options) { sent ->
                    if (closed || outboxInFlight !== batch) return@appendIdempotent
                    outboxInFlight = null
                    sent.onSuccess { receipt ->
                        if (receipt.id != batch.id) {
                            // The receipt must name the ticket we sent; otherwise nothing is confirmed.
                            outbox.markUnknown(batch)
                            outbox.hold()
                            outboxStatus = strings.getString(R.string.voice_outbox_unconfirmed)
                        } else {
                            outbox.confirm(batch)
                            outboxStatus = strings.getString(R.string.voice_outbox_sent)
                        }
                        changed()
                        drainOutbox()
                    }.onFailure { failure ->
                        val outcome = outboxFailure(failure)
                        if (outcome == OutboxFailure.REJECTED && !batch.unknown) {
                            // A refusal of the original attempt proves nothing was queued, so the
                            // head may merge again after 5 s (at most MAX_BATCH entries).
                            outbox.reject(batch)
                            outboxStatus = strings.getString(R.string.voice_outbox_rejected)
                        } else {
                            // A possibly-delivered ticket is checked again with the same id/content.
                            outbox.markUnknown(batch)
                            outboxStatus = strings.getString(
                                if (outcome == OutboxFailure.NOT_FOUND) R.string.voice_outbox_missing
                                else R.string.voice_outbox_unconfirmed,
                            )
                        }
                        outbox.hold()
                        changed()
                        drainOutbox()
                    }
                }
            }
        }
    }

    /**
     * A batch that never left the device may merge into a new attempt after 5 s. Once an attempt
     * marker was persisted, preparation failures keep the same ticket and content verbatim.
     */
    private fun retryOutbox(batch: OutboxBatch, message: String) {
        if (closed || outboxInFlight !== batch) return
        outboxInFlight = null
        val outbox = outbox ?: return
        if (batch.unknown) outbox.markUnknown(batch) else outbox.reject(batch)
        outbox.hold()
        outboxStatus = message
        changed()
        drainOutbox()
    }

    /**
     * The outbox may wait on a held queue, a missing model or an unfinished steering turn. Nothing
     * else on the socket may change then, so a light timer re-reads the native state and the queue
     * snapshot; only a fresh snapshot can release the send.
     */
    private fun scheduleOutboxRetry(delay: Long = VoiceOutbox.RETRY_DELAY_MS) {
        if (closed || !active || outbox?.count == 0) return
        val now = android.os.SystemClock.uptimeMillis()
        val at = now + maxOf(0L, delay)
        // Keep the earliest poll; a later frame must not push a pending recovery out indefinitely.
        if (outboxRetryAt in 1 until at) return
        main.removeCallbacks(outboxRetry)
        outboxRetryAt = at
        main.postDelayed(outboxRetry, at - now)
    }

    private fun refreshOutboxSnapshot() {
        val ws = socket?.takeIf { connected } ?: return
        if (stateRequest != null) {
            scheduleOutboxRetry()
            return
        }
        readState(ws) { native ->
            if (closed) return@readState
            if (native != null && native.runtime == "app-server") state = native
            changed()
            refreshQueue()
        }
    }

    private companion object {
        val BLOCKING_QUEUE_STATUS = setOf("held", "unknown", "steering")
    }
}
