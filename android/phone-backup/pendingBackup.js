import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import {
  scanIncrementalBackup,
  enrichFilesBatch,
  pendingFileKey,
  enrichFileMetadata,
} from './scanner';
import { uploadFile } from './uploader';
import { loadScanSnapshot, saveScanSnapshot, isUploadedBatch, markUploadedBatch, getSyncRuntimeState } from './settings';

const SNAPSHOT_KEY = 'pending_backup_snapshot_v1';
const UPLOAD_CONCURRENCY = 2;

let cachedFiles = null;
let cachedSummary = null;

function buildSummary(pending) {
  return {
    count: pending.length,
    totalBytes: pending.reduce((sum, file) => sum + (file.size || 0), 0),
    scannedAt: Date.now(),
  };
}

async function persistSummary(summary) {
  cachedSummary = summary;
  // Fire-and-forget — never block sync completion or UI on disk write.
  AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(summary)).catch(() => {});
  DeviceEventEmitter.emit('pending-backup-updated', summary);
}

async function finalizePendingList(pending, snapshotSkipped = 0, { persist = true } = {}) {
  pending.sort((a, b) => (b.modifiedTime || 0) - (a.modifiedTime || 0));
  cachedFiles = pending;
  const summary = buildSummary(pending);
  if (persist) await persistSummary(summary);
  else {
    cachedSummary = summary;
    DeviceEventEmitter.emit('pending-backup-updated', summary);
  }
  return { pending, summary, skippedFromSnapshot: snapshotSkipped };
}

export function invalidatePendingBackupCache() {
  cachedFiles = null;
  cachedSummary = null;
  AsyncStorage.removeItem(SNAPSHOT_KEY).catch(() => {});
}

export async function getPendingBackupSummary() {
  if (cachedSummary) return cachedSummary;
  const raw = await AsyncStorage.getItem(SNAPSHOT_KEY).catch(() => null);
  if (!raw) return { count: null, totalBytes: 0, scannedAt: null };
  try {
    const parsed = JSON.parse(raw);
    cachedSummary = {
      count: typeof parsed.count === 'number' ? parsed.count : null,
      totalBytes: Number(parsed.totalBytes) || 0,
      scannedAt: parsed.scannedAt || null,
    };
    return cachedSummary;
  } catch {
    return { count: null, totalBytes: 0, scannedAt: null };
  }
}

export function getPendingBackupFiles() {
  return cachedFiles ? [...cachedFiles] : [];
}

/** Reuse Sync Now results — zero extra filesystem walk after a sync session. */
export function setPendingBackupFromSync(pendingFiles) {
  const pending = Array.isArray(pendingFiles) ? pendingFiles : [];
  return finalizePendingList(pending, 0, { persist: true });
}

async function filterPendingFiles(files) {
  if (!files.length) return [];
  const trusted = await isUploadedBatch(files);
  return files.filter((file) => !trusted.has(pendingFileKey(file)));
}

/**
 * Same incremental scan strategy as Sync Now:
 * 1) walk with snapshot skips (noMetadata for a fast directory pass)
 * 2) enrich only newly discovered files
 * 3) client-side upload-cache check
 */
export async function computePendingFiles(options = {}) {
  const { shouldStop, onProgress } = options;

  // Never compete with an active Sync Now — reuse cached results instead.
  const runtime = await getSyncRuntimeState().catch(() => ({ active: false }));
  if (runtime?.active) {
    const summary = await getPendingBackupSummary();
    const pending = getPendingBackupFiles();
    return { pending, summary, skippedFromSnapshot: 0, fromCache: true };
  }

  const snapshotCache = await loadScanSnapshot();

  if (onProgress) onProgress({ phase: 'scanning', files: 0, skipped: 0 });

  const { files, snapshotSkipped, stopped } = await scanIncrementalBackup(
    (detail) => {
      if (onProgress) onProgress(detail);
    },
    snapshotCache,
    {
      incremental: true,
      noMetadata: true,
      shouldStop: () => !!shouldStop?.(),
    }
  );

  if (stopped || shouldStop?.()) return null;

  // Lightning-fast path: snapshot covered everything, nothing new on disk.
  if (!files.length) {
    return finalizePendingList([], snapshotSkipped);
  }

  await enrichFilesBatch(files, { shouldStop });
  if (shouldStop?.()) return null;

  const pending = await filterPendingFiles(files);
  return finalizePendingList(pending, snapshotSkipped);
}

export async function uploadPendingFiles(files, options = {}) {
  const { onProgress, shouldStop } = options;
  if (!files.length) return { uploaded: [], errors: [] };

  const uploaded = [];
  const errors = [];
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < files.length) {
      if (shouldStop?.()) break;
      const index = nextIndex++;
      const file = files[index];
      if (!file) break;

      try {
        const enriched = await enrichFileMetadata(file);
        if (shouldStop?.()) break;

        const res = await uploadFile(enriched, null, { verifyDisk: false });
        if (res?.success) {
          uploaded.push(enriched);
        } else {
          errors.push({
            file: enriched,
            message: 'Server rejected the file. Check server logs.',
          });
        }
      } catch (err) {
        errors.push({
          file,
          message: err?.message || 'Upload failed',
        });
      } finally {
        completed += 1;
        if (onProgress) onProgress(completed, files.length, file);
      }
    }
  }

  const workers = Math.min(UPLOAD_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  if (uploaded.length > 0) {
    await markUploadedBatch(uploaded);
    await saveScanSnapshot(uploaded, { merge: true }).catch(() => {});
  }

  if (cachedFiles) {
    // Key on the stable SAF `uri`: `uploaded` holds enriched objects (real
    // size|mtime) while cachedFiles may hold noMetadata entries (0|0) from a
    // prior sync, so pendingFileKey would never match and the count would stall.
    const uploadedUris = new Set(uploaded.map((file) => file.uri));
    cachedFiles = cachedFiles.filter((file) => !uploadedUris.has(file.uri));
    const summary = buildSummary(cachedFiles);
    await persistSummary(summary);
  }

  return { uploaded, errors };
}
