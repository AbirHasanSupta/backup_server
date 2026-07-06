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
};

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

export async function getServerPort()      { return parseInt((await AsyncStorage.getItem(KEYS.SERVER_PORT)) || '8000'); }
export async function setServerPort(port)  { await AsyncStorage.setItem(KEYS.SERVER_PORT, String(port)); }

export async function getServerName()      { return (await AsyncStorage.getItem(KEYS.SERVER_NAME)) || ''; }
export async function setServerName(name)  { await AsyncStorage.setItem(KEYS.SERVER_NAME, name); }

export async function getApiKey()          { return (await AsyncStorage.getItem(KEYS.API_KEY)) || 'YOUR_SECRET_KEY'; }
export async function setApiKey(key)       { await AsyncStorage.setItem(KEYS.API_KEY, key); }

// ─── Folders ──────────────────────────────────────────────────────────────────
export async function getFolders() {
  const raw = await AsyncStorage.getItem(KEYS.FOLDERS);
  return raw ? JSON.parse(raw) : [];
}

export async function addFolder(uri, name) {
  const folders = await getFolders();
  if (folders.find((f) => f.uri === uri)) return folders;
  const updated = [...folders, { uri, name, addedAt: Date.now() }];
  await AsyncStorage.setItem(KEYS.FOLDERS, JSON.stringify(updated));
  return updated;
}

export async function removeFolder(uri) {
  const folders = await getFolders();
  const updated = folders.filter((f) => f.uri !== uri);
  await AsyncStorage.setItem(KEYS.FOLDERS, JSON.stringify(updated));
  // Also wipe that folder's upload cache so it re-syncs if re-added
  const keys = await AsyncStorage.getAllKeys();
  const folderKeys = keys.filter((k) => k.startsWith(`uploaded_${uri}`));
  if (folderKeys.length > 0) await AsyncStorage.multiRemove(folderKeys);
  return updated;
}

// ─── File types ───────────────────────────────────────────────────────────────
export async function getFileTypes() {
  const raw = await AsyncStorage.getItem(KEYS.FILE_TYPES);
  return raw ? JSON.parse(raw) : ['all'];
}
export async function setFileTypes(types) {
  await AsyncStorage.setItem(KEYS.FILE_TYPES, JSON.stringify(types));
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

// ─── Sync schedule ────────────────────────────────────────────────────────────
export async function getSyncInterval()        { return parseInt((await AsyncStorage.getItem(KEYS.SYNC_INTERVAL)) || '15'); }
export async function setSyncInterval(minutes) { await AsyncStorage.setItem(KEYS.SYNC_INTERVAL, String(minutes)); }

export async function getSyncPaused()     { return (await AsyncStorage.getItem(KEYS.SYNC_PAUSED)) === 'true'; }
export async function setSyncPaused(val)  { await AsyncStorage.setItem(KEYS.SYNC_PAUSED, val ? 'true' : 'false'); }

// ─── Sync stats ───────────────────────────────────────────────────────────────
export async function getLastSyncTime() {
  const raw = await AsyncStorage.getItem(KEYS.LAST_SYNC_TIME);
  return raw ? parseInt(raw) : null;
}
export async function setLastSyncTime(ts) {
  await AsyncStorage.setItem(KEYS.LAST_SYNC_TIME, String(ts));
}

export async function getTotalSynced() {
  return parseInt((await AsyncStorage.getItem(KEYS.TOTAL_SYNCED)) || '0');
}
export async function incrementTotalSynced(count) {
  const current = await getTotalSynced();
  await AsyncStorage.setItem(KEYS.TOTAL_SYNCED, String(current + count));
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