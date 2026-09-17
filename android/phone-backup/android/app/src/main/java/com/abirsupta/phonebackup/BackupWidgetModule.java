package com.abirsupta.phonebackup;

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
  private static final String MODULE_NAME = "PhoneBackupWidget";
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
