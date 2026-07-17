import AsyncStorage from '@react-native-async-storage/async-storage';

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
  SYNC_RUNTIME_STATE: 'sync_runtime_state',
  DEVICE_ID:      'device_id',
  FORCE_REFRESH_ALL: 'force_refresh_all',
  FORCE_REFRESH_FOLDERS: 'force_refresh_folders',
  THEME_MODE:     'theme_mode',
  SCAN_SNAPSHOT:  'scan_snapshot_v1',
};

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
export async function setServerIp(ip) { await AsyncStorage.setItem(KEYS.SERVER_IP, ip); }

export async function getServerPort() {
  const port = parseStoredInteger(await AsyncStorage.getItem(KEYS.SERVER_PORT), 8000);
  return port >= 1 && port <= 65535 ? port : 8000;
}
export async function setServerPort(port)  { await AsyncStorage.setItem(KEYS.SERVER_PORT, String(port)); }

export async function getServerName()      { return (await AsyncStorage.getItem(KEYS.SERVER_NAME)) || ''; }
export async function setServerName(name)  { await AsyncStorage.setItem(KEYS.SERVER_NAME, name); }

export async function getApiKey()          { return (await AsyncStorage.getItem(KEYS.API_KEY)) || 'YOUR_SECRET_KEY'; }
export async function setApiKey(key)       { await AsyncStorage.setItem(KEYS.API_KEY, key); }

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

export async function isUploaded(relativePath, modifiedTime) {
  const val = await AsyncStorage.getItem(`uploaded_${relativePath}`);
  return val === String(modifiedTime);
}

export async function markUploaded(relativePath, modifiedTime) {
  await AsyncStorage.setItem(`uploaded_${relativePath}`, String(modifiedTime));
}

export async function markUploadedBatch(files) {
  if (!files.length) return;
  await AsyncStorage.multiSet(
    files.map((file) => [`uploaded_${file.relativePath}`, String(file.modifiedTime)])
  );
}

// ─── Sync schedule ────────────────────────────────────────────────────────────
export async function getSyncInterval() {
  const val = parseStoredInteger(await AsyncStorage.getItem(KEYS.SYNC_INTERVAL), 15);
  return isNaN(val) || val < 15 ? 15 : val;
}
export async function setSyncInterval(minutes) { await AsyncStorage.setItem(KEYS.SYNC_INTERVAL, String(minutes)); }

export async function getSyncPaused()     { return (await AsyncStorage.getItem(KEYS.SYNC_PAUSED)) === 'true'; }
export async function setSyncPaused(val)  { await AsyncStorage.setItem(KEYS.SYNC_PAUSED, val ? 'true' : 'false'); }

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
}

export async function getTotalSynced() {
  return Math.max(0, parseStoredInteger(await AsyncStorage.getItem(KEYS.TOTAL_SYNCED), 0));
}
export async function setTotalSynced(count) {
  await AsyncStorage.setItem(KEYS.TOTAL_SYNCED, String(Math.max(0, count || 0)));
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
  return match.length;
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
    map.set(path, { mtime: Number(mtime) || 0, size: Number(size) || 0 });
  }
  return map;
}

export async function saveScanSnapshot(files) {
  const obj = {};
  for (const file of files) {
    obj[file.relativePath] = `${file.modifiedTime}:${file.size || 0}`;
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
    if (path === folderName || path.startsWith(`${folderName}/`)) {
      delete obj[path];
      changed = true;
    }
  }
  if (changed) await AsyncStorage.setItem(KEYS.SCAN_SNAPSHOT, JSON.stringify(obj));
}