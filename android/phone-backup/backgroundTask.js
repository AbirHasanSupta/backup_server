import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { scan } from './scanner';
import { uploadFile } from './uploader';
import {
  isUploaded,
  markUploaded,
  getSyncPaused,
  getSyncInterval,
  setLastSyncTime,
  incrementTotalSynced,
} from './settings';
import {
  showSyncProgressNotification,
  showSyncCompleteNotification,
  showSyncErrorNotification,
} from './notificationService';

const TASK_NAME = 'backup-task';

/**
 * Core sync logic — scans, filters already-uploaded files, uploads pending ones.
 * @param {(current: number, total: number) => void} [onProgress]
 * @returns {Promise<{uploaded: number, skipped: number, total: number}>}
 */
export async function runSync(onProgress) {
  const files = await scan();
  const pending = [];

  for (const file of files) {
    const already = await isUploaded(file.relativePath, file.modifiedTime);
    if (!already) pending.push(file);
  }

  const total = pending.length;
  let uploaded = 0;
  let errors = 0;

  onProgress && onProgress(0, total);

  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    try {
      // Bug fix: pass a per-file progress callback so bytes are tracked
      const success = await uploadFile(file, () => {});
      if (success) {
        await markUploaded(file.relativePath, file.modifiedTime);
        uploaded++;
      } else {
        // Server returned non-200 but didn't throw — count as skipped
        errors++;
      }
    } catch (err) {
      console.warn('[BackupTask] Upload failed:', file.relativePath, err?.message);
      errors++;
    }
    // Report after every file so the progress ring updates smoothly
    onProgress && onProgress(i + 1, total);
  }

  const skipped = total - uploaded - errors;
  return { uploaded, skipped: skipped < 0 ? 0 : skipped, total, errors };
}

// ─── Background task definition ────────────────────────────────────────────────

TaskManager.defineTask(TASK_NAME, async () => {
  try {
    const paused = await getSyncPaused();
    if (paused) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    await showSyncProgressNotification(0, 0);

    const result = await runSync(async (current, total) => {
      await showSyncProgressNotification(current, total);
    });

    await setLastSyncTime(Date.now());

    if (result.uploaded > 0) {
      await incrementTotalSynced(result.uploaded);
    }

    await showSyncCompleteNotification(result.uploaded, result.skipped);

    return result.uploaded > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (err) {
    console.error('[BackupTask] Error:', err);
    await showSyncErrorNotification(err?.message || 'Unknown error');
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ─── Registration helpers ──────────────────────────────────────────────────────

/**
 * Register (or re-register) the background sync task.
 * Unregisters the existing task first so the new interval takes effect.
 * @param {number} [intervalMinutes]
 */
export async function registerBackgroundTask(intervalMinutes) {
  try {
    const minutes = intervalMinutes ?? (await getSyncInterval());

    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME).catch(() => false);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(TASK_NAME).catch(() => {});
    }

    await BackgroundFetch.registerTaskAsync(TASK_NAME, {
      minimumInterval: minutes * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (err) {
    // Registration can fail on first launch before permissions are granted;
    // the _layout.tsx will retry on next app open.
    console.warn('[BackupTask] Registration failed (will retry):', err?.message);
  }
}

export async function unregisterBackgroundTask() {
  await BackgroundFetch.unregisterTaskAsync(TASK_NAME).catch(() => {});
}