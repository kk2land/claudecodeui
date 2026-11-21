package ai.cloudcli.android.voice

import ai.cloudcli.android.ReconnectPolicy
import android.os.Handler
import android.os.Looper
import java.util.UUID
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/** The session, pending submission and audio decisions are all owned by the main thread. */
internal class VoiceSession(
    private val api: VoiceApi,
    val choice: VoiceChoice,
    private val changed: () -> Unit,
    private val unsupported: () -> Unit,
    private val returnDraft: (String) -> Unit,
    private val play: (String) -> Unit,
    private val stopPlayback: () -> Unit,
    restored: VoiceSubmission? = null,
) {
    private enum class Stage { PREPARING, SENDING, APPENDING, STEERING, UNKNOWN }
    private data class Pending(val message: VoiceSubmission, var stage: Stage, val route: SendRoute? = null)

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
    private var connectionMessage = "Connecting to Codex…"
    private var historyMessage: String? = null
    private var queueMessage: String? = null
    private var deliveryMessage: String? = restored?.let { "Delivery is unconfirmed. Checking history and queue…" }

    var connected = false
        private set
    var loading = true
        private set
    val waitingForWeb: Boolean get() = permissions.isNotEmpty() || state?.questionPending == true
    val rows: List<VoiceRow> get() = transcript.rows()
    val pendingText: String? get() = pending?.message?.text
    val unconfirmed: VoiceSubmission? get() = pending?.takeUnless { it.stage == Stage.PREPARING }?.message
    val unknown: Boolean get() = pending?.stage == Stage.UNKNOWN
    val note: String? get() = deliveryMessage ?: historyMessage ?: queueMessage
    val route: SendRoute? get() = if (connected && pending == null) routeNow() else null
    val canAutoSubmit: Boolean get() = route != null && state?.queueHeld != true && queue?.status != "held"
    val canQueue: Boolean get() = connected && pending == null && sendRoute(state, processing, true, enqueue = true) != null
    val status: String get() = when {
        !connected -> connectionMessage
        state?.modelRequired == true -> "Choose a model in the web session."
        waitingForWeb -> "Codex is waiting for your input."
        state?.error != null -> state?.error.orEmpty()
        queue?.status == "unknown" -> "A message needs delivery confirmation in the web session."
        queue?.status == "steering" -> "The queue is waiting for Codex to confirm a message."
        state?.queueHeld == true || queue?.status == "held" -> "The queue is held. Open the web session to manage it."
        (queue?.entries?.size ?: 0) > 0 -> "Queued messages: ${queue?.entries?.size}"
        queue == null -> "Checking the message queue…"
        state?.phase == "running" || processing || state?.goalActive == true -> "Codex is working."
        else -> "Connected to Codex."
    }

    private val retry = Runnable { connect() }
    private val handshakeDeadline = Runnable { disconnect("Codex did not respond.", retry = true) }
    private val deliveryDeadline = Runnable {
        if (pending?.stage == Stage.PREPARING) settle("Session settings timed out. Your draft is ready to edit.", restore = true)
        else uncertain("Delivery is unconfirmed. Checking history and queue…", refresh = true)
    }

    fun start() {
        active = true
        connect()
    }

    fun pause() {
        active = false
        disconnect("Connection paused.", retry = false)
    }

    fun close() {
        closed = true
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
    }

    private fun connect() {
        if (!active || closed || socket != null) return
        main.removeCallbacks(retry)
        loading = true
        connectionMessage = "Connecting to Codex…"
        socket = api.socket(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onSocket(webSocket) {
                subscribe(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) = onSocket(webSocket) {
                val frame = runCatching { JSONObject(text) }.getOrNull() ?: return@onSocket
                receive(frame)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = onSocket(webSocket) {
                disconnect("Connection closed ($code).", retry = true)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onSocket(webSocket) {
                val auth = response?.code == 401 || response?.code == 403
                disconnect(if (auth) "Sign in to CloudCLI on the web." else "Connection lost. Reconnecting…", retry = !auth)
            }
        })
        if (socket == null) {
            loading = false
            connectionMessage = "Sign in to CloudCLI on the web."
        } else {
            main.postDelayed(handshakeDeadline, 20_000)
        }
        changed()
    }

    private fun onSocket(ws: WebSocket, action: () -> Unit) {
        main.post { if (socket === ws && !closed) action() }
    }

    private fun disconnect(message: String, retry: Boolean) {
        main.removeCallbacks(this.retry)
        main.removeCallbacks(handshakeDeadline)
        socket?.cancel()
        socket = null
        stateRequest = null
        connected = false
        loading = false
        queue = null
        permissions.clear()
        connectionMessage = message
        speech.close()
        stopPlayback()
        when (pending?.stage) {
            Stage.PREPARING -> settle("Connection changed. Your draft is ready to edit.", restore = true)
            Stage.SENDING, Stage.STEERING -> uncertain("Delivery is unconfirmed. It will be checked on reconnect.")
            else -> Unit // A POST may still return its queue ticket, even after the socket closes.
        }
        if (active && retry) main.postDelayed(this.retry, reconnect.onAttemptFailed())
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
                    disconnect("Connection lost.", retry = true)
                }
            }
        }
    }

    private fun readState(ws: WebSocket, receive: (VoiceState?) -> Unit) {
        val request = UUID.randomUUID().toString()
        stateRequest = request to receive
        if (!ws.send(control(request, JSONObject().put("action", "state")).toString())) {
            disconnect("Connection lost.", retry = true)
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
            connected = true
            opened = true
            loading = false
            reconnect.onRegistered()
            main.removeCallbacks(handshakeDeadline)
            refresh()
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
                if (pending?.stage == Stage.SENDING) uncertain("Delivery is unconfirmed. Checking history and queue…")
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
                settle("Message saved to the queue.")
                refreshQueue()
            }
            "control_result" -> steerResult(frame)
            "protocol_error" -> protocolError(frame)
        }
        if (connected) changed()
    }

    private fun unavailable() {
        if (!opened) unsupported()
        else disconnect("This session no longer uses Codex app-server.", retry = false)
    }

    private fun observeUser(change: TranscriptChange, sequenced: Boolean) {
        val row = change.row
        if (pending?.message?.matchesEcho(row) == true) {
            settle("Message delivered.")
            refreshQueue()
        }
        val ticket = speechTicket
        if (ticket?.matchesEcho(row) == true) {
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
            historyMessage = result.exceptionOrNull()?.let { "History unavailable. ${it.message.orEmpty()}" }
            if (rows != null) {
                transcript.mergeHistory(rows)
                if (pending?.message?.let { ticket -> rows.any(ticket::matchesEcho) } == true) settle("Message verified in history.")
                val ticket = speechTicket
                val lastUser = rows.lastOrNull { it.role == "user" }
                val echoTurn = lastUser?.turnId ?: ticket?.expectedTurnId?.takeIf { lastUser?.clientId == ticket.steerId && ticket.steerId != null }
                val run = sequence.executionId
                if (!speech.open && ticket != null && lastUser != null && ticket.matchesEcho(lastUser) &&
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
        val request = ++queueRead
        api.queue(id) { result ->
            if (socket !== ws || queueRead != request) return@queue
            queue = result.getOrNull()
            pending?.takeIf { it.stage == Stage.UNKNOWN }?.let { staged ->
                val snapshot = queue
                if (snapshot?.contains(staged.message) == true && !snapshot.deliveryUnclear(staged.message)) {
                    val held = snapshot.status == "held" || state?.queueHeld == true
                    settle(if (held) "Message saved in a held queue. Open the web session." else "Message verified in the queue.")
                }
            }
            if (unknown) deliveryMessage = "Delivery is unconfirmed. Check the web session before sending again."
            queueMessage = result.exceptionOrNull()?.let { "Queue unavailable. ${it.message.orEmpty()}" }
            changed()
        }
    }

    private fun routeNow(): SendRoute? = sendRoute(state, processing, queue?.empty == true, enqueue = false)

    fun submit(text: String, enqueue: Boolean, automatic: Boolean, permissions: ((String?) -> Unit) -> Unit): Boolean {
        if (automatic && !canAutoSubmit) return false
        val ws = socket?.takeIf { connected } ?: return false
        val route = (if (enqueue && canQueue) SendRoute.QUEUE else if (!enqueue) route else null) ?: return false
        val message = VoiceSubmission(text, UUID.randomUUID().toString(), state?.turnId.takeIf { route == SendRoute.STEER })
        val staged = Pending(message, Stage.PREPARING, route)
        pending = staged
        silence()
        stopPlayback()
        speechTicket = message
        deliveryMessage = "Preparing message…"
        main.postDelayed(deliveryDeadline, 40_000)
        changed()

        permissions permission@{ mode ->
            if (pending !== staged || socket !== ws) return@permission
            if (mode == null) {
                settle("Open the web session to load its permission settings.", restore = true)
                return@permission
            }
            api.model(id) { result ->
                if (pending !== staged || socket !== ws) return@model
                val model = result.getOrElse {
                    settle("Could not load the model settings. ${it.message.orEmpty()}", restore = true)
                    return@model
                }
                readState(ws) read@{ native ->
                    if (pending !== staged || socket !== ws) return@read
                    if (native?.runtime != "app-server") {
                        unavailable()
                        return@read
                    }
                    state = native
                    val options = JSONObject().put("clientMessageId", message.clientId).put("permissionMode", mode)
                        .put("model", native.model ?: model.string("model")).put("effort", model.string("effort"))
                    when {
                        native.modelRequired -> settle("Choose a model in the web session.", restore = true)
                        route == SendRoute.QUEUE -> append(staged, ws, options)
                        else -> checkQueueBeforeSend(staged, ws, options, automatic)
                    }
                }
            }
        }
        return true
    }

    private fun checkQueueBeforeSend(staged: Pending, ws: WebSocket, options: JSONObject, automatic: Boolean) {
        val request = ++queueRead
        api.queue(id) { result ->
            if (pending !== staged || socket !== ws) return@queue
            val snapshot = result.getOrElse {
                settle("Could not check the queue. ${it.message.orEmpty()}", restore = true)
                return@queue
            }
            if (request == queueRead) queue = snapshot
            when {
                automatic && (state?.queueHeld == true || snapshot.status == "held") ->
                    settle("The queue is held. Your draft is ready to edit.", restore = true)
                !snapshot.empty -> settle("A message is already queued. You can edit or add this draft to the queue.", restore = true)
                routeNow() != staged.route || staged.route == SendRoute.STEER && state?.turnId != staged.message.expectedTurnId ->
                    settle("The Codex turn changed. Your draft is ready to edit.", restore = true)
                staged.route == SendRoute.DIRECT -> send(staged, ws, options)
                else -> append(staged, ws, options)
            }
        }
    }

    private fun send(staged: Pending, ws: WebSocket, options: JSONObject) {
        val frame = JSONObject().put("type", "chat.send").put("sessionId", id)
            .put("content", staged.message.text).put("options", options)
        if (ws.send(frame.toString())) awaitEcho(staged, Stage.SENDING)
        else settle("Connection lost. Your draft is ready to edit.", restore = true)
    }

    private fun append(staged: Pending, ws: WebSocket, options: JSONObject) {
        val message = staged.message
        val target = message.expectedTurnId
        staged.stage = Stage.APPENDING
        main.removeCallbacks(deliveryDeadline)
        deliveryMessage = "Saving message to the queue…"
        changed()
        api.append(id, message.text, options, ifEmpty = target != null) { result ->
            if (closed || pending !== staged) return@append
            val receipt = result.getOrElse {
                if (it is VoiceHttpError && it.status in 400..499 && it.status != 408) {
                    val error = if (it.status == 409 && it.code == "QUEUE_NOT_EMPTY") {
                        "A message is already queued. You can edit or add this draft to the queue."
                    } else it.message.orEmpty()
                    settle(error, restore = true)
                    refreshQueue()
                } else uncertain("Queue delivery is unconfirmed. Checking saved messages…", refresh = connected)
                return@append
            }
            message.queueId = receipt.id
            if (target == null || receipt.appended || socket !== ws || state?.phase != "running" || state?.turnId != target) {
                settle("Message saved to the queue.")
                refreshQueue()
                return@append
            }
            val request = UUID.randomUUID().toString()
            message.steerId = request
            val action = JSONObject().put("action", "steer").put("messageId", receipt.id)
                .put("expectedTurnId", target).put("queueIfTurnEnded", true)
            if (ws.send(control(request, action).toString())) awaitEcho(staged, Stage.STEERING)
            else {
                settle("Message saved to the queue.")
                refreshQueue()
            }
        }
    }

    private fun awaitEcho(staged: Pending, stage: Stage) {
        staged.stage = stage
        deliveryMessage = if (stage == Stage.SENDING) "Waiting for Codex to echo your message…" else "Sending to the current Codex turn…"
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
                settle("Message accepted by Codex.")
                refreshQueue()
            }
            delivery == "rejected" && frame.string("code") == "STALE_TURN" ->
                uncertain("The original turn ended. Checking the saved message…", refresh = true)
            delivery == "rejected" -> {
                settle("Message held in the queue. ${frame.string("error").orEmpty()}")
                refreshQueue()
            }
            else -> uncertain("Delivery is unconfirmed. Checking saved messages…", refresh = staged.stage != Stage.UNKNOWN)
        }
    }

    private fun protocolError(frame: JSONObject) {
        val staged = pending?.takeIf { it.route == SendRoute.DIRECT && (it.stage == Stage.SENDING || it.stage == Stage.UNKNOWN) } ?: return
        val client = frame.string("clientMessageId")
        if (client != null && client != staged.message.clientId) return
        when (frame.string("code")) {
            "MESSAGE_ALREADY_SENT" -> uncertain("Checking this message's existing receipt…", refresh = true)
            "RUN_IN_PROGRESS", "CODEX_MODEL_REQUIRED", "SESSION_NOT_FOUND", "UNSUPPORTED_PROVIDER",
            "QUEUE_REJECTED", "QUEUE_LIMIT_REACHED", "QUEUE_BUSY", "CONTENT_REQUIRED", "INVALID_TODO_IDS" -> {
                settle(frame.string("error") ?: "Codex refused the message.", restore = true)
                refreshQueue()
            }
        }
    }

    private fun settle(message: String, restore: Boolean = false) {
        val staged = pending ?: return
        main.removeCallbacks(deliveryDeadline)
        pending = null
        deliveryMessage = message
        if (restore) {
            if (speechTicket === staged.message) silence()
            returnDraft(staged.message.text)
        }
        if (!closed) changed()
    }

    private fun uncertain(message: String, refresh: Boolean = false) {
        main.removeCallbacks(deliveryDeadline)
        pending?.stage = Stage.UNKNOWN
        deliveryMessage = message
        if (refresh) refresh()
        if (!closed) changed()
    }
}
