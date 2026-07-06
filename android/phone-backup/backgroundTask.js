import { scan } from './scanner';
import { checkServerFiles, uploadFile } from './uploader';
import {
  markUploaded,
  markUploadedBatch,
  getSyncPaused,
  getSyncInterval,
  setLastSyncTime,
  setTotalSynced,
} from './settings';
import {
  showSyncProgressNotification,
  showSyncCompleteNotification,
  showSyncErrorNotification,
} from './notificationService';

const TASK_NAME = 'backup-task';
const CHECK_BATCH_SIZE = 300;
const UPLOAD_CONCURRENCY = 3;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

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

      await setTotalSynced(result.uploaded + result.skipped);

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
// ─── Registration helpers ──────────────────────────────────────────────────────

/**
 * Register (or re-register) the background sync task.
 * Unregisters the existing task first so the new interval takes effect.
 * No-ops silently if the native module is not available.
 * @param {number} [intervalMinutes]
 */
export async function runSync(onProgress) {
  onProgress && onProgress(0, 0, { phase: 'scanning' });
  const files = await scan((detail) => {
    onProgress && onProgress(0, 0, detail);
  });

  onProgress && onProgress(0, 0, { phase: 'checking', checked: 0, total: files.length });

  const present = new Set();
  const presentFiles = [];
  let checked = 0;

  for (const batch of chunk(files, CHECK_BATCH_SIZE)) {
    const statuses = await checkServerFiles(batch);
    const batchByKey = new Map(
      batch.map((file) => [`${file.relativePath}|${file.modifiedTime}|${file.size || 0}`, file])
    );

    for (const status of statuses) {
      const key = `${status.relative_path}|${status.modified_time}|${status.size || 0}`;
      if (status.status === 'present') {
        present.add(key);
        const file = batchByKey.get(key);
        if (file) presentFiles.push(file);
      }
    }

    checked += batch.length;
    onProgress && onProgress(0, 0, { phase: 'checking', checked, total: files.length });
  }

  await markUploadedBatch(presentFiles);

  const pending = files.filter((file) => (
    !present.has(`${file.relativePath}|${file.modifiedTime}|${file.size || 0}`)
  ));

  const totalUploads = pending.length;
  let uploaded = 0;
  let completed = 0;
  let errors = 0;
  let nextIndex = 0;

  onProgress && onProgress(0, totalUploads, { phase: 'uploading', currentFile: '' });

  async function worker() {
    while (nextIndex < pending.length) {
      const file = pending[nextIndex++];
      onProgress && onProgress(completed, totalUploads, {
        phase: 'uploading',
        currentFile: file.relativePath,
      });

      try {
        const success = await uploadFile(file, () => {});
        if (success) {
          await markUploaded(file.relativePath, file.modifiedTime);
          uploaded++;
        } else {
          errors++;
        }
      } catch (err) {
        console.warn('[BackupTask] Upload failed:', file.relativePath, err?.message);
        errors++;
      } finally {
        completed++;
        onProgress && onProgress(completed, totalUploads, {
          phase: 'uploading',
          currentFile: file.relativePath,
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, () => worker())
  );

  const skipped = files.length - pending.length;

  if (totalUploads > 0 && skipped === 0 && uploaded === 0 && errors === totalUploads) {
    throw new Error(`Upload failed for all ${errors} file(s). Check folder permissions and API key.`);
  }

  return { uploaded, skipped, total: files.length, errors };
}

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
