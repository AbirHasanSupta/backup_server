/**
 * freeUpStorage.js
 *
 * Client-side "Free up storage" logic.
 *
 * Strategy: use the local AsyncStorage upload-cache (keys of the form
 * `uploaded_<relativePath>` = "<modifiedTime>") as the single source of truth
 * for "this file is backed up".  No server round-trip is needed for scanning —
 * the cache is written during every upload/skip cycle in backgroundTask.js.
 *
 * Flow:
 *   1. scanIncrementalBackup() walks the phone folders.
 *   2. For each file we check AsyncStorage: if `uploaded_<path>` has a stored
 *      value the file is confirmed backed up on the server.
 *   3. We also maintain a local "already-cleaned" list in AsyncStorage so files
 *      the user already deleted are never shown again.
 *   4. The result is cached in memory + AsyncStorage so the home-screen banner
 *      loads instantly on cold start.
 *   5. After the user deletes files we POST to /cleanup/delete (best-effort).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { scanIncrementalBackup, enrichFilesBatch } from './scanner';
import {
  getServerIp,
  getServerPort,
  getApiKey,
  getDeviceId,
  getDeviceToken,
  getSyncRuntimeState,
  loadScanSnapshot,
} from './settings';

// ─── Persistence keys ─────────────────────────────────────────────────────────

const SUMMARY_KEY = 'free_up_summary_v1';
const CLEANED_PATHS_KEY = 'free_up_cleaned_paths_v1';

// ─── In-memory cache ──────────────────────────────────────────────────────────

let cachedFiles = null;    // CleanupCandidate[]
let cachedSummary = null;  // { count, totalBytes, scannedAt }

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Core scan ────────────────────────────────────────────────────────────────

/**
 * Walk the user's selected folders and return files that are:
 *   - Present in the local upload cache (confirmed backed up by this device)
 *   - Not already logged as cleaned locally
 *
 * @param {{ onProgress?: Function, shouldStop?: () => boolean }} options
 * @returns {Promise<{ files: object[], summary: object } | null>}
 */
export async function computeCleanupCandidates(options = {}) {
  const { onProgress, shouldStop } = options;

  // Never compete with an active Sync Now
  const runtime = await getSyncRuntimeState().catch(() => ({ active: false }));
  if (runtime?.active) {
    const summary = await getCleanupSummary();
    return { files: cachedFiles || [], summary, fromCache: true };
  }

  const [snapshotCache, cleanedPaths] = await Promise.all([
    loadScanSnapshot(),
    loadCleanedPathsCache(),
  ]);

  if (onProgress) onProgress({ phase: 'scanning', files: 0 });

  const { files: scannedFiles, stopped } = await scanIncrementalBackup(
    (detail) => { if (onProgress) onProgress(detail); },
    snapshotCache,
    {
      incremental: true,
      noMetadata: true,
      shouldStop: () => !!shouldStop?.(),
    }
  );

  if (stopped || shouldStop?.()) return null;

  if (!scannedFiles.length) {
    return _finalize([], cleanedPaths);
  }

  // Batch-check local upload cache in chunks of 500
  const CHUNK = 500;
  const uploadKeys = scannedFiles.map((f) => `uploaded_${f.relativePath}`);
  const chunks = [];
  for (let i = 0; i < uploadKeys.length; i += CHUNK) {
    chunks.push(uploadKeys.slice(i, i + CHUNK));
  }
  const chunkResults = await Promise.all(chunks.map((c) => AsyncStorage.multiGet(c)));
  const valueByKey = new Map(chunkResults.flat());

  const candidates = scannedFiles.filter((file) => {
    if (cleanedPaths.has(file.relativePath)) return false;
    // Any cached value means this path was confirmed backed up at some point
    const cached = valueByKey.get(`uploaded_${file.relativePath}`);
    return cached != null;
  });

  // Enrich metadata (size, modifiedTime) for display in the UI.
  // noMetadata=true leaves these as 0 for files not in the snapshot cache;
  // enrichFilesBatch fills them in without re-walking the directory tree.
  if (candidates.length > 0) {
    await enrichFilesBatch(candidates, { shouldStop });
    if (shouldStop?.()) return null;
  }

  return _finalize(candidates, cleanedPaths);
}

function _finalize(candidates, _cleanedPaths) {
  candidates.sort((a, b) => (b.modifiedTime || 0) - (a.modifiedTime || 0));
  cachedFiles = candidates;
  const totalBytes = candidates.reduce((s, f) => s + (f.size || 0), 0);
  const summary = { count: candidates.length, totalBytes, scannedAt: Date.now() };
  cachedSummary = summary;
  AsyncStorage.setItem(SUMMARY_KEY, JSON.stringify(summary)).catch(() => {});
  DeviceEventEmitter.emit('cleanup-candidates-updated', summary);
  return { files: candidates, summary };
}

// ─── Summary (home-screen banner) ─────────────────────────────────────────────

export async function getCleanupSummary() {
  if (cachedSummary) return cachedSummary;
  try {
    const raw = await AsyncStorage.getItem(SUMMARY_KEY);
    if (!raw) return { count: 0, totalBytes: 0, scannedAt: null };
    const parsed = JSON.parse(raw);
    cachedSummary = {
      count: typeof parsed.count === 'number' ? parsed.count : 0,
      totalBytes: Number(parsed.totalBytes) || 0,
      scannedAt: parsed.scannedAt || null,
    };
    return cachedSummary;
  } catch {
    return { count: 0, totalBytes: 0, scannedAt: null };
  }
}

export function getCleanupCandidateFiles() {
  return cachedFiles ? [...cachedFiles] : [];
}

export function invalidateCleanupCache() {
  cachedFiles = null;
  cachedSummary = null;
  AsyncStorage.multiRemove([SUMMARY_KEY]).catch(() => {});
}

// ─── Report deletions to server ───────────────────────────────────────────────

/**
 * POST the deleted files to the server (best-effort; never blocks local delete).
 * @param {Array<{ relativePath: string, size: number }>} files
 */
export async function reportDeletedFiles(files) {
  if (!files.length) return null;
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
          files: files.map((f) => ({ path: f.relativePath, size: f.size || 0 })),
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const body = await res.json();
    return { totalBytesFreed: body.total_bytes_freed || 0 };
  } catch {
    return null;
  }
}

/**
 * Persist a list of relative paths as "already cleaned" locally so future
 * scans skip them.  Also removes them from the in-memory candidate list and
 * fires an update event for the home screen banner.
 * @param {string[]} relativePaths
 */
export async function markAsCleanedLocally(relativePaths) {
  const existing = await loadCleanedPathsCache();
  for (const p of relativePaths) existing.add(p);
  await persistCleanedPaths(existing);

  if (cachedFiles) {
    const cleaned = new Set(relativePaths);
    cachedFiles = cachedFiles.filter((f) => !cleaned.has(f.relativePath));
    const totalBytes = cachedFiles.reduce((s, f) => s + (f.size || 0), 0);
    cachedSummary = { count: cachedFiles.length, totalBytes, scannedAt: Date.now() };
    AsyncStorage.setItem(SUMMARY_KEY, JSON.stringify(cachedSummary)).catch(() => {});
    DeviceEventEmitter.emit('cleanup-candidates-updated', cachedSummary);
  }
}
