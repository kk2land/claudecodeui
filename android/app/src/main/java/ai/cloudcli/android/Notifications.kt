package ai.cloudcli.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Channels and notification publishing (contract §3.8). */
object Notifications {

    const val CHANNEL_SERVICE = "cloudcli-service"
    const val CHANNEL_EVENTS = "cloudcli-events"

    private const val SERVICE_NOTIFICATION_ID = 1001
    private const val EVENTS_NOTIFICATION_BASE_ID = 2000

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val service = NotificationChannel(
            CHANNEL_SERVICE,
            context.getString(R.string.channel_service_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.channel_service_description)
            setShowBadge(false)
        }
        val events = NotificationChannel(
            CHANNEL_EVENTS,
            context.getString(R.string.channel_events_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.channel_events_description)
        }
        manager.createNotificationChannel(service)
        manager.createNotificationChannel(events)
    }

    fun canPostEvents(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        val granted = ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        return granted && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** Posts one user notification. Returns false when the permission is missing. */
    fun postEvent(
        context: Context,
        tag: String,
        title: String,
        body: String,
        sessionId: String?,
    ): Boolean {
        if (!canPostEvents(context)) return false
        val notification: Notification = NotificationCompat.Builder(context, CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(contentIntent(context, sessionId, tag.hashCode()))
            .build()
        return try {
            NotificationManagerCompat.from(context).notify(tag, EVENTS_NOTIFICATION_BASE_ID, notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    fun foregroundNotification(context: Context): Notification {
        val stopIntent = Intent(context, NotificationService::class.java)
            .setAction(NotificationService.ACTION_DISABLE)
        val stop = PendingIntent.getService(
            context,
            2,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.service_title))
            .setContentText(context.getString(R.string.service_description))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, context.getString(R.string.service_stop), stop)
            .build()
    }

    fun foregroundNotificationId(): Int = SERVICE_NOTIFICATION_ID

    private fun contentIntent(context: Context, sessionId: String?, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (!sessionId.isNullOrBlank()) {
            intent.putExtra(MainActivity.EXTRA_SESSION_ID, sessionId)
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
