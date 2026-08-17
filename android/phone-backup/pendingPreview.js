import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFolders, loadScanSnapshot } from './settings';
import { scan, hasProperExtension } from './scanner';

const CACHE_KEY = 'pending_preview_cache_v1';
const MULTI_GET_CHUNK = 500;
const STALE_MS = 2 * 60 * 1000;

let inFlight = null;
let inFlightEpoch = -1;
let cacheEpoch = 0;
let lastScanAt = 0;

export function formatPendingBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function multiGetChunked(keys) {
  if (!keys.length) return [];
  const chunks = [];
  for (let i = 0; i < keys.length; i += MULTI_GET_CHUNK) {
    chunks.push(keys.slice(i, i + MULTI_GET_CHUNK));
  }
  const chunkResults = await Promise.all(chunks.map((c) => AsyncStorage.multiGet(c)));
  return chunkResults.flat();
}

function emptyPreview(extra = {}) {
  return {
    newCount: 0,
    changedCount: 0,
    pendingBytes: 0,
    snapshotFiles: 0,
    scanned: false,
    aborted: false,
    noFolders: false,
    ...extra,
  };
}

export function isValidPendingPreview(parsed) {
  return !!(
    parsed &&
    typeof parsed === 'object' &&
    Number.isFinite(parsed.newCount) &&
    Number.isFinite(parsed.changedCount) &&
    Number.isFinite(parsed.pendingBytes) &&
    !parsed.aborted
  );
}

function fileNameFromPath(path) {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1] || path;
}

function summarizePendingFiles(files, extra = {}) {
  let newCount = 0;
  let changedCount = 0;
  let pendingBytes = 0;
  for (const file of files) {
    pendingBytes += Number(file.size) || 0;
    if (file.status === 'changed') changedCount += 1;
    else newCount += 1;
  }
  return {
    files,
    newCount,
    changedCount,
    pendingBytes,
    ...extra,
  };
}

async function collectPendingFromSnapshot(snapshotCache, shouldStop) {
  const entries = [...snapshotCache.entries()];
  if (entries.length === 0) return [];

  if (shouldStop?.()) return null;

  const keys = entries.map(([path]) => `uploaded_${path}`);
  const pairs = await multiGetChunked(keys);
  if (shouldStop?.()) return null;
  const valueByKey = new Map(pairs);

  const files = [];
  for (let i = 0; i < entries.length; i++) {
    if (i % 500 === 0 && shouldStop?.()) return null;
    const [path, meta] = entries[i];
    const val = valueByKey.get(`uploaded_${path}`);
    const mtime = String(meta?.mtime || 0);
    const size = Number(meta?.size) || 0;
    if (val == null) {
      files.push({
        relativePath: path,
        name: fileNameFromPath(path),
        size,
        modifiedTime: Number(meta?.mtime) || 0,
        status: 'new',
      });
    } else if (val !== mtime && meta?.mtime) {
      files.push({
        relativePath: path,
        name: fileNameFromPath(path),
        size,
        modifiedTime: Number(meta?.mtime) || 0,
        status: 'changed',
      });
    }
  }
  return files;
}

async function classifySnapshot(snapshotCache, shouldStop) {
  const entries = [...snapshotCache.entries()];
  if (entries.length === 0) {
    return emptyPreview({ snapshotFiles: 0 });
  }

  const files = await collectPendingFromSnapshot(snapshotCache, shouldStop);
  if (files == null) {
    return emptyPreview({ aborted: true, snapshotFiles: entries.length });
  }

  const summary = summarizePendingFiles(files);
  return {
    newCount: summary.newCount,
    changedCount: summary.changedCount,
    pendingBytes: summary.pendingBytes,
    snapshotFiles: entries.length,
    scanned: false,
    aborted: false,
    noFolders: false,
  };
}

async function saveCache(preview) {
  if (!isValidPendingPreview(preview) || preview.aborted) return;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
      ...preview,
      cachedAt: Date.now(),
    }));
  } catch {}
}

export async function getCachedPendingPreview() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidPendingPreview(parsed) || parsed.noFolders) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Local estimate of files that would upload on the next sync.
 * Snapshot classification is instant; an incremental folder scan finds
 * files created since the last backup without talking to the server.
 */
export async function previewPendingSync({ shouldStop, skipScan = false } = {}) {
  const folders = await getFolders();
  if (!folders.length) {
    const result = emptyPreview({ noFolders: true });
    try {
      await AsyncStorage.removeItem(CACHE_KEY);
    } catch {}
    return result;
  }

  if (shouldStop?.()) return emptyPreview({ aborted: true });

  const snapshotCache = await loadScanSnapshot();
  const snapshotResult = await classifySnapshot(snapshotCache, shouldStop);
  if (snapshotResult.aborted || shouldStop?.()) {
    return emptyPreview({ aborted: true, snapshotFiles: snapshotResult.snapshotFiles });
  }

  if (skipScan) {
    return snapshotResult;
  }

  const now = Date.now();
  if (lastScanAt && now - lastScanAt < STALE_MS) {
    const cached = await getCachedPendingPreview();
    if (cached) {
      return { ...cached, scanned: true };
    }
  }

  if (shouldStop?.()) return { ...snapshotResult, aborted: true };

  const isInitial = snapshotCache.size === 0;
  const scanned = await scan(null, null, isInitial ? null : snapshotCache, {
    incremental: !isInitial,
    noMetadata: true,
    shouldStop: () => !!shouldStop?.(),
  });

  if (scanned?.stopped || shouldStop?.()) {
    return { ...snapshotResult, aborted: true };
  }

  const files = Array.isArray(scanned) ? scanned : [];
  const fresh = files.filter((file) => file?.name && hasProperExtension(file.name));

  let newFromScan = fresh.length;
  let bytesFromScan = fresh.reduce((sum, file) => sum + (file.size || 0), 0);

  if (isInitial && fresh.length > 0) {
    // On first scan before snapshot exists, check uploaded keys in batch
    const keys = fresh.map((f) => `uploaded_${f.relativePath}`);
    const pairs = await multiGetChunked(keys);
    const valueByKey = new Map(pairs);
    const unuploaded = fresh.filter((f) => !valueByKey.has(`uploaded_${f.relativePath}`));
    newFromScan = unuploaded.length;
    bytesFromScan = unuploaded.reduce((sum, file) => sum + (file.size || 0), 0);
  }

  lastScanAt = Date.now();
  const result = {
    newCount: snapshotResult.newCount + newFromScan,
    changedCount: snapshotResult.changedCount,
    pendingBytes: snapshotResult.pendingBytes + bytesFromScan,
    snapshotFiles: snapshotResult.snapshotFiles,
    scanned: true,
    aborted: false,
    noFolders: false,
  };
  await saveCache(result);
  return result;
}

export async function refreshPendingPreview(options = {}) {
  const epoch = cacheEpoch;
  // Reuse only a matching in-flight request. Caller-specific shouldStop
  // (screen unfocus / generation) must not share another caller's promise.
  if (inFlight && inFlightEpoch === epoch && !options.force && !options.shouldStop) {
    return inFlight;
  }

  const startedEpoch = cacheEpoch;
  inFlightEpoch = startedEpoch;
  const promise = previewPendingSync({
    skipScan: !!options.skipScan,
    shouldStop: () => cacheEpoch !== startedEpoch || !!options.shouldStop?.(),
  }).finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

export function invalidatePendingPreviewCache() {
  lastScanAt = 0;
  lastFileList = null;
  cacheEpoch += 1;
}

let listInFlight = null;
let listInFlightEpoch = -1;
let lastFileList = null;

/**
 * Returns individual local files not yet backed up (new or changed).
 * Uses the same snapshot + incremental scan logic as previewPendingSync.
 */
export async function listPendingFiles({ shouldStop, skipScan = false } = {}) {
  const folders = await getFolders();
  if (!folders.length) {
    return summarizePendingFiles([], { noFolders: true, aborted: false, scanned: false });
  }

  if (shouldStop?.()) {
    return summarizePendingFiles([], { aborted: true, scanned: false, noFolders: false });
  }

  const snapshotCache = await loadScanSnapshot();
  let files = await collectPendingFromSnapshot(snapshotCache, shouldStop);
  if (files == null || shouldStop?.()) {
    return summarizePendingFiles(files || [], { aborted: true, scanned: false, noFolders: false });
  }

  if (skipScan) {
    return summarizePendingFiles(files, { scanned: false, aborted: false, noFolders: false });
  }

  const now = Date.now();
  if (lastScanAt && now - lastScanAt < STALE_MS && lastFileList) {
    return { ...lastFileList, scanned: true };
  }

  if (shouldStop?.()) {
    return summarizePendingFiles(files, { aborted: true, scanned: false, noFolders: false });
  }

  const isInitial = snapshotCache.size === 0;
  const scanned = await scan(null, null, isInitial ? null : snapshotCache, {
    incremental: !isInitial,
    noMetadata: true,
    shouldStop: () => !!shouldStop?.(),
  });

  if (scanned?.stopped || shouldStop?.()) {
    return summarizePendingFiles(files, { aborted: true, scanned: false, noFolders: false });
  }

  const scanFiles = Array.isArray(scanned) ? scanned : [];
  const fresh = scanFiles.filter((file) => file?.name && hasProperExtension(file.name));
  const seen = new Set(files.map((file) => file.relativePath));

  let freshToAdd = fresh;
  if (isInitial && fresh.length > 0) {
    const keys = fresh.map((f) => `uploaded_${f.relativePath}`);
    const pairs = await multiGetChunked(keys);
    const valueByKey = new Map(pairs);
    freshToAdd = fresh.filter((f) => !valueByKey.has(`uploaded_${f.relativePath}`));
  }

  for (const file of freshToAdd) {
    if (seen.has(file.relativePath)) continue;
    files.push({
      relativePath: file.relativePath,
      name: file.name,
      size: file.size || 0,
      modifiedTime: file.modifiedTime || 0,
      status: 'new',
    });
    seen.add(file.relativePath);
  }

  lastScanAt = Date.now();
  const result = summarizePendingFiles(files, { scanned: true, aborted: false, noFolders: false });
  lastFileList = result;
  return result;
}

export async function refreshPendingFileList(options = {}) {
  const epoch = cacheEpoch;
  if (listInFlight && listInFlightEpoch === epoch && !options.force && !options.shouldStop) {
    return listInFlight;
  }

  const startedEpoch = cacheEpoch;
  listInFlightEpoch = startedEpoch;
  const promise = listPendingFiles({
    skipScan: !!options.skipScan,
    shouldStop: () => cacheEpoch !== startedEpoch || !!options.shouldStop?.(),
  }).finally(() => {
    if (listInFlight === promise) listInFlight = null;
  });
  listInFlight = promise;
  return promise;
}