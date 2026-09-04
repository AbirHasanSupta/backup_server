import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';

const KEYS = {
  SERVER_IP:      'server_ip',
  SERVER_PORT:    'server_port',
  SERVER_NAME:    'server_name',
  API_KEY:        'api_key',
  FOLDERS:        'folders',
  FILE_TYPES:     'file_types',
  SYNC_INTERVAL:  'sync_interval',
  SYNC_PAUSED:    'sync_paused',
  LAST_SYNC_TIME: 'last_sync_time',
  TOTAL_SYNCED:   'total_synced',
  TOTAL_SYNCED_BYTES: 'total_synced_bytes',
  SYNC_RUNTIME_STATE: 'sync_runtime_state',
  DEVICE_ID:      'device_id',
  FORCE_REFRESH_ALL: 'force_refresh_all',
  FORCE_REFRESH_FOLDERS: 'force_refresh_folders',
  THEME_MODE:     'theme_mode',
  SCAN_SNAPSHOT:  'scan_snapshot_v1',
  DEVICE_TOKEN:   'device_token',
  CERT_FINGERPRINT: 'server_cert_fp',
  AUTO_SYNC_SUPPRESSED_UNTIL: 'auto_sync_suppressed_until',
  LAST_MEMORY_NOTIFIED_DATE: 'last_memory_notified_date',
  LAST_FLASHBACK_NOTIFIED_AT: 'last_flashback_notified_at',
  LAST_RECAP_NOTIFIED_MONTH: 'last_recap_notified_month',
  SAVED_SERVERS: 'saved_servers_v1',
  USERNAME: 'username',
  RECOVERY_SYNC_PENDING: 'recovery_sync_pending',
  UPLOAD_CACHE_INITIALIZED: 'upload_cache_initialized',
};

export async function getLastMemoryNotifiedDate() { return (await AsyncStorage.getItem(KEYS.LAST_MEMORY_NOTIFIED_DATE)) || ''; }
export async function setLastMemoryNotifiedDate(dateStr) { await AsyncStorage.setItem(KEYS.LAST_MEMORY_NOTIFIED_DATE, dateStr); }

export async function getLastFlashbackNotifiedAt() {
  const raw = await AsyncStorage.getItem(KEYS.LAST_FLASHBACK_NOTIFIED_AT);
  return Number.parseInt(raw || '', 10) || 0;
}
export async function setLastFlashbackNotifiedAt(ts) {
  await AsyncStorage.setItem(KEYS.LAST_FLASHBACK_NOTIFIED_AT, String(ts));
}

export async function getLastRecapNotifiedMonth() {
  return (await AsyncStorage.getItem(KEYS.LAST_RECAP_NOTIFIED_MONTH)) || '';
}
export async function setLastRecapNotifiedMonth(monthKey) {
  await AsyncStorage.setItem(KEYS.LAST_RECAP_NOTIFIED_MONTH, monthKey);
}

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[Settings] Ignoring invalid stored JSON:', e?.message);
    return fallback;
  }
}

function parseStoredInteger(raw, fallback) {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getUniqueFolderName(folders, name) {
  const baseName = name?.trim() || 'Folder';
  const usedNames = new Set(folders.map((folder) => folder.name));
  if (!usedNames.has(baseName)) return baseName;

  let suffix = 2;
  let candidate = `${baseName} (${suffix})`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${baseName} (${suffix})`;
  }
  return candidate;
}

// ─── File-type labels (displayed in UI) ───────────────────────────────────────
export const FILE_TYPE_LABELS = {
  all:    'All Files',
  photos: 'Photos',
  videos: 'Videos',
  pdfs:   'PDFs',
  docs:   'Docs',
  others: 'Others',
};

// ─── Extension sets used by scanner.js ────────────────────────────────────────
// This map MUST stay in sync with the labels above.
export const FILE_TYPE_EXTENSIONS = {
  photos: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.tif', '.raw', '.arw', '.cr2', '.nef'],
  videos: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.ts', '.mts'],
  pdfs:   ['.pdf'],
  docs:   ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.odt', '.ods', '.odp', '.csv', '.md'],
  others: [], // handled specially: any ext NOT in the above lists
};

// ─── Server ───────────────────────────────────────────────────────────────────
export async function getServerIp()   { return (await AsyncStorage.getItem(KEYS.SERVER_IP)) || ''; }
export async function setServerIp(ip) {
  await AsyncStorage.setItem(KEYS.SERVER_IP, ip);
  DeviceEventEmitter.emit('settings-updated');
}

export async function getServerPort() {
  const port = parseStoredInteger(await AsyncStorage.getItem(KEYS.SERVER_PORT), 8000);
  return port >= 1 && port <= 65535 ? port : 8000;
}
export async function setServerPort(port)  {
  await AsyncStorage.setItem(KEYS.SERVER_PORT, String(port));
  DeviceEventEmitter.emit('settings-updated');
}

export async function getServerName()      { return (await AsyncStorage.getItem(KEYS.SERVER_NAME)) || ''; }
export async function setServerName(name)  {
  await AsyncStorage.setItem(KEYS.SERVER_NAME, name);
  DeviceEventEmitter.emit('settings-updated');
}

export async function getApiKey()          { return (await AsyncStorage.getItem(KEYS.API_KEY)) || 'YOUR_SECRET_KEY'; }
export async function setApiKey(key)       {
  await AsyncStorage.setItem(KEYS.API_KEY, key);
  DeviceEventEmitter.emit('settings-updated');
}

export async function getUsername()        { return (await AsyncStorage.getItem(KEYS.USERNAME)) || ''; }
export async function setUsername(name)    {
  await AsyncStorage.setItem(KEYS.USERNAME, (name || '').trim());
  DeviceEventEmitter.emit('settings-updated');
}

export function formatDisplayName(username, deviceName) {
  const u = (username || '').trim();
  const d = (deviceName || '').trim();
  if (u && d) return `${u} (${d})`;
  return u || d || '';
}

export async function getDeviceId() {
  let id = await AsyncStorage.getItem(KEYS.DEVICE_ID);
  if (!id) {
    id = `android_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(KEYS.DEVICE_ID, id);
  }
  return id;
}

// ─── Folders ──────────────────────────────────────────────────────────────────
export async function getFolders() {
  const raw = await AsyncStorage.getItem(KEYS.FOLDERS);
  const folders = safeJsonParse(raw, []);
  return Array.isArray(folders)
    ? folders.filter((folder) => folder?.uri && folder?.name)
    : [];
}

export async function addFolder(uri, name) {
  const folders = await getFolders();
  if (folders.find((f) => f.uri === uri)) return folders;
  const folderName = getUniqueFolderName(folders, name);
  const updated = [...folders, { uri, name: folderName, addedAt: Date.now() }];
  await AsyncStorage.setItem(KEYS.FOLDERS, JSON.stringify(updated));
  return updated;
}

export async function removeFolder(uri) {
  const folders = await getFolders();
  const removed = folders.find((f) => f.uri === uri);
  const updated = folders.filter((f) => f.uri !== uri);
  await AsyncStorage.setItem(KEYS.FOLDERS, JSON.stringify(updated));
  // Also wipe that folder's upload cache so it re-syncs if re-added
  const keys = await AsyncStorage.getAllKeys();
  const folderKeys = removed
    ? keys.filter((k) => k.startsWith(`uploaded_${removed.name}/`) || k === `uploaded_${removed.name}`)
    : [];
  if (folderKeys.length > 0) await AsyncStorage.multiRemove(folderKeys);
  if (removed) await clearScanSnapshotForFolder(removed.name);
  return updated;
}

// ─── File types ───────────────────────────────────────────────────────────────
export async function getFileTypes() {
  const raw = await AsyncStorage.getItem(KEYS.FILE_TYPES);
  const types = safeJsonParse(raw, ['all']);
  if (!Array.isArray(types)) return ['all'];
  const valid = types.filter((type) =>
    Object.prototype.hasOwnProperty.call(FILE_TYPE_LABELS, type)
  );
  return valid.length > 0 ? Array.from(new Set(valid)) : ['all'];
}
export async function setFileTypes(types) {
  const valid = Array.isArray(types)
    ? types.filter((type) => Object.prototype.hasOwnProperty.call(FILE_TYPE_LABELS, type))
    : [];
  await AsyncStorage.setItem(KEYS.FILE_TYPES, JSON.stringify(valid.length > 0 ? valid : ['all']));
  await clearScanSnapshot();
}

// ─── Upload dedup cache ───────────────────────────────────────────────────────
// Key: "uploaded_<relativePath>", value: "<modifiedTime>"

function uploadCacheStorageKey(relativePath) {
  return `uploaded_${(relativePath || '').replace(/\\/g, '/')}`;
}

export function getUploadCacheStorageKey(relativePath) {
  return uploadCacheStorageKey(relativePath);
}

function uploadCacheMatchKey(file) {
  const path = (file.relativePath || '').replace(/\\/g, '/');
  return `${path}|${file.modifiedTime}|${file.size || 0}`;
}

/** Canonical match key shared by isUploadedBatch and sync pending checks. */
export function getFileCacheMatchKey(file) {
  return uploadCacheMatchKey(file);
}

function normalizeSnapshotPath(path) {
  return (path || '').replace(/\\/g, '/');
}

export async function isUploaded(relativePath, modifiedTime) {
  const val = await AsyncStorage.getItem(uploadCacheStorageKey(relativePath));
  return val === String(modifiedTime);
}

export async function markUploaded(relativePath, modifiedTime) {
  await AsyncStorage.setItem(uploadCacheStorageKey(relativePath), String(modifiedTime));
}

export async function markUploadedBatch(files) {
  if (!files.length) return;
  const CHUNK_SIZE = 500;
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    await AsyncStorage.multiSet(
      chunk.map((file) => [uploadCacheStorageKey(file.relativePath), String(file.modifiedTime)])
    );
  }
}

export async function isUploadedBatch(files) {
  const trusted = new Set();
  if (!files.length) return trusted;
  const CHUNK_SIZE = 500;
  const keys = files.map((file) => uploadCacheStorageKey(file.relativePath));
  const chunks = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    chunks.push(keys.slice(i, i + CHUNK_SIZE));
  }
  const chunkResults = await Promise.all(chunks.map((c) => AsyncStorage.multiGet(c)));
  const pairs = chunkResults.flat();
  const valueByKey = new Map(pairs);
  for (const file of files) {
    const storageKey = uploadCacheStorageKey(file.relativePath);
    const val = valueByKey.get(storageKey);
    if (val == null) continue;

    if (file.metadataLoaded) {
      if (val === String(file.modifiedTime)) {
        trusted.add(getFileCacheMatchKey(file));
      }
      continue;
    }

    // noMetadata scan: path is in the local upload cache — hydrate mtime from storage
    // so trusted keys, snapshot writes, and pending checks stay consistent.
    const cachedMtime = Number(val) || 0;
    file.modifiedTime = cachedMtime;
    file.metadataLoaded = true;
    trusted.add(getFileCacheMatchKey(file));
  }
  return trusted;
}

// ─── Sync schedule ────────────────────────────────────────────────────────────
export const SYNC_INTERVAL_PRESETS = [
  { label: '1 hr', value: 60 },
  { label: '6 hr', value: 360 },
  { label: '12 hr', value: 720 },
  { label: '24 hr', value: 1440 },
  { label: '72 hr', value: 4320 },
  { label: '1 week', value: 10080 },
  { label: '1 month', value: 43200 },
];

export function formatSyncIntervalLabel(minutes) {
  const preset = SYNC_INTERVAL_PRESETS.find((item) => item.value === minutes);
  if (preset) return preset.label;
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return `${minutes / 60}h`;
}

export async function getSyncInterval() {
  const val = parseStoredInteger(await AsyncStorage.getItem(KEYS.SYNC_INTERVAL), 60);
  return isNaN(val) || val < 60 ? 60 : val;
}
export async function setSyncInterval(minutes) {
  await AsyncStorage.setItem(KEYS.SYNC_INTERVAL, String(minutes));
  DeviceEventEmitter.emit('settings-updated');
}

export async function getSyncPaused()     { return (await AsyncStorage.getItem(KEYS.SYNC_PAUSED)) === 'true'; }
export async function setSyncPaused(val)  {
  await AsyncStorage.setItem(KEYS.SYNC_PAUSED, val ? 'true' : 'false');
  if (val) {
    await AsyncStorage.setItem(KEYS.LAST_SYNC_TIME, String(Date.now()));
  }
  DeviceEventEmitter.emit('settings-updated');
}

export async function getSyncRuntimeState() {
  const state = safeJsonParse(await AsyncStorage.getItem(KEYS.SYNC_RUNTIME_STATE), null);
  return state && typeof state === 'object' ? state : { active: false, phase: 'idle' };
}
export async function setSyncRuntimeState(state) {
  await AsyncStorage.setItem(KEYS.SYNC_RUNTIME_STATE, JSON.stringify({
    ...state,
    updatedAt: Date.now(),
  }));
}
export async function clearSyncRuntimeState() {
  await AsyncStorage.multiRemove([KEYS.SYNC_RUNTIME_STATE]);
}

// Used to prevent the next *automatic* sync run from immediately restarting right
// after the user requests a stop (especially across app relaunch / force-stop).
export async function getAutoSyncSuppressedUntil() {
  const raw = await AsyncStorage.getItem(KEYS.AUTO_SYNC_SUPPRESSED_UNTIL);
  const ts = parseStoredInteger(raw, 0);
  return ts > Date.now() ? ts : null;
}

export async function setAutoSyncSuppressedUntil(ts) {
  await AsyncStorage.setItem(KEYS.AUTO_SYNC_SUPPRESSED_UNTIL, String(Math.max(0, ts || 0)));
  DeviceEventEmitter.emit('settings-updated');
}

export async function clearAutoSyncSuppressedUntil() {
  await AsyncStorage.multiRemove([KEYS.AUTO_SYNC_SUPPRESSED_UNTIL]).catch(() => {});
  DeviceEventEmitter.emit('settings-updated');
}

export async function getThemeMode() {
  const mode = await AsyncStorage.getItem(KEYS.THEME_MODE);
  return mode === 'dark' ? 'dark' : 'light';
}
export async function setThemeMode(mode) {
  await AsyncStorage.setItem(KEYS.THEME_MODE, mode === 'dark' ? 'dark' : 'light');
}

// ─── Sync stats ───────────────────────────────────────────────────────────────
export async function getLastSyncTime() {
  const raw = await AsyncStorage.getItem(KEYS.LAST_SYNC_TIME);
  if (!raw) return null;
  const ts = parseStoredInteger(raw, 0);
  return ts > 0 ? ts : null;
}
export async function setLastSyncTime(ts) {
  await AsyncStorage.setItem(KEYS.LAST_SYNC_TIME, String(ts));
  DeviceEventEmitter.emit('settings-updated');
}

export async function getTotalSynced() {
  return Math.max(0, parseStoredInteger(await AsyncStorage.getItem(KEYS.TOTAL_SYNCED), 0));
}
export async function setTotalSynced(count) {
  await AsyncStorage.setItem(KEYS.TOTAL_SYNCED, String(Math.max(0, count || 0)));
  DeviceEventEmitter.emit('settings-updated');
}

export async function getTotalSyncedBytes() {
  return Math.max(0, parseStoredInteger(await AsyncStorage.getItem(KEYS.TOTAL_SYNCED_BYTES), 0));
}
export async function setTotalSyncedBytes(bytes) {
  await AsyncStorage.setItem(KEYS.TOTAL_SYNCED_BYTES, String(Math.max(0, bytes || 0)));
  DeviceEventEmitter.emit('settings-updated');
}

export async function getForceRefresh() {
  const [all, foldersRaw] = await Promise.all([
    AsyncStorage.getItem(KEYS.FORCE_REFRESH_ALL),
    AsyncStorage.getItem(KEYS.FORCE_REFRESH_FOLDERS),
  ]);
  const folders = safeJsonParse(foldersRaw, []);
  return {
    all: all === 'true',
    folders: Array.isArray(folders) ? folders : [],
  };
}

export async function clearForceRefresh() {
  await AsyncStorage.multiRemove([KEYS.FORCE_REFRESH_ALL, KEYS.FORCE_REFRESH_FOLDERS]);
}

// ─── Cache management ─────────────────────────────────────────────────────────

/** Clear upload cache for one folder (forces re-sync of its files). */
export async function clearFolderUploads(folderName) {
  const keys = await AsyncStorage.getAllKeys();
  // The relative paths start with "<folderName>/…"
  const match = keys.filter(
    (k) => k.startsWith(`uploaded_${folderName}/`) || k === `uploaded_${folderName}`
  );
  if (match.length > 0) await AsyncStorage.multiRemove(match);
  return match.length;
}

/** Clear ALL upload caches — every file will be re-uploaded on next sync. */
export async function clearAllUploads() {
  const keys = await AsyncStorage.getAllKeys();
  const match = keys.filter((k) => k.startsWith('uploaded_'));
  if (match.length > 0) await AsyncStorage.multiRemove(match);
  await setUploadCacheInitialized(false);
  return match.length;
}

export async function isUploadCacheInitialized() {
  return (await AsyncStorage.getItem(KEYS.UPLOAD_CACHE_INITIALIZED)) === 'true';
}

export async function setUploadCacheInitialized(initialized = true) {
  if (initialized) {
    await AsyncStorage.setItem(KEYS.UPLOAD_CACHE_INITIALIZED, 'true');
  } else {
    await AsyncStorage.removeItem(KEYS.UPLOAD_CACHE_INITIALIZED);
  }
}

/** Set when the server detects a reinstall and has an existing backup to restore. */
export async function setRecoverySyncPending(pending) {
  if (pending) {
    await AsyncStorage.setItem(KEYS.RECOVERY_SYNC_PENDING, 'true');
  } else {
    await AsyncStorage.removeItem(KEYS.RECOVERY_SYNC_PENDING);
  }
}

export async function getRecoverySyncPending() {
  return (await AsyncStorage.getItem(KEYS.RECOVERY_SYNC_PENDING)) === 'true';
}

export async function clearRecoverySyncPending() {
  await AsyncStorage.removeItem(KEYS.RECOVERY_SYNC_PENDING);
}

/**
 * One-time migration for installs that already had a populated upload cache
 * before the initialized sentinel was introduced.
 */
export async function ensureUploadCacheInitialized() {
  if (await isUploadCacheInitialized()) return;
  const keys = await AsyncStorage.getAllKeys();
  if (keys.some((key) => key.startsWith('uploaded_'))) {
    await setUploadCacheInitialized(true);
  }
}

/**
 * True only after an explicit reinstall (server sets recovery_available on connect).
 * Normal Sync Now / background sync never downloads the server upload index.
 */
export async function shouldAttemptRecoverySync() {
  if (await getRecoverySyncPending()) return true;
  await ensureUploadCacheInitialized();
  return false;
}

/** Rebuild the local upload cache from a one-time server index fetch after reinstall. */
export async function rebuildLocalCacheFromServer(serverFiles) {
  if (!Array.isArray(serverFiles) || !serverFiles.length) return 0;
  const CHUNK_SIZE = 500;
  let written = 0;
  for (let i = 0; i < serverFiles.length; i += CHUNK_SIZE) {
    const chunk = serverFiles.slice(i, i + CHUNK_SIZE).map((entry) => ({
      relativePath: (entry.path || '').replace(/\\/g, '/'),
      modifiedTime: entry.modified_time || 0,
      size: entry.size || 0,
    }));
    await markUploadedBatch(chunk);
    written += chunk.length;
  }
  return written;
}

/**
 * Apply a server upload index after reinstall: rebuild local cache, optionally
 * hydrate scanned files, and clear the recovery flag.
 * Returns false when the payload is unusable (recovery will retry on next sync).
 */
export async function applyServerUploadCacheRecovery(serverCache, scannedFiles = null) {
  if (!serverCache) return false;

  const serverFiles = Array.isArray(serverCache.files) ? serverCache.files : [];
  if (serverCache.count > 0 && serverFiles.length === 0) {
    console.warn('[Settings] Server upload cache count/files mismatch; skipping recovery rebuild');
    return false;
  }

  await rebuildLocalCacheFromServer(serverFiles);

  if (Array.isArray(scannedFiles) && scannedFiles.length > 0 && serverFiles.length > 0) {
    const byPath = new Map(
      serverFiles.map((entry) => [
        (entry.path || '').replace(/\\/g, '/'),
        {
          modifiedTime: entry.modified_time || 0,
          size: entry.size || 0,
        },
      ])
    );
    for (const file of scannedFiles) {
      const entry = byPath.get((file.relativePath || '').replace(/\\/g, '/'));
      if (entry) {
        file.modifiedTime = entry.modifiedTime;
        file.size = entry.size;
        file.metadataLoaded = true;
      }
    }
  }

  await setUploadCacheInitialized(true);
  await clearRecoverySyncPending();
  return true;
}

// ─── Scan snapshot cache ───────────────────────────────────────────────────────
// Key: "scan_snapshot_v1", value: { "<relativePath>": "<mtime>:<size>", ... }

export async function loadScanSnapshot() {
  const raw = await AsyncStorage.getItem(KEYS.SCAN_SNAPSHOT);
  const obj = safeJsonParse(raw, null);
  const map = new Map();
  if (!obj || typeof obj !== 'object') return map;
  for (const [path, val] of Object.entries(obj)) {
    const [mtime, size] = String(val).split(':');
    map.set(normalizeSnapshotPath(path), { mtime: Number(mtime) || 0, size: Number(size) || 0 });
  }
  return map;
}

export async function saveScanSnapshot(files, options = {}) {
  let obj = {};
  if (options.merge) {
    const raw = await AsyncStorage.getItem(KEYS.SCAN_SNAPSHOT);
    const existing = safeJsonParse(raw, null);
    if (existing && typeof existing === 'object') {
      for (const [path, val] of Object.entries(existing)) {
        obj[normalizeSnapshotPath(path)] = val;
      }
    }
  }
  for (const file of files) {
    const normPath = normalizeSnapshotPath(file.relativePath);
    let size = Number(file.size) || 0;
    if (size <= 0 && obj[normPath]) {
      const existingSize = Number(String(obj[normPath]).split(':')[1]) || 0;
      if (existingSize > 0) size = existingSize;
    }
    const mtime = file.modifiedTime || 0;
    obj[normPath] = `${mtime}:${size}`;
  }
  await AsyncStorage.setItem(KEYS.SCAN_SNAPSHOT, JSON.stringify(obj));
}

export async function clearScanSnapshot() {
  await AsyncStorage.removeItem(KEYS.SCAN_SNAPSHOT);
}

export async function clearScanSnapshotForFolder(folderName) {
  const raw = await AsyncStorage.getItem(KEYS.SCAN_SNAPSHOT);
  const obj = safeJsonParse(raw, null);
  if (!obj || typeof obj !== 'object') return;
  let changed = false;
  for (const path of Object.keys(obj)) {
    const normalized = normalizeSnapshotPath(path);
    if (normalized === folderName || normalized.startsWith(`${folderName}/`)) {
      delete obj[path];
      changed = true;
    }
  }
  if (changed) await AsyncStorage.setItem(KEYS.SCAN_SNAPSHOT, JSON.stringify(obj));
}

export async function removePathsFromScanSnapshot(paths) {
  if (!paths || !paths.length) return;
  const raw = await AsyncStorage.getItem(KEYS.SCAN_SNAPSHOT);
  const obj = safeJsonParse(raw, null);
  if (!obj || typeof obj !== 'object') return;
  let changed = false;
  for (const p of paths) {
    const normP = normalizeSnapshotPath(p);
    if (obj[normP] !== undefined) {
      delete obj[normP];
      changed = true;
    }
    if (obj[p] !== undefined) {
      delete obj[p];
      changed = true;
    }
  }
  if (changed) await AsyncStorage.setItem(KEYS.SCAN_SNAPSHOT, JSON.stringify(obj));
}

// ─── Device token (per-device auth from server) ───────────────────────────────
export async function getDeviceToken() { return (await AsyncStorage.getItem(KEYS.DEVICE_TOKEN)) || ''; }
export async function setDeviceToken(token) { await AsyncStorage.setItem(KEYS.DEVICE_TOKEN, token); }

// ─── TLS cert fingerprint ─────────────────────────────────────────────────────
export async function getServerCertFingerprint() { return (await AsyncStorage.getItem(KEYS.CERT_FINGERPRINT)) || ''; }
export async function setServerCertFingerprint(fp) { await AsyncStorage.setItem(KEYS.CERT_FINGERPRINT, fp); }

// ─── Saved Servers Profiles & Switching ───────────────────────────────────────

export async function getSavedServers() {
  const raw = await AsyncStorage.getItem(KEYS.SAVED_SERVERS).catch(() => null);
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

// Max number of candidate IPs to persist per server profile. Prevents unbounded growth
// when the phone roams across many mesh subnets over time.
const MAX_CANDIDATE_IPS = 20;

export async function saveServerProfile(server) {
  if (!server?.ip) return await getSavedServers();
  if (!ipv4Octets(server.ip)) {
    const numeric = (server.all_ips || server.candidateIps || []).find((ip) => ipv4Octets(ip));
    if (numeric) server = { ...server, ip: numeric };
  }
  const servers = await getSavedServers();
  const port = Number(server.port) || 8000;
  const id = `${server.ip}:${port}`;
  const now = Date.now();

  // Match by: serverId, exact id, exact ip:port, or candidateIps overlap.
  // The candidateIps overlap is critical for mesh roaming: after the phone switches
  // mesh nodes, resolveReachableServer may call saveServerProfile with a new primary IP
  // that doesn't match the saved id/ip — but it IS in the saved candidateIps list.
  const idx = servers.findIndex((s) => {
    if (server.serverId && s.serverId && server.serverId !== s.serverId) {
      return false;
    }
    return (
      (server.serverId && s.serverId && s.serverId === server.serverId) ||
      s.id === id ||
      (s.ip === server.ip && (Number(s.port) || 8000) === port) ||
      (
        Array.isArray(s.candidateIps) &&
        s.candidateIps.includes(server.ip) &&
        (Number(s.port) || 8000) === port
      )
    );
  });
  const existing = idx >= 0 ? servers[idx] : null;

  const resolvedName = (server.name && server.name !== server.ip)
    ? server.name
    : (existing?.name && existing.name !== server.ip ? existing.name : (server.name || server.ip));

  const existingCandidates = Array.isArray(existing?.candidateIps) ? existing.candidateIps : [];
  const incomingCandidates = Array.isArray(server.candidateIps)
    ? server.candidateIps
    : (Array.isArray(server.all_ips) ? server.all_ips : []);
  const candidateSet = new Set([server.ip, ...incomingCandidates, ...existingCandidates].filter(Boolean));
  // Keep most-recent IPs (first added = highest priority) within cap
  const candidateIps = Array.from(candidateSet).slice(0, MAX_CANDIDATE_IPS);

  const profile = {
    // If matching an existing profile via candidateIps, keep id consistent with new primary IP
    id,
    serverId: server.serverId || existing?.serverId || '',
    ip: server.ip,
    candidateIps,
    hostname: server.hostname || existing?.hostname || '',
    port,
    name: resolvedName,
    apiKey: server.apiKey || existing?.apiKey || 'YOUR_SECRET_KEY',
    deviceToken: server.deviceToken || existing?.deviceToken || '',
    certFingerprint: server.certFingerprint || existing?.certFingerprint || '',
    lastConnectedAt: now,
  };

  if (idx >= 0) {
    servers[idx] = {
      ...servers[idx],
      ...profile,
    };
  } else {
    servers.unshift(profile);
  }

  await AsyncStorage.setItem(KEYS.SAVED_SERVERS, JSON.stringify(servers)).catch(() => {});
  return servers;
}

export async function removeSavedServer(id) {
  const servers = (await getSavedServers()).filter((s) => s.id !== id && s.ip !== id);
  await AsyncStorage.setItem(KEYS.SAVED_SERVERS, JSON.stringify(servers)).catch(() => {});
  return servers;
}

export async function switchToSavedServer(id) {
  const servers = await getSavedServers();
  const server = servers.find((s) => s.id === id || s.ip === id);
  if (!server) return null;

  await AsyncStorage.multiSet([
    [KEYS.SERVER_IP, server.ip],
    [KEYS.SERVER_PORT, String(server.port || 8000)],
    [KEYS.SERVER_NAME, server.name || server.ip],
    [KEYS.API_KEY, server.apiKey || 'YOUR_SECRET_KEY'],
    [KEYS.DEVICE_TOKEN, server.deviceToken || ''],
    [KEYS.CERT_FINGERPRINT, server.certFingerprint || ''],
  ]);

  server.lastConnectedAt = Date.now();
  await AsyncStorage.setItem(KEYS.SAVED_SERVERS, JSON.stringify(servers)).catch(() => {});
  DeviceEventEmitter.emit('settings-updated');
  return server;
}

export async function getActiveServerCandidates() {
  const [currentIp, savedServers] = await Promise.all([
    getServerIp(),
    getSavedServers(),
  ]);
  const activeProfile = savedServers.find((s) => s.ip === currentIp) || savedServers[0];
  const candidates = new Set();
  if (currentIp) candidates.add(currentIp);
  if (activeProfile) {
    if (Array.isArray(activeProfile.candidateIps)) {
      activeProfile.candidateIps.forEach((ip) => { if (ip) candidates.add(ip); });
    }
    if (activeProfile.hostname) {
      candidates.add(activeProfile.hostname);
      if (!activeProfile.hostname.endsWith('.local')) {
        candidates.add(`${activeProfile.hostname}.local`);
      }
    }
  }
  return Array.from(candidates);
}

// ─── Mesh Roaming Auto-Failover Resolver ──────────────────────────────────────
let _resolvingPromise = null;
let _resolveGeneration = 0;

/** @type {import('expo-network') | null} */
let _Network = null;
try {
  _Network = require('expo-network');
} catch (_e) {}

async function quickProbe(target, port, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${target}:${port}/ping`, { signal: controller.signal });
    // clearTimeout must be called unconditionally before inspecting res.ok —
    // if we returned early on !res.ok without clearing, the timer would fire
    // later and abort an unrelated in-flight request sharing the controller.
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.status === 'ok') {
        return { ok: true, data };
      }
    }
    return { ok: false };
  } catch {
    clearTimeout(timer);
    return { ok: false };
  }
}

function ipv4Octets(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/**
 * Last-resort fallback for resolveReachableServer: sweeps the /24 subnet of the
 * given IP for a responding server.
 *
 * @param {string} baseIp           — any IP in the subnet to sweep
 * @param {number} port
 * @param {Set<string>} exclude     — mutable set; probed IPs are added so callers can pass the
 *                                    same set across multiple sweep calls to avoid re-probing
 * @param {string} [expectedServerId]
 * @returns {Promise<{ip: string, probe: {ok: boolean, data: any}} | null>}
 */
async function subnetSweep(baseIp, port, exclude, expectedServerId = '') {
  const octets = ipv4Octets(baseIp);
  if (!octets) return null;
  const prefix = `${octets[0]}.${octets[1]}.${octets[2]}.`;
  const candidates = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${prefix}${i}`;
    // Exclude both the base IP itself and anything already probed by the caller
    if (!exclude.has(ip)) candidates.push(ip);
  }

  const BATCH = 40;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    // Mark as probed before firing so concurrent callers don't duplicate work
    batch.forEach((ip) => exclude.add(ip));
    const results = await Promise.all(
      batch.map(async (ip) => ({ ip, probe: await quickProbe(ip, port, 1000) }))
    );
    const found = results.find((r) => {
      if (!r.probe.ok) return false;
      if (!expectedServerId) return true;
      return r.probe.data?.server_id === expectedServerId;
    });
    if (found) return found;
  }
  return null;
}

/**
 * Shared commit path: persists the newly-discovered server IP, updates the
 * saved-servers profile, and fires the settings-updated event.
 * Extracted to avoid copy-paste divergence between the candidate and sweep paths.
 */
async function _commitReachableServer({ newIp, port, probeData, serverName }) {
  // Write IP first so that any code triggered by the event sees the new IP.
  await AsyncStorage.setItem(KEYS.SERVER_IP, newIp);
  await saveServerProfile({
    ip: newIp,
    port,
    serverId: probeData?.server_id || '',
    name: probeData?.name || serverName || newIp,
    all_ips: probeData?.all_ips || [newIp],
    candidateIps: probeData?.candidateIps || probeData?.all_ips || [newIp],
    hostname: probeData?.hostname || '',
  });
  // Emit AFTER both writes so listeners always read a consistent state.
  DeviceEventEmitter.emit('settings-updated');
}

/**
 * Probes the currently configured server IP and, if unreachable (e.g. after mesh roaming),
 * concurrently probes candidate IPs and hostname to find the server's new IP.
 * Automatically updates active settings and returns { ok: boolean, ip: string, reconnected: boolean }.
 */
export async function resolveReachableServer(options = {}) {
  if (_resolvingPromise && !options.force) {
    return _resolvingPromise;
  }

  // Increment generation BEFORE assigning _resolvingPromise so that any
  // older in-flight resolution that finishes after us sees a stale generation
  // and does NOT clobber our promise in the finally block.
  const generation = ++_resolveGeneration;
  _resolvingPromise = (async () => {
    try {
      const [currentIp, port, savedServers, serverName] = await Promise.all([
        getServerIp(),
        getServerPort(),
        getSavedServers(),
        getServerName(),
      ]);

      if (!currentIp) {
        return { ok: false, ip: '', reconnected: false };
      }

      const activeProfile = savedServers.find(
        (s) => s.ip === currentIp || (Array.isArray(s.candidateIps) && s.candidateIps.includes(currentIp))
      ) || null;
      const expectedServerId = activeProfile?.serverId || '';

      const matchesExpectedServer = (probe) => {
        if (!expectedServerId) return true;
        return probe?.data?.server_id === expectedServerId;
      };

      // Step 1: Probe current configured IP first
      const currentProbe = await quickProbe(currentIp, port, options.timeoutMs || 1000);
      if (currentProbe.ok && matchesExpectedServer(currentProbe)) {
        // Refresh candidate list if server returned all_ips
        if (Array.isArray(currentProbe.data?.all_ips) && currentProbe.data.all_ips.length > 0) {
          saveServerProfile({
            ip: currentIp,
            port,
            serverId: currentProbe.data.server_id || '',
            name: currentProbe.data.name || serverName || currentIp,
            all_ips: currentProbe.data.all_ips,
            candidateIps: currentProbe.data.all_ips,
            hostname: currentProbe.data.hostname || '',
          }).catch(() => {});
        }
        return { ok: true, ip: currentIp, reconnected: false, data: currentProbe.data };
      }

      // Step 2: Probe saved profile mesh IPs and hostnames concurrently.
      const step2TimeoutMs = Math.max(options.timeoutMs || 1200, 2000);

      const candidates = new Set();
      if (activeProfile) {
        if (Array.isArray(activeProfile.candidateIps)) {
          activeProfile.candidateIps.forEach((cip) => {
            if (cip && cip !== currentIp) candidates.add(cip);
          });
        }
        if (activeProfile.hostname) {
          candidates.add(activeProfile.hostname);
          if (!activeProfile.hostname.endsWith('.local')) {
            candidates.add(`${activeProfile.hostname}.local`);
          }
        }
      }

      savedServers.forEach((s) => {
        if (s === activeProfile) return;
        if (!expectedServerId || s.serverId !== expectedServerId) return;
        if (s.ip && s.ip !== currentIp) candidates.add(s.ip);
        if (Array.isArray(s.candidateIps)) {
          s.candidateIps.forEach((cip) => { if (cip && cip !== currentIp) candidates.add(cip); });
        }
        if (s.hostname) {
          candidates.add(s.hostname);
          if (!s.hostname.endsWith('.local')) candidates.add(`${s.hostname}.local`);
        }
      });

      const candidateList = Array.from(candidates);
      if (candidateList.length > 0) {
        const probeResults = await Promise.all(
          candidateList.map(async (cand) => {
            const probe = await quickProbe(cand, port, step2TimeoutMs);
            return { target: cand, probe };
          })
        );

        const found = probeResults.find((r) => r.probe.ok && matchesExpectedServer(r.probe));
        if (found) {
          const numericAllIp = Array.isArray(found.probe.data?.all_ips)
            ? found.probe.data.all_ips.find((ip) => ipv4Octets(ip))
            : null;
          const newIp = ipv4Octets(found.target) ? found.target : (numericAllIp || found.target);
          console.log(`[Mesh Roaming] Found server at candidate address: ${newIp} (was ${currentIp})`);
          await _commitReachableServer({ newIp, port, probeData: found.probe.data, serverName });
          return { ok: true, ip: newIp, reconnected: true, data: found.probe.data };
        }
      }

      // Step 3: Subnet sweep — sweeps device's current network subnet (if roaming to a new mesh node AP),
      // last-known server IP's subnet, and any known candidate subnets.
      if (options.subnetSweep !== false) {
        const sweptExclude = new Set([currentIp, ...candidateList]);

        let deviceIp = null;
        try {
          if (_Network?.getIpAddressAsync) {
            deviceIp = await _Network.getIpAddressAsync();
          }
        } catch (_e) {}

        const sweptSubnetPrefixes = new Set();
        const subnetsToSweep = [];

        const addSubnet = (ip) => {
          const oct = ipv4Octets(ip);
          if (oct) {
            const prefix = `${oct[0]}.${oct[1]}.${oct[2]}`;
            if (!sweptSubnetPrefixes.has(prefix)) {
              sweptSubnetPrefixes.add(prefix);
              subnetsToSweep.push(ip);
            }
          }
        };

        // Prefer device's current subnet first
        if (deviceIp && deviceIp !== '0.0.0.0') {
          addSubnet(deviceIp);
        }
        addSubnet(currentIp);

        // Add candidate subnets from saved servers
        candidateList.forEach((cand) => {
          if (ipv4Octets(cand)) addSubnet(cand);
        });
        savedServers.forEach((s) => {
          if (s.ip && ipv4Octets(s.ip)) addSubnet(s.ip);
          if (Array.isArray(s.candidateIps)) {
            s.candidateIps.forEach((cip) => { if (ipv4Octets(cip)) addSubnet(cip); });
          }
        });

        for (const baseIp of subnetsToSweep) {
          const swept = await subnetSweep(baseIp, port, sweptExclude, expectedServerId);
          if (swept) {
            const newIp = swept.ip;
            console.log(`[Mesh Roaming] Found server via subnet sweep: ${newIp} (was ${currentIp})`);
            await _commitReachableServer({ newIp, port, probeData: swept.probe.data, serverName });
            return { ok: true, ip: newIp, reconnected: true, data: swept.probe.data };
          }
        }
      }

      return { ok: false, ip: currentIp, reconnected: false };
    } catch (e) {
      console.warn('[resolveReachableServer] Error resolving server:', e?.message);
      return { ok: false, ip: '', reconnected: false };
    } finally {
      if (generation === _resolveGeneration) {
        _resolvingPromise = null;
      }
    }
  })();

  return _resolvingPromise;
}