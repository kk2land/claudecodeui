package ai.cloudcli.android.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import java.util.concurrent.Executors

class VoiceAudio(context: Context, private val listener: Listener) : AutoCloseable {
    enum class Playback { IDLE, PREPARING, PLAYING }

    interface Listener {
        fun onCaptureReady()
        fun onSpeechStart()
        fun onPartialTranscript(text: String)
        fun onFinalTranscript(text: String)
        fun onCaptureError(message: String)
        fun onPlaybackChanged()
        fun onPlaybackError(message: String)
    }

    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audioManager = app.getSystemService(AudioManager::class.java)
    private val inputWorker = Executors.newSingleThreadExecutor { Thread(it, "Voice input") }
    private val outputWorker = Executors.newSingleThreadExecutor { Thread(it, "Voice synthesis") }

    // Keep inference and blocking reads outside this lock. Track writes under it are non-blocking.
    private val audioLock = Any()
    private var closed = false
    private var listening = false
    private var captureGeneration = 0L
    private var userSpeaking = false
    private var recorder: AudioRecord? = null
    private var track: AudioTrack? = null
    private var communicationActive = false
    private var previousSpeakerphone = false
    private var playbackGeneration = 0L
    private var playback = Playback.IDLE
    private val speechQueue = ArrayDeque<String>()
    private var rendering = false

    val playbackState: Playback get() = synchronized(audioLock) { playback }

    // Each model is used and released only on its own worker.
    private var vad: Vad? = null
    private var recognizer: OnlineRecognizer? = null
    private var tts: OfflineTts? = null

    private val audioDevices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refreshRoute()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refreshRoute()
    }

    fun setListening(enabled: Boolean) {
        synchronized(audioLock) {
            if (closed || listening == enabled) return
            listening = enabled
            val generation = ++captureGeneration
            if (enabled) {
                inputWorker.execute { capture(generation) }
            } else {
                stopRecordingLocked()
            }
        }
    }

    fun speak(text: String) {
        val utterance = text.trim()
        if (utterance.isEmpty()) return
        synchronized(audioLock) {
            if (closed || userSpeaking) return
            speechQueue.addLast(utterance)
            if (playback == Playback.IDLE) setPlaybackLocked(Playback.PREPARING)
            if (!rendering) {
                rendering = true
                outputWorker.execute(::renderSpeechQueue)
            }
        }
    }

    fun stopPlayback() {
        synchronized(audioLock) { cancelPlaybackLocked() }
    }

    override fun close() {
        synchronized(audioLock) {
            if (closed) return
            closed = true
            listening = false
            stopRecordingLocked()
            cancelPlaybackLocked()
            inputWorker.execute {
                recognizer?.release()
                vad?.release()
            }
            outputWorker.execute { tts?.release() }
            inputWorker.shutdown()
            outputWorker.shutdown()
        }
    }

    private fun capture(generation: Long) {
        if (!isListening(generation)) return
        runCatching {
            if (app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                error("Microphone permission is required")
            }
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            val detector = vad ?: Vad(
                app.assets,
                VadModelConfig(
                    sileroVadModelConfig = SileroVadModelConfig(
                        model = "voice/silero_vad_v5.onnx",
                        windowSize = VAD_WINDOW,
                        minSpeechDuration = 0.032f,
                        minSilenceDuration = 0.65f,
                        maxSpeechDuration = 60f,
                    ),
                    sampleRate = INPUT_RATE,
                ),
            ).also { vad = it }
            val asr = recognizer ?: OnlineRecognizer(
                app.assets,
                OnlineRecognizerConfig(
                    featConfig = FeatureConfig(sampleRate = INPUT_RATE, featureDim = 80),
                    modelConfig = OnlineModelConfig(
                        transducer = OnlineTransducerModelConfig(
                            encoder = "$ZIPFORMER/encoder-epoch-99-avg-1.int8.onnx",
                            decoder = "$ZIPFORMER/decoder-epoch-99-avg-1.int8.onnx",
                            joiner = "$ZIPFORMER/joiner-epoch-99-avg-1.int8.onnx",
                        ),
                        tokens = "$ZIPFORMER/tokens.txt",
                    ),
                    enableEndpoint = false,
                ),
            ).also { recognizer = it }
            if (!isListening(generation)) return

            val bufferBytes = AudioRecord.getMinBufferSize(
                INPUT_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            )
            check(bufferBytes > 0) { "16 kHz microphone capture is unavailable ($bufferBytes)" }
            val input = AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioFormat(AudioFormat.Builder()
                    .setSampleRate(INPUT_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build())
                .setBufferSizeInBytes(maxOf(bufferBytes, VAD_WINDOW * 4))
                .build()
            var echoCanceler: AcousticEchoCanceler? = null
            try {
                if (AcousticEchoCanceler.isAvailable()) {
                    echoCanceler = AcousticEchoCanceler.create(input.audioSessionId)
                    echoCanceler?.setEnabled(true)
                }
                synchronized(audioLock) {
                    if (!isListening(generation)) return
                    recorder = input
                    updateCommunicationLocked()
                    input.startRecording()
                    check(input.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        "Microphone capture did not start"
                    }
                }
                postInput(generation, listener::onCaptureReady)
                recognize(input, detector, asr, generation)
            } finally {
                synchronized(audioLock) {
                    if (recorder === input) stopRecordingLocked()
                }
                echoCanceler?.release()
                input.release()
            }
        }.onFailure { failure ->
            synchronized(audioLock) {
                if (!isListening(generation)) return
                listening = false
            }
            postInput(generation) { listener.onCaptureError(failure.message.orEmpty()) }
        }
    }

    private fun recognize(input: AudioRecord, detector: Vad, asr: OnlineRecognizer, generation: Long) {
        val pcm = ShortArray(VAD_WINDOW)
        val preRoll = ArrayDeque<FloatArray>(PRE_ROLL_WINDOWS)
        var buffered = 0
        var stream: OnlineStream? = null
        var partial = ""
        var speechWindows = 0
        try {
            while (isListening(generation)) {
                val count = input.read(pcm, buffered, pcm.size - buffered, AudioRecord.READ_BLOCKING)
                if (!isListening(generation)) break
                check(count >= 0) { "Microphone read failed ($count)" }
                buffered += count
                if (buffered < pcm.size) continue
                buffered = 0
                val frame = FloatArray(pcm.size) { pcm[it] / 32768f }
                detector.acceptWaveform(frame)
                val speechDetected = detector.isSpeechDetected()
                if (stream == null) {
                    if (!speechDetected) {
                        if (preRoll.size == PRE_ROLL_WINDOWS) preRoll.removeFirst()
                        preRoll.addLast(frame)
                        continue
                    }
                    synchronized(audioLock) {
                        if (!isListening(generation)) return
                        userSpeaking = true
                        cancelPlaybackLocked()
                    }
                    postInput(generation, listener::onSpeechStart)
                    stream = asr.createStream()
                    for (previous in preRoll) stream.acceptWaveform(previous, INPUT_RATE)
                    preRoll.clear()
                }

                stream.acceptWaveform(frame, INPUT_RATE)
                val reachedLimit = ++speechWindows == MAX_SPEECH_WINDOWS
                val endpoint = !speechDetected || reachedLimit
                if (endpoint) {
                    if (reachedLimit) stream.acceptWaveform(FloatArray(INPUT_RATE / 2), INPUT_RATE)
                    stream.inputFinished()
                } else if (!asr.isReady(stream)) {
                    continue
                }
                while (asr.isReady(stream)) asr.decode(stream)
                val text = asr.getResult(stream).text.trim()
                if (endpoint) {
                    stream.release()
                    stream = null
                    if (reachedLimit) detector.reset() else detector.clear()
                    partial = ""
                    speechWindows = 0
                    synchronized(audioLock) { userSpeaking = false }
                    postInput(generation) { listener.onFinalTranscript(text) }
                } else if (text != partial) {
                    partial = text
                    postInput(generation) { listener.onPartialTranscript(text) }
                }
            }
        } finally {
            stream?.release()
            detector.reset()
        }
    }

    private fun isListening(generation: Long): Boolean = synchronized(audioLock) {
        listening && generation == captureGeneration
    }

    private fun postInput(generation: Long, callback: () -> Unit) {
        main.post {
            if (synchronized(audioLock) { !closed && generation == captureGeneration }) callback()
        }
    }

    private fun stopRecordingLocked() {
        if (recorder?.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder?.stop()
        recorder = null
        userSpeaking = false
        updateCommunicationLocked()
    }

    private fun renderSpeechQueue() {
        while (true) {
            val (text, generation) = synchronized(audioLock) {
                val utterance = speechQueue.removeFirstOrNull()
                if (utterance == null) {
                    rendering = false
                    setPlaybackLocked(Playback.IDLE)
                    return
                }
                setPlaybackLocked(Playback.PREPARING)
                utterance to playbackGeneration
            }
            runCatching { renderSpeech(text, generation) }.onFailure { failure ->
                main.post {
                    if (isPlaybackCurrent(generation)) {
                        listener.onPlaybackError(failure.message.orEmpty())
                    }
                }
            }
        }
    }

    private fun renderSpeech(text: String, generation: Long) {
        if (!isPlaybackCurrent(generation)) return
        val engine = tts ?: OfflineTts(
            app.assets,
            OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    kokoro = OfflineTtsKokoroModelConfig(
                        model = "$KOKORO/model.int8.onnx",
                        voices = "$KOKORO/voices.bin",
                        tokens = "$KOKORO/tokens.txt",
                        lexicon = "$KOKORO/lexicon-us-en.txt,$KOKORO/lexicon-zh.txt",
                    ),
                    numThreads = 2,
                ),
                ruleFsts = "$KOKORO/phone-zh.fst,$KOKORO/date-zh.fst,$KOKORO/number-zh.fst",
            ),
        ).also { tts = it }
        if (!isPlaybackCurrent(generation)) return
        val rate = engine.sampleRate()
        val bufferBytes = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        check(bufferBytes > 0) { "Voice playback sample rate is unavailable ($bufferBytes)" }
        val output = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
            .setAudioFormat(AudioFormat.Builder()
                .setSampleRate(rate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                .build())
            .setBufferSizeInBytes(bufferBytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        try {
            synchronized(audioLock) {
                if (generation != playbackGeneration) return
                track = output
                updateCommunicationLocked()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) output.setStartThresholdInFrames(1)
                output.play()
            }

            var writtenFrames = 0
            var writeError = 0
            // Sherpa's JNI looks up the typed invoke(float[]) method on the callback class.
            val callback = object : (FloatArray) -> Int {
                override fun invoke(samples: FloatArray): Int {
                    var offset = 0
                    while (offset < samples.size) {
                        val written = synchronized(audioLock) {
                            if (generation != playbackGeneration) return 0
                            output.write(samples, offset, samples.size - offset, AudioTrack.WRITE_NON_BLOCKING).also {
                                if (it > 0) setPlaybackLocked(Playback.PLAYING)
                            }
                        }
                        if (written < 0) {
                            writeError = written
                            return 0
                        }
                        if (written == 0) SystemClock.sleep(8)
                        offset += written
                    }
                    writtenFrames += offset
                    return 1
                }
            }
            val config = GenerationConfig(sid = 3) // Kokoro v1.1-zh's zf_001 speaker.
            var start = 0
            while (start < text.length && writeError == 0 && isPlaybackCurrent(generation)) {
                var end = minOf(start + SYNTHESIS_CHARS, text.length)
                if (end < text.length) {
                    val boundary = (end - 1 downTo start + SYNTHESIS_CHARS / 2).firstOrNull {
                        text[it].isWhitespace() || text[it] in "。！？；，.!?;,"
                    }
                    if (boundary != null) end = boundary + 1
                    else if (text[end - 1].isHighSurrogate()) end--
                }
                engine.generateWithConfigAndCallback(text.substring(start, end), config, callback)
                start = end
            }
            check(writeError == 0) { "AudioTrack write failed ($writeError)" }
            // The final write can leave audio in the hardware buffer, especially on headsets.
            while (synchronized(audioLock) {
                generation == playbackGeneration && output.playbackHeadPosition < writtenFrames
            }) {
                SystemClock.sleep(8)
            }
        } finally {
            synchronized(audioLock) {
                if (track === output) {
                    track = null
                    updateCommunicationLocked()
                }
            }
            output.release()
        }
    }

    private fun isPlaybackCurrent(generation: Long): Boolean = synchronized(audioLock) {
        generation == playbackGeneration
    }

    private fun cancelPlaybackLocked() {
        ++playbackGeneration
        speechQueue.clear()
        track?.let { output ->
            if (output.playState == AudioTrack.PLAYSTATE_PLAYING) output.pause()
            output.flush()
        }
        track = null
        updateCommunicationLocked()
        setPlaybackLocked(Playback.IDLE)
    }

    private fun setPlaybackLocked(next: Playback) {
        if (playback == next) return
        playback = next
        // The main thread reads the current snapshot, including any cancellation since this post.
        main.post { if (synchronized(audioLock) { !closed }) listener.onPlaybackChanged() }
    }

    @Suppress("DEPRECATION")
    private fun updateCommunicationLocked() {
        val active = recorder != null || track != null
        if (active == communicationActive) return
        communicationActive = active
        if (active) {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                previousSpeakerphone = audioManager.isSpeakerphoneOn
            }
            audioManager.registerAudioDeviceCallback(audioDevices, main)
            selectRouteLocked()
        } else {
            audioManager.unregisterAudioDeviceCallback(audioDevices)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.clearCommunicationDevice()
            else audioManager.isSpeakerphoneOn = previousSpeakerphone
            audioManager.mode = AudioManager.MODE_NORMAL
        }
    }

    private fun refreshRoute() {
        synchronized(audioLock) { if (communicationActive) selectRouteLocked() }
    }

    @Suppress("DEPRECATION")
    private fun selectRouteLocked() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = audioManager.availableCommunicationDevices
            val selected = devices.firstOrNull { it.type in HEADSET_TYPES }
                ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            if (selected != null && audioManager.communicationDevice?.id != selected.id) {
                audioManager.setCommunicationDevice(selected)
            }
        } else {
            audioManager.isSpeakerphoneOn = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                .none { it.type in HEADSET_TYPES }
        }
    }

    private companion object {
        const val INPUT_RATE = 16_000
        const val VAD_WINDOW = 512
        const val PRE_ROLL_WINDOWS = 6 // 192 ms at 16 kHz.
        const val MAX_SPEECH_WINDOWS = 30 * INPUT_RATE / VAD_WINDOW
        const val SYNTHESIS_CHARS = 400
        const val ZIPFORMER = "voice/zipformer"
        const val KOKORO = "voice/kokoro"
        val HEADSET_TYPES = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_HEARING_AID,
        )
    }
}
