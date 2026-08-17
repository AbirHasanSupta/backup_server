import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFolders, loadScanSnapshot, getTotalSyncedBytes, setTotalSyncedBytes } from './settings';
import { checkServerFiles } from './uploader';
import { formatPendingBytes } from './pendingPreview';

const CACHE_KEY = 'storage_savings_cache_v1';
const MULTI_GET_CHUNK = 500;
const STALE_MS = 5 * 60 * 1000;

let inFlight = null;
let inFlightEpoch = -1;
let cacheEpoch = 0;
let lastRefreshAt = 0;

export { formatPendingBytes as formatStorageBytes };

async function multiGetChunked(keys) {
  if (!keys.length) return [];
  const chunks = [];
  for (let i = 0; i < keys.length; i += MULTI_GET_CHUNK) {
    chunks.push(keys.slice(i, i + MULTI_GET_CHUNK));
  }
  const chunkResults = await Promise.all(chunks.map((c) => AsyncStorage.multiGet(c)));
  return chunkResults.flat();
}

function fileNameFromPath(path) {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1] || path;
}

function emptyPreview(extra = {}) {
  return {
    serverTotalBytes: 0,
    serverTotalFiles: 0,
    deletableCount: 0,
    deletableBytes: 0,
    localBackedUpCount: 0,
    serverVerified: false,
    scanned: false,
    aborted: false,
    noFolders: false,
    noServer: false,
    ...extra,
  };
}

function summarizeDeletable(files, extra = {}) {
  let deletableBytes = 0;
  for (const file of files) {
    deletableBytes += Number(file.size) || 0;
  }
  return {
    deletableCount: files.length,
    deletableBytes,
    ...extra,
  };
}

export function isValidStorageSavingsPreview(parsed) {
  return !!(
    parsed &&
    typeof parsed === 'object' &&
    Number.isFinite(parsed.serverTotalBytes) &&
    Number.isFinite(parsed.deletableCount) &&
    Number.isFinite(parsed.deletableBytes) &&
    !parsed.aborted
  );
}

async function collectLocallyBackedUpFromSnapshot(snapshotCache, shouldStop) {
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
    if (val != null && (val === mtime || !meta?.mtime)) {
      files.push({
        relativePath: path,
        name: fileNameFromPath(path),
        size: Number(meta?.size) || 0,
        modifiedTime: Number(meta?.mtime) || 0,
      });
    }
  }
  return files;
}

async function fetchServerTotals() {
  try {
    const res = await checkServerFiles([]);
    return {
      serverTotalFiles: res.deviceTotalFiles || 0,
      serverTotalBytes: res.deviceTotalSize || 0,
    };
  } catch {
    return null;
  }
}

async function verifyBackedUpOnServer(files, shouldStop) {
  const totals = await fetchServerTotals();
  if (!totals) return null;
  return {
    confirmed: files,
    serverTotalFiles: totals.serverTotalFiles,
    serverTotalBytes: totals.serverTotalBytes,
  };
}

async function saveCache(preview) {
  if (!isValidStorageSavingsPreview(preview) || preview.aborted) return;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
      ...preview,
      cachedAt: Date.now(),
    }));
  } catch {}
}

export async function getCachedStorageSavingsPreview() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidStorageSavingsPreview(parsed) || parsed.noFolders) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Estimates how much is backed up on the server and how much local storage
 * could be freed by deleting files that are confirmed present on the server.
 */
export async function previewStorageSavings({ shouldStop, skipServerCheck = false } = {}) {
  const folders = await getFolders();
  if (!folders.length) {
    const result = emptyPreview({ noFolders: true });
    try {
      await AsyncStorage.removeItem(CACHE_KEY);
    } catch {}
    return result;
  }

  if (shouldStop?.()) return emptyPreview({ aborted: true });

  const persistedBytes = await getTotalSyncedBytes();
  const snapshotCache = await loadScanSnapshot();
  const localCandidates = await collectLocallyBackedUpFromSnapshot(snapshotCache, shouldStop);
  if (localCandidates == null || shouldStop?.()) {
    return emptyPreview({ aborted: true, localBackedUpCount: 0 });
  }

  const localSummary = summarizeDeletable(localCandidates, {
    localBackedUpCount: localCandidates.length,
    serverTotalBytes: persistedBytes,
    serverTotalFiles: 0,
    serverVerified: false,
    scanned: true,
    aborted: false,
    noFolders: false,
    noServer: false,
  });

  if (skipServerCheck) {
    return {
      ...localSummary,
      deletableCount: localCandidates.length,
      deletableBytes: localSummary.deletableBytes,
    };
  }

  if (shouldStop?.()) {
    return { ...localSummary, aborted: true };
  }

  const verified = await verifyBackedUpOnServer(localCandidates, shouldStop);
  if (verified == null || shouldStop?.()) {
    return {
      ...localSummary,
      aborted: false,
      noServer: verified == null,
    };
  }

  const serverTotalBytes = verified.serverTotalBytes > 0
    ? verified.serverTotalBytes
    : persistedBytes;
  const serverTotalFiles = verified.serverTotalFiles || 0;

  if (verified.serverTotalBytes > 0) {
    await setTotalSyncedBytes(verified.serverTotalBytes);
  }

  const confirmedSummary = summarizeDeletable(verified.confirmed);
  const result = {
    serverTotalBytes,
    serverTotalFiles,
    deletableCount: confirmedSummary.deletableCount,
    deletableBytes: confirmedSummary.deletableBytes,
    localBackedUpCount: localCandidates.length,
    serverVerified: true,
    scanned: true,
    aborted: false,
    noFolders: false,
    noServer: false,
  };

  lastRefreshAt = Date.now();
  await saveCache(result);
  return result;
}

export async function refreshStorageSavingsPreview(options = {}) {
  const epoch = cacheEpoch;
  if (inFlight && inFlightEpoch === epoch && !options.force && !options.shouldStop) {
    return inFlight;
  }

  const now = Date.now();
  if (!options.force && !options.skipServerCheck && lastRefreshAt && now - lastRefreshAt < STALE_MS) {
    const cached = await getCachedStorageSavingsPreview();
    if (cached) return cached;
  }

  const startedEpoch = cacheEpoch;
  inFlightEpoch = startedEpoch;
  const promise = previewStorageSavings({
    skipServerCheck: !!options.skipServerCheck,
    shouldStop: () => cacheEpoch !== startedEpoch || !!options.shouldStop?.(),
  }).finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

export function invalidateStorageSavingsCache() {
  lastRefreshAt = 0;
  cacheEpoch += 1;
}
