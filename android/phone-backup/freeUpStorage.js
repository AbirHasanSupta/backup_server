/**
 * freeUpStorage.js
 *
 * Client-side "Free up storage" engine.
 *
 * Identifies files currently residing on the device that have been safely backed
 * up to the server, enabling users to reclaim local storage space.
 *
 * Architecture:
 *   1. Full Device Scan: Scans selected folders with incremental=false so all
 *      existing device files are discovered (snapshot cache provides instant
 *      mtime/size lookup without disk I/O).
 *   2. Hybrid Verification: Confirms backup status using both local AsyncStorage
 *      `uploaded_<relativePath>` records and server `GET /cleanup/candidates`.
 *   3. Cleaned State Tracking: Keeps a local Set of cleaned paths so deleted
 *      files are excluded from future scans.
 *   4. Offline Sync Queue: Queues deletion reports in AsyncStorage and flushes
 *      them to `POST /cleanup/delete` when connectivity is available.
 *   5. Instant Dashboard Summary: Computes a sub-10ms estimate from snapshot
 *      data for instant home screen banner display on app launch.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { scan, enrichFilesBatch } from './scanner';
import {
  getServerIp,
  getServerPort,
  getApiKey,
  getDeviceId,
  getDeviceToken,
  getSyncRuntimeState,
  loadScanSnapshot,
  removePathsFromScanSnapshot,
  markUploadedBatch,
  getUploadCacheStorageKey,
} from './settings';

// ─── Persistence keys ─────────────────────────────────────────────────────────

const SUMMARY_KEY = 'free_up_summary_v2';
const CLEANED_PATHS_KEY = 'free_up_cleaned_paths_v1';
const PENDING_REPORTS_KEY = 'free_up_pending_reports_v1';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', '3gp', 'm4v']);

// ─── In-memory cache ──────────────────────────────────────────────────────────

let cachedFiles = null;    // CleanupCandidate[]
let cachedSummary = null;  // CleanupSummary

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getFileCategory(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

async function getServerConfig() {
  const [serverIp, apiKey, serverPort, deviceId, deviceToken] = await Promise.all([
    getServerIp(),
    getApiKey(),
    getServerPort(),
    getDeviceId(),
    getDeviceToken(),
  ]);
  if (!serverIp) throw new Error('No server IP configured');
  return { serverIp, apiKey: deviceToken || apiKey, serverPort, deviceId };
}

export function formatFreeUpBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ─── Already-cleaned paths cache ─────────────────────────────────────────────

async function loadCleanedPathsCache() {
  try {
    const raw = await AsyncStorage.getItem(CLEANED_PATHS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function persistCleanedPaths(paths) {
  try {
    await AsyncStorage.setItem(CLEANED_PATHS_KEY, JSON.stringify([...paths]));
  } catch {}
}

// ─── Offline deletion queue ───────────────────────────────────────────────────

async function loadPendingReports() {
  try {
    const raw = await AsyncStorage.getItem(PENDING_REPORTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function savePendingReports(reports) {
  try {
    if (!reports.length) {
      await AsyncStorage.removeItem(PENDING_REPORTS_KEY);
    } else {
      await AsyncStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify(reports));
    }
  } catch {}
}

export async function flushPendingCleanupReports() {
  const pending = await loadPendingReports();
  if (!pending.length) return;

  try {
    const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
    const res = await fetch(
      `http://${serverIp}:${serverPort}/cleanup/delete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          source_id: deviceId,
          files: pending.map((f) => ({ path: f.relativePath, size: f.size || 0, file_id: f.file_id || null })),
        }),
        signal: AbortSignal.timeout(10000),
      }
    );
    if (res.ok) {
      await savePendingReports([]);
    }
  } catch {
    // Will retry on next flush
  }
}

// ─── Server candidate verification ───────────────────────────────────────────

async function fetchServerCandidates() {
  try {
    const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
    const res = await fetch(
      `http://${serverIp}:${serverPort}/cleanup/candidates?source_id=${encodeURIComponent(deviceId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const body = await res.json();
    if (Array.isArray(body.candidates)) {
      const map = new Map();
      for (const item of body.candidates) {
        if (item.path) {
          map.set(item.path, {
            file_id: item.file_id,
            size: item.size || 0,
            capture_time: item.capture_time,
          });
        }
      }
      return map;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Core candidate computation ───────────────────────────────────────────────

/**
 * Walk the user's selected folders and return files that:
 *   - Are present on the device
 *   - Are confirmed backed up (via local upload cache or server verification)
 *   - Have not been cleaned/deleted locally
 *
 * @param {{ onProgress?: Function, shouldStop?: () => boolean, forceRefresh?: boolean }} options
 * @returns {Promise<{ files: object[], summary: object, fromCache?: boolean } | null>}
 */
export async function computeCleanupCandidates(options = {}) {
  const { onProgress, shouldStop } = options;

  // Never compete with an active Sync Now
  const runtime = await getSyncRuntimeState().catch(() => ({ active: false }));
  if (runtime?.active) {
    const summary = await getCleanupSummary();
    return { files: cachedFiles || [], summary, fromCache: true };
  }

  // Best-effort flush of pending deletion reports from earlier sessions
  flushPendingCleanupReports().catch(() => {});

  const [snapshotCache, cleanedPaths, serverCandidatesMap] = await Promise.all([
    loadScanSnapshot(),
    loadCleanedPathsCache(),
    fetchServerCandidates().catch(() => null),
  ]);

  if (shouldStop?.()) return null;
  if (onProgress) onProgress({ phase: 'scanning', files: 0 });

  // Perform full device folder walk with incremental=false so all files on device are found.
  // noMetadata=true ensures snapshotCache is used for instant mtime/size lookup without disk I/O.
  const scannedFiles = await scan(
    (detail) => { if (onProgress) onProgress(detail); },
    null,
    snapshotCache,
    {
      incremental: false,
      noMetadata: true,
      shouldStop: () => !!shouldStop?.(),
    }
  );

  if (scannedFiles.stopped || shouldStop?.()) return null;

  if (!scannedFiles.length) {
    return _finalize([], cleanedPaths);
  }

  // Check local upload cache in batches of 500
  const CHUNK = 500;
  const uploadKeys = scannedFiles.map((f) => getUploadCacheStorageKey(f.relativePath));
  const chunks = [];
  for (let i = 0; i < uploadKeys.length; i += CHUNK) {
    chunks.push(uploadKeys.slice(i, i + CHUNK));
  }
  const chunkResults = await Promise.all(chunks.map((c) => AsyncStorage.multiGet(c)));
  const localUploadMap = new Map(chunkResults.flat());

  const newlyConfirmedServerFiles = [];

  const candidates = scannedFiles.filter((file) => {
    // 1. Exclude already cleaned files
    if (cleanedPaths.has(file.relativePath)) return false;

    // 2. Check local upload cache
    const localUploaded = localUploadMap.get(getUploadCacheStorageKey(file.relativePath));
    const isLocalBackedUp = localUploaded != null;

    // 3. Check server candidates (if server was reachable)
    const serverRecord = serverCandidatesMap ? serverCandidatesMap.get(file.relativePath) : null;
    const isServerBackedUp = serverRecord != null;

    if (isServerBackedUp && !isLocalBackedUp) {
      newlyConfirmedServerFiles.push({
        relativePath: file.relativePath,
        modifiedTime: serverRecord.capture_time || file.modifiedTime || Date.now(),
      });
    }

    if (serverRecord) {
      if (!file.file_id) file.file_id = serverRecord.file_id;
      if (serverRecord.size > 0) {
        file.size = serverRecord.size;
        file.metadataLoaded = true;
      }
    }

    return isLocalBackedUp || isServerBackedUp;
  });

  if (shouldStop?.()) return null;

  // Auto-sync any server-confirmed files into local upload cache
  if (newlyConfirmedServerFiles.length > 0) {
    markUploadedBatch(newlyConfirmedServerFiles).catch(() => {});
  }

  // Populate metadata (size, modifiedTime) from snapshot cache where available
  for (const file of candidates) {
    if (!file.metadataLoaded) {
      const snap = snapshotCache.get(file.relativePath);
      if (snap) {
        file.modifiedTime = snap.mtime || file.modifiedTime || 0;
        file.size = snap.size || file.size || 0;
        file.metadataLoaded = true;
      }
    }
  }

  // Enrich any remaining candidate files that still lack size metadata
  const needEnrichment = candidates.filter((f) => !f.metadataLoaded);
  if (needEnrichment.length > 0) {
    await enrichFilesBatch(needEnrichment, { shouldStop });
    if (shouldStop?.()) return null;
  }

  return _finalize(candidates, cleanedPaths);
}

function _finalize(candidates, _cleanedPaths) {
  // Sort by size descending by default (largest files first to maximize reclaimed space)
  candidates.sort((a, b) => (b.size || 0) - (a.size || 0) || (b.modifiedTime || 0) - (a.modifiedTime || 0));
  cachedFiles = candidates;

  let totalBytes = 0;
  let photoBytes = 0;
  let photoCount = 0;
  let videoBytes = 0;
  let videoCount = 0;
  let otherBytes = 0;
  let otherCount = 0;

  for (const f of candidates) {
    const sz = f.size || 0;
    totalBytes += sz;
    const cat = getFileCategory(f.name || f.relativePath);
    if (cat === 'image') {
      photoBytes += sz;
      photoCount += 1;
    } else if (cat === 'video') {
      videoBytes += sz;
      videoCount += 1;
    } else {
      otherBytes += sz;
      otherCount += 1;
    }
  }

  const summary = {
    count: candidates.length,
    totalBytes,
    photoBytes,
    photoCount,
    videoBytes,
    videoCount,
    otherBytes,
    otherCount,
    scannedAt: Date.now(),
  };

  cachedSummary = summary;
  AsyncStorage.setItem(SUMMARY_KEY, JSON.stringify(summary)).catch(() => {});
  DeviceEventEmitter.emit('cleanup-candidates-updated', summary);
  return { files: candidates, summary };
}

// ─── Summary (instant Home-Screen & Dashboard banner) ─────────────────────────

export async function getCleanupSummary() {
  if (cachedSummary) return cachedSummary;

  try {
    const raw = await AsyncStorage.getItem(SUMMARY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      cachedSummary = {
        count: typeof parsed.count === 'number' ? parsed.count : 0,
        totalBytes: Number(parsed.totalBytes) || 0,
        photoBytes: Number(parsed.photoBytes) || 0,
        photoCount: Number(parsed.photoCount) || 0,
        videoBytes: Number(parsed.videoBytes) || 0,
        videoCount: Number(parsed.videoCount) || 0,
        otherBytes: Number(parsed.otherBytes) || 0,
        otherCount: Number(parsed.otherCount) || 0,
        scannedAt: parsed.scannedAt || null,
      };
      return cachedSummary;
    }
  } catch {}

  // Fast-path instant estimate from snapshot cache and upload cache (<10ms)
  try {
    const [snapshotCache, cleanedPaths] = await Promise.all([
      loadScanSnapshot(),
      loadCleanedPathsCache(),
    ]);

    if (snapshotCache.size > 0) {
      let count = 0;
      let totalBytes = 0;
      let photoBytes = 0;
      let photoCount = 0;
      let videoBytes = 0;
      let videoCount = 0;
      let otherBytes = 0;
      let otherCount = 0;

      for (const [path, info] of snapshotCache.entries()) {
        if (cleanedPaths.has(path)) continue;
        const sz = info.size || 0;
        count += 1;
        totalBytes += sz;
        const cat = getFileCategory(path);
        if (cat === 'image') {
          photoBytes += sz;
          photoCount += 1;
        } else if (cat === 'video') {
          videoBytes += sz;
          videoCount += 1;
        } else {
          otherBytes += sz;
          otherCount += 1;
        }
      }

      cachedSummary = {
        count,
        totalBytes,
        photoBytes,
        photoCount,
        videoBytes,
        videoCount,
        otherBytes,
        otherCount,
        scannedAt: null,
      };
      return cachedSummary;
    }
  } catch {}

  return {
    count: 0,
    totalBytes: 0,
    photoBytes: 0,
    photoCount: 0,
    videoBytes: 0,
    videoCount: 0,
    otherBytes: 0,
    otherCount: 0,
    scannedAt: null,
  };
}

export function getCleanupCandidateFiles() {
  return cachedFiles ? [...cachedFiles] : [];
}

export function invalidateCleanupCache() {
  cachedFiles = null;
  cachedSummary = null;
  AsyncStorage.multiRemove([SUMMARY_KEY]).catch(() => {});
}

// ─── Deletion reporting & state update ────────────────────────────────────────

/**
 * Report deleted files to server (posts immediately, queues in AsyncStorage if offline).
 * @param {Array<{ relativePath: string, size: number, file_id?: number }>} files
 */
export async function reportDeletedFiles(files) {
  if (!files.length) return null;

  // Queue locally first for guaranteed eventual delivery (deduplicated by path)
  const existingPending = await loadPendingReports();
  const map = new Map();
  for (const f of existingPending) {
    if (f.relativePath) map.set(f.relativePath, f);
  }
  for (const f of files) {
    if (f.relativePath) map.set(f.relativePath, f);
  }
  const combined = Array.from(map.values());
  await savePendingReports(combined);

  try {
    const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
    const res = await fetch(
      `http://${serverIp}:${serverPort}/cleanup/delete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          source_id: deviceId,
          files: files.map((f) => ({
            path: f.relativePath,
            size: f.size || 0,
            file_id: f.file_id || null,
          })),
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (res.ok) {
      const body = await res.json();
      // Remove successfully reported files from pending queue
      const reportedPaths = new Set(files.map((f) => f.relativePath));
      const remaining = combined.filter((f) => !reportedPaths.has(f.relativePath));
      await savePendingReports(remaining);
      return { totalBytesFreed: body.total_bytes_freed || 0 };
    }
    return null;
  } catch {
    // Queued in pending reports, will retry automatically
    return null;
  }
}

/**
 * Mark files as cleaned locally so future scans skip them.
 * Updates in-memory candidate list, recalibrates summary, and emits update event.
 * @param {string[]} relativePaths
 */
export async function markAsCleanedLocally(relativePaths) {
  if (!relativePaths || !relativePaths.length) return;

  const existing = await loadCleanedPathsCache();
  for (const p of relativePaths) existing.add(p);
  await persistCleanedPaths(existing);
  await removePathsFromScanSnapshot(relativePaths).catch(() => {});

  if (cachedFiles) {
    const cleaned = new Set(relativePaths);
    cachedFiles = cachedFiles.filter((f) => !cleaned.has(f.relativePath));
    _finalize(cachedFiles, existing);
  }
}

