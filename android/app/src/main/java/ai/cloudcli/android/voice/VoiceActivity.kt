package ai.cloudcli.android.voice

import ai.cloudcli.android.AppRuntime
import ai.cloudcli.android.MainActivity
import ai.cloudcli.android.R
import ai.cloudcli.android.voice.VoiceAudio.Playback
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Foreground microphone, playback and the local voice queue for one verified Codex session. */
class VoiceActivity : Activity() {
    private enum class Capture { OFF, PREPARING, LISTENING, HEARING }
    private enum class MicAccess { FIRST_REQUEST, REQUEST_AGAIN, SETTINGS, GRANTED }

    private var api: VoiceApi? = null
    private var session: VoiceSession? = null
    private var sessionTitle: String? = null
    private var audio: VoiceAudio? = null
    private var started = false
    private var resumed = false
    private var muted = false
    private var capture = Capture.OFF
    private val isRecording: Boolean get() = capture == Capture.LISTENING || capture == Capture.HEARING
    private var captureError: String? = null
    private var playbackError: String? = null
    private var micAccess = MicAccess.FIRST_REQUEST
    private var requestingMic = false
    private var transcriptOpen = false
    private var selectorLoading = false
    private var selectorError = false
    private var selectorMessage = R.string.voice_picker_choose
    private var nextOffset: Int? = 0
    private var displayedPending: PendingView? = null
    private var displayedSent = emptyList<Pair<String, String>>()
    private var displayedStatus = 0

    private lateinit var root: View
    private lateinit var title: TextView
    private lateinit var screenAction: Button
    private lateinit var call: View
    private lateinit var wave: VoiceWaveform
    private lateinit var status: TextView
    private lateinit var hint: TextView
    private lateinit var web: Button
    private lateinit var recovery: Button
    private lateinit var stopReply: Button
    private lateinit var records: ScrollView
    private lateinit var partial: TextView
    private lateinit var outboxStatus: TextView
    private lateinit var outboxRows: LinearLayout
    private lateinit var outboxEmpty: TextView
    private lateinit var sentRows: LinearLayout
    private lateinit var sentEmpty: TextView
    private lateinit var picker: View
    private lateinit var pickerStatus: TextView
    private lateinit var choices: LinearLayout
    private lateinit var more: Button
    private lateinit var controls: View
    private lateinit var mic: Button

    private var renderScheduled = false
    private val renderQueued = Runnable {
        renderScheduled = false
        if (!isFinishing) render()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppRuntime.init(applicationContext)
        muted = savedInstanceState?.getBoolean("muted") == true
        transcriptOpen = savedInstanceState?.getBoolean("transcriptOpen") == true
        setContentView(R.layout.activity_voice)
        bindPage()
        applyInsets()

        val origin = AppRuntime.prefs.siteOrigin
        if (origin == null || !AppRuntime.prefs.signedIn()) {
            selectorMessage = if (origin == null) R.string.voice_picker_no_site else R.string.voice_status_sign_in
            render()
            return
        }
        api = VoiceApi(origin)
        val preferred = savedInstanceState?.getString("session") ?: intent.getStringExtra(MainActivity.EXTRA_SESSION_ID)
        if (preferred == null) {
            loadRecent()
        } else {
            val restored = savedInstanceState?.getBundle("pending")?.let {
                VoiceSubmission(it.getString("text").orEmpty(), it.getString("client").orEmpty(), it.getString("turn")).apply {
                    queueId = it.getString("queue")
                    steerId = it.getString("steer")
                }
            }
            select(VoiceChoice(preferred, savedInstanceState?.getString("title")), restored)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        val current = session
        outState.putString("session", current?.choice?.id)
        outState.putString("title", sessionTitle)
        outState.putBoolean("muted", muted)
        outState.putBoolean("transcriptOpen", transcriptOpen)
        current?.unconfirmed?.let { unresolved ->
            outState.putBundle("pending", Bundle().apply {
                putString("text", unresolved.text)
                putString("client", unresolved.clientId)
                putString("turn", unresolved.expectedTurnId)
                putString("queue", unresolved.queueId)
                putString("steer", unresolved.steerId)
            })
        }
    }

    override fun onStart() {
        super.onStart()
        started = true
        session?.start()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        readMicPermission()
        render()
    }

    override fun onPause() {
        resumed = false
        stopAudio()
        super.onPause()
    }

    override fun onStop() {
        started = false
        session?.pause()
        super.onStop()
    }

    override fun onDestroy() {
        session?.close()
        audio?.close()
        root.removeCallbacks(renderQueued)
        super.onDestroy()
    }

    private fun select(choice: VoiceChoice, restored: VoiceSubmission? = null) {
        val client = api ?: return
        intent.removeExtra(MainActivity.EXTRA_SESSION_ID)
        sessionTitle = choice.title
        stopAudio()
        audio?.close()
        audio = null
        capture = Capture.OFF
        captureError = null
        playbackError = null
        val outbox = client.userId?.let {
            VoiceOutbox(
                VoiceOutbox.destination(client.origin, it, choice.id),
                OutboxPrefs(applicationContext),
            )
        }
        val current = VoiceSession(client, choice, resources, {
            updateCapture(session)
            scheduleRender()
        }, {
            session?.close()
            session = null
            sessionTitle = null
            transcriptOpen = false
            selectorMessage = R.string.voice_picker_unsupported
            if (choices.childCount == 0 && nextOffset != null && !selectorLoading) loadRecent() else render()
        }, { _ ->
            // Existing handwritten drafts are never touched or sent from the call UI.
        }, { text ->
            val target = session
            if (target != null && resumed && !isFinishing) audio(target).speak(text)
        }, { audio?.stopPlayback() }, outbox, { result ->
            MainActivity.readVoicePermissionMode(client.origin, choice.id, result)
        }, restored)
        session = current
        if (choice.title == null) {
            client.title(choice.id) { result ->
                if (session === current && !isFinishing && !isDestroyed) {
                    sessionTitle = result.getOrNull()
                    scheduleRender()
                }
            }
        }
        if (started) current.start()
        render()
        if (transcriptOpen) showQueue()
    }

    private fun loadRecent() {
        val client = api ?: return
        val offset = nextOffset ?: return
        if (selectorLoading) return
        selectorLoading = true
        selectorError = false
        render()
        client.recent(offset) { result ->
            if (isFinishing || isDestroyed) return@recent
            selectorLoading = false
            result.onSuccess { page ->
                nextOffset = page.nextOffset
                for (choice in page.choices) {
                    choices.addView(Button(this, null, 0, R.style.Widget_CloudCLI_Voice_Button).apply {
                        text = listOfNotNull(choice.title, choice.project).joinToString("\n")
                        gravity = Gravity.START or Gravity.CENTER_VERTICAL
                        setOnClickListener { select(choice) }
                    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
                }
                if (choices.childCount == 0 && nextOffset == null) selectorMessage = R.string.voice_picker_empty
            }.onFailure {
                selectorError = true
                selectorMessage = R.string.voice_picker_error
            }
            render()
        }
    }

    private fun endCall() {
        stopAudio()
        finish()
    }

    private fun openWeb() {
        session?.choice?.let {
            setResult(RESULT_OK, Intent().putExtra(MainActivity.EXTRA_SESSION_ID, it.id).putExtra(EXTRA_ORIGIN, api?.origin))
        }
        endCall()
    }

    private fun toggleTranscript() {
        if (session == null) {
            endCall()
            return
        }
        transcriptOpen = !transcriptOpen
        render()
        if (transcriptOpen) showQueue()
    }

    private fun audio(target: VoiceSession): VoiceAudio =
        audio ?: VoiceAudio(this, AudioListener(target)).also { audio = it }

    private fun silence() {
        session?.silence()
        audio?.stopPlayback()
    }

    private fun stopAudio() {
        stopCapture()
        silence()
        wave.setMotion(false)
    }

    private fun stopCapture() {
        if (capture == Capture.OFF) return
        capture = Capture.OFF
        partial.showText(null)
        audio?.setListening(false)
    }

    private fun readMicPermission() {
        micAccess = when {
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> MicAccess.GRANTED
            shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) -> MicAccess.REQUEST_AGAIN
            getPreferences(MODE_PRIVATE).getBoolean(MIC_REQUESTED, false) -> MicAccess.SETTINGS
            else -> MicAccess.FIRST_REQUEST
        }
    }

    private fun requestMic() {
        requestingMic = true
        getPreferences(MODE_PRIVATE).edit().putBoolean(MIC_REQUESTED, true).apply()
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
    }

    private fun toggleMic() {
        when {
            micAccess == MicAccess.SETTINGS ->
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            micAccess != MicAccess.GRANTED -> requestMic()
            captureError != null -> captureError = null
            else -> muted = !muted
        }
        render()
    }

    private fun updateCapture(current: VoiceSession?) {
        if (current != null && resumed && !isFinishing && !muted && !requestingMic) {
            val usable = current.connection != VoiceConnection.SIGN_IN &&
                current.connection != VoiceConnection.UNSUPPORTED
            if (usable && micAccess == MicAccess.FIRST_REQUEST) requestMic()
            if (usable && micAccess == MicAccess.GRANTED && captureError == null) {
                // Recognition is local; keep it running through reconnects and queue the text.
                if (capture == Capture.OFF) {
                    capture = Capture.PREPARING
                    audio(current).setListening(true)
                }
                return
            }
        }
        stopCapture()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MIC) return
        requestingMic = false
        readMicPermission()
        render()
    }

    private fun scheduleRender() {
        if (renderScheduled) return
        renderScheduled = true
        root.postDelayed(renderQueued, 40)
    }

    private fun render() {
        val current = session
        updateCapture(current)
        val sessionLabel = sessionTitle ?: getString(R.string.action_voice)
        if (title.text != sessionLabel) title.text = sessionLabel
        val actionLabel = getString(when {
            current == null -> R.string.voice_close
            transcriptOpen -> R.string.voice_back_to_call
            else -> R.string.voice_transcript
        })
        if (screenAction.text != actionLabel) screenAction.text = actionLabel
        picker.visibility = if (current == null) View.VISIBLE else View.GONE
        call.visibility = if (current != null && !transcriptOpen) View.VISIBLE else View.GONE
        records.visibility = if (current != null && transcriptOpen) View.VISIBLE else View.GONE
        controls.visibility = if (current != null) View.VISIBLE else View.GONE
        if (current == null) {
            wave.setMotion(false)
            pickerStatus.setText(if (selectorLoading) R.string.voice_picker_loading else selectorMessage)
            more.visibility = if (!selectorLoading && api != null && nextOffset != null) View.VISIBLE else View.GONE
            more.setText(if (selectorError) R.string.voice_retry else R.string.voice_more_sessions)
            return
        }

        renderCall(current)
        if (transcriptOpen) renderTranscript(current)
    }

    private fun renderCall(current: VoiceSession) {
        val playback = audio?.playbackState ?: Playback.IDLE
        val recording = isRecording
        val webReason = current.webReason
        val statusRes = when (current.connection) {
            VoiceConnection.CONNECTING, VoiceConnection.RECONNECTING -> when {
                recording -> R.string.voice_status_reconnecting_draft
                current.connection == VoiceConnection.RECONNECTING -> R.string.voice_status_reconnecting
                else -> R.string.voice_status_connecting
            }
            VoiceConnection.SIGN_IN -> R.string.voice_status_sign_in
            VoiceConnection.UNSUPPORTED -> R.string.voice_status_unsupported
            VoiceConnection.CONNECTED -> when {
                current.unknown -> R.string.voice_status_unconfirmed
                webReason != null -> webReason
                capture == Capture.HEARING -> R.string.voice_status_hearing
                playback == Playback.PLAYING -> R.string.voice_status_speaking
                requestingMic -> R.string.voice_status_preparing
                micAccess != MicAccess.GRANTED -> R.string.voice_status_mic_permission
                captureError != null -> R.string.voice_status_mic_error
                capture == Capture.PREPARING -> R.string.voice_status_preparing
                current.queueUnavailable -> R.string.voice_status_queue_error
                current.generating || playback == Playback.PREPARING -> R.string.voice_status_processing
                muted -> R.string.voice_status_muted
                recording -> R.string.voice_status_listening
                else -> R.string.voice_status_preparing
            }
        }
        if (displayedStatus != statusRes) {
            displayedStatus = statusRes
            status.setText(statusRes)
        }
        val queued = current.queuedCount
        val hintText = when {
            statusRes == R.string.voice_status_mic_permission -> getString(
                if (micAccess == MicAccess.SETTINGS) R.string.voice_hint_mic_settings else R.string.voice_hint_mic_permission,
            )
            playbackError != null && playback == Playback.IDLE -> getString(R.string.voice_hint_playback_error)
            statusRes == R.string.voice_status_listening && current.outboxWaiting ->
                current.outboxNote ?: getString(R.string.voice_outbox_pending)
            statusRes == R.string.voice_status_listening && queued > 0 ->
                resources.getQuantityString(R.plurals.voice_queued_count, queued, queued)
            statusRes == R.string.voice_status_listening -> getString(R.string.voice_hint_speak)
            statusRes == R.string.voice_status_speaking && recording -> getString(R.string.voice_hint_interrupt)
            else -> null
        }
        hint.showText(hintText)
        val recoveryAction = when {
            current.unknown -> R.string.voice_check_delivery
            current.queueUnavailable -> R.string.voice_retry
            current.connection == VoiceConnection.RECONNECTING -> R.string.voice_reconnect
            else -> null
        }
        recovery.visibility = if (recoveryAction == null) View.GONE else View.VISIBLE
        if (recoveryAction != null) recovery.setText(recoveryAction)
        val webRequired = current.connection == VoiceConnection.SIGN_IN || current.connection == VoiceConnection.UNSUPPORTED
        web.visibility = if (webReason != null || current.unknown || webRequired) {
            View.VISIBLE
        } else View.GONE
        stopReply.visibility = if (playback != Playback.IDLE) View.VISIBLE else View.GONE
        mic.isEnabled = current.opened && !requestingMic && current.connection != VoiceConnection.UNSUPPORTED
        val micLabel = getString(when {
            micAccess == MicAccess.SETTINGS -> R.string.voice_mic_settings
            micAccess != MicAccess.GRANTED -> R.string.voice_allow_mic
            captureError != null -> R.string.voice_retry_mic
            muted -> R.string.voice_unmute_mic
            else -> R.string.voice_mute_mic
        })
        if (mic.text != micLabel) mic.text = micLabel
        if (mic.isActivated != recording) {
            mic.isActivated = recording
            mic.setCompoundDrawablesRelativeWithIntrinsicBounds(
                0, if (recording) R.drawable.ic_voice_mic else R.drawable.ic_voice_mic_off, 0, 0,
            )
        }
        wave.setMotion(resumed && !transcriptOpen && (statusRes == R.string.voice_status_listening ||
            statusRes == R.string.voice_status_hearing || statusRes == R.string.voice_status_speaking ||
            statusRes == R.string.voice_status_reconnecting_draft))
    }

    private fun renderTranscript(current: VoiceSession) {
        renderPending(current)
        renderSent(current)
    }

    private fun renderPending(current: VoiceSession) {
        val batch = current.outboxBatch
        val entries = current.outboxEntries.filterNot { entry -> batch?.entryIds?.contains(entry.id) == true }
        val view = PendingView(batch, entries, current.outboxSending)
        if (view != displayedPending) {
            displayedPending = view
            outboxRows.removeAllViews()
            if (batch != null) outboxRows.addView(batchRow(batch, current.outboxSending))
            entries.forEachIndexed { index, entry -> outboxRows.addView(entryRow(index, entry)) }
        }
        outboxEmpty.visibility = if (batch == null && entries.isEmpty()) View.VISIBLE else View.GONE
        outboxStatus.showText(current.outboxNote)
    }

    private fun entryRow(index: Int, entry: OutboxEntry): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)
        }
        row.addView(TextView(this).apply {
            text = getString(R.string.voice_outbox_entry, index + 1, entry.text)
            setTextColor(getColor(R.color.voice_ink))
            textSize = 15f
            setTextIsSelectable(true)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Button(this).apply {
            text = getString(R.string.voice_outbox_delete)
            setOnClickListener { session?.dropOutbox(entry.id) }
        })
        return row
    }

    private fun batchRow(batch: OutboxBatch, sending: Boolean): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)
        }
        row.addView(TextView(this).apply {
            text = listOf(
                getString(R.string.voice_outbox_batch), batch.content,
            ).joinToString("\n")
            setTextColor(getColor(R.color.voice_ink))
            textSize = 15f
            setTextIsSelectable(true)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Button(this).apply {
            text = getString(R.string.voice_outbox_delete)
            isEnabled = !sending
            setOnClickListener { confirmDropBatch(batch) }
        })
        return row
    }

    private fun confirmDropBatch(batch: OutboxBatch) {
        if (session?.outboxSending == true) return
        if (batch.entryIds.size <= 1) {
            session?.dropOutboxBatch(batch.id)
            return
        }
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.voice_outbox_batch_confirm, batch.entryIds.size))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.voice_outbox_delete) { _, _ ->
                if (session?.outboxSending != true) session?.dropOutboxBatch(batch.id)
            }
            .show()
    }

    private fun renderSent(current: VoiceSession) {
        val items = current.outboxSent.map { it.id to it.text }
        if (items != displayedSent) {
            displayedSent = items
            sentRows.removeAllViews()
            items.forEach { (_, text) ->
                sentRows.addView(TextView(this).apply {
                    this.text = text
                    setTextColor(getColor(R.color.voice_ink))
                    textSize = 15f
                    setTextIsSelectable(true)
                    setPadding(0, dp(8), 0, 0)
                })
            }
        }
        sentEmpty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
    }

    private data class PendingView(
        val batch: OutboxBatch?,
        val entries: List<OutboxEntry>,
        val sending: Boolean,
    )

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun TextView.showText(message: String?) {
        if (text != message.orEmpty()) text = message.orEmpty()
        visibility = if (message.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    private fun showQueue() {
        records.post { records.fullScroll(View.FOCUS_UP) }
    }

    private fun bindPage() {
        root = findViewById(R.id.voice_root)
        title = findViewById(R.id.voice_title)
        screenAction = findViewById<Button>(R.id.voice_screen_action).apply { setOnClickListener { toggleTranscript() } }
        call = findViewById(R.id.voice_call)
        wave = findViewById(R.id.voice_wave)
        status = findViewById(R.id.voice_status)
        hint = findViewById(R.id.voice_hint)
        partial = findViewById(R.id.voice_partial)
        web = findViewById<Button>(R.id.voice_web).apply { setOnClickListener { openWeb() } }
        recovery = findViewById<Button>(R.id.voice_recovery).apply { setOnClickListener { session?.check() } }
        stopReply = findViewById<Button>(R.id.voice_stop_reply).apply { setOnClickListener { silence() } }
        records = findViewById(R.id.voice_records)
        outboxStatus = findViewById(R.id.voice_outbox_status)
        outboxRows = findViewById(R.id.voice_outbox_rows)
        outboxEmpty = findViewById(R.id.voice_outbox_empty)
        sentRows = findViewById(R.id.voice_sent_rows)
        sentEmpty = findViewById(R.id.voice_sent_empty)
        picker = findViewById(R.id.voice_picker)
        pickerStatus = findViewById(R.id.voice_picker_status)
        choices = findViewById(R.id.voice_choices)
        more = findViewById<Button>(R.id.voice_more).apply { setOnClickListener { loadRecent() } }
        controls = findViewById(R.id.voice_controls)
        mic = findViewById<Button>(R.id.voice_mic).apply { setOnClickListener { toggleMic() } }
        findViewById<Button>(R.id.voice_end).setOnClickListener { endCall() }
        findViewById<Button>(R.id.voice_picker_web).setOnClickListener { openWeb() }
    }

    /**
     * Final speech is always written to the session that owned the audio, even after the view is
     * gone. Only UI state for that same live session may change here.
     */
    private inner class AudioListener(private val target: VoiceSession) : VoiceAudio.Listener {
        override fun onCaptureReady() = ui {
            if (capture == Capture.PREPARING) {
                capture = Capture.LISTENING
                scheduleRender()
            }
        }

        override fun onSpeechStart() = ui {
            if (capture == Capture.LISTENING) {
                capture = Capture.HEARING
                target.bargeIn()
                scheduleRender()
            }
        }

        override fun onPartialTranscript(text: String) = ui {
            if (capture == Capture.HEARING) {
                partial.showText(text.takeIf { it.isNotBlank() }?.let { getString(R.string.voice_recognized, it) })
            }
        }

        override fun onFinalTranscript(text: String) {
            if (text.isNotBlank()) target.enqueueVoice(text)
            ui {
                if (capture == Capture.HEARING) capture = Capture.LISTENING
                partial.showText(null)
                scheduleRender()
            }
        }

        override fun onCaptureError(message: String) = ui {
            if (capture != Capture.OFF) {
                captureError = message
                stopCapture()
                scheduleRender()
            }
        }

        override fun onPlaybackChanged() = ui {
            if (audio?.playbackState == Playback.PLAYING) playbackError = null
            scheduleRender()
        }

        override fun onPlaybackError(message: String) = ui {
            if (resumed) {
                playbackError = message
                scheduleRender()
            }
        }

        private fun ui(block: () -> Unit) {
            if (target !== session || isFinishing || isDestroyed) return
            block()
        }
    }

    @Suppress("DEPRECATION")
    private fun applyInsets() {
        window.setBackgroundDrawableResource(R.color.voice_background)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            val appearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(appearance, appearance)
            val left = root.paddingLeft
            val top = root.paddingTop
            val right = root.paddingRight
            val bottom = root.paddingBottom
            root.setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                view.setPadding(safe.left + left, safe.top + top, safe.right + right, safe.bottom + bottom)
                insets
            }
            root.requestApplyInsets()
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            window.statusBarColor = getColor(R.color.voice_background)
            window.navigationBarColor = getColor(R.color.voice_background)
        }
    }

    companion object {
        internal const val EXTRA_ORIGIN = "ai.cloudcli.android.extra.VOICE_ORIGIN"
        private const val REQUEST_MIC = 21
        private const val MIC_REQUESTED = "mic_requested"
    }
}
