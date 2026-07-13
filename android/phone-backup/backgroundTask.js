import { DeviceEventEmitter, Platform, NativeModules } from 'react-native';
import { enrichFileMetadata, scan } from './scanner';
import { checkDeviceConnection, checkServerFiles, uploadFile } from './uploader';
import { acquireSyncWakeLock, releaseSyncWakeLock } from './wakeLock';
import {
  markUploadedBatch,
  clearSyncRuntimeState,
  getSyncPaused,
  getSyncInterval,
  getSyncRuntimeState,
  setLastSyncTime,
  setSyncRuntimeState,
  setTotalSynced,
  getServerIp,
  getLastSyncTime,
  getApiKey,
  getServerPort,
  getDeviceId,
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
const DEFAULT_UPLOAD_CONCURRENCY = 4;
const SMALL_FILE_UPLOAD_CONCURRENCY = 6;
const LARGE_FILE_UPLOAD_CONCURRENCY = 2;
const SMALL_FILE_THRESHOLD = 25 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 150 * 1024 * 1024;
const SERVICE_LOOP_TICK_MS = 15000;
const APP_PRIMARY_COLOR = '#2563EB';
const BACKUP_FOREGROUND_SERVICE_TYPE = ['dataSync'];

function withBackupForegroundServiceType(options) {
  return {
    ...options,
    foregroundServiceType: BACKUP_FOREGROUND_SERVICE_TYPE,
  };
}

function emptySyncResult(skippedReason = '') {
  return {
    uploaded: 0,
    skipped: 0,
    total: 0,
    errors: 0,
    deviceTotalFiles: 0,
    deviceTotalSize: 0,
    skippedReason,
  };
}

async function getScheduledSyncState() {
  const [paused, intervalMinutes, lastSyncTime] = await Promise.all([
    getSyncPaused(),
    getSyncInterval(),
    getLastSyncTime(),
  ]);
  const now = Date.now();
  const dueAt = (lastSyncTime || 0) + intervalMinutes * 60 * 1000;

  return {
    paused,
    intervalMinutes,
    lastSyncTime,
    dueAt,
    now,
    due: !paused && now >= dueAt,
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function getUploadConcurrency(files) {
  if (!files.length) return 0;

  let totalSize = 0;
  let largestSize = 0;
  for (const file of files) {
    const size = file.size || 0;
    totalSize += size;
    if (size > largestSize) largestSize = size;
  }

  const averageSize = totalSize / files.length;
  if (largestSize >= LARGE_FILE_THRESHOLD || averageSize >= LARGE_FILE_THRESHOLD) {
    return LARGE_FILE_UPLOAD_CONCURRENCY;
  }
  if (largestSize <= LARGE_FILE_THRESHOLD && averageSize <= SMALL_FILE_THRESHOLD) {
    return SMALL_FILE_UPLOAD_CONCURRENCY;
  }
  return DEFAULT_UPLOAD_CONCURRENCY;
}

let TaskManager = null;
let BackgroundFetch = null;

try {
  TaskManager = require('expo-task-manager');
  BackgroundFetch = require('expo-background-fetch');

  TaskManager.defineTask(TASK_NAME, async () => {
    try {
      const result = await runSync(null, { isBackgroundFetch: true });
      return result.uploaded > 0
        ? BackgroundFetch.BackgroundFetchResult.NewData
        : BackgroundFetch.BackgroundFetchResult.NoData;
    } catch (err) {
      console.warn('[BackgroundTask] Safety-net tick failed:', err?.message);
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
} catch (e) {
  console.warn('[BackgroundTask] Native modules not available.', e?.message);
}

let lastIdleDesc = null;
let currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
let isSyncInProgress = false;
// Per-sync AbortController — aborted immediately on force-stop so the worker
// can abandon an in-flight upload without waiting for the native HTTP call.
let syncAbortController = null;

function emitSyncState(state) {
  DeviceEventEmitter.emit('sync-state', state);
}

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

async function writeSyncState(patch = {}) {
  currentSyncState = {
    ...currentSyncState,
    ...patch,
    updatedAt: Date.now(),
  };
  await setSyncRuntimeState(currentSyncState).catch(() => {});
  emitSyncState(currentSyncState);
  return currentSyncState;
}

function buildStateFromProgress(current, total, detail = {}) {
  return {
    active: true,
    stopping: !!currentSyncState.stopping || !!detail.stopping,
    phase: detail.phase || currentSyncState.phase || 'uploading',
    current,
    total,
    detail,
  };
}

async function reportServerActivity(message) {
  try {
    const [serverIp, apiKey, serverPort, deviceId] = await Promise.all([
      getServerIp(),
      getApiKey(),
      getServerPort(),
      getDeviceId(),
    ]);
    if (!serverIp || !apiKey) return;

    await fetch(`http://${serverIp}:${serverPort}/status/activity`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        device_id: deviceId,
      }),
    }).catch(() => {});
  } catch (_e) {
    // Ignore errors
  }
}

export async function getCurrentSyncState() {
  const stored = await getSyncRuntimeState().catch(() => null);
  if (currentSyncState.active) return currentSyncState;

  const isActuallyRunning = (
    Platform.OS !== 'android' ||
    !BackgroundService ||
    BackgroundService.isRunning() ||
    isSyncInProgress
  );

  if (stored?.active) {
    if (!isActuallyRunning) {
      await clearSyncRuntimeState().catch(() => {});
      currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false };
      return currentSyncState;
    }
    currentSyncState = {
      active: true,
      stopping: !!stored.stopping,
      phase: stored.phase || 'idle',
      ...stored,
    };
    return currentSyncState;
  }
  return { active: false, phase: 'idle', stopRequested: false, stopping: false };
}

export async function stopCurrentSync() {
  if (!currentSyncState.active || currentSyncState.stopRequested) return false;
  currentSyncState.stopRequested = true;
  currentSyncState.forceStop = false;
  await writeSyncState({ stopping: true, forceStop: false });
  await reportServerActivity('Stopping backup');

  if (Platform.OS === 'android' && BackgroundService && BackgroundService.isRunning()) {
    const detail = { ...(currentSyncState.detail || {}), stopping: true };
    const desc = buildSyncProgressText(currentSyncState.current || 0, currentSyncState.total || 0, detail);

    await BackgroundService.updateNotification({
      taskTitle: 'Stopping backup',
      taskDesc: desc,
      taskProgressBarOptions: {
        max: currentSyncState.total || 100,
        value: currentSyncState.current || 0,
        indeterminate: !currentSyncState.total,
      },
    }).catch(() => {});
  }

  return true;
}

/**
 * Force-stops the current sync immediately — does not wait for the current
 * file to finish. Only valid while a graceful stop is already in progress
 * (i.e. stopRequested === true). Safe to call even if no sync is running.
 */
export async function forceStopCurrentSync() {
  if (!currentSyncState.active && !isSyncInProgress) return false;
  currentSyncState.stopRequested = true;
  currentSyncState.forceStop = true;
  isSyncInProgress = false;

  // Abort the per-sync AbortController so any raceWithAbort() call resolves
  // immediately, dropping the in-flight upload promise from the JS side.
  // The native HTTP request may still complete, but JS moves on instantly.
  syncAbortController?.abort();

  await writeSyncState({ stopping: true, forceStop: true });
  await reportServerActivity('Force-stopping backup');

  // Immediately tear down the foreground service so the OS kills the upload.
  if (Platform.OS === 'android' && BackgroundService) {
    await BackgroundService.stop().catch(() => {});
  }

  // Reset to idle immediately so UI reflects the stopped state.
  await clearSyncRuntimeState().catch(() => {});
  currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
  emitSyncState(currentSyncState);
  await reportServerActivity(null);
  await updateIdleNotification(true);

  return true;
}

function isStopRequested() {
  return !!currentSyncState.stopRequested;
}

function isForceStop() {
  return !!currentSyncState.forceStop;
}

function isAborted() {
  return !!syncAbortController?.signal.aborted;
}

/**
 * Races a promise against the per-sync AbortController.
 * If force-stop fires while `promise` is pending, the returned promise rejects
 * immediately with an 'aborted' error — the native upload continues in the
 * background but JS abandons it, giving a truly instant force-stop.
 */
function raceWithAbort(promise) {
  if (!syncAbortController) return promise;
  const { signal } = syncAbortController;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => { settled = true; signal.removeEventListener('abort', onAbort); resolve(val); },
      (err) => { settled = true; signal.removeEventListener('abort', onAbort); reject(err); }
    );
  });
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
  // Always propagate the stopping flag so the UI never flickers back to the
  // active-syncing state after the user pressed Stop.
  const enrichedDetail = currentSyncState.stopping
    ? { ...detail, stopping: true }
    : detail;

  await writeSyncState(buildStateFromProgress(current, total, enrichedDetail));
  emitSyncProgress(current, total, enrichedDetail);

  if (Platform.OS === 'android' && BackgroundService && BackgroundService.isRunning()) {
    const desc = buildSyncProgressText(current, total, enrichedDetail);
    let progressVal = 0;
    let progressMax = 100;
    let indeterminate = true;

    if (enrichedDetail?.phase === 'checking') {
      progressVal = enrichedDetail.checked || 0;
      progressMax = enrichedDetail.total || 100;
      indeterminate = false;
    } else if (enrichedDetail?.phase === 'uploading' || total > 0) {
      progressVal = current;
      progressMax = total || 100;
      indeterminate = false;
    }

    lastIdleDesc = null;
    await BackgroundService.updateNotification({
      taskTitle: currentSyncState.stopping ? 'Stopping backup' : '☁️ Backing up',
      taskDesc: desc,
      taskProgressBarOptions: { max: progressMax, value: progressVal, indeterminate },
    }).catch((err) => console.warn('[BackgroundService] updateNotification error:', err?.message));
  } else {
    await showSyncProgressNotification(current, total, enrichedDetail);
  }
}

export async function performActualSync(onProgress, runOptions = {}) {
  const forceRefreshFolder = runOptions.forceRefreshFolder;
  const targetFolderUri = runOptions.targetFolderUri;

  if (isStopRequested()) return { ...emptySyncResult('stopped'), stopped: true };

  if (onProgress) await onProgress(0, 0, { phase: 'scanning' });
  await reportServerActivity('Scanning folders');
  const files = await scan(async (detail) => {
    if (onProgress) await onProgress(0, 0, detail);
  }, targetFolderUri);

  if (isStopRequested()) return { ...emptySyncResult('stopped'), stopped: true };

  if (onProgress) await onProgress(0, 0, { phase: 'checking', checked: 0, total: files.length });
  await reportServerActivity('Checking server files');

  const present = new Set();
  const presentFiles = [];
  let checked = 0;
  let serverDeviceTotalFiles = 0;
  let serverDeviceTotalSize = 0;
  let stoppedDuringCheck = false;

  for (const batch of chunk(files, CHECK_BATCH_SIZE)) {
    if (isStopRequested()) { stoppedDuringCheck = true; break; }
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

  if (stoppedDuringCheck) {
    return {
      uploaded: 0,
      skipped: present.size,
      total: files.length,
      errors: 0,
      deviceTotalFiles: serverDeviceTotalFiles,
      deviceTotalSize: serverDeviceTotalSize,
      stopped: true,
    };
  }

  const pending = files.filter((file) => (
    !present.has(`${file.relativePath}|${file.modifiedTime}|${file.size || 0}`)
  ));

  const totalUploads = pending.length;
  let uploaded = 0;
  let skipped = files.length - pending.length;
  let completed = 0;
  let errors = 0;
  let lastError = null;
  let nextIndex = 0;
  const uploadedFiles = [];

  if (onProgress) await onProgress(0, totalUploads, { phase: 'uploading', currentFile: '' });
  await reportServerActivity('Uploading files');

  async function worker() {
    while (nextIndex < pending.length) {
      // Graceful stop: don't pick up any new file once stop is requested.
      // isStopRequested() is also true during force-stop (forceStop implies stopRequested).
      if (isStopRequested() || isAborted()) break;
      let file = pending[nextIndex++];
      if (!file) break;
      if (onProgress) {
        await onProgress(completed, totalUploads, { phase: 'uploading', currentFile: file.relativePath });
      }

      try {
        file = await enrichFileMetadata(file);

        // Graceful stop: stop pressed while loading metadata — don't start the upload.
        // Force stop: also caught here since forceStop sets stopRequested too.
        if (isStopRequested() || isAborted()) break;

        // Race the upload against the per-sync AbortController.
        // Graceful stop: upload runs to completion (one file per worker).
        // Force stop:    AbortController fires → raceWithAbort rejects immediately;
        //                the native HTTP call may still complete, but JS exits now.
        const res = await raceWithAbort(uploadFile(file, () => {}));

        if (res.success) {
          serverDeviceTotalFiles = res.deviceTotalFiles;
          serverDeviceTotalSize = res.deviceTotalSize;
          uploadedFiles.push(file);
          if (res.status === 'skipped') {
            skipped++;
          } else {
            uploaded++;
          }
        } else {
          errors++;
          lastError = 'Server rejected the file. Check server logs.';
        }
      } catch (err) {
        // Abandoned via force-stop or abort — not a real upload error.
        if (isForceStop() || isAborted()) {
          break;
        }
        console.warn('[BackupTask] Upload failed:', file.relativePath, err?.message);
        errors++;
        lastError = err?.message || 'Unknown network error';
      } finally {
        completed++;
        if (onProgress && !isForceStop() && !isAborted()) {
          await onProgress(completed, totalUploads, { phase: 'uploading', currentFile: file.relativePath });
        }
        // Graceful stop: break immediately after the current file completes.
        // Workers will not pick up another file from the shared queue.
        if (isForceStop() || isAborted() || isStopRequested()) break;
      }
    }
  }

  const uploadConcurrency = getUploadConcurrency(pending);
  await Promise.all(Array.from({ length: uploadConcurrency }, () => worker()));
  await markUploadedBatch(uploadedFiles);

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
    stopped: isStopRequested(),
  };
}



async function runOneOffForegroundSync(progressHandler, runOptions) {
  let result = null;
  let error = null;
  let isSyncRunning = true;
  const options = withBackupForegroundServiceType({
    taskName: 'PhoneBackupSync',
    taskTitle: '☁️ Backing up files',
    taskDesc: 'Scanning folders...',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: APP_PRIMARY_COLOR,
    parameters: {},
    taskProgressBarOptions: { max: 100, value: 0, indeterminate: true },
  });

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
  if (isBackgroundFetch && !runOptions.ignoreSchedule) {
    const schedule = await getScheduledSyncState();
    if (schedule.paused) {
      console.log('[BackgroundTask] Auto sync skipped: paused.');
      return emptySyncResult('paused');
    }
    if (!schedule.due) {
      console.log(
        `[BackgroundTask] Auto sync skipped: next run due at ${new Date(schedule.dueAt).toISOString()}.`
      );
      return emptySyncResult('not_due');
    }
  }

  if (isSyncInProgress) {
    console.log('[BackgroundTask] Sync already in progress, skipping.');
    return emptySyncResult('already_running');
  }
  isSyncInProgress = true;

  const progressHandler = async (current, total, detail) => {
    if (onProgress) await onProgress(current, total, detail);
    await reportProgress(current, total, detail);
  };

  let wakeLockAcquired = false;

  try {
    if (isBackgroundFetch) {
      const ip = await getServerIp();
      if (!ip) {
        console.log('[BackgroundTask] Sync skipped: No server IP configured.');
        return emptySyncResult('no_server');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const status = await checkDeviceConnection({ signal: controller.signal });
        clearTimeout(timeout);
        if (!status.connected) {
          console.log('[BackgroundTask] Sync skipped: Device is no longer approved by server.');
          return emptySyncResult('device_removed');
        }
      } catch (_err) {
        clearTimeout(timeout);
        console.log('[BackgroundTask] Sync skipped: Server unreachable/offline.');
        return emptySyncResult('server_unreachable');
      }
    }

    currentSyncState.stopRequested = false;
    currentSyncState.forceStop = false;
    syncAbortController = new AbortController();
    await writeSyncState({
      active: true,
      phase: 'scanning',
      current: 0,
      total: 0,
      detail: { phase: 'scanning' },
      startedAt: Date.now(),
    });
    await reportServerActivity('Scanning folders');

    wakeLockAcquired = await acquireSyncWakeLock();
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
      stopped: !!result.stopped,
    });

    await clearSyncRuntimeState().catch(() => {});
    currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
    emitSyncState(currentSyncState);
    await reportServerActivity(null);
    await updateIdleNotification(true);

    return result;
  } catch (err) {
    // If a force-stop already cleaned up state, don't emit a spurious failure.
    if (!isForceStop() && !isAborted()) {
      if (!isBackgroundFetch) {
        await showSyncErrorNotification(err?.message || 'Unknown error').catch(() => {});
        emitSyncFailed(err?.message || 'Unknown error');
      }
      await clearSyncRuntimeState().catch(() => {});
      currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
      emitSyncState(currentSyncState);
      await reportServerActivity(null);
      await updateIdleNotification(true);
    }
    throw err;
  } finally {
    syncAbortController = null;
    await releaseSyncWakeLock(wakeLockAcquired);
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
        const schedule = await getScheduledSyncState();

        if (schedule.paused) {
          await updateIdleNotification();
        } else if (schedule.due) {
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
    const options = withBackupForegroundServiceType({
      taskName: 'PhoneBackupAutoSync',
      taskTitle: '☁️ Phone Backup',
      taskDesc: 'Auto backup enabled',
      taskIcon: { name: 'ic_launcher', type: 'mipmap' },
      color: APP_PRIMARY_COLOR,
      parameters: { delay: SERVICE_LOOP_TICK_MS },
      taskProgressBarOptions: { max: 100, value: 0, indeterminate: false },
    });
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
