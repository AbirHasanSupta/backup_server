package com.abirsupta.phonebackup;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class BackupRewindNotifier {
  private static final String CHANNEL_ID = "random_rewind";
  private static final int NOTIFICATION_ID = 8420;
  private static final String PREFS_NAME = BackupWidgetModule.PREFS_NAME;
  private static final String KEY_LAST_NOTIFIED_DATE = "last_notified_date";

  private BackupRewindNotifier() {}

  static void maybeNotify(Context context, Bitmap bitmap, String label) {
    if (bitmap == null) return;
    if (!isNewDay(context)) return;

    try {
      ensureChannel(context);

      Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
      PendingIntent contentIntent = null;
      if (launchIntent != null) {
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        contentIntent = PendingIntent.getActivity(context, 0, launchIntent, flags);
      }

      NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.notification_icon)
        .setContentTitle("Random Rewind")
        .setContentText(label)
        .setLargeIcon(bitmap)
        .setStyle(new NotificationCompat.BigPictureStyle()
          .bigPicture(bitmap)
          .bigLargeIcon((Bitmap) null))
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true);

      if (contentIntent != null) {
        builder.setContentIntent(contentIntent);
      }

      NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
      markNotifiedToday(context);
    } catch (SecurityException ignored) {
    } catch (Exception ignored) {
    }
  }

  static void clearForNewDay(Context context) {
    if (!isNewDay(context)) return;
    try {
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
    } catch (Exception ignored) {
    }
    markNotifiedToday(context);
  }

  private static boolean isNewDay(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    String lastNotified = prefs.getString(KEY_LAST_NOTIFIED_DATE, null);
    return !todayStr().equals(lastNotified);
  }

  private static void markNotifiedToday(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    prefs.edit().putString(KEY_LAST_NOTIFIED_DATE, todayStr()).apply();
  }

  private static String todayStr() {
    return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
  }

  private static void ensureChannel(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return;
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return;

    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      "Random Rewind",
      NotificationManager.IMPORTANCE_DEFAULT
    );
    channel.setDescription("Daily memory thumbnail on your lock screen");
    channel.setSound(null, null);
    channel.enableVibration(false);
    manager.createNotificationChannel(channel);
  }
}
