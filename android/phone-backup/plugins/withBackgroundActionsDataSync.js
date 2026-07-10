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

function getAndroidPackageName(config) {
  return config.android?.package || 'com.abirsupta.phonebackup';
}

function getPackagePath(packageName) {
  return packageName.split('.').join(path.sep);
}

function writeWakeLockModule(projectRoot, packageName) {
  const packagePath = getPackagePath(packageName);
  const javaDir = path.join(projectRoot, 'app', 'src', 'main', 'java', packagePath);
  fs.mkdirSync(javaDir, { recursive: true });

  fs.writeFileSync(
    path.join(javaDir, 'BackupWakeLockModule.java'),
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
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(javaDir, 'BackupWakeLockPackage.java'),
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
    return Arrays.<NativeModule>asList(new BackupWakeLockModule(reactContext));
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
    return Collections.emptyList();
  }
}
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
      writeWakeLockModule(configWithMod.modRequest.platformProjectRoot, packageName);
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

  return withAndroidManifest(config, (configWithManifest) => {
    const androidManifest = configWithManifest.modResults;
    androidManifest.manifest.$ = androidManifest.manifest.$ || {};
    androidManifest.manifest.$['xmlns:android'] =
      androidManifest.manifest.$['xmlns:android'] || ANDROID_NS;

    ensureUsesPermission(androidManifest, 'android.permission.FOREGROUND_SERVICE');
    ensureUsesPermission(androidManifest, DATA_SYNC_PERMISSION);
    ensureBackgroundActionsService(androidManifest);

    return configWithManifest;
  });
};
