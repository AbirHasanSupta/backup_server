import { DeviceEventEmitter, Platform, NativeModules } from 'react-native';
import { scan } from './scanner';
import { checkServerFiles, uploadFile } from './uploader';
import { hashFile } from './crypto';
import {
  markUploaded,
  markUploadedBatch,
  getSyncPaused,
  getSyncInterval,
  setLastSyncTime,
  setTotalSynced,
  getServerIp,
  getServerPort,
  getLastSyncTime,
} from './settings';
import {
  showSyncProgressNotification,
  showSyncCompleteNotification,
  showSyncErrorNotification,
  buildSyncProgressText,
} from './notificationService';

const hasNativeBackgroundActions = !!(
  NativeModules &&
  NativeModules.RNBackgroundActions
);
let BackgroundServiceModule = null;
if (hasNativeBackgroundActions) {
  try {
    BackgroundServiceModule = require('react-native-background-actions');
  } catch (e) {
    console.warn('[BackgroundTask] react-native-background-actions not available.', e?.message);
  }
}
const BackgroundService = BackgroundServiceModule ? (BackgroundServiceModule.default || BackgroundServiceModule) : null;


const TASK_NAME = 'backup-task';
const CHECK_BATCH_SIZE = 300;
const UPLOAD_CONCURRENCY = 3;
const SERVICE_LOOP_TICK_MS = 15000;
const APP_PRIMARY_COLOR = '#2563EB';

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

let TaskManager = null;
let BackgroundFetch = null;

try {
  TaskManager = require('expo-task-manager');
  BackgroundFetch = require('expo-background-fetch');

  TaskManager.defineTask(TASK_NAME, async () => {
    try {
      if (Platform.OS === 'android' && BackgroundService && !BackgroundService.isRunning()) {
        await startPersistentSyncService();
        if (!BackgroundService.isRunning()) {
          console.log('[BackgroundTask] Safety-net: Foreground service start restricted in background, running headless sync.');
          const result = await runSync(null, { isBackgroundFetch: true });
          return result.uploaded > 0
            ? BackgroundFetch.BackgroundFetchResult.NewData
            : BackgroundFetch.BackgroundFetchResult.NoData;
        }
      }
      return BackgroundFetch.BackgroundFetchResult.NewData;
    } catch (err) {
      console.warn('[BackgroundTask] Safety-net tick failed:', err?.message);
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
} catch (e) {
  console.warn('[BackgroundTask] Native modules not available.', e?.message);
}

let lastIdleDesc = null;

function emitSyncStarted() {
  DeviceEventEmitter.emit('sync-started', {});
}

function emitSyncProgress(current, total, detail) {
  DeviceEventEmitter.emit('sync-progress', { current, total, detail });
}

function emitSyncCompleted(payload) {
  DeviceEventEmitter.emit('sync-completed', payload);
}

function emitSyncFailed(message) {
  DeviceEventEmitter.emit('sync-failed', { message });
}

async function updateIdleNotification(force = false) {
  if (!BackgroundService?.isRunning()) return;

  const paused = await getSyncPaused();
  const ip = await getServerIp();
  let desc = 'Auto backup enabled';
  if (paused) desc = 'Auto sync paused';
  else if (!ip) desc = 'No server configured';

  if (!force && desc === lastIdleDesc) return;
  lastIdleDesc = desc;

  await BackgroundService.updateNotification({
    taskTitle: '☁️ Phone Backup',
    taskDesc: desc,
    taskProgressBarOptions: { max: 100, value: 0, indeterminate: false },
  }).catch(() => {});
}

async function reportProgress(current, total, detail) {
  emitSyncProgress(current, total, detail);

  if (Platform.OS === 'android' && BackgroundService && BackgroundService.isRunning()) {
    const desc = buildSyncProgressText(current, total, detail);
    let progressVal = 0;
    let progressMax = 100;
    let indeterminate = true;

    if (detail?.phase === 'checking') {
      progressVal = detail.checked || 0;
      progressMax = detail.total || 100;
      indeterminate = false;
    } else if (detail?.phase === 'uploading' || total > 0) {
      progressVal = current;
      progressMax = total || 100;
      indeterminate = false;
    }

    lastIdleDesc = null;
    await BackgroundService.updateNotification({
      taskTitle: '☁️ Backing up',
      taskDesc: desc,
      taskProgressBarOptions: { max: progressMax, value: progressVal, indeterminate },
    }).catch((err) => console.warn('[BackgroundService] updateNotification error:', err?.message));
  } else {
    await showSyncProgressNotification(current, total, detail);
  }
}

export async function performActualSync(onProgress, runOptions = {}) {
  const forceRefreshFolder = runOptions.forceRefreshFolder;
  const targetFolderUri = runOptions.targetFolderUri;
  if (onProgress) await onProgress(0, 0, { phase: 'scanning' });
  const files = await scan(async (detail) => {
    if (onProgress) await onProgress(0, 0, detail);
  }, targetFolderUri);

  if (onProgress) await onProgress(0, 0, { phase: 'checking', checked: 0, total: files.length });

  const present = new Set();
  const presentFiles = [];
  let checked = 0;
  let serverDeviceTotalFiles = 0;
  let serverDeviceTotalSize = 0;

  for (const batch of chunk(files, CHECK_BATCH_SIZE)) {
    const res = await checkServerFiles(batch);
    const statuses = res.files;
    serverDeviceTotalFiles = res.deviceTotalFiles;
    serverDeviceTotalSize = res.deviceTotalSize;

    const batchByKey = new Map(
      batch.map((file) => [`${file.relativePath}|${file.modifiedTime}|${file.size || 0}`, file])
    );

    for (const status of statuses) {
      const key = `${status.relative_path}|${status.modified_time}|${status.size || 0}`;
      
      let isPresentStatus = status.status === 'present';
      if (forceRefreshFolder && (status.relative_path.startsWith(`${forceRefreshFolder}/`) || status.relative_path === forceRefreshFolder)) {
        isPresentStatus = false;
      }

      if (isPresentStatus) {
        present.add(key);
        const file = batchByKey.get(key);
        if (file) presentFiles.push(file);
      }
    }

    checked += batch.length;
    if (onProgress) await onProgress(0, 0, { phase: 'checking', checked, total: files.length });
  }

  await markUploadedBatch(presentFiles);

  const pending = files.filter((file) => (
    !present.has(`${file.relativePath}|${file.modifiedTime}|${file.size || 0}`)
  ));

  const totalUploads = pending.length;
  let uploaded = 0;
  let completed = 0;
  let errors = 0;
  let lastError = null;
  let nextIndex = 0;

  if (onProgress) await onProgress(0, totalUploads, { phase: 'uploading', currentFile: '' });

  async function worker() {
    while (nextIndex < pending.length) {
      const file = pending[nextIndex++];
      if (!file) break;
      if (onProgress) {
        await onProgress(completed, totalUploads, { phase: 'uploading', currentFile: file.relativePath });
      }

      try {
        let sha256 = '';
        if (file.size < 10 * 1024 * 1024) {
          sha256 = await hashFile(file.uri);
        }

        const fileToUpload = { ...file, sha256 };
        const res = await uploadFile(fileToUpload, () => {});
        if (res.success) {
          serverDeviceTotalFiles = res.deviceTotalFiles;
          serverDeviceTotalSize = res.deviceTotalSize;
          await markUploaded(file.relativePath, file.modifiedTime);
          uploaded++;
        } else {
          errors++;
          lastError = 'Server rejected the file. Check server logs.';
        }
      } catch (err) {
        console.warn('[BackupTask] Upload failed:', file.relativePath, err?.message);
        errors++;
        lastError = err?.message || 'Unknown network error';
      } finally {
        completed++;
        if (onProgress) {
          await onProgress(completed, totalUploads, { phase: 'uploading', currentFile: file.relativePath });
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, () => worker())
  );

  const skipped = files.length - pending.length;

  if (totalUploads > 0 && uploaded === 0 && errors === totalUploads && present.size === 0) {
    const msg = lastError ? `Last error: ${lastError}` : 'Check folder permissions and API key';
    throw new Error(`Upload failed for all ${errors} file(s). ${msg}`);
  }

  return {
    uploaded,
    skipped,
    total: files.length,
    errors,
    deviceTotalFiles: serverDeviceTotalFiles,
    deviceTotalSize: serverDeviceTotalSize,
  };
}

let isSyncInProgress = false;

async function runOneOffForegroundSync(progressHandler, runOptions) {
  let result = null;
  let error = null;
  let isSyncRunning = true;
  const options = {
    taskName: 'PhoneBackupSync',
    taskTitle: '☁️ Backing up files',
    taskDesc: 'Scanning folders...',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: APP_PRIMARY_COLOR,
    parameters: {},
    taskProgressBarOptions: { max: 100, value: 0, indeterminate: true },
  };

  try {
    await BackgroundService.start(async () => {
      try {
        result = await performActualSync(progressHandler, runOptions);
      } catch (err) {
        error = err;
      } finally {
        isSyncRunning = false;
      }
    }, options);

    while (isSyncRunning && result === null && error === null) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    if (error) throw error;
    if (!result) throw new Error('Sync was cancelled or stopped prematurely');
    return result;
  } finally {
    await BackgroundService.stop().catch(() => {});
  }
}

export async function runSync(onProgress, runOptions = {}) {
  const isBackgroundFetch = !!runOptions.isBackgroundFetch;
  if (isSyncInProgress) {
    console.log('[BackgroundTask] Sync already in progress, skipping.');
    return { uploaded: 0, skipped: 0, total: 0, errors: 0, deviceTotalFiles: 0, deviceTotalSize: 0 };
  }
  isSyncInProgress = true;

  const progressHandler = async (current, total, detail) => {
    if (onProgress) await onProgress(current, total, detail);
    await reportProgress(current, total, detail);
  };

  try {
    if (isBackgroundFetch) {
      const ip = await getServerIp();
      const port = await getServerPort();
      if (!ip) {
        console.log('[BackgroundTask] Sync skipped: No server IP configured.');
        return { uploaded: 0, skipped: 0, total: 0, errors: 0, deviceTotalFiles: 0, deviceTotalSize: 0 };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`http://${ip}:${port}/ping`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          console.log('[BackgroundTask] Sync skipped: Server ping status not OK.');
          return { uploaded: 0, skipped: 0, total: 0, errors: 0, deviceTotalFiles: 0, deviceTotalSize: 0 };
        }
      } catch (err) {
        clearTimeout(timeout);
        console.log('[BackgroundTask] Sync skipped: Server unreachable/offline.');
        return { uploaded: 0, skipped: 0, total: 0, errors: 0, deviceTotalFiles: 0, deviceTotalSize: 0 };
      }
    }

    emitSyncStarted();

    let result;
    if (Platform.OS !== 'android' || !BackgroundService || !hasNativeBackgroundActions) {
      result = await performActualSync(progressHandler, runOptions);
    } else if (BackgroundService.isRunning()) {
      result = await performActualSync(progressHandler, runOptions);
    } else if (isBackgroundFetch) {
      result = await performActualSync(progressHandler, runOptions);
    } else {
      result = await runOneOffForegroundSync(progressHandler, runOptions);
    }

    const now = Date.now();
    await setLastSyncTime(now);

    const totalSynced = result.deviceTotalFiles > 0 ? result.deviceTotalFiles : (result.uploaded + result.skipped);
    if (totalSynced > 0) await setTotalSynced(totalSynced);

    if (!isBackgroundFetch || result.uploaded > 0) {
      await showSyncCompleteNotification(result.uploaded, result.skipped);
    }

    emitSyncCompleted({
      lastSyncTime: now,
      totalSynced: totalSynced > 0 ? totalSynced : undefined,
      uploaded: result.uploaded,
      skipped: result.skipped,
      errors: result.errors,
      total: result.total,
    });

    await updateIdleNotification(true);

    return result;
  } catch (err) {
    if (!isBackgroundFetch) {
      await showSyncErrorNotification(err?.message || 'Unknown error').catch(() => {});
      emitSyncFailed(err?.message || 'Unknown error');
    }
    await updateIdleNotification(true);
    throw err;
  } finally {
    isSyncInProgress = false;
  }
}


async function persistentSyncLoop(taskDataArguments) {
  const { delay } = taskDataArguments;
  await updateIdleNotification(true);

  while (BackgroundService.isRunning()) {
    try {
      if (isSyncInProgress) {
        // Progress notification is updated by reportProgress during sync.
      } else {
        const paused = await getSyncPaused();
        const intervalMinutes = await getSyncInterval();
        const last = await getLastSyncTime();
        const dueAt = (last || 0) + intervalMinutes * 60 * 1000;
        const now = Date.now();

        if (paused) {
          await updateIdleNotification();
        } else if (now >= dueAt) {
          const ip = await getServerIp();
          if (ip) {
            await runSync(null, { isBackgroundFetch: true }).catch((err) =>
              console.warn('[BackgroundTask] Auto sync failed:', err?.message)
            );
          } else {
            await updateIdleNotification();
          }
        } else {
          await updateIdleNotification();
        }
      }
    } catch (err) {
      console.warn('[BackgroundTask] Persistent loop tick failed:', err?.message);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

let persistentServiceStarting = false;

export async function startPersistentSyncService() {
  if (Platform.OS !== 'android' || !BackgroundService || !hasNativeBackgroundActions) return;
  if (BackgroundService.isRunning() || persistentServiceStarting) return;
  persistentServiceStarting = true;
  try {
    const options = {
      taskName: 'PhoneBackupAutoSync',
      taskTitle: '☁️ Phone Backup',
      taskDesc: 'Auto backup enabled',
      taskIcon: { name: 'ic_launcher', type: 'mipmap' },
      color: APP_PRIMARY_COLOR,
      parameters: { delay: SERVICE_LOOP_TICK_MS },
      taskProgressBarOptions: { max: 100, value: 0, indeterminate: false },
    };
    await BackgroundService.start(persistentSyncLoop, options);
  } catch (err) {
    console.warn('[BackgroundTask] Could not start persistent sync service:', err?.message);
  } finally {
    persistentServiceStarting = false;
  }
}

export async function stopPersistentSyncService() {
  if (!BackgroundService) return;
  await BackgroundService.stop().catch(() => {});
}

export async function registerBackgroundTask(intervalMinutes) {
  if (Platform.OS === 'android') {
    await startPersistentSyncService();
  }

  if (!TaskManager || !BackgroundFetch) {
    console.warn('[BackgroundTask] registerBackgroundTask: safety-net unavailable.');
    return;
  }

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME).catch(() => false);

    if (isRegistered && intervalMinutes === undefined) {
      return;
    }

    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(TASK_NAME).catch(() => {});
    }

    await BackgroundFetch.registerTaskAsync(TASK_NAME, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
    console.log('[BackgroundTask] Safety-net registered');
  } catch (err) {
    console.warn('[BackupTask] Safety-net registration failed (will retry):', err?.message);
  }
}

export async function unregisterBackgroundTask() {
  if (!BackgroundFetch) return;
  await BackgroundFetch.unregisterTaskAsync(TASK_NAME).catch(() => {});
}
