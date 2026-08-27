import { DeviceEventEmitter, Platform, NativeModules } from 'react-native';
import { enrichFileMetadata, scanIncrementalBackup, pendingFileKey } from './scanner';
import { checkDeviceConnection, checkServerFiles, postSyncSession, uploadFile } from './uploader';
import { acquireSyncWakeLock, releaseSyncWakeLock } from './wakeLock';
import {
  markUploadedBatch,
  isUploadedBatch,
  clearSyncRuntimeState,
  getSyncPaused,
  getSyncInterval,
  getSyncRuntimeState,
  setLastSyncTime,
  setSyncRuntimeState,
  setTotalSynced,
  setTotalSyncedBytes,
  getServerIp,
  getLastSyncTime,
  getApiKey,
  getServerPort,
  getDeviceId,
  getDeviceToken,
  getFolders,
  loadScanSnapshot,
  saveScanSnapshot,
  clearScanSnapshot,
  clearScanSnapshotForFolder,
  getAutoSyncSuppressedUntil,
  setAutoSyncSuppressedUntil,
  resolveReachableServer,
} from './settings';
import {
  showSyncProgressNotification,
  showSyncCompleteNotification,
  showSyncErrorNotification,
  showStreakRiskNotification,
  buildSyncProgressText,
} from './notificationService';
import { appendSyncSession } from './syncHistory';
import {
  recordSyncCompleted,
  getStreakData,
  todayStr as streakTodayStr,
  getLastStreakRiskNotifiedDate,
  setLastStreakRiskNotifiedDate,
} from './streak';
import { setPendingBackupFromSync } from './pendingBackup';
import { triggerWidgetRefresh } from './widget';

/**
 * Converts any raw error message to a short, user-readable string.
 * Keeps technical noise (native module names, Java exception classes, stack
 * traces) in the Expo / developer console only — not visible in the app UI.
 */
function sanitizeErrorForUser(msg) {
  const raw = (msg || 'Unknown error').trim();

  // Content type / MIME type resolution errors
  if (
    raw.includes('guessContentTypeFromName') ||
    raw.includes('guessContentType') ||
    raw.includes('must not be null')
  ) {
    return 'File format error — unable to determine file type for upload';
  }

  // Null pointer / reference errors
  if (
    raw.includes('NullPointerException') ||
    raw.includes('null reference') ||
    raw.includes('cannot read property') ||
    raw.includes('undefined is not')
  ) {
    return 'File error — unable to read file details';
  }

  // Native ExponentFileSystem / NativeModule noise
  if (
    raw.includes('ExponentFileSystem') ||
    raw.includes('uploadAsync') ||
    raw.includes('has been rejected') ||
    raw.includes('NativeModule') ||
    raw.includes('Invariant Violation')
  ) {
    const caused = raw.match(/(?:Caused by|caused by)[:\s]+(.+?)(?:\n|$)/i);
    if (caused && caused[1]) {
      return sanitizeErrorForUser(caused[1]);
    }
    return 'File could not be uploaded (inaccessible or removed)';
  }

  // Common Android / network errors
  if (raw.includes('FileNotFoundException') || raw.includes('ENOENT') || raw.includes('No such file')) {
    return 'File not found — it may have been moved or deleted';
  }
  if (raw.includes('SecurityException') || raw.includes('EPERM') || raw.includes('EACCES')) {
    return 'Permission denied — check folder access in Settings';
  }
  if (raw.includes('SocketException') || raw.includes('ConnectException') || raw.includes('ECONNREFUSED') || raw.includes('ETIMEDOUT') || raw.includes('Network')) {
    return 'Network error — check Wi-Fi and server connection';
  }
  if (raw.includes('IOException')) {
    return 'File read error — the file may be corrupted or in use';
  }

  // Catch-all for code-level/technical errors
  if (/java\.|android\.|com\.|Exception|TypeError|ReferenceError|IllegalState|IllegalArgument|NullPointer|Method|Class/i.test(raw)) {
    return 'File could not be uploaded — system error';
  }

  // Truncate anything excessively long
  if (raw.length > 120) return raw.substring(0, 117).replace(/\n.*$/, '').trim() + '…';

  return raw;
}

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
const DEFAULT_UPLOAD_CONCURRENCY = 2;
const SMALL_FILE_UPLOAD_CONCURRENCY = 3;
const LARGE_FILE_UPLOAD_CONCURRENCY = 1;
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
  const [paused, intervalMinutes, lastSyncTime, autoSuppressedUntil] = await Promise.all([
    getSyncPaused(),
    getSyncInterval(),
    getLastSyncTime(),
    getAutoSyncSuppressedUntil(),
  ]);
  const now = Date.now();
  const isSuppressed = !!autoSuppressedUntil && now < autoSuppressedUntil;
  const dueAt = (lastSyncTime || 0) + intervalMinutes * 60 * 1000;

  return {
    paused,
    intervalMinutes,
    lastSyncTime,
    dueAt,
    now,
    due: !paused && !isSuppressed && now >= dueAt,
    autoSuppressedUntil,
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
      checkStreakRiskInBackground().catch(() => {});
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

async function checkStreakRiskInBackground() {
  try {
    const todayStr = streakTodayStr();
    const lastNotified = await getLastStreakRiskNotifiedDate();
    if (lastNotified === todayStr) return;

    const hourNow = new Date().getHours();
    if (hourNow < 18) return; // only warn in the evening, once the day's sync window is closing

    const streak = await getStreakData();
    if (streak.atRisk && streak.currentStreak > 0) {
      await showStreakRiskNotification(streak.currentStreak);
      await setLastStreakRiskNotifiedDate(todayStr);
    }
  } catch {}
}

let lastIdleDesc = null;
let lastNotificationUpdateAt = 0;
let lastProgressEmitAt = 0;
const NOTIFICATION_THROTTLE_MS = 400;
const PROGRESS_EMIT_THROTTLE_MS = 150;
let currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
let lastPersistedSyncStateAt = 0;
const SYNC_STATE_PERSIST_INTERVAL_MS = 800;
let isSyncInProgress = false;
let syncRunsInOneOffService = false;
let forceStopRequested = false;
let stopFlagsHydratePromise = null;
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

let lastStateEmitAt = 0;
const STATE_EMIT_THROTTLE_MS = 250;

async function writeSyncState(patch = {}) {
  const prevPhase = currentSyncState.phase;
  const prevActive = currentSyncState.active;
  const prevStopping = currentSyncState.stopping;
  const prevStopRequested = currentSyncState.stopRequested;
  currentSyncState = {
    ...currentSyncState,
    ...patch,
    updatedAt: Date.now(),
  };

  const now = Date.now();
  const structuralChange =
    currentSyncState.phase !== prevPhase ||
    currentSyncState.active !== prevActive ||
    currentSyncState.stopping !== prevStopping ||
    currentSyncState.stopRequested !== prevStopRequested;

  if (structuralChange || now - lastStateEmitAt >= STATE_EMIT_THROTTLE_MS) {
    lastStateEmitAt = now;
    emitSyncState(currentSyncState);
  }

  // Persisting to AsyncStorage on every file's progress tick (thousands of
  // times for a large library) is what makes the sync feel like it slows
  // down over time. Only persist on meaningful transitions or throttled.
  if (structuralChange || now - lastPersistedSyncStateAt >= SYNC_STATE_PERSIST_INTERVAL_MS) {
    lastPersistedSyncStateAt = now;
    await setSyncRuntimeState(currentSyncState).catch(() => {});
  }
  return currentSyncState;
}

function buildStateFromProgress(current, total, detail = {}) {
  return {
    active: true,
    stopping: !!currentSyncState.stopping || !!detail.stopping,
    stopRequested: !!currentSyncState.stopRequested || !!currentSyncState.stopping,
    forceStop: !!currentSyncState.forceStop,
    phase: detail.phase || currentSyncState.phase || 'uploading',
    current,
    total,
    detail,
  };
}

async function reportServerActivity(message) {
  try {
    const [serverIp, apiKey, serverPort, deviceId, deviceToken] = await Promise.all([
      getServerIp(),
      getApiKey(),
      getServerPort(),
      getDeviceId(),
      getDeviceToken(),
    ]);
    if (!serverIp || !apiKey) return;

    await fetch(`http://${serverIp}:${serverPort}/status/activity`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken || apiKey}`,
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
      // Persisted state exists, but nothing is running. Treat as stale.
      await clearSyncRuntimeState().catch(() => {});
      currentSyncState = {
        active: false,
        phase: 'idle',
        stopRequested: false,
        stopping: false,
        forceStop: false,
      };
      forceStopRequested = false;
      return currentSyncState;
    }

    // Sync engine is (likely) running in another JS context (background-action)
    // OR it is running in this JS context (isSyncInProgress).
    currentSyncState = {
      active: true,
      stopping: !!stored.stopping,
      stopRequested: !!stored.stopRequested,
      phase: stored.phase || 'idle',
      ...stored,
    };
    return currentSyncState;
  }

  return { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
}

export async function stopCurrentSync() {
  await hydrateStopFlagsFromStorage();
  if (!currentSyncState.active && !isSyncInProgress) return false;
  if (currentSyncState.stopRequested) return false;

  currentSyncState.stopRequested = true;
  currentSyncState.stopping = true;
  currentSyncState.forceStop = false;
  await writeSyncState({
    active: true,
    stopping: true,
    stopRequested: true,
    forceStop: false,
  });
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

  // Prevent the next *automatic* sync run from starting immediately after
  // the user manually requests a stop (especially across app relaunch /
  // force-stop). This does not affect the manual "Sync Now" button.
  try {
    const intervalMinutes = await getSyncInterval();
    await setLastSyncTime(Date.now());
    await setAutoSyncSuppressedUntil(Date.now() + intervalMinutes * 60 * 1000);
  } catch {}

  return true;
}

/**
 * Force-stops the current sync immediately — does not wait for the current
 * file to finish. Only valid while a graceful stop is already in progress
 * (i.e. stopRequested === true). Safe to call even if no sync is running.
 */
export async function forceStopCurrentSync() {
  if (!currentSyncState.active && !isSyncInProgress) return false;

  forceStopRequested = true;
  currentSyncState.stopRequested = true;
  currentSyncState.stopping = true;
  currentSyncState.forceStop = true;

  syncAbortController?.abort();

  await writeSyncState({
    active: true,
    stopping: true,
    stopRequested: true,
    forceStop: true,
  });
  await reportServerActivity('Force-stopping backup');

  // Only tear down the foreground service when this sync owns a one-off service.
  // Never stop the persistent auto-sync service while a sync runs inline.
  if (Platform.OS === 'android' && BackgroundService && syncRunsInOneOffService) {
    await BackgroundService.stop().catch(() => {});
  }

  // Same auto-sync suppression as graceful stop.
  try {
    const intervalMinutes = await getSyncInterval();
    await setLastSyncTime(Date.now());
    await setAutoSyncSuppressedUntil(Date.now() + intervalMinutes * 60 * 1000);
  } catch {}

  await clearSyncRuntimeState().catch(() => {});
  currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
  emitSyncState(currentSyncState);
  await reportServerActivity(null);
  await updateIdleNotification(true);

  if (Platform.OS === 'android' && BackgroundService && syncRunsInOneOffService) {
    await startPersistentSyncService().catch(() => {});
  }

  return true;
}

function applyStoredStopFlags(stored = {}) {
  if (stored.forceStop) {
    forceStopRequested = true;
    currentSyncState.forceStop = true;
    currentSyncState.stopRequested = true;
    currentSyncState.stopping = true;
    syncAbortController?.abort();
    return;
  }
  if (stored.stopRequested || stored.stopping) {
    currentSyncState.stopRequested = true;
    currentSyncState.stopping = !!stored.stopping || !!stored.stopRequested;
  }
}

async function hydrateStopFlagsFromStorage() {
  if (!stopFlagsHydratePromise) {
    stopFlagsHydratePromise = getSyncRuntimeState()
      .then((stored) => {
        if (stored && typeof stored === 'object') {
          applyStoredStopFlags(stored);
        }
      })
      .catch(() => {})
      .finally(() => {
        stopFlagsHydratePromise = null;
      });
  }
  await stopFlagsHydratePromise;
}

function isStopRequested() {
  return !!currentSyncState.stopRequested || !!currentSyncState.stopping;
}

function isForceStop() {
  return !!currentSyncState.forceStop || forceStopRequested;
}

function isAborted() {
  return !!syncAbortController?.signal.aborted || forceStopRequested;
}

async function shouldAbortSync() {
  if (isForceStop() || isAborted() || isStopRequested()) return true;
  await hydrateStopFlagsFromStorage();
  return isForceStop() || isAborted() || isStopRequested();
}

async function recoverStaleSyncStateOnStartup() {
  if (isSyncInProgress) return;

  const stored = await getSyncRuntimeState().catch(() => null);
  if (!stored?.active) return;

  // Only clear runtime state when we can be sure sync isn't actually running.
  // Auto-sync uses a persistent Android foreground service, which stays up
  // even if the app UI JS context restarts.
  const isActuallyRunning = (
    Platform.OS !== 'android' ||
    !BackgroundService ||
    BackgroundService.isRunning()
  );

  if (!isActuallyRunning) {
    await clearSyncRuntimeState().catch(() => {});
    currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
    forceStopRequested = false;
    emitSyncState(currentSyncState);
  }
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
  const enrichedDetail = currentSyncState.stopping
    ? { ...detail, stopping: true }
    : detail;

  const prevPhase = currentSyncState.phase;
  await writeSyncState(buildStateFromProgress(current, total, enrichedDetail));

  const now = Date.now();
  const isPhaseChange = enrichedDetail?.phase !== prevPhase;
  const isTerminal = enrichedDetail?.phase === 'idle' || enrichedDetail?.stopping || total > 0 && current >= total;

  const shouldEmitProgress = isPhaseChange || isTerminal || now - lastProgressEmitAt >= PROGRESS_EMIT_THROTTLE_MS;
  if (shouldEmitProgress) {
    lastProgressEmitAt = now;
    emitSyncProgress(current, total, enrichedDetail);
  }

  const shouldUpdateNotification = isPhaseChange || isTerminal || now - lastNotificationUpdateAt >= NOTIFICATION_THROTTLE_MS;
  if (!shouldUpdateNotification) return;
  lastNotificationUpdateAt = now;

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
  const forceRefreshAll = runOptions.forceRefreshAll;
  const isTwoWay = !!(forceRefreshAll || forceRefreshFolder);
  const incrementalScan = !isTwoWay;

  if (await shouldAbortSync()) return { ...emptySyncResult('stopped'), stopped: true };

  if (forceRefreshAll) {
    await clearScanSnapshot();
  } else if (forceRefreshFolder) {
    await clearScanSnapshotForFolder(forceRefreshFolder);
  }

  if (onProgress) await onProgress(0, 0, { phase: 'scanning' });
  reportServerActivity('Scanning folders');
  const snapshotCache = await loadScanSnapshot();
  const { files, snapshotSkipped, stopped: scanStopped } = await scanIncrementalBackup(
    async (detail) => {
      if (await shouldAbortSync()) return;
      if (onProgress) await onProgress(0, 0, detail);
    },
    snapshotCache,
    {
      incremental: incrementalScan,
      // Two-way refresh needs real size/modifiedTime before hitting /files/check.
      // Normal Sync Now / Auto Sync defers metadata to the upload worker so the
      // scan doesn't block on per-file SAF stat calls (drain()) before checking.
      noMetadata: !isTwoWay,
      targetFolderUri,
      shouldStop: () => isStopRequested() || isForceStop() || isAborted(),
    }
  );

  if (scanStopped || await shouldAbortSync()) {
    return { ...emptySyncResult('stopped'), stopped: true };
  }

  if (onProgress) await onProgress(0, 0, { phase: 'checking', checked: 0, total: files.length });
  reportServerActivity(isTwoWay ? 'Checking server files' : 'Checking local files');

  const present = new Set();
  const presentFiles = [];
  const trustedFiles = [];
  let checked = 0;
  let serverDeviceTotalFiles = 0;
  let serverDeviceTotalSize = 0;
  let stoppedDuringCheck = false;

  if (!isTwoWay) {
    // Pure client-side check against cached upload keys (no HTTP request)
    const trusted = await isUploadedBatch(files);
    for (const file of files) {
      const key = pendingFileKey(file);
      if (trusted.has(key)) {
        present.add(key);
        trustedFiles.push(file);
      }
    }
    checked = files.length;
    if (onProgress) await onProgress(0, 0, { phase: 'checking', checked, total: files.length });
  } else {
    // Two-way server-side check for Refresh Folder / Refresh All Backups
    for (const batch of chunk(files, CHECK_BATCH_SIZE)) {
      if (await shouldAbortSync()) { stoppedDuringCheck = true; break; }
      const res = await checkServerFiles(batch, { verifyDisk: true });
      const statuses = res.files;
      serverDeviceTotalFiles = res.deviceTotalFiles;
      serverDeviceTotalSize = res.deviceTotalSize;

      const batchByKey = new Map(
        batch.map((file) => [pendingFileKey(file), file])
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
      if (onProgress) await onProgress(0, 0, { phase: 'checking', checked, total: files.length });
    }

    if (presentFiles.length > 0) {
      await markUploadedBatch(presentFiles);
    }
  }

  if (stoppedDuringCheck) {
    const stoppedPending = files.filter((file) => !present.has(pendingFileKey(file)));
    return {
      uploaded: 0,
      skipped: present.size + snapshotSkipped,
      total: files.length + snapshotSkipped,
      errors: 0,
      deviceTotalFiles: serverDeviceTotalFiles,
      deviceTotalSize: serverDeviceTotalSize,
      stopped: true,
      pendingFiles: stoppedPending,
    };
  }

  const pending = files.filter((file) => !present.has(pendingFileKey(file)));

  const totalUploads = pending.length;
  let uploaded = 0;
  let skipped = files.length - pending.length + snapshotSkipped;
  let completed = 0;
  let errors = 0;
  let lastError = null;
  let nextIndex = 0;
  const uploadedFiles = [];

  if (onProgress) await onProgress(0, totalUploads, { phase: 'uploading', currentFile: '' });
  reportServerActivity('Uploading files');

  async function worker() {
    while (nextIndex < pending.length) {
      if (await shouldAbortSync()) break;
      let file = pending[nextIndex++];
      if (!file) break;
      if (onProgress) {
        await onProgress(completed, totalUploads, { phase: 'uploading', currentFile: file.relativePath });
      }

      try {
        file = await enrichFileMetadata(file);

        if (await shouldAbortSync()) break;

        const res = await raceWithAbort(uploadFile(file, () => {}, { verifyDisk: isTwoWay }));

        if (res.success) {
          serverDeviceTotalFiles = res.deviceTotalFiles;
          serverDeviceTotalSize = res.deviceTotalSize;
          uploadedFiles.push(file);
          // Collect basenames for session history (capped at 20)
          if (runOptions.sessionBuilder && runOptions.sessionBuilder.uploadedFiles.length < 20) {
            runOptions.sessionBuilder.uploadedFiles.push(file.name || file.relativePath.split('/').pop() || file.relativePath);
          }
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
        // Errors from uploader.js are already sanitized; sanitize anything else
        // (e.g. enrichFileMetadata failures) so no technical strings reach the UI.
        const friendlyMsg = sanitizeErrorForUser(err?.message || 'Upload failed');
        lastError = friendlyMsg;
        // Record error detail for history using file basename, not full path
        if (runOptions.sessionBuilder) {
          runOptions.sessionBuilder.errorDetails.push(`${file.name || file.relativePath.split('/').pop()}: ${friendlyMsg}`);
        }
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

  // Match on the stable SAF document `uri` (unique per file and preserved by
  // enrichFileMetadata). pendingFileKey embeds size|mtime, which differ between
  // the noMetadata `pending` entries (0|0) and the enriched `uploadedFiles`, so
  // keying on it would leave every uploaded file counted as still-pending.
  const uploadedUris = new Set(uploadedFiles.map((file) => file.uri));
  const remainingPending = pending.filter((file) => !uploadedUris.has(file.uri));

  if (!(await shouldAbortSync())) {
    const scannedSuccessfully = [...trustedFiles, ...presentFiles, ...uploadedFiles];
    await saveScanSnapshot(scannedSuccessfully, { merge: !forceRefreshAll }).catch(() => {});
  }

  if (totalUploads > 0 && uploaded === 0 && errors === totalUploads && present.size === 0) {
    const msg = lastError ? `Last error: ${lastError}` : 'Check folder permissions and server connection';
    throw new Error(`Upload failed for all ${errors} file(s). ${msg}`);
  }

  return {
    uploaded,
    skipped,
    total: files.length + snapshotSkipped,
    scanned: files.length,
    errors,
    deviceTotalFiles: serverDeviceTotalFiles,
    deviceTotalSize: serverDeviceTotalSize,
    stopped: await shouldAbortSync(),
    pendingFiles: remainingPending,
  };
}



async function runOneOffForegroundSync(progressHandler, runOptions) {
  let result = null;
  let error = null;
  let isSyncRunning = true;
  syncRunsInOneOffService = true;
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
    syncRunsInOneOffService = false;
    await BackgroundService.stop().catch(() => {});
    await startPersistentSyncService().catch(() => {});
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

  const isAuto = !!runOptions.isBackgroundFetch;
  const sessionBuilder = {
    id:            String(Date.now()),
    startedAt:     Date.now(),
    trigger:       isAuto ? 'auto' : 'manual',
    uploadedFiles: [],
    errorDetails:  [],
  };
  // Thread through so worker can accumulate files/errors
  runOptions = { ...runOptions, sessionBuilder, isAuto };

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
        // Before giving up, attempt mesh roaming failover: the phone may have switched to
        // a different mesh node while the app was in the background.
        console.log('[BackgroundTask] Server unreachable — attempting mesh roaming resolution...');
        try {
          const resolved = await resolveReachableServer({ timeoutMs: 1500 });
          if (resolved.ok) {
            // New IP found — verify the device is still connected
            const retryStatus = await checkDeviceConnection();
            if (!retryStatus.connected) {
              console.log('[BackgroundTask] Sync skipped: Device no longer approved after re-resolve.');
              return emptySyncResult('device_removed');
            }
            console.log(`[BackgroundTask] Mesh re-resolution successful (IP: ${resolved.ip}). Proceeding with sync.`);
          } else {
            console.log('[BackgroundTask] Sync skipped: Server unreachable after mesh resolution attempt.');
            return emptySyncResult('server_unreachable');
          }
        } catch {
          console.log('[BackgroundTask] Sync skipped: Server unreachable/offline.');
          return emptySyncResult('server_unreachable');
        }
      }
    }

    currentSyncState.stopRequested = false;
    currentSyncState.forceStop = false;
    currentSyncState.stopping = false;
    forceStopRequested = false;
    syncAbortController = new AbortController();
    await writeSyncState({
      active: true,
      phase: 'scanning',
      current: 0,
      total: 0,
      detail: { phase: 'scanning' },
      startedAt: Date.now(),
      stopRequested: false,
      stopping: false,
      forceStop: false,
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

    if (!result) {
      result = { ...emptySyncResult('stopped'), stopped: true };
    }

    const wasForceStopped = forceStopRequested || isForceStop() || isAborted();
    const now = Date.now();

    if (!wasForceStopped) {
      await setLastSyncTime(now);
    }

    const totalSynced = result.deviceTotalFiles > 0 ? result.deviceTotalFiles : (result.uploaded + result.skipped);
    if (totalSynced > 0) await setTotalSynced(totalSynced);
    if (result.deviceTotalSize > 0) await setTotalSyncedBytes(result.deviceTotalSize);

    // ── Persist sync session history ─────────────────────────────────────────
    const folders = await getFolders().catch(() => []);
    const outcome = wasForceStopped
      ? 'force_stopped'
      : result.stopped
        ? 'stopped'
        : 'completed';
    await appendSyncSession({
      ...sessionBuilder,
      endedAt:      now,
      durationMs:   now - sessionBuilder.startedAt,
      outcome,
      scanned:      result.scanned   ?? result.total ?? 0,
      checked:      result.total     ?? 0,
      uploaded:     result.uploaded  ?? 0,
      skipped:      result.skipped   ?? 0,
      errors:       result.errors    ?? 0,
      totalFiles:   totalSynced,
      totalSize:    result.deviceTotalSize ?? 0,
      folders:      folders.map((f) => f.name),
    }).catch(() => {});
    // Fire-and-forget: also post to server (best-effort, never blocks sync completion)
    postSyncSession({
      started_at:  sessionBuilder.startedAt,
      ended_at:    now,
      duration_ms: now - sessionBuilder.startedAt,
      trigger:     sessionBuilder.trigger,
      outcome,
      scanned:     result.scanned   ?? result.total ?? 0,
      checked:     result.total     ?? 0,
      uploaded:    result.uploaded  ?? 0,
      skipped:     result.skipped   ?? 0,
      errors:      result.errors    ?? 0,
      total_files: totalSynced,
    }).catch(() => {});
    // ─────────────────────────────────────────────────────────────────────────

    if (outcome === 'completed' && result.errors === 0) {
      await recordSyncCompleted().catch(() => {});
    }

    if (!wasForceStopped && Array.isArray(result.pendingFiles)) {
      setPendingBackupFromSync(result.pendingFiles).catch(() => {});
    }

    if (outcome === 'completed' && !result.stopped && !wasForceStopped) {
      triggerWidgetRefresh().catch(() => {});
    }

    if ((!isBackgroundFetch || result.uploaded > 0) && !result.stopped && !wasForceStopped) {
      await showSyncCompleteNotification(result.uploaded, result.skipped);
    }

    emitSyncCompleted({
      lastSyncTime: wasForceStopped ? undefined : now,
      totalSynced: totalSynced > 0 ? totalSynced : undefined,
      uploaded: result.uploaded,
      skipped: result.skipped,
      errors: result.errors,
      total: result.total,
      stopped: !!result.stopped || wasForceStopped,
    });

    await clearSyncRuntimeState().catch(() => {});
    currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
    forceStopRequested = false;
    emitSyncState(currentSyncState);
    await reportServerActivity(null);
    await updateIdleNotification(true);

    return result;
  } catch (err) {
    const failedAt = Date.now();
    // If a force-stop already cleaned up state, record a force_stopped session
    // and exit cleanly — do NOT emit a spurious failure notification.
    if (isForceStop() || isAborted()) {
      await appendSyncSession({
        ...sessionBuilder,
        endedAt:    failedAt,
        durationMs: failedAt - sessionBuilder.startedAt,
        outcome:    'force_stopped',
        uploaded:   sessionBuilder.uploadedFiles.length,
        errors:     sessionBuilder.errorDetails.length,
      }).catch(() => {});
      postSyncSession({
        started_at:  sessionBuilder.startedAt,
        ended_at:    failedAt,
        duration_ms: failedAt - sessionBuilder.startedAt,
        trigger:     sessionBuilder.trigger,
        outcome:     'force_stopped',
      }).catch(() => {});
      return;  // swallow the thrown abort error
    }
    if (!isBackgroundFetch) {
      // Sanitize before showing to user — no native module names in UI
      const userMsg = sanitizeErrorForUser(err?.message || 'Unknown error');
      await showSyncErrorNotification(userMsg).catch(() => {});
      emitSyncFailed(userMsg);
    }
    // Persist failed session with single consistent timestamp
    await appendSyncSession({
      ...sessionBuilder,
      endedAt:      failedAt,
      durationMs:   failedAt - sessionBuilder.startedAt,
      outcome:      'failed',
      errors:       (sessionBuilder.errorDetails.length || 0) + 1,
      errorDetails: [
        ...sessionBuilder.errorDetails,
        sanitizeErrorForUser(err?.message || 'Unknown error'),
      ].slice(0, 10),
    }).catch(() => {});
    postSyncSession({
      started_at:  sessionBuilder.startedAt,
      ended_at:    failedAt,
      duration_ms: failedAt - sessionBuilder.startedAt,
      trigger:     sessionBuilder.trigger,
      outcome:     'failed',
      errors:      1,
    }).catch(() => {});
    await clearSyncRuntimeState().catch(() => {});
    currentSyncState = { active: false, phase: 'idle', stopRequested: false, stopping: false, forceStop: false };
    forceStopRequested = false;
    emitSyncState(currentSyncState);
    await reportServerActivity(null);
    await updateIdleNotification(true);
    throw err;
  } finally {
    syncAbortController = null;
    await releaseSyncWakeLock(wakeLockAcquired);
    isSyncInProgress = false;
    forceStopRequested = false;
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
        checkStreakRiskInBackground().catch(() => {});
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

export async function registerBackgroundTask(intervalMinutes) {
  await recoverStaleSyncStateOnStartup();

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
      minimumInterval: 60 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
    console.log('[BackgroundTask] Safety-net registered');
  } catch (err) {
    console.warn('[BackupTask] Safety-net registration failed (will retry):', err?.message);
  }
}