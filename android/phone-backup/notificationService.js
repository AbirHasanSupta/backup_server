import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const SYNC_CHANNEL_ID = 'backup-sync';
const SYNC_NOTIFICATION_ID = 'backup-sync-progress';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function setupNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(SYNC_CHANNEL_ID, {
      name: 'Backup Sync',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 0],
      enableVibrate: false,
      lightColor: '#6366F1',
      showBadge: false,
    });
  }
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

export async function showSyncProgressNotification(current, total) {
  const body =
    total > 0
      ? `Uploading ${current} of ${total} files…`
      : 'Scanning your folders…';

  await Notifications.scheduleNotificationAsync({
    identifier: SYNC_NOTIFICATION_ID,
    content: {
      title: '☁️ Backing up',
      body,
      data: { type: 'sync_progress' },
      sticky: true,
      autoDismiss: false,
      ...(Platform.OS === 'android' && {
        channelId: SYNC_CHANNEL_ID,
      }),
    },
    trigger: null,
  });
}

export async function showSyncCompleteNotification(uploaded, skipped) {
  await Notifications.dismissNotificationAsync(SYNC_NOTIFICATION_ID).catch(() => {});

  const allDone = uploaded === 0;
  await Notifications.scheduleNotificationAsync({
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
}

export async function showSyncErrorNotification(message) {
  await Notifications.dismissNotificationAsync(SYNC_NOTIFICATION_ID).catch(() => {});

  await Notifications.scheduleNotificationAsync({
    content: {
      title: '❌ Backup failed',
      body: message || 'An error occurred. Tap to retry.',
      data: { type: 'sync_error' },
      ...(Platform.OS === 'android' && { channelId: SYNC_CHANNEL_ID }),
    },
    trigger: null,
  });
}

export async function dismissSyncNotification() {
  await Notifications.dismissNotificationAsync(SYNC_NOTIFICATION_ID).catch(() => {});
}
