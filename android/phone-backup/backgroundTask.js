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

// ─── Lazy native module guard ──────────────────────────────────────────────────
//
// `expo-task-manager` and `expo-background-fetch` both need native modules that
// are only present in a compiled development/production build — not in Expo Go.
// Using require() in try/catch prevents the crash at module initialization time
// (same pattern as notificationService.js).
//
// • TaskManager: Needed for defineTask() — must be called at module-load time
//   once the native module is available.
// • BackgroundFetch: Needed for register/unregister helpers.

/** @type {import('expo-task-manager') | null} */
let TaskManager = null;

/** @type {import('expo-background-fetch') | null} */
let BackgroundFetch = null;

try {
  TaskManager = require('expo-task-manager');
  BackgroundFetch = require('expo-background-fetch');

  // defineTask MUST be called at module-load time (not inside a function),
  // but only once the native module is confirmed to be present.
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
} catch (e) {
  console.warn(
    '[BackgroundTask] Native modules not available — background sync disabled. ' +
    'Build a development client with: eas build --profile development --platform android\n' +
    'Reason:', e?.message
  );
}

// ─── Core sync logic ───────────────────────────────────────────────────────────

/**
 * Core sync logic — scans, filters already-uploaded files, uploads pending ones.
 * Can be called from the background task OR directly from the UI (Sync Now button).
 * @param {(current: number, total: number) => void} [onProgress]
 * @returns {Promise<{uploaded: number, skipped: number, total: number, errors: number}>}
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

  // If EVERY file failed (likely a permission or SAF error), throw so the
  // caller surfaces the ❌ error UI instead of misleading "up to date" message.
  if (total > 0 && uploaded === 0 && errors > 0) {
    throw new Error(`Upload failed for all ${errors} file(s). Check folder permissions and API key.`);
  }

  return { uploaded, skipped: skipped < 0 ? 0 : skipped, total, errors };
}

// ─── Registration helpers ──────────────────────────────────────────────────────

/**
 * Register (or re-register) the background sync task.
 * Unregisters the existing task first so the new interval takes effect.
 * No-ops silently if the native module is not available.
 * @param {number} [intervalMinutes]
 */
export async function registerBackgroundTask(intervalMinutes) {
  if (!TaskManager || !BackgroundFetch) {
    console.warn('[BackgroundTask] registerBackgroundTask skipped — native modules unavailable.');
    return;
  }
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
  if (!BackgroundFetch) return;
  await BackgroundFetch.unregisterTaskAsync(TASK_NAME).catch(() => {});
}