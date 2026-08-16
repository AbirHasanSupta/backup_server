import { Platform, NativeModules } from 'react-native';

const hasNativeBackgroundActions = !!(
  NativeModules &&
  NativeModules.RNBackgroundActions
);
let BackgroundServiceModule = null;
if (hasNativeBackgroundActions) {
  try {
    BackgroundServiceModule = require('react-native-background-actions');
  } catch (_e) {}
}
const BackgroundService = BackgroundServiceModule ? (BackgroundServiceModule.default || BackgroundServiceModule) : null;


const SYNC_CHANNEL_ID = 'backup-sync';
const SYNC_NOTIFICATION_ID = 'backup-sync-progress';
const MEMORIES_CHANNEL_ID = 'memories';
const MEMORIES_NOTIFICATION_ID = 'memories-today';
const FLASHBACK_CHANNEL_ID = 'flashback';
const FLASHBACK_NOTIFICATION_ID = 'memories-flashback';
const APP_PRIMARY_COLOR = '#2563EB';

function immediateNotificationTrigger() {
  return Platform.OS === 'android' ? { channelId: SYNC_CHANNEL_ID } : null;
}

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
        lightColor: APP_PRIMARY_COLOR,
        showBadge: false,
      });
      await N.setNotificationChannelAsync(MEMORIES_CHANNEL_ID, {
        name: 'Memories',
        importance: N.AndroidImportance.DEFAULT,
        lightColor: APP_PRIMARY_COLOR,
        showBadge: false,
      });
      await N.setNotificationChannelAsync(FLASHBACK_CHANNEL_ID, {
        name: 'Flashback',
        importance: N.AndroidImportance.DEFAULT,
        lightColor: APP_PRIMARY_COLOR,
        showBadge: false,
      });
    }
    const current = await N.getPermissionsAsync();
    if (current.granted || current.status === 'granted') return true;

    const requested = await N.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: false,
        allowSound: false,
      },
    });
    return requested.granted || requested.status === 'granted';
  } catch (e) {
    console.warn('[Notifications] setupNotifications failed:', e?.message);
    return false;
  }
}

function buildSyncProgressText(current, total, detail) {
  if (detail?.stopping) {
    if (detail?.currentFile) {
      const filename = detail.currentFile.split('/').pop() || detail.currentFile;
      return `Stopping…\n${filename}`;
    }
    return 'Stopping backup';
  }

  if (detail?.phase === 'scanning') {
    return detail.files
      ? `Scanning… ${detail.files.toLocaleString()} files found`
      : 'Scanning your folders…';
  }

  if (detail?.phase === 'checking') {
    const checked = detail.checked || 0;
    const subTotal = detail.total || 0;
    if (subTotal > 0) {
      const pct = Math.round((checked / subTotal) * 100);
      const remaining = subTotal - checked;
      return `${pct}% · Checking ${checked}/${subTotal} · ${remaining} remaining`;
    }
    return 'Checking files on server…';
  }

  if (detail?.phase === 'uploading' || total > 0) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const remaining = Math.max(total - current, 0);
    let text = `${pct}% · ${current}/${total} uploaded · ${remaining} remaining`;
    if (detail?.currentFile) {
      const filename = detail.currentFile.split('/').pop() || detail.currentFile;
      text += `\n${filename}`;
    }
    return text;
  }

  return 'Preparing backup…';
}

export async function showSyncProgressNotification(current, total, detail) {
  if (!N) return;
  // Foreground service owns the progress notification while it is running.
  if (Platform.OS === 'android' && BackgroundService && hasNativeBackgroundActions && BackgroundService.isRunning()) {
    return;
  }
  try {
    const body = buildSyncProgressText(current, total, detail);

    await N.scheduleNotificationAsync({
      identifier: SYNC_NOTIFICATION_ID,
      content: {
        title: '☁️ Backing up',
        body,
        data: { type: 'sync_progress' },
        sticky: true,
        autoDismiss: false,
      },
      trigger: immediateNotificationTrigger(),
    });
  } catch (e) {
    console.warn('[Notifications] showSyncProgressNotification failed:', e?.message);
  }
}

export { buildSyncProgressText };

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
      },
      trigger: immediateNotificationTrigger(),
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
      },
      trigger: immediateNotificationTrigger(),
    });
  } catch (e) {
    console.warn('[Notifications] showSyncErrorNotification failed:', e?.message);
  }
}

function memoriesNotificationTrigger() {
  return Platform.OS === 'android' ? { channelId: MEMORIES_CHANNEL_ID } : null;
}

function flashbackNotificationTrigger() {
  return Platform.OS === 'android' ? { channelId: FLASHBACK_CHANNEL_ID } : null;
}

export async function showMemoriesNotification(count) {
  if (!N) return;
  try {
    await N.scheduleNotificationAsync({
      identifier: MEMORIES_NOTIFICATION_ID,
      content: {
        title: '✨ On This Day',
        body: count > 1
          ? `You have ${count} memories from past years. Tap to check them out!`
          : 'You have a memory from a past year. Tap to check it out!',
        data: { type: 'memories' },
      },
      trigger: memoriesNotificationTrigger(),
    });
  } catch (e) {
    console.warn('[Notifications] showMemoriesNotification failed:', e?.message);
  }
}

export async function showFlashbackNotification(yearsAgo) {
  if (!N) return;
  try {
    await N.scheduleNotificationAsync({
      identifier: FLASHBACK_NOTIFICATION_ID,
      content: {
        title: '👀 Remember this?',
        body: yearsAgo === 1
          ? 'A memory from a year ago this week. Tap to see it!'
          : `A memory from ${yearsAgo} years ago this week. Tap to see it!`,
        data: { type: 'flashback' },
      },
      trigger: flashbackNotificationTrigger(),
    });
  } catch (e) {
    console.warn('[Notifications] showFlashbackNotification failed:', e?.message);
  }
}

export async function getInitialFlashbackTap() {
  if (!N) return false;
  try {
    const response = await N.getLastNotificationResponseAsync();
    return response?.notification?.request?.content?.data?.type === 'flashback';
  } catch (e) {
    console.warn('[Notifications] getInitialFlashbackTap failed:', e?.message);
    return false;
  }
}

export function addFlashbackTapListener(onTap) {
  if (!N) return () => {};
  try {
    const sub = N.addNotificationResponseReceivedListener(response => {
      if (response.notification.request.content.data?.type === 'flashback') {
        onTap();
      }
    });
    return () => sub.remove();
  } catch (e) {
    console.warn('[Notifications] addFlashbackTapListener failed:', e?.message);
    return () => {};
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

export async function getInitialMemoriesTap() {
  if (!N) return false;
  try {
    const response = await N.getLastNotificationResponseAsync();
    return response?.notification?.request?.content?.data?.type === 'memories';
  } catch (e) {
    console.warn('[Notifications] getInitialMemoriesTap failed:', e?.message);
    return false;
  }
}

export function addMemoriesTapListener(onTap) {
  if (!N) return () => {};
  try {
    const sub = N.addNotificationResponseReceivedListener(response => {
      if (response.notification.request.content.data?.type === 'memories') {
        onTap();
      }
    });
    return () => sub.remove();
  } catch (e) {
    console.warn('[Notifications] addMemoriesTapListener failed:', e?.message);
    return () => {};
  }
}