import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFolders, loadScanSnapshot } from './settings';
import { scan, hasProperExtension } from './scanner';

const CACHE_KEY = 'pending_preview_cache_v1';
const MULTI_GET_CHUNK = 80;
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
  const pairs = [];
  for (let i = 0; i < keys.length; i += MULTI_GET_CHUNK) {
    const chunk = await AsyncStorage.multiGet(keys.slice(i, i + MULTI_GET_CHUNK));
    pairs.push(...chunk);
  }
  return pairs;
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

async function classifySnapshot(snapshotCache, shouldStop) {
  const entries = [...snapshotCache.entries()];
  if (entries.length === 0) {
    return emptyPreview({ snapshotFiles: 0 });
  }

  if (shouldStop?.()) return emptyPreview({ aborted: true, snapshotFiles: entries.length });

  const keys = entries.map(([path]) => `uploaded_${path}`);
  const pairs = await multiGetChunked(keys);
  if (shouldStop?.()) return emptyPreview({ aborted: true, snapshotFiles: entries.length });
  const valueByKey = new Map(pairs);

  let newCount = 0;
  let changedCount = 0;
  let pendingBytes = 0;

  for (let i = 0; i < entries.length; i++) {
    if (i % 250 === 0 && shouldStop?.()) {
      return emptyPreview({ aborted: true, snapshotFiles: entries.length });
    }
    const [path, meta] = entries[i];
    const val = valueByKey.get(`uploaded_${path}`);
    const mtime = String(meta?.mtime || 0);
    const size = Number(meta?.size) || 0;
    if (val == null) {
      newCount += 1;
      pendingBytes += size;
    } else if (val !== mtime) {
      changedCount += 1;
      pendingBytes += size;
    }
  }

  return {
    newCount,
    changedCount,
    pendingBytes,
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

  const scanned = await scan(null, null, snapshotCache, {
    incremental: true,
    shouldStop: () => !!shouldStop?.(),
  });

  if (scanned?.stopped || shouldStop?.()) {
    return { ...snapshotResult, aborted: true };
  }

  const files = Array.isArray(scanned) ? scanned : [];
  const fresh = files.filter((file) => file?.name && hasProperExtension(file.name));
  const newFromScan = fresh.length;
  const bytesFromScan = fresh.reduce((sum, file) => sum + (file.size || 0), 0);

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
  cacheEpoch += 1;
}
