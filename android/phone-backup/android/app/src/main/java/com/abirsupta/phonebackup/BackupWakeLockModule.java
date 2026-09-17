package com.abirsupta.phonebackup;

import android.content.Context;
import android.os.PowerManager;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class BackupWakeLockModule extends ReactContextBaseJavaModule {
  private static final String MODULE_NAME = "PhoneBackupWakeLock";
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
