package ai.cloudcli.android.voice

import ai.cloudcli.android.AppRuntime
import ai.cloudcli.android.MainActivity
import ai.cloudcli.android.R
import ai.cloudcli.android.voice.VoiceAudio.Playback
import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Foreground microphone, playback and transcript for one verified Codex app-server session. */
class VoiceActivity : Activity(), VoiceAudio.Listener {
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
    private var autoSubmitUtterance = false
    private var transcriptOpen = false
    private var imeVisible = false
    private var selectorLoading = false
    private var selectorError = false
    private var selectorMessage = R.string.voice_picker_choose
    private var nextOffset: Int? = 0

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
    private lateinit var recordStatus: TextView
    private lateinit var history: TextView
    private lateinit var note: TextView
    private lateinit var composer: View
    private lateinit var draft: EditText
    private lateinit var partial: TextView
    private lateinit var pending: TextView
    private lateinit var send: Button
    private lateinit var enqueue: Button
    private lateinit var picker: View
    private lateinit var pickerStatus: TextView
    private lateinit var choices: LinearLayout
    private lateinit var more: Button
    private lateinit var controls: View
    private lateinit var mic: Button
    private var displayedRows = emptyList<VoiceRow>()
    private var displayedStatus = 0

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
        draft.setText(savedInstanceState?.getString("draft").orEmpty())

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
        val unresolved = current?.unconfirmed
        outState.putString("draft", listOfNotNull(current?.pendingText?.takeIf { unresolved == null }, draft.text.toString())
            .filter { it.isNotBlank() }.joinToString("\n"))
        outState.putString("session", current?.choice?.id)
        outState.putString("title", sessionTitle)
        outState.putBoolean("muted", muted)
        outState.putBoolean("transcriptOpen", transcriptOpen)
        if (unresolved != null) outState.putBundle("pending", Bundle().apply {
            putString("text", unresolved.text)
            putString("client", unresolved.clientId)
            putString("turn", unresolved.expectedTurnId)
            putString("queue", unresolved.queueId)
            putString("steer", unresolved.steerId)
        })
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
        val current = VoiceSession(client, choice, resources, {
            val connection = session?.connection
            if (connection != VoiceConnection.CONNECTED) updateCapture(connection)
            scheduleRender()
        }, {
            session?.close()
            session = null
            sessionTitle = null
            transcriptOpen = false
            selectorMessage = R.string.voice_picker_unsupported
            if (choices.childCount == 0 && nextOffset != null && !selectorLoading) loadRecent() else render()
        }, { text ->
            draft.text.insert(0, if (draft.length() == 0) text else "$text\n")
        }, { text ->
            if (resumed && !isFinishing) audio().speak(text)
        }, { audio?.stopPlayback() }, restored)
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
        if (transcriptOpen) showLatest()
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
        if (!transcriptOpen && draft.hasFocus()) {
            getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(draft.windowToken, 0)
            draft.clearFocus()
        }
        render()
        if (transcriptOpen) showLatest()
    }

    private fun submit(toQueue: Boolean, automatic: Boolean = false) {
        val current = session ?: return
        val client = api ?: return
        val raw = draft.text.toString()
        val text = raw.trim()
        if (text.isEmpty()) return
        draft.text.clear()
        val submitted = current.submit(text, toQueue, automatic) { result ->
            MainActivity.readVoicePermissionMode(client.origin, current.choice.id, result)
        }
        if (!submitted) draft.setText(raw)
    }

    private fun audio(): VoiceAudio = audio ?: VoiceAudio(this, this).also { audio = it }

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
        autoSubmitUtterance = false
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

    private fun updateCapture(connection: VoiceConnection?) {
        if (resumed && !isFinishing && !muted && !requestingMic) {
            if (connection == VoiceConnection.CONNECTED && micAccess == MicAccess.FIRST_REQUEST) requestMic()
            if (micAccess == MicAccess.GRANTED && captureError == null) {
                if (connection == VoiceConnection.CONNECTED) {
                    if (capture == Capture.OFF) {
                        capture = Capture.PREPARING
                        audio().setListening(true)
                    }
                    return
                }
                if (isRecording && (connection == VoiceConnection.RECONNECTING || connection == VoiceConnection.CONNECTING)) {
                    // Keep the current utterance as a draft through reconnection.
                    autoSubmitUtterance = false
                    return
                }
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

    override fun onCaptureReady() {
        if (capture != Capture.PREPARING) return
        capture = Capture.LISTENING
        scheduleRender()
    }

    override fun onSpeechStart() {
        if (capture != Capture.LISTENING) return
        capture = Capture.HEARING
        val current = session
        current?.bargeIn()
        autoSubmitUtterance = current?.connection == VoiceConnection.CONNECTED &&
            !draft.hasFocus() && draft.length() == 0 && current.pendingText == null
        scheduleRender()
    }

    override fun onPartialTranscript(text: String) {
        if (capture != Capture.HEARING) return
        partial.showText(text.takeIf { it.isNotBlank() }?.let { getString(R.string.voice_recognized, it) })
    }

    override fun onFinalTranscript(text: String) {
        if (capture != Capture.HEARING) return
        capture = Capture.LISTENING
        val sendNow = autoSubmitUtterance && !draft.hasFocus() && draft.length() == 0 && session?.canAutoSubmit == true
        autoSubmitUtterance = false
        partial.showText(null)
        if (text.isNotBlank()) {
            if (draft.length() != 0) draft.append("\n")
            draft.append(text)
            if (sendNow) submit(toQueue = false, automatic = true)
        }
        scheduleRender()
    }

    override fun onCaptureError(message: String) {
        if (capture == Capture.OFF) return
        captureError = message
        stopCapture()
        scheduleRender()
    }

    override fun onPlaybackChanged() {
        if (audio?.playbackState == Playback.PLAYING) playbackError = null
        scheduleRender()
    }

    override fun onPlaybackError(message: String) {
        if (!resumed) return
        playbackError = message
        scheduleRender()
    }

    private fun scheduleRender() {
        if (renderScheduled) return
        renderScheduled = true
        root.postDelayed(renderQueued, 40)
    }

    private fun render() {
        val current = session
        updateCapture(current?.connection)
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
        controls.visibility = if (current != null && !imeVisible) View.VISIBLE else View.GONE
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
                current.generating || current.pendingText != null || playback == Playback.PREPARING -> R.string.voice_status_processing
                muted -> R.string.voice_status_muted
                recording -> R.string.voice_status_listening
                else -> R.string.voice_status_preparing
            }
        }
        if (displayedStatus != statusRes) {
            displayedStatus = statusRes
            status.setText(statusRes)
            recordStatus.setText(statusRes)
        }
        val queued = current.queuedCount
        val hintText = when {
            draft.text.isNotBlank() -> getString(R.string.voice_hint_draft)
            statusRes == R.string.voice_status_mic_permission -> getString(
                if (micAccess == MicAccess.SETTINGS) R.string.voice_hint_mic_settings else R.string.voice_hint_mic_permission,
            )
            playbackError != null && playback == Playback.IDLE -> getString(R.string.voice_hint_playback_error)
            statusRes == R.string.voice_status_listening && queued > 0 ->
                resources.getQuantityString(R.plurals.voice_queued_count, queued, queued)
            statusRes == R.string.voice_status_listening ->
                getString(if (current.canAutoSubmit) R.string.voice_hint_speak else R.string.voice_hint_review)
            statusRes == R.string.voice_status_speaking && recording -> getString(R.string.voice_hint_interrupt)
            else -> null
        }
        hint.showText(hintText)
        val reconnecting = current.connection == VoiceConnection.RECONNECTING
        recovery.visibility = if (reconnecting || current.unknown || current.queueUnavailable) View.VISIBLE else View.GONE
        recovery.setText(when {
            current.unknown -> R.string.voice_check_delivery
            current.queueUnavailable -> R.string.voice_retry
            else -> R.string.voice_reconnect
        })
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
        val follow = !draft.hasFocus() && !records.canScrollVertically(1)
        val rows = current.rows
        if (rows != displayedRows) {
            displayedRows = rows
            history.text = if (rows.isEmpty()) getString(R.string.voice_transcript_empty) else SpannableStringBuilder().apply {
                rows.forEachIndexed { index, row ->
                    if (index != 0) append("\n\n")
                    val start = length
                    append(getString(when (row.role) {
                        "user" -> R.string.voice_transcript_you
                        "tool" -> R.string.voice_transcript_tool_output
                        else -> R.string.voice_transcript_codex
                    }))
                    setSpan(StyleSpan(Typeface.BOLD), start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    append('\n').append(row.content)
                }
            }
            if (follow) showLatest()
        }

        val queued = current.queuedCount
        note.showText(listOfNotNull(
            current.note,
            captureError?.takeIf { it.isNotBlank() },
            playbackError?.takeIf { it.isNotBlank() },
            if (queued > 0) resources.getQuantityString(R.plurals.voice_queued_count, queued, queued) else null,
        ).joinToString("\n"))
        composer.visibility = if (current.opened) View.VISIBLE else View.GONE
        pending.showText(current.pendingText?.let { getString(R.string.voice_pending, it) })
        val hasDraft = draft.text.isNotBlank()
        send.isEnabled = current.route != null && hasDraft
        send.setText(if (current.route == SendRoute.STEER) R.string.voice_steer else R.string.voice_send)
        enqueue.isEnabled = current.canQueue && hasDraft
    }

    private fun TextView.showText(message: String?) {
        if (text != message.orEmpty()) text = message.orEmpty()
        visibility = if (message.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    private fun showLatest() {
        records.post { records.scrollTo(0, records.getChildAt(0).height) }
    }

    private fun bindPage() {
        root = findViewById(R.id.voice_root)
        title = findViewById(R.id.voice_title)
        screenAction = findViewById<Button>(R.id.voice_screen_action).apply { setOnClickListener { toggleTranscript() } }
        call = findViewById(R.id.voice_call)
        wave = findViewById(R.id.voice_wave)
        status = findViewById(R.id.voice_status)
        hint = findViewById(R.id.voice_hint)
        web = findViewById<Button>(R.id.voice_web).apply { setOnClickListener { openWeb() } }
        recovery = findViewById<Button>(R.id.voice_recovery).apply { setOnClickListener { session?.check() } }
        stopReply = findViewById<Button>(R.id.voice_stop_reply).apply { setOnClickListener { silence() } }
        records = findViewById(R.id.voice_records)
        recordStatus = findViewById(R.id.voice_records_status)
        history = findViewById(R.id.voice_history)
        note = findViewById(R.id.voice_note)
        composer = findViewById(R.id.voice_composer)
        draft = findViewById(R.id.voice_draft)
        partial = findViewById(R.id.voice_partial)
        pending = findViewById(R.id.voice_pending)
        send = findViewById<Button>(R.id.voice_send).apply { setOnClickListener { submit(toQueue = false) } }
        enqueue = findViewById<Button>(R.id.voice_enqueue).apply { setOnClickListener { submit(toQueue = true) } }
        picker = findViewById(R.id.voice_picker)
        pickerStatus = findViewById(R.id.voice_picker_status)
        choices = findViewById(R.id.voice_choices)
        more = findViewById<Button>(R.id.voice_more).apply { setOnClickListener { loadRecent() } }
        controls = findViewById(R.id.voice_controls)
        mic = findViewById<Button>(R.id.voice_mic).apply { setOnClickListener { toggleMic() } }
        findViewById<Button>(R.id.voice_end).setOnClickListener { endCall() }
        findViewById<Button>(R.id.voice_records_web).setOnClickListener { openWeb() }
        findViewById<Button>(R.id.voice_picker_web).setOnClickListener { openWeb() }
        draft.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                autoSubmitUtterance = false
                scheduleRender()
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })
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
                imeVisible = insets.isVisible(WindowInsets.Type.ime())
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                view.setPadding(safe.left + left, safe.top + top, safe.right + right, safe.bottom + bottom)
                controls.visibility = if (session != null && !imeVisible) View.VISIBLE else View.GONE
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
