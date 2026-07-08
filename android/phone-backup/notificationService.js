import { Platform, NativeModules } from 'react-native';

let BackgroundServiceModule = null;
try {
  BackgroundServiceModule = require('react-native-background-actions');
} catch (e) {}
const BackgroundService = BackgroundServiceModule ? (BackgroundServiceModule.default || BackgroundServiceModule) : null;
const hasNativeBackgroundActions = !!(
  NativeModules && 
  (NativeModules.BackgroundActions || NativeModules.RNBackgroundActions)
);


const SYNC_CHANNEL_ID = 'backup-sync';
const SYNC_NOTIFICATION_ID = 'backup-sync-progress';

// ─── Lazy native module guard ──────────────────────────────────────────────────
//
// `expo-notifications` requires the native 'ExpoPushTokenManager' module which is
// only available in a compiled development client or production build — NOT in
// Expo Go or a dev-client build that was run without `eas build`.
//
// We use require() inside try/catch instead of a top-level `import` because
// ES module imports run SYNCHRONOUSLY before any try/catch in the module body
// can protect them. A top-level import crash propagates up the entire module
// graph (_layout.tsx → backgroundTask.js → notificationService.js) and kills
// all three routes before React can mount anything.
//
// With require() in try/catch:
//  • If the native module is absent  → N stays null, all functions no-op silently
//  • If the native module is present → full notification support is enabled

/** @type {import('expo-notifications') | null} */
let N = null;

try {
  N = require('expo-notifications');

  N.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch (e) {
  console.warn(
    '[Notifications] Native module "ExpoPushTokenManager" not available — ' +
    'push notifications are disabled. To enable them, build a development ' +
    'client with: eas build --profile development --platform android\n' +
    'Reason:', e?.message
  );
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function setupNotifications() {
  if (!N) return false;
  try {
    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync(SYNC_CHANNEL_ID, {
        name: 'Backup Sync',
        importance: N.AndroidImportance.LOW,
        vibrationPattern: [0, 0],
        enableVibrate: false,
        lightColor: '#6366F1',
        showBadge: false,
      });
    }
    const { status } = await N.requestPermissionsAsync();
    return status === 'granted';
  } catch (e) {
    console.warn('[Notifications] setupNotifications failed:', e?.message);
    return false;
  }
}

export async function showSyncProgressNotification(current, total, detail) {
  if (!N) return;
  // If the native persistent sync service is running, do not show duplicate expo sticky notifications
  if (Platform.OS === 'android' && BackgroundService && hasNativeBackgroundActions && BackgroundService.isRunning()) {
    return;
  }
  try {
    let body = '';

    if (detail) {
      if (detail.phase === 'scanning') {
        body = detail.files
          ? `Scanning: ${detail.files} files found…`
          : 'Scanning your folders…';
      } else if (detail.phase === 'checking') {
        const checked = detail.checked || 0;
        const subTotal = detail.total || 0;
        body = `Checking ${checked} of ${subTotal}…`;
      } else if (detail.phase === 'uploading') {
        body = `Uploading ${current} of ${total}…`;
        if (detail.currentFile) {
          const filename = detail.currentFile.split('/').pop() || detail.currentFile;
          body += `\n${filename}`;
        }
      } else {
        body = `Syncing… (${detail.phase})`;
      }
    } else {
      body =
        total > 0
          ? `Uploading ${current} of ${total} files…`
          : 'Scanning your folders…';
    }

    await N.scheduleNotificationAsync({
      identifier: SYNC_NOTIFICATION_ID,
      content: {
        title: '☁️ Backing up',
        body,
        data: { type: 'sync_progress' },
        sticky: true,
        autoDismiss: false,
        ...(Platform.OS === 'android' && { channelId: SYNC_CHANNEL_ID }),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[Notifications] showSyncProgressNotification failed:', e?.message);
  }
}

export async function showSyncCompleteNotification(uploaded, skipped) {
  if (!N) return;
  try {
    await N.dismissNotificationAsync(SYNC_NOTIFICATION_ID).catch(() => {});

    const allDone = uploaded === 0;
    await N.scheduleNotificationAsync({
      content: {
        title: allDone ? '✓ Already up to date' : '✅ Backup complete',
        body: allDone
          ? 'All files are already backed up'
          : `${uploaded} file${uploaded !== 1 ? 's' : ''} backed up${skipped > 0 ? `, ${skipped} skipped` : ''}`,
        data: { type: 'sync_complete' },
        ...(Platform.OS === 'android' && { channelId: SYNC_CHANNEL_ID }),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[Notifications] showSyncCompleteNotification failed:', e?.message);
  }
}

export async function showSyncErrorNotification(message) {
  if (!N) return;
  try {
    await N.dismissNotificationAsync(SYNC_NOTIFICATION_ID).catch(() => {});

    await N.scheduleNotificationAsync({
      content: {
        title: '❌ Backup failed',
        body: message || 'An error occurred. Tap to retry.',
        data: { type: 'sync_error' },
        ...(Platform.OS === 'android' && { channelId: SYNC_CHANNEL_ID }),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[Notifications] showSyncErrorNotification failed:', e?.message);
  }
}

export async function dismissSyncNotification() {
  if (!N) return;
  try {
    await N.dismissNotificationAsync(SYNC_NOTIFICATION_ID).catch(() => {});
  } catch (e) {
    console.warn('[Notifications] dismissSyncNotification failed:', e?.message);
  }
}
