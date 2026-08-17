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
      new BackupWidgetModule(reactContext));
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

function addWakeLockPackageToMainApplication(contents, language) {
  if (contents.includes('BackupWakeLockPackage')) return contents;

  if (language === 'kt') {
    if (contents.includes('PackageList(this).packages.apply {')) {
      return contents.replace(
        /(PackageList\(this\)\.packages\.apply\s*\{\s*)/,
        '$1\n          add(BackupWakeLockPackage())\n'
      );
    }

    if (contents.includes('val packages = PackageList(this).packages')) {
      return contents.replace(
        'val packages = PackageList(this).packages',
        'val packages = PackageList(this).packages\n            packages.add(BackupWakeLockPackage())'
      );
    }

    if (contents.includes('return PackageList(this).packages')) {
      return contents.replace(
        'return PackageList(this).packages',
        'val packages = PackageList(this).packages\n            packages.add(BackupWakeLockPackage())\n            return packages'
      );
    }
  }

  if (language === 'java') {
    if (contents.includes('new PackageList(this).getPackages()')) {
      return contents.replace(
        /(List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);\s*)/,
        '$1\n          packages.add(new BackupWakeLockPackage());\n'
      );
    }
  }

  throw new Error('Could not add BackupWakeLockPackage to MainApplication');
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
    configWithMainApplication.modResults.contents = addWakeLockPackageToMainApplication(
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
    ensureBackgroundActionsService(androidManifest);
    ensureWidgetReceiver(androidManifest, packageName);

    return configWithManifest;
  });
};