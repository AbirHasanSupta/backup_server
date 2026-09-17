package com.abirsupta.phonebackup;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class BackupWidgetProvider extends AppWidgetProvider {
  private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
  private static final int CONNECT_TIMEOUT_MS = 8000;
  private static final int READ_TIMEOUT_MS = 8000;
  private static final int MAX_THUMBNAIL_PX = 480;

  @Override
  public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
    updateWidgets(context, appWidgetManager, appWidgetIds);
  }

  public static void updateWidgets(Context context, final AppWidgetManager appWidgetManager, final int[] appWidgetIds) {
    final Context appContext = context.getApplicationContext();
    EXECUTOR.execute(new Runnable() {
      @Override
      public void run() {
        WidgetContent content = fetchWidgetContent(appContext);
        if (content != null) {
          BackupRewindNotifier.maybeNotify(appContext, content.bitmap, content.label);
        } else {
          BackupRewindNotifier.clearForNewDay(appContext);
        }
        for (int appWidgetId : appWidgetIds) {
          RemoteViews views = buildRemoteViews(appContext, content);
          appWidgetManager.updateAppWidget(appWidgetId, views);
        }
      }
    });
  }

  private static RemoteViews buildRemoteViews(Context context, WidgetContent content) {
    RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_backup_rewind);

    if (content != null && content.bitmap != null) {
      views.setImageViewBitmap(R.id.widget_thumbnail, content.bitmap);
      views.setTextViewText(R.id.widget_label, content.label);
    } else {
      views.setImageViewResource(R.id.widget_thumbnail, R.mipmap.ic_launcher);
      views.setTextViewText(R.id.widget_label, "No memories today");
    }

    Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launchIntent != null) {
      launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
      int flags = PendingIntent.FLAG_UPDATE_CURRENT;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        flags |= PendingIntent.FLAG_IMMUTABLE;
      }
      PendingIntent pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, flags);
      views.setOnClickPendingIntent(R.id.widget_thumbnail, pendingIntent);
    }

    return views;
  }

  private static class WidgetContent {
    Bitmap bitmap;
    String label;
  }

  private static WidgetContent fetchWidgetContent(Context context) {
    try {
      SharedPreferences prefs = context.getSharedPreferences(BackupWidgetModule.PREFS_NAME, Context.MODE_PRIVATE);
      String ip = prefs.getString(BackupWidgetModule.KEY_SERVER_IP, null);
      int port = prefs.getInt(BackupWidgetModule.KEY_SERVER_PORT, 8000);
      String token = prefs.getString(BackupWidgetModule.KEY_TOKEN, "");
      String deviceId = prefs.getString(BackupWidgetModule.KEY_DEVICE_ID, null);

      if (ip == null || ip.length() == 0 || deviceId == null || deviceId.length() == 0) {
        return null;
      }

      String baseUrl = "http://" + ip + ":" + port;
      String todayUrl = baseUrl + "/memories/today?device_id=" + URLEncoder.encode(deviceId, "UTF-8")
        + "&token=" + URLEncoder.encode(token == null ? "" : token, "UTF-8");

      String json = httpGetString(todayUrl);
      if (json == null) {
        return null;
      }

      JSONObject root = new JSONObject(json);
      JSONArray groups = root.optJSONArray("groups");
      if (groups == null || groups.length() == 0) {
        return null;
      }

      List<JSONObject> candidates = new ArrayList<>();
      List<Integer> yearsAgoByCandidate = new ArrayList<>();
      for (int i = 0; i < groups.length(); i++) {
        JSONObject group = groups.getJSONObject(i);
        int yearsAgo = group.optInt("years_ago", 0);
        JSONArray items = group.optJSONArray("items");
        if (items == null) continue;
        for (int j = 0; j < items.length(); j++) {
          candidates.add(items.getJSONObject(j));
          yearsAgoByCandidate.add(yearsAgo);
        }
      }

      if (candidates.isEmpty()) {
        return null;
      }

      int pick = new Random().nextInt(candidates.size());
      JSONObject item = candidates.get(pick);
      int yearsAgo = yearsAgoByCandidate.get(pick);

      String relativePath = item.isNull("relative_path") ? null : item.optString("relative_path", null);
      boolean isVideo = item.optBoolean("is_video", false);
      String sourceType = item.optString("source_type", "phone");
      String sourceId = item.optString("source_id", "");

      if (relativePath == null || relativePath.length() == 0) {
        return null;
      }

      String encodedPath = URLEncoder.encode(relativePath, "UTF-8");
      String encodedDeviceId = URLEncoder.encode(deviceId, "UTF-8");
      String encodedToken = URLEncoder.encode(token == null ? "" : token, "UTF-8");

      String imageUrl;
      if ("shared".equals(sourceType)) {
        String encodedSourceId = URLEncoder.encode(sourceId, "UTF-8");
        imageUrl = baseUrl + "/shared/" + encodedSourceId + (isVideo ? "/thumbnail" : "/download")
          + "?relative_path=" + encodedPath + "&device_id=" + encodedDeviceId + "&token=" + encodedToken;
      } else {
        imageUrl = baseUrl + "/files/" + (isVideo ? "thumbnail" : "download")
          + "?relative_path=" + encodedPath + "&device_id=" + encodedDeviceId + "&token=" + encodedToken;
      }

      Bitmap bitmap = httpGetBitmap(imageUrl);
      if (bitmap == null) {
        return null;
      }

      WidgetContent content = new WidgetContent();
      content.bitmap = bitmap;
      content.label = yearsAgo <= 0 ? "Today's memory" : (yearsAgo + (yearsAgo == 1 ? " year ago" : " years ago"));
      return content;
    } catch (Exception exception) {
      return null;
    }
  }

  private static String httpGetString(String urlString) {
    HttpURLConnection connection = null;
    try {
      URL url = new URL(urlString);
      connection = (HttpURLConnection) url.openConnection();
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setRequestMethod("GET");
      int status = connection.getResponseCode();
      if (status != 200) {
        return null;
      }
      InputStream inputStream = connection.getInputStream();
      ByteArrayOutputStream buffer = new ByteArrayOutputStream();
      byte[] chunk = new byte[4096];
      int bytesRead;
      while ((bytesRead = inputStream.read(chunk)) != -1) {
        buffer.write(chunk, 0, bytesRead);
      }
      return buffer.toString("UTF-8");
    } catch (Exception exception) {
      return null;
    } finally {
      if (connection != null) {
        connection.disconnect();
      }
    }
  }

  private static Bitmap httpGetBitmap(String urlString) {
    HttpURLConnection connection = null;
    try {
      URL url = new URL(urlString);
      connection = (HttpURLConnection) url.openConnection();
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setRequestMethod("GET");
      int status = connection.getResponseCode();
      if (status != 200) {
        return null;
      }
      InputStream inputStream = connection.getInputStream();
      ByteArrayOutputStream buffer = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      int bytesRead;
      while ((bytesRead = inputStream.read(chunk)) != -1) {
        buffer.write(chunk, 0, bytesRead);
      }
      byte[] bytes = buffer.toByteArray();

      BitmapFactory.Options boundsOptions = new BitmapFactory.Options();
      boundsOptions.inJustDecodeBounds = true;
      BitmapFactory.decodeByteArray(bytes, 0, bytes.length, boundsOptions);

      int sampleSize = calculateInSampleSize(boundsOptions, MAX_THUMBNAIL_PX, MAX_THUMBNAIL_PX);
      BitmapFactory.Options decodeOptions = new BitmapFactory.Options();
      decodeOptions.inSampleSize = sampleSize;
      return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, decodeOptions);
    } catch (Exception exception) {
      return null;
    } finally {
      if (connection != null) {
        connection.disconnect();
      }
    }
  }

  private static int calculateInSampleSize(BitmapFactory.Options options, int reqWidth, int reqHeight) {
    int height = options.outHeight;
    int width = options.outWidth;
    int inSampleSize = 1;
    if (height > reqHeight || width > reqWidth) {
      int halfHeight = height / 2;
      int halfWidth = width / 2;
      while ((halfHeight / inSampleSize) >= reqHeight && (halfWidth / inSampleSize) >= reqWidth) {
        inSampleSize *= 2;
      }
    }
    return inSampleSize;
  }
}
