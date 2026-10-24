const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('expo/config-plugins');

const BACKGROUND_ACTIONS_SERVICE = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const DATA_SYNC_PERMISSION = 'android.permission.FOREGROUND_SERVICE_DATA_SYNC';
const WAKE_LOCK_MODULE_NAME = 'PhoneBackupWakeLock';
const WIDGET_MODULE_NAME = 'PhoneBackupWidget';
const WIDGET_PROVIDER_CLASS = 'BackupWidgetProvider';

function ensureUsesPermission(androidManifest, permissionName) {
  androidManifest.manifest['uses-permission'] =
    androidManifest.manifest['uses-permission'] || [];

  const permissions = androidManifest.manifest['uses-permission'];
  const exists = permissions.some(
    (permission) => permission?.$?.['android:name'] === permissionName
  );

  if (!exists) {
    permissions.push({ $: { 'android:name': permissionName } });
  }
}

function ensureBackgroundActionsService(androidManifest) {
  const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  mainApplication.service = mainApplication.service || [];

  let service = mainApplication.service.find((candidate) => {
    const name = candidate?.$?.['android:name'];
    return name === BACKGROUND_ACTIONS_SERVICE || name === '.RNBackgroundActionsTask';
  });

  if (!service) {
    service = { $: { 'android:name': BACKGROUND_ACTIONS_SERVICE } };
    mainApplication.service.push(service);
  }

  service.$['android:name'] = BACKGROUND_ACTIONS_SERVICE;
  service.$['android:foregroundServiceType'] = 'dataSync';
}

function ensureWidgetReceiver(androidManifest, packageName) {
  const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  mainApplication.receiver = mainApplication.receiver || [];

  const receiverName = `${packageName}.${WIDGET_PROVIDER_CLASS}`;

  let receiver = mainApplication.receiver.find((candidate) => {
    return candidate?.$?.['android:name'] === receiverName;
  });

  if (!receiver) {
    receiver = { $: {} };
    mainApplication.receiver.push(receiver);
  }

  receiver.$['android:name'] = receiverName;
  receiver.$['android:exported'] = 'true';
  receiver.$['android:label'] = 'Random Rewind';

  receiver['intent-filter'] = receiver['intent-filter'] || [{}];
  receiver['intent-filter'][0].action = [
    { $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } },
  ];

  receiver['meta-data'] = [
    {
      $: {
        'android:name': 'android.appwidget.provider',
        'android:resource': '@xml/backup_widget_info',
      },
    },
  ];
}

function getAndroidPackageName(config) {
  return config.android?.package || 'com.abirsupta.phonebackup';
}

function getPackagePath(packageName) {
  return packageName.split('.').join(path.sep);
}

function writeJavaFile(javaDir, fileName, contents) {
  fs.writeFileSync(path.join(javaDir, fileName), contents, 'utf8');
}

function writeNativeModules(projectRoot, packageName) {
  const packagePath = getPackagePath(packageName);
  const javaDir = path.join(projectRoot, 'app', 'src', 'main', 'java', packagePath);
  fs.mkdirSync(javaDir, { recursive: true });

  writeJavaFile(
    javaDir,
    'BackupWakeLockModule.java',
    `package ${packageName};

import android.content.Context;
import android.os.PowerManager;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class BackupWakeLockModule extends ReactContextBaseJavaModule {
  private static final String MODULE_NAME = "${WAKE_LOCK_MODULE_NAME}";
  private static final String WAKE_LOCK_TAG_SUFFIX = ":PhoneBackupSync";
  private static final long MAX_WAKE_LOCK_MS = 12L * 60L * 60L * 1000L;
  private static PowerManager.WakeLock wakeLock;

  public BackupWakeLockModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @NonNull
  @Override
  public String getName() {
    return MODULE_NAME;
  }

  @ReactMethod
  public void acquire(Promise promise) {
    synchronized (BackupWakeLockModule.class) {
      try {
        if (wakeLock != null && wakeLock.isHeld()) {
          promise.resolve(null);
          return;
        }

        Context context = getReactApplicationContext().getApplicationContext();
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) {
          promise.reject("E_WAKE_LOCK_UNAVAILABLE", "PowerManager is unavailable");
          return;
        }

        wakeLock = powerManager.newWakeLock(
          PowerManager.PARTIAL_WAKE_LOCK,
          context.getPackageName() + WAKE_LOCK_TAG_SUFFIX
        );
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(MAX_WAKE_LOCK_MS);
        promise.resolve(null);
      } catch (Exception exception) {
        promise.reject("E_WAKE_LOCK_ACQUIRE_FAILED", exception);
      }
    }
  }

  @ReactMethod
  public void release(Promise promise) {
    synchronized (BackupWakeLockModule.class) {
      try {
        if (wakeLock != null && wakeLock.isHeld()) {
          wakeLock.release();
        }
        wakeLock = null;
        promise.resolve(null);
      } catch (Exception exception) {
        promise.reject("E_WAKE_LOCK_RELEASE_FAILED", exception);
      }
    }
  }
}
`
  );

  writeJavaFile(
    javaDir,
    'BackupWidgetModule.java',
    `package ${packageName};

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class BackupWidgetModule extends ReactContextBaseJavaModule {
  private static final String MODULE_NAME = "${WIDGET_MODULE_NAME}";
  public static final String PREFS_NAME = "backup_widget_prefs";
  public static final String KEY_SERVER_IP = "server_ip";
  public static final String KEY_SERVER_PORT = "server_port";
  public static final String KEY_TOKEN = "token";
  public static final String KEY_DEVICE_ID = "device_id";

  public BackupWidgetModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @NonNull
  @Override
  public String getName() {
    return MODULE_NAME;
  }

  @ReactMethod
  public void updateServerConfig(String ip, double port, String token, String deviceId, Promise promise) {
    try {
      Context context = getReactApplicationContext().getApplicationContext();
      SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
      prefs.edit()
        .putString(KEY_SERVER_IP, ip)
        .putInt(KEY_SERVER_PORT, (int) port)
        .putString(KEY_TOKEN, token == null ? "" : token)
        .putString(KEY_DEVICE_ID, deviceId)
        .apply();
      requestWidgetUpdate(context);
      promise.resolve(true);
    } catch (Exception exception) {
      promise.reject("E_WIDGET_CONFIG_FAILED", exception);
    }
  }

  @ReactMethod
  public void refreshWidget(Promise promise) {
    try {
      requestWidgetUpdate(getReactApplicationContext().getApplicationContext());
      promise.resolve(true);
    } catch (Exception exception) {
      promise.reject("E_WIDGET_REFRESH_FAILED", exception);
    }
  }

  private void requestWidgetUpdate(Context context) {
    AppWidgetManager manager = AppWidgetManager.getInstance(context);
    ComponentName provider = new ComponentName(context, BackupWidgetProvider.class);
    int[] appWidgetIds = manager.getAppWidgetIds(provider);
    if (appWidgetIds != null && appWidgetIds.length > 0) {
      BackupWidgetProvider.updateWidgets(context, manager, appWidgetIds);
    }
  }
}
`
  );

  writeJavaFile(
    javaDir,
    'BackupWidgetProvider.java',
    `package ${packageName};

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
      // Pass the device's local calendar day so Docker UTC servers still return
      // On-This-Day for the phone's timezone.
      java.util.Calendar cal = java.util.Calendar.getInstance();
      String localDate = String.format(
        java.util.Locale.US,
        "%04d-%02d-%02d",
        cal.get(java.util.Calendar.YEAR),
        cal.get(java.util.Calendar.MONTH) + 1,
        cal.get(java.util.Calendar.DAY_OF_MONTH)
      );
      int tzOffsetMinutes = cal.get(java.util.Calendar.ZONE_OFFSET) + cal.get(java.util.Calendar.DST_OFFSET);
      // JS getTimezoneOffset is minutes *behind* UTC; Java ZONE_OFFSET is ms east of UTC.
      int jsTzOffsetMinutes = -(tzOffsetMinutes / 60000);
      String todayUrl = baseUrl + "/memories/today?device_id=" + URLEncoder.encode(deviceId, "UTF-8")
        + "&token=" + URLEncoder.encode(token == null ? "" : token, "UTF-8")
        + "&local_date=" + URLEncoder.encode(localDate, "UTF-8")
        + "&tz_offset_minutes=" + jsTzOffsetMinutes;

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
`
  );

  writeJavaFile(
    javaDir,
    'BackupRewindNotifier.java',
    `package ${packageName};

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
`
  );

  writeJavaFile(
    javaDir,
    'BackupP2PServerModule.java',
    `package ${packageName};

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class BackupP2PServerModule extends ReactContextBaseJavaModule {
  private static final String MODULE_NAME = "PhoneBackupP2PServer";
  private static final String TAG = "P2PServer";

  private static ServerSocket serverSocket;
  private static DatagramSocket udpBeaconSocket;
  private static final int UDP_BEACON_PORT = 8822;
  private static ExecutorService executorService;
  private static final AtomicBoolean isRunning = new AtomicBoolean(false);
  private static int activePort = 8088;

  private static String deviceId = "";
  private static String deviceName = "";
  private static String username = "";
  private static WifiManager.MulticastLock multicastLock;

  public BackupP2PServerModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @NonNull
  @Override
  public String getName() {
    return MODULE_NAME;
  }

  private void emitEvent(String eventName, WritableMap params) {
    try {
      getReactApplicationContext()
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit(eventName, params);
    } catch (Exception e) {
      Log.w(TAG, "Failed to emit event: " + eventName, e);
    }
  }

  @ReactMethod
  public void startServer(int port, String configJson, Promise promise) {
    synchronized (BackupP2PServerModule.class) {
      try {
        if (configJson != null && !configJson.isEmpty()) {
          JSONObject cfg = new JSONObject(configJson);
          deviceId = cfg.optString("deviceId", deviceId);
          deviceName = cfg.optString("deviceName", deviceName);
          username = cfg.optString("username", username);
        }

        if (isRunning.get() && serverSocket != null && !serverSocket.isClosed()) {
          WritableMap res = Arguments.createMap();
          res.putBoolean("running", true);
          res.putInt("port", activePort);
          res.putString("deviceId", deviceId);
          promise.resolve(res);
          return;
        }

        activePort = (port >= 1024 && port <= 65535) ? port : 8088;

        try {
          serverSocket = new ServerSocket();
          serverSocket.setReuseAddress(true);
          serverSocket.bind(new java.net.InetSocketAddress(activePort));
        } catch (Exception bindEx) {
          serverSocket = new ServerSocket();
          serverSocket.setReuseAddress(true);
          serverSocket.bind(new java.net.InetSocketAddress(0));
          activePort = serverSocket.getLocalPort();
        }

        isRunning.set(true);
        executorService = Executors.newCachedThreadPool();

        executorService.execute(new Runnable() {
          @Override
          public void run() {
            while (isRunning.get()) {
              try {
                Socket clientSocket = serverSocket.accept();
                executorService.execute(new ClientHandler(clientSocket));
              } catch (SocketException se) {
                break;
              } catch (Exception e) {
                if (isRunning.get()) {
                  Log.e(TAG, "Accept error", e);
                }
              }
            }
          }
        });

        acquireMulticastLockInternal();
        startUdpBeaconListenerInternal();

        WritableMap res = Arguments.createMap();
        res.putBoolean("running", true);
        res.putInt("port", activePort);
        res.putString("deviceId", deviceId);
        promise.resolve(res);
      } catch (Exception e) {
        promise.reject("E_P2P_START_FAILED", e.getMessage(), e);
      }
    }
  }

  @ReactMethod
  public void stopServer(Promise promise) {
    synchronized (BackupP2PServerModule.class) {
      try {
        isRunning.set(false);
        if (serverSocket != null && !serverSocket.isClosed()) {
          serverSocket.close();
        }
        serverSocket = null;

        if (udpBeaconSocket != null && !udpBeaconSocket.isClosed()) {
          udpBeaconSocket.close();
        }
        udpBeaconSocket = null;

        if (executorService != null) {
          executorService.shutdownNow();
          executorService = null;
        }

        releaseMulticastLockInternal();
        promise.resolve(true);
      } catch (Exception e) {
        promise.reject("E_P2P_STOP_FAILED", e.getMessage(), e);
      }
    }
  }

  @ReactMethod
  public void getServerStatus(Promise promise) {
    WritableMap res = Arguments.createMap();
    res.putBoolean("running", isRunning.get());
    res.putInt("port", activePort);
    res.putString("deviceId", deviceId);
    res.putString("deviceName", deviceName);
    res.putString("username", username);
    promise.resolve(res);
  }

  @ReactMethod
  public void updateIdentity(String configJson, Promise promise) {
    try {
      if (configJson != null && !configJson.isEmpty()) {
        JSONObject cfg = new JSONObject(configJson);
        deviceId = cfg.optString("deviceId", deviceId);
        deviceName = cfg.optString("deviceName", deviceName);
        username = cfg.optString("username", username);
      }
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_P2P_IDENTITY_FAILED", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void updateFeedManifest(String feedManifestJson, Promise promise) {
    try {
      File p2pDir = new File(getReactApplicationContext().getCacheDir(), "p2p_shared");
      if (!p2pDir.exists()) p2pDir.mkdirs();
      File manifestFile = new File(p2pDir, "feed_manifest.json");
      FileOutputStream fos = new FileOutputStream(manifestFile);
      fos.write(feedManifestJson.getBytes(StandardCharsets.UTF_8));
      fos.flush();
      fos.close();
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_P2P_MANIFEST_FAILED", e.getMessage(), e);
    }
  }

  @ReactMethod
  public void broadcastUdpBeacon(Promise promise) {
    Executors.newSingleThreadExecutor().execute(new Runnable() {
      @Override
      public void run() {
        try {
          DatagramSocket socket = new DatagramSocket();
          socket.setBroadcast(true);
          JSONObject probe = new JSONObject();
          probe.put("type", "p2p_probe");
          probe.put("service", "phone-backup-p2p");
          probe.put("device_id", deviceId);
          byte[] data = probe.toString().getBytes(StandardCharsets.UTF_8);
          DatagramPacket packet = new DatagramPacket(data, data.length, InetAddress.getByName("255.255.255.255"), UDP_BEACON_PORT);
          socket.send(packet);
          socket.close();
          promise.resolve(true);
        } catch (Exception e) {
          promise.resolve(false);
        }
      }
    });
  }

  private void startUdpBeaconListenerInternal() {
    try {
      if (udpBeaconSocket != null && !udpBeaconSocket.isClosed()) {
        try { udpBeaconSocket.close(); } catch (Exception ignored) {}
      }
      udpBeaconSocket = new DatagramSocket(null);
      udpBeaconSocket.setReuseAddress(true);
      udpBeaconSocket.setBroadcast(true);
      udpBeaconSocket.bind(new java.net.InetSocketAddress(UDP_BEACON_PORT));
      executorService.execute(new Runnable() {
        @Override
        public void run() {
          byte[] buf = new byte[1024];
          while (isRunning.get() && udpBeaconSocket != null && !udpBeaconSocket.isClosed()) {
            try {
              DatagramPacket packet = new DatagramPacket(buf, buf.length);
              udpBeaconSocket.receive(packet);
              String msg = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
              if (msg.contains("p2p_probe") || msg.contains("phone-backup-p2p")) {
                JSONObject reply = new JSONObject();
                reply.put("service", "phone-backup-p2p");
                reply.put("status", "ok");
                reply.put("device_id", deviceId);
                reply.put("device_name", deviceName);
                reply.put("username", username);
                reply.put("p2p_port", activePort);
                reply.put("protocol_version", 1);
                byte[] replyBytes = reply.toString().getBytes(StandardCharsets.UTF_8);
                DatagramPacket replyPacket = new DatagramPacket(replyBytes, replyBytes.length, packet.getAddress(), packet.getPort());
                udpBeaconSocket.send(replyPacket);
              }
            } catch (SocketException se) {
              break;
            } catch (Exception e) {
              if (isRunning.get()) Log.w(TAG, "UDP beacon error", e);
            }
          }
        }
      });
    } catch (Exception e) {
      Log.w(TAG, "Could not bind UDP beacon port " + UDP_BEACON_PORT, e);
    }
  }

  private void acquireMulticastLockInternal() {
    try {
      Context context = getReactApplicationContext().getApplicationContext();
      WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
      if (wifi != null && (multicastLock == null || !multicastLock.isHeld())) {
        multicastLock = wifi.createMulticastLock("PhoneBackupP2PMulticast");
        multicastLock.setReferenceCounted(true);
        multicastLock.acquire();
      }
    } catch (Exception ignored) {}
  }

  private void releaseMulticastLockInternal() {
    try {
      if (multicastLock != null && multicastLock.isHeld()) {
        multicastLock.release();
        multicastLock = null;
      }
    } catch (Exception ignored) {}
  }

  private class ClientHandler implements Runnable {
    private final Socket socket;

    ClientHandler(Socket socket) {
      this.socket = socket;
    }

    @Override
    public void run() {
      try {
        socket.setSoTimeout(15000);
        InputStream in = socket.getInputStream();
        OutputStream out = new BufferedOutputStream(socket.getOutputStream());

        String requestLine = readLine(in);
        if (requestLine == null || requestLine.isEmpty()) {
          socket.close();
          return;
        }

        String[] parts = requestLine.split(" ");
        if (parts.length < 2) {
          socket.close();
          return;
        }

        String method = parts[0].toUpperCase();
        String path = parts[1];

        int contentLength = 0;
        String contentType = "";
        String rangeHeader = "";
        String headerLine;
        while ((headerLine = readLine(in)) != null && !headerLine.isEmpty()) {
          int colonIdx = headerLine.indexOf(":");
          if (colonIdx > 0) {
            String name = headerLine.substring(0, colonIdx).trim().toLowerCase();
            String value = headerLine.substring(colonIdx + 1).trim();
            if ("content-length".equals(name)) {
              try { contentLength = Integer.parseInt(value); } catch (Exception ignored) {}
            } else if ("content-type".equals(name)) {
              contentType = value;
            } else if ("range".equals(name)) {
              rangeHeader = value;
            }
          }
        }

        if ("OPTIONS".equals(method)) {
          writeCorsResponse(out, 200, "OK");
          out.flush();
          socket.close();
          return;
        }

        if ("GET".equals(method) && path.startsWith("/p2p/ping")) {
          JSONObject resp = new JSONObject();
          resp.put("status", "ok");
          resp.put("service", "phone-backup-p2p");
          resp.put("device_id", deviceId);
          resp.put("device_name", deviceName);
          resp.put("username", username);
          resp.put("p2p_port", activePort);
          resp.put("protocol_version", 1);
          writeJsonResponse(out, 200, resp.toString());
        } else if ("GET".equals(method) && path.startsWith("/p2p/status")) {
          JSONObject st = new JSONObject();
          st.put("status", "ok");
          st.put("device_id", deviceId);
          st.put("device_name", deviceName);
          st.put("username", username);
          st.put("running", isRunning.get());
          st.put("port", activePort);
          File cacheDir = getReactApplicationContext().getCacheDir();
          st.put("free_space", cacheDir.getFreeSpace());
          st.put("total_space", cacheDir.getTotalSpace());
          writeJsonResponse(out, 200, st.toString());
        } else if ("POST".equals(method) && path.startsWith("/p2p/pair")) {
          byte[] bodyBytes = readExactBytes(in, contentLength);
          String bodyStr = new String(bodyBytes, StandardCharsets.UTF_8);
          JSONObject req = new JSONObject(bodyStr);

          String action = req.optString("action", "request");
          String peerDeviceId = req.optString("device_id", "");
          String peerDeviceName = req.optString("device_name", "Nearby Peer");
          String peerUsername = req.optString("username", "");
          String pin = req.optString("pin", "");
          int peerPort = req.optInt("port", 8088);
          String remoteIp = socket.getInetAddress() != null ? socket.getInetAddress().getHostAddress() : "";

          WritableMap eventParams = Arguments.createMap();
          eventParams.putString("action", action);
          eventParams.putString("deviceId", peerDeviceId);
          eventParams.putString("deviceName", peerDeviceName);
          eventParams.putString("username", peerUsername);
          eventParams.putString("pin", pin);
          eventParams.putString("ip", remoteIp);
          eventParams.putInt("port", peerPort);
          if ("accepted".equals(action) || "confirm".equals(action)) {
            emitEvent("p2p_pair_accepted", eventParams);
            JSONObject resp = new JSONObject();
            resp.put("status", "accepted");
            resp.put("peer_device_id", deviceId);
            resp.put("peer_device_name", deviceName);
            resp.put("peer_username", username);
            resp.put("pin", pin);
            writeJsonResponse(out, 200, resp.toString());
          } else {
            emitEvent("p2p_pair_request", eventParams);
            JSONObject resp = new JSONObject();
            resp.put("status", "pending");
            resp.put("peer_device_id", deviceId);
            resp.put("peer_device_name", deviceName);
            resp.put("peer_username", username);
            resp.put("pin", pin);
            writeJsonResponse(out, 200, resp.toString());
          }
        } else if ("POST".equals(method) && path.startsWith("/p2p/upload")) {
          String query = "";
          int qIdx = path.indexOf("?");
          if (qIdx >= 0) {
            query = path.substring(qIdx + 1);
          }
          String shareId = "p2p_" + System.currentTimeMillis();
          String originalName = "media_" + System.currentTimeMillis();
          for (String pair : query.split("&")) {
            int eq = pair.indexOf("=");
            if (eq > 0) {
              String k = pair.substring(0, eq).trim();
              String v = pair.substring(eq + 1).trim();
              try { v = java.net.URLDecoder.decode(v, "UTF-8"); } catch (Exception ignored) {}
              if ("share_id".equals(k)) shareId = v;
              else if ("name".equals(k)) originalName = v;
            }
          }

          File p2pDir = new File(getReactApplicationContext().getCacheDir(), "p2p_shared");
          if (!p2pDir.exists()) p2pDir.mkdirs();

          String safeName = shareId + "_" + System.currentTimeMillis() + "_" + new File(originalName).getName();
          File targetFile = new File(p2pDir, safeName);
          FileOutputStream fos = new FileOutputStream(targetFile);

          byte[] buf = new byte[65536];
          long bytesRemaining = contentLength;
          while (bytesRemaining > 0) {
            int toRead = (int) Math.min(buf.length, bytesRemaining);
            int read = in.read(buf, 0, toRead);
            if (read == -1) break;
            fos.write(buf, 0, read);
            bytesRemaining -= read;
          }
          fos.flush();
          fos.close();

          JSONObject resp = new JSONObject();
          resp.put("ok", true);
          resp.put("fileName", safeName);
          resp.put("uri", "file://" + targetFile.getAbsolutePath());
          resp.put("size", targetFile.length());
          writeJsonResponse(out, 200, resp.toString());
        } else if ("POST".equals(method) && path.startsWith("/p2p/share")) {
          byte[] bodyBytes = readExactBytes(in, contentLength);
          String bodyStr = new String(bodyBytes, StandardCharsets.UTF_8);
          JSONObject req = new JSONObject(bodyStr);

          String shareId = req.optString("share_id", "p2p_" + System.currentTimeMillis());
          String sharedByDeviceId = req.optString("shared_by_device_id", "");
          String sharedByDeviceName = req.optString("shared_by_device_name", "Peer");
          String sharedByUsername = req.optString("shared_by_username", "");
          String caption = req.optString("caption", "");
          String postKind = req.optString("post_kind", "direct_post");
          long createdAt = req.optLong("created_at", System.currentTimeMillis());

          File p2pDir = new File(getReactApplicationContext().getCacheDir(), "p2p_shared");
          if (!p2pDir.exists()) p2pDir.mkdirs();

          JSONArray filesArr = req.optJSONArray("files");
          JSONArray savedFilesArr = new JSONArray();

          if (filesArr != null) {
            for (int i = 0; i < filesArr.length(); i++) {
              JSONObject fObj = filesArr.getJSONObject(i);
              String originalName = fObj.optString("name", "file_" + i);
              String safeName = shareId + "_" + System.currentTimeMillis() + "_" + new File(originalName).getName();
              String b64 = fObj.optString("base64", "");

              String preUploadedName = fObj.optString("fileName", "");
              if (!preUploadedName.isEmpty()) {
                File targetFile = new File(p2pDir, preUploadedName);
                if (targetFile.exists()) {
                  JSONObject savedObj = new JSONObject();
                  savedObj.put("name", originalName);
                  savedObj.put("fileName", preUploadedName);
                  savedObj.put("uri", "file://" + targetFile.getAbsolutePath());
                  savedObj.put("size", targetFile.length());
                  savedFilesArr.put(savedObj);
                  continue;
                }
              }

              if (!b64.isEmpty()) {
                byte[] decoded = Base64.decode(b64, Base64.DEFAULT);
                File targetFile = new File(p2pDir, safeName);
                FileOutputStream fos = new FileOutputStream(targetFile);
                fos.write(decoded);
                fos.flush();
                fos.close();

                JSONObject savedObj = new JSONObject();
                savedObj.put("name", originalName);
                savedObj.put("fileName", safeName);
                savedObj.put("uri", "file://" + targetFile.getAbsolutePath());
                savedObj.put("size", targetFile.length());
                savedFilesArr.put(savedObj);
              }
            }
          }

          WritableMap eventParams = Arguments.createMap();
          eventParams.putString("shareId", shareId);
          eventParams.putString("sharedByDeviceId", sharedByDeviceId);
          eventParams.putString("sharedByDeviceName", sharedByDeviceName);
          eventParams.putString("sharedByUsername", sharedByUsername);
          eventParams.putString("caption", caption);
          eventParams.putString("postKind", postKind);
          eventParams.putDouble("createdAt", (double) createdAt);
          eventParams.putString("filesJson", savedFilesArr.toString());
          emitEvent("p2p_incoming_share", eventParams);

          JSONObject resp = new JSONObject();
          try {
            File manifestFile = new File(p2pDir, "feed_manifest.json");
            JSONArray manifestItems = new JSONArray();
            if (manifestFile.exists() && manifestFile.isFile()) {
              FileInputStream fis = new FileInputStream(manifestFile);
              byte[] mData = new byte[(int) manifestFile.length()];
              fis.read(mData);
              fis.close();
              JSONObject mObj = new JSONObject(new String(mData, StandardCharsets.UTF_8));
              manifestItems = mObj.optJSONArray("items");
              if (manifestItems == null) manifestItems = new JSONArray();
            }
            JSONObject newPost = new JSONObject();
            newPost.put("id", shareId);
            newPost.put("shared_by_device_id", sharedByDeviceId);
            newPost.put("shared_by_device_name", sharedByDeviceName);
            newPost.put("shared_by_username", sharedByUsername);
            newPost.put("caption", caption);
            newPost.put("post_kind", postKind);
            newPost.put("created_at", createdAt);
            newPost.put("files", savedFilesArr);

            JSONArray updatedItems = new JSONArray();
            updatedItems.put(newPost);
            for (int j = 0; j < Math.min(manifestItems.length(), 199); j++) {
              updatedItems.put(manifestItems.get(j));
            }
            JSONObject fullManifest = new JSONObject();
            fullManifest.put("items", updatedItems);
            fullManifest.put("status", "ok");

            FileOutputStream mFos = new FileOutputStream(manifestFile);
            mFos.write(fullManifest.toString().getBytes(StandardCharsets.UTF_8));
            mFos.flush();
            mFos.close();
          } catch (Exception eManifest) {
            Log.w(TAG, "Failed updating manifest", eManifest);
          }

          resp.put("ok", true);
          resp.put("share_id", shareId);
          writeJsonResponse(out, 200, resp.toString());
        } else if ("GET".equals(method) && path.startsWith("/p2p/files/")) {
          String rawFilename = path.substring("/p2p/files/".length());
          String safeFilename = new File(rawFilename).getName();
          File p2pDir = new File(getReactApplicationContext().getCacheDir(), "p2p_shared");
          File targetFile = new File(p2pDir, safeFilename);

          if (targetFile.exists() && targetFile.isFile()) {
            writeFileResponse(out, targetFile, rangeHeader);
          } else {
            writeNotFound(out);
          }
        } else if ("GET".equals(method) && path.startsWith("/p2p/feed")) {
          File p2pDir = new File(getReactApplicationContext().getCacheDir(), "p2p_shared");
          File manifestFile = new File(p2pDir, "feed_manifest.json");
          if (manifestFile.exists() && manifestFile.isFile()) {
            try {
              FileInputStream fis = new FileInputStream(manifestFile);
              byte[] data = new byte[(int) manifestFile.length()];
              fis.read(data);
              fis.close();
              String jsonStr = new String(data, StandardCharsets.UTF_8);
              writeJsonResponse(out, 200, jsonStr);
            } catch (Exception e) {
              writeJsonResponse(out, 200, "{\\"items\\":[],\\"status\\":\\"ok\\"}");
            }
          } else {
            writeJsonResponse(out, 200, "{\\"items\\":[],\\"status\\":\\"ok\\"}");
          }
        } else if ("POST".equals(method) && path.startsWith("/p2p/react")) {
          byte[] bodyBytes = readExactBytes(in, contentLength);
          String bodyStr = new String(bodyBytes, StandardCharsets.UTF_8);
          JSONObject req = new JSONObject(bodyStr);

          String shareId = req.optString("share_id", "");
          String emoji = req.optString("emoji", "");
          String reactAction = req.optString("action", "add");
          String reactorDeviceId = req.optString("reactor_device_id", "");
          String reactorName = req.optString("reactor_name", "Nearby Peer");

          WritableMap eventParams = Arguments.createMap();
          eventParams.putString("shareId", shareId);
          eventParams.putString("emoji", emoji);
          eventParams.putString("action", reactAction);
          eventParams.putString("reactorDeviceId", reactorDeviceId);
          eventParams.putString("reactorName", reactorName);
          emitEvent("p2p_incoming_reaction", eventParams);

          JSONObject resp = new JSONObject();
          resp.put("ok", true);
          resp.put("status", "success");
          writeJsonResponse(out, 200, resp.toString());
        } else if ("POST".equals(method) && path.startsWith("/p2p/comment")) {
          byte[] bodyBytes = readExactBytes(in, contentLength);
          String bodyStr = new String(bodyBytes, StandardCharsets.UTF_8);
          JSONObject req = new JSONObject(bodyStr);

          String shareId = req.optString("share_id", "");
          String commentId = req.optString("comment_id", "");
          String commentAction = req.optString("action", "add");
          JSONObject commentObj = req.optJSONObject("comment");

          WritableMap eventParams = Arguments.createMap();
          eventParams.putString("shareId", shareId);
          eventParams.putString("commentId", commentId);
          eventParams.putString("action", commentAction);
          if (commentObj != null) {
            eventParams.putString("commentJson", commentObj.toString());
          }
          emitEvent("p2p_incoming_comment", eventParams);

          JSONObject resp = new JSONObject();
          resp.put("ok", true);
          resp.put("status", "success");
          writeJsonResponse(out, 200, resp.toString());
        } else {
          writeNotFound(out);
        }

        out.flush();
      } catch (Exception e) {
        Log.w(TAG, "Request handle error", e);
      } finally {
        try { socket.close(); } catch (Exception ignored) {}
      }
    }

    private String readLine(InputStream in) throws IOException {
      StringBuilder sb = new StringBuilder();
      int c;
      while ((c = in.read()) != -1) {
        if (c == '\\r') {
          int next = in.read();
          if (next == '\\n' || next == -1) break;
          sb.append((char) c).append((char) next);
        } else if (c == '\\n') {
          break;
        } else {
          sb.append((char) c);
        }
      }
      return sb.toString();
    }

    private byte[] readExactBytes(InputStream in, int length) throws IOException {
      byte[] data = new byte[length];
      int totalRead = 0;
      while (totalRead < length) {
        int read = in.read(data, totalRead, length - totalRead);
        if (read == -1) break;
        totalRead += read;
      }
      return data;
    }

    private void writeJsonResponse(OutputStream out, int status, String json) throws IOException {
      byte[] jsonBytes = json.getBytes(StandardCharsets.UTF_8);
      String header = "HTTP/1.1 " + status + " OK\\r\\n" +
        "Content-Type: application/json; charset=utf-8\\r\\n" +
        "Content-Length: " + jsonBytes.length + "\\r\\n" +
        "Access-Control-Allow-Origin: *\\r\\n" +
        "Connection: close\\r\\n\\r\\n";
      out.write(header.getBytes(StandardCharsets.UTF_8));
      out.write(jsonBytes);
    }

    private void writeCorsResponse(OutputStream out, int status, String msg) throws IOException {
      String header = "HTTP/1.1 " + status + " " + msg + "\\r\\n" +
        "Access-Control-Allow-Origin: *\\r\\n" +
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\\r\\n" +
        "Access-Control-Allow-Headers: Content-Type, Authorization, X-Device-Id\\r\\n" +
        "Content-Length: 0\\r\\n" +
        "Connection: close\\r\\n\\r\\n";
      out.write(header.getBytes(StandardCharsets.UTF_8));
    }

    private void writeFileResponse(OutputStream out, File file) throws IOException {
      writeFileResponse(out, file, "");
    }

    private void writeFileResponse(OutputStream out, File file, String rangeHeader) throws IOException {
      String contentType = "application/octet-stream";
      String lower = file.getName().toLowerCase();
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) contentType = "image/jpeg";
      else if (lower.endsWith(".png")) contentType = "image/png";
      else if (lower.endsWith(".webp")) contentType = "image/webp";
      else if (lower.endsWith(".mp4")) contentType = "video/mp4";

      long fileLength = file.length();
      long start = 0;
      long end = fileLength - 1;
      boolean isRange = false;

      if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
        String rangeSpec = rangeHeader.substring("bytes=".length()).trim();
        int dashIdx = rangeSpec.indexOf("-");
        if (dashIdx >= 0) {
          try {
            String startStr = rangeSpec.substring(0, dashIdx).trim();
            String endStr = rangeSpec.substring(dashIdx + 1).trim();
            if (!startStr.isEmpty()) {
              start = Long.parseLong(startStr);
            }
            if (!endStr.isEmpty()) {
              end = Long.parseLong(endStr);
            }
            if (end >= fileLength) {
              end = fileLength - 1;
            }
            if (start <= end && start < fileLength) {
              isRange = true;
            }
          } catch (Exception ignored) {}
        }
      }

      if (isRange) {
        long contentLength = end - start + 1;
        String header = "HTTP/1.1 206 Partial Content\\r\\n" +
          "Content-Type: " + contentType + "\\r\\n" +
          "Content-Length: " + contentLength + "\\r\\n" +
          "Content-Range: bytes " + start + "-" + end + "/" + fileLength + "\\r\\n" +
          "Accept-Ranges: bytes\\r\\n" +
          "Access-Control-Allow-Origin: *\\r\\n" +
          "Connection: close\\r\\n\\r\\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));

        FileInputStream fis = new FileInputStream(file);
        try {
          long toSkip = start;
          while (toSkip > 0) {
            long skipped = fis.skip(toSkip);
            if (skipped <= 0) break;
            toSkip -= skipped;
          }
          byte[] buf = new byte[8192];
          long remaining = contentLength;
          while (remaining > 0) {
            int toRead = (int) Math.min((long) buf.length, remaining);
            int n = fis.read(buf, 0, toRead);
            if (n == -1) break;
            out.write(buf, 0, n);
            remaining -= n;
          }
        } finally {
          fis.close();
        }
      } else {
        String header = "HTTP/1.1 200 OK\\r\\n" +
          "Content-Type: " + contentType + "\\r\\n" +
          "Content-Length: " + fileLength + "\\r\\n" +
          "Accept-Ranges: bytes\\r\\n" +
          "Access-Control-Allow-Origin: *\\r\\n" +
          "Connection: close\\r\\n\\r\\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));

        FileInputStream fis = new FileInputStream(file);
        try {
          byte[] buf = new byte[8192];
          int n;
          while ((n = fis.read(buf)) != -1) {
            out.write(buf, 0, n);
          }
        } finally {
          fis.close();
        }
      }
    }

    private void writeNotFound(OutputStream out) throws IOException {
      String body = "{\\"error\\":\\"not_found\\"}";
      byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
      String header = "HTTP/1.1 404 Not Found\\r\\n" +
        "Content-Type: application/json\\r\\n" +
        "Content-Length: " + bytes.length + "\\r\\n" +
        "Connection: close\\r\\n\\r\\n";
      out.write(header.getBytes(StandardCharsets.UTF_8));
      out.write(bytes);
    }
  }
}
`
  );

  writeJavaFile(
    javaDir,
    'BackupWakeLockPackage.java',
    `package ${packageName};

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class BackupWakeLockPackage implements ReactPackage {
  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
    return Arrays.<NativeModule>asList(
      new BackupWakeLockModule(reactContext),
      new BackupWidgetModule(reactContext),
      new BackupP2PServerModule(reactContext));
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
    return Collections.emptyList();
  }
}
`
  );
}

function writeWidgetResources(projectRoot) {
  const resDir = path.join(projectRoot, 'app', 'src', 'main', 'res');
  const xmlDir = path.join(resDir, 'xml');
  const layoutDir = path.join(resDir, 'layout');
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.mkdirSync(layoutDir, { recursive: true });

  fs.writeFileSync(
    path.join(xmlDir, 'backup_widget_info.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="180dp"
    android:minHeight="180dp"
    android:targetCellWidth="2"
    android:targetCellHeight="2"
    android:updatePeriodMillis="21600000"
    android:previewImage="@mipmap/ic_launcher"
    android:initialLayout="@layout/widget_backup_rewind"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen">
</appwidget-provider>
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(layoutDir, 'widget_backup_rewind.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#1A1A1A">

    <ImageView
        android:id="@+id/widget_thumbnail"
        android:layout_width="match_parent"
        android:layout_height="match_parent"
        android:scaleType="centerCrop"
        android:contentDescription="Random Rewind memory thumbnail" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_gravity="bottom"
        android:orientation="vertical"
        android:background="#99000000"
        android:padding="8dp">

        <TextView
            android:id="@+id/widget_label"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:textColor="#FFFFFF"
            android:textSize="12sp"
            android:text="On this day" />
    </LinearLayout>
</FrameLayout>
`,
    'utf8'
  );
}

function customizeMainApplication(contents, language) {
  let modified = contents;

  if (language === 'kt') {
    // 1. Add OkHttp imports if not present
    const kotlinImports = [
      'import com.facebook.react.modules.network.OkHttpClientProvider',
      'import com.facebook.react.modules.network.OkHttpClientFactory',
      'import okhttp3.OkHttpClient',
      'import okhttp3.Dispatcher',
      'import okhttp3.ConnectionPool',
      'import java.util.concurrent.TimeUnit',
    ];

    const missingKotlinImports = kotlinImports.filter((imp) => !modified.includes(imp));
    if (missingKotlinImports.length > 0) {
      modified = modified.replace(
        /package\s+[^\n]+/,
        `$&\n\n${missingKotlinImports.join('\n')}`
      );
    }

    // 2. Add BackupWakeLockPackage to package list
    if (!modified.includes('BackupWakeLockPackage()')) {
      if (modified.includes('PackageList(this).packages.apply {')) {
        modified = modified.replace(
          /(PackageList\(this\)\.packages\.apply\s*\{\s*)/,
          '$1\n          add(BackupWakeLockPackage())\n'
        );
      } else if (modified.includes('val packages = PackageList(this).packages')) {
        modified = modified.replace(
          'val packages = PackageList(this).packages',
          'val packages = PackageList(this).packages\n            packages.add(BackupWakeLockPackage())'
        );
      } else if (modified.includes('return PackageList(this).packages')) {
        modified = modified.replace(
          'return PackageList(this).packages',
          'val packages = PackageList(this).packages\n            packages.add(BackupWakeLockPackage())\n            return packages'
        );
      }
    }

    // 3. Add OkHttpClientProvider configuration in onCreate
    if (!modified.includes('OkHttpClientProvider.setOkHttpClientFactory')) {
      const okHttpConfigKotlin = `    // Configure high-performance OkHttp connection pool & dispatcher so UI API calls
    // (Reels, Feed, Library, Thumbnails) execute in parallel without queueing behind active sync uploads.
    OkHttpClientProvider.setOkHttpClientFactory(object : OkHttpClientFactory {
      override fun createNewNetworkModuleClient(): OkHttpClient {
        val dispatcher = Dispatcher().apply {
          // High enough that feed/reels thumbs + API calls never queue behind
          // each other under multi-user Docker / LAN load.
          maxRequests = 256
          maxRequestsPerHost = 128
        }
        val connectionPool = ConnectionPool(64, 5, TimeUnit.MINUTES)
        return OkHttpClientProvider.createClientBuilder()
          .dispatcher(dispatcher)
          .connectionPool(connectionPool)
          .build()
      }
    })\n`;

      if (modified.includes('super.onCreate()')) {
        modified = modified.replace(
          /super\.onCreate\(\)\s*/,
          `$&\n${okHttpConfigKotlin}\n`
        );
      }
    }

    return modified;
  }

  if (language === 'java') {
    // 1. Add OkHttp imports if not present
    const javaImports = [
      'import com.facebook.react.modules.network.OkHttpClientProvider;',
      'import com.facebook.react.modules.network.OkHttpClientFactory;',
      'import okhttp3.OkHttpClient;',
      'import okhttp3.Dispatcher;',
      'import okhttp3.ConnectionPool;',
      'import java.util.concurrent.TimeUnit;',
    ];

    const missingJavaImports = javaImports.filter((imp) => !modified.includes(imp));
    if (missingJavaImports.length > 0) {
      modified = modified.replace(
        /package\s+[^\n]+/,
        `$&\n\n${missingJavaImports.join('\n')}`
      );
    }

    // 2. Add BackupWakeLockPackage to package list
    if (!modified.includes('BackupWakeLockPackage')) {
      if (modified.includes('new PackageList(this).getPackages()')) {
        modified = modified.replace(
          /(List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);\s*)/,
          '$1\n          packages.add(new BackupWakeLockPackage());\n'
        );
      }
    }

    // 3. Add OkHttpClientProvider configuration in onCreate
    if (!modified.includes('OkHttpClientProvider.setOkHttpClientFactory')) {
      const okHttpConfigJava = `    // Configure high-performance OkHttp connection pool & dispatcher so UI API calls
    // (Reels, Feed, Library, Thumbnails) execute in parallel without queueing behind active sync uploads.
    OkHttpClientProvider.setOkHttpClientFactory(new OkHttpClientFactory() {
      @Override
      public OkHttpClient createNewNetworkModuleClient() {
        Dispatcher dispatcher = new Dispatcher();
        dispatcher.setMaxRequests(256);
        dispatcher.setMaxRequestsPerHost(128);
        ConnectionPool connectionPool = new ConnectionPool(64, 5, TimeUnit.MINUTES);
        return OkHttpClientProvider.createClientBuilder()
          .dispatcher(dispatcher)
          .connectionPool(connectionPool)
          .build();
      }
    });\n`;

      if (modified.includes('super.onCreate();')) {
        modified = modified.replace(
          /super\.onCreate\(\);\s*/,
          `$&\n${okHttpConfigJava}\n`
        );
      }
    }

    return modified;
  }

  return contents;
}

function withBackupWakeLock(config) {
  const packageName = getAndroidPackageName(config);

  config = withDangerousMod(config, [
    'android',
    (configWithMod) => {
      writeNativeModules(configWithMod.modRequest.platformProjectRoot, packageName);
      writeWidgetResources(configWithMod.modRequest.platformProjectRoot);
      return configWithMod;
    },
  ]);

  return withMainApplication(config, (configWithMainApplication) => {
    configWithMainApplication.modResults.contents = customizeMainApplication(
      configWithMainApplication.modResults.contents,
      configWithMainApplication.modResults.language
    );
    return configWithMainApplication;
  });
}

module.exports = function withBackgroundActionsDataSync(config) {
  config = withBackupWakeLock(config);
  const packageName = getAndroidPackageName(config);

  return withAndroidManifest(config, (configWithManifest) => {
    const androidManifest = configWithManifest.modResults;
    androidManifest.manifest.$ = androidManifest.manifest.$ || {};
    androidManifest.manifest.$['xmlns:android'] =
      androidManifest.manifest.$['xmlns:android'] || ANDROID_NS;

    ensureUsesPermission(androidManifest, 'android.permission.FOREGROUND_SERVICE');
    ensureUsesPermission(androidManifest, DATA_SYNC_PERMISSION);
    ensureUsesPermission(androidManifest, 'android.permission.ACCESS_WIFI_STATE');
    ensureUsesPermission(androidManifest, 'android.permission.CHANGE_WIFI_MULTICAST_STATE');
    ensureBackgroundActionsService(androidManifest);
    ensureWidgetReceiver(androidManifest, packageName);

    return configWithManifest;
  });
};