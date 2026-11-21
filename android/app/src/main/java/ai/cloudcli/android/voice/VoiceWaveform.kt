package ai.cloudcli.android.voice

import ai.cloudcli.android.R
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.sin

internal class VoiceWaveform(context: Context, attrs: AttributeSet) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = context.getColor(R.color.voice_blue) }
    private val heights = floatArrayOf(0.34f, 0.67f, 1f, 0.61f, 0.36f)
    private var phase = 0f
    private val pulse = ValueAnimator.ofFloat(0f, (2 * PI).toFloat()).apply {
        duration = 1_450
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            phase = it.animatedValue as Float
            invalidate()
        }
    }

    fun setMotion(active: Boolean) {
        if (active && ValueAnimator.areAnimatorsEnabled()) {
            if (!pulse.isStarted) pulse.start()
        } else if (pulse.isStarted) {
            pulse.cancel()
            phase = 0f
            invalidate()
        }
    }

    override fun onDetachedFromWindow() {
        setMotion(false)
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val size = minOf(width, height).toFloat()
        val radius = size * 0.031f
        val y = height / 2f
        val moving = pulse.isStarted
        for ((index, barHeight) in heights.withIndex()) {
            val x = width / 2f + (index - 2) * size * 0.113f
            val scale = if (moving) 0.92f + 0.10f * sin(phase + index) else 1f
            val halfHeight = size * 0.225f * barHeight * scale
            canvas.drawRoundRect(x - radius, y - halfHeight, x + radius, y + halfHeight, radius, radius, paint)
        }
    }
}
