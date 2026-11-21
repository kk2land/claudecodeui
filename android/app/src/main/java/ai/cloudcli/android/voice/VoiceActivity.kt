package ai.cloudcli.android.voice

import ai.cloudcli.android.AppRuntime
import ai.cloudcli.android.MainActivity
import ai.cloudcli.android.R
import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView

/** Foreground microphone, playback and transcript for one verified Codex app-server session. */
class VoiceActivity : Activity(), VoiceAudio.Listener {
    private var api: VoiceApi? = null
    private var session: VoiceSession? = null
    private var audio: VoiceAudio? = null
    private var started = false
    private var resumed = false
    private var micOn = false
    private var autoSubmitUtterance = false
    private var selectorLoading = false
    private var selectorError = false
    private var selectorMessage = "Choose a recent Codex session."
    private var nextOffset: Int? = 0

    private lateinit var root: LinearLayout
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var note: TextView
    private lateinit var spinner: ProgressBar
    private lateinit var web: Button
    private lateinit var check: Button
    private lateinit var scroll: ScrollView
    private lateinit var list: LinearLayout
    private lateinit var more: Button
    private lateinit var transcript: TextView
    private lateinit var composer: LinearLayout
    private lateinit var draft: EditText
    private lateinit var partial: TextView
    private lateinit var pending: TextView
    private lateinit var audioStatus: TextView
    private lateinit var mic: Button
    private lateinit var send: Button
    private lateinit var enqueue: Button
    private var displayedRows = emptyList<VoiceRow>()

    private var renderScheduled = false
    private val renderQueued = Runnable {
        renderScheduled = false
        render()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppRuntime.init(applicationContext)
        buildPage()
        val origin = AppRuntime.prefs.siteOrigin
        if (origin == null || !AppRuntime.prefs.signedIn()) {
            selectorMessage = if (origin == null) "Set up your CloudCLI server first." else "Sign in to CloudCLI on the web."
            render()
            return
        }
        api = VoiceApi(origin)
        draft.setText(savedInstanceState?.getString("draft").orEmpty())
        val preferred = savedInstanceState?.getString("session") ?: intent.getStringExtra(MainActivity.EXTRA_SESSION_ID)
        if (preferred == null) {
            loadRecent()
        } else {
            val data = savedInstanceState?.getBundle("pending")
            val restored = data?.let {
                VoiceSubmission(it.getString("text").orEmpty(), it.getString("client").orEmpty(), it.getString("turn")).apply {
                    queueId = it.getString("queue")
                    steerId = it.getString("steer")
                }
            }
            select(VoiceChoice(preferred, savedInstanceState?.getString("title") ?: getString(R.string.action_voice)), restored)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        val current = session
        val unresolved = current?.unconfirmed
        outState.putString("draft", listOfNotNull(current?.pendingText?.takeIf { unresolved == null }, draft.text.toString())
            .filter { it.isNotBlank() }.joinToString("\n"))
        outState.putString("session", current?.choice?.id)
        outState.putString("title", current?.choice?.title)
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
        updateMic()
    }

    override fun onPause() {
        resumed = false
        micOn = false
        autoSubmitUtterance = false
        partial.text = ""
        audio?.setListening(false)
        silence()
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
        session = VoiceSession(client, choice, ::scheduleRender, {
            session?.close()
            session = null
            selectorMessage = "Voice chat requires Codex app-server. Choose a recent Codex session."
            if (list.childCount == 0 && !selectorLoading) loadRecent() else render()
        }, { text ->
            draft.text.insert(0, if (draft.length() == 0) text else "$text\n")
        }, { text ->
            if (resumed) audio().speak(text)
        }, { audio?.stopPlayback() }, restored)
        if (started) session?.start()
        render()
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
                    val label = listOfNotNull(choice.title, choice.project).joinToString("\n")
                    list.addView(button(label) { select(choice) }.apply { gravity = Gravity.START or Gravity.CENTER_VERTICAL })
                }
                if (list.childCount == 0 && nextOffset == null) selectorMessage = "No recent Codex sessions."
            }.onFailure {
                selectorError = true
                selectorMessage = "Could not load recent sessions. ${it.message.orEmpty()}"
            }
            render()
        }
    }

    private fun openWeb() {
        val choice = session?.choice
        if (choice != null) {
            setResult(RESULT_OK, Intent().putExtra(MainActivity.EXTRA_SESSION_ID, choice.id).putExtra(EXTRA_ORIGIN, api?.origin))
        }
        finish()
    }

    private fun submit(toQueue: Boolean, automatic: Boolean = false) {
        val current = session ?: return
        val client = api ?: return
        val raw = draft.text.toString()
        val text = raw.trim()
        if (text.isEmpty()) return
        draft.text.clear()
        val started = current.submit(text, toQueue, automatic) { result -> MainActivity.readVoicePermissionMode(client.origin, current.choice.id, result) }
        if (!started) draft.setText(raw)
    }

    private fun audio(): VoiceAudio = audio ?: VoiceAudio(this, this).also { audio = it }

    private fun silence() {
        session?.silence()
        audio?.stopPlayback()
    }

    private fun toggleMic() {
        audioStatus.text = ""
        if (micOn) {
            micOn = false
            autoSubmitUtterance = false
            partial.text = ""
        } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            micOn = true
        } else {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
        }
        updateMic()
        render()
    }

    private fun updateMic() {
        val listening = resumed && micOn && session?.opened == true &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (listening) audio().setListening(true) else audio?.setListening(false)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MIC) return
        micOn = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        if (!micOn) audioStatus.setText(R.string.voice_mic_denied)
        updateMic()
        render()
    }

    override fun onSpeechStart() {
        session?.bargeIn()
        autoSubmitUtterance = draft.length() == 0 && session?.pendingText == null
    }

    override fun onPartialTranscript(text: String) {
        if (resumed && micOn) {
            partial.text = text
            partial.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
        }
    }

    override fun onFinalTranscript(text: String) {
        if (!resumed || !micOn) return
        val sendNow = autoSubmitUtterance && draft.length() == 0 && session?.canAutoSubmit == true
        autoSubmitUtterance = false
        partial.text = ""
        partial.visibility = View.GONE
        if (text.isNotBlank()) {
            if (draft.length() != 0) draft.append("\n")
            draft.append(text)
            if (sendNow) submit(toQueue = false, automatic = true)
        }
    }

    override fun onAudioError(message: String) {
        if (resumed) {
            audioStatus.text = message
            audioStatus.visibility = View.VISIBLE
        }
    }

    private fun scheduleRender() {
        if (renderScheduled) return
        renderScheduled = true
        root.postDelayed(renderQueued, 40)
    }

    private fun render() {
        val current = session
        title.text = current?.choice?.title ?: getString(R.string.action_voice)
        status.text = if (selectorLoading) "Loading recent sessions…" else current?.status ?: selectorMessage
        spinner.visibility = if (selectorLoading || current?.loading == true) View.VISIBLE else View.GONE
        web.setText(if (current == null) R.string.voice_open_site else R.string.voice_open_web)
        web.isActivated = current?.waitingForWeb == true
        check.visibility = if (current != null && !current.loading || selectorError) View.VISIBLE else View.GONE
        check.setText(if (current?.unknown == true) R.string.voice_check_delivery else R.string.voice_check)
        note.text = current?.note.orEmpty()
        note.visibility = if (note.length() > 0) View.VISIBLE else View.GONE
        list.visibility = if (current == null) View.VISIBLE else View.GONE
        transcript.visibility = if (current == null) View.GONE else View.VISIBLE
        composer.visibility = if (current?.opened == true) View.VISIBLE else View.GONE
        more.visibility = if (current == null && !selectorLoading && !selectorError && api != null && nextOffset != null) View.VISIBLE else View.GONE
        if (current != null) {
            mic.isEnabled = current.opened
            mic.setText(if (micOn) R.string.voice_mute_mic else R.string.voice_enable_mic)
            partial.visibility = if (partial.length() == 0) View.GONE else View.VISIBLE
            audioStatus.visibility = if (audioStatus.length() == 0) View.GONE else View.VISIBLE
            pending.text = current.pendingText.orEmpty()
            pending.visibility = if (pending.length() == 0) View.GONE else View.VISIBLE
            send.isEnabled = current.route != null && draft.text.isNotBlank()
            send.setText(if (current.route == SendRoute.STEER) R.string.voice_steer else R.string.voice_send)
            enqueue.isEnabled = current.canQueue && draft.text.isNotBlank()
            val rows = current.rows
            if (rows != displayedRows) {
                val follow = scroll.scrollY + scroll.height >= transcript.height - dp(40)
                displayedRows = rows
                transcript.text = SpannableStringBuilder().apply {
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
                if (follow) scroll.post { scroll.scrollTo(0, transcript.height) }
            }
        }
        updateMic()
    }

    private fun buildPage() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        setContentView(root)
        applyInsets()

        title = label(23f).apply {
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
        }
        root.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(button(R.string.voice_end) { finish() })
        })
        status = label(15f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        root.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(status, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            spinner = ProgressBar(this@VoiceActivity, null, android.R.attr.progressBarStyleSmall)
            addView(spinner, LinearLayout.LayoutParams(dp(24), dp(24)))
        })
        web = button(R.string.voice_open_site, ::openWeb)
        check = button(R.string.voice_check) { session?.check() ?: loadRecent() }
        root.addView(buttonRow(web, check))
        note = label(14f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        root.addView(note)

        transcript = label(16f).apply {
            setTextIsSelectable(true)
            setPadding(dp(12), dp(10), dp(12), dp(14))
        }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(Color.WHITE)
            addView(LinearLayout(this@VoiceActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(list)
                addView(transcript)
            })
        }
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        more = button(R.string.voice_more_sessions, ::loadRecent)
        root.addView(more)

        composer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        pending = label(14f).apply {
            maxLines = 3
            setTextIsSelectable(true)
        }
        audioStatus = label(14f)
        partial = label(15f).apply { maxLines = 2 }
        draft = EditText(this).apply {
            setHint(R.string.voice_draft_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setTextSize(16f)
            minLines = 2
            maxLines = 4
            gravity = Gravity.TOP or Gravity.START
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    autoSubmitUtterance = false
                    scheduleRender()
                }
                override fun afterTextChanged(s: Editable?) = Unit
            })
        }
        composer.addView(pending)
        composer.addView(partial)
        composer.addView(audioStatus)
        composer.addView(draft)
        send = button(R.string.voice_send) { submit(toQueue = false) }
        enqueue = button(R.string.voice_enqueue) { submit(toQueue = true) }
        composer.addView(buttonRow(send, enqueue))
        mic = button(R.string.voice_enable_mic, ::toggleMic)
        composer.addView(buttonRow(mic, button(R.string.voice_stop_speech, ::silence)))
        root.addView(composer)
    }

    private fun applyInsets() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            val appearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(appearance, appearance)
            root.setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                view.setPadding(safe.left + dp(16), safe.top + dp(12), safe.right + dp(16), safe.bottom + dp(12))
                insets
            }
            root.requestApplyInsets()
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
    }

    private fun label(size: Float) = TextView(this).apply {
        textSize = size
        setTextColor(INK)
    }

    private fun button(resource: Int, action: () -> Unit) = button(getString(resource), action)

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        setAllCaps(false)
        minimumWidth = 0
        minHeight = dp(48)
        setOnClickListener { action() }
    }

    private fun buttonRow(vararg buttons: Button) = LinearLayout(this).apply {
        for (button in buttons) addView(button, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun dp(value: Int) = (resources.displayMetrics.density * value + 0.5f).toInt()

    companion object {
        internal const val EXTRA_ORIGIN = "ai.cloudcli.android.extra.VOICE_ORIGIN"
        private const val REQUEST_MIC = 21
        private val BACKGROUND = Color.rgb(244, 246, 249)
        private val INK = Color.rgb(22, 34, 50)
    }
}
