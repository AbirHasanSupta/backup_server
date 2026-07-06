import AsyncStorage from '@react-native-async-storage/async-storage';

// ─────────────────────────────────────────────
// Server settings
// ─────────────────────────────────────────────
export const getServerIp = async () =>
  (await AsyncStorage.getItem('server_ip')) || '';
export const setServerIp = (ip) => AsyncStorage.setItem('server_ip', ip);

export const getServerPort = async () =>
  parseInt((await AsyncStorage.getItem('server_port')) || '8000');
export const setServerPort = (port) =>
  AsyncStorage.setItem('server_port', String(port));

export const getApiKey = async () =>
  (await AsyncStorage.getItem('api_key')) || 'YOUR_SECRET_KEY';
export const setApiKey = (key) => AsyncStorage.setItem('api_key', key);

export const getServerName = async () =>
  (await AsyncStorage.getItem('server_name')) || '';
export const setServerName = (name) => AsyncStorage.setItem('server_name', name);

// ─────────────────────────────────────────────
// File type filter
// ─────────────────────────────────────────────
export const FILE_TYPE_LABELS = {
  all: 'All Files',
  photos: 'Photos',
  videos: 'Videos',
  pdfs: 'PDFs',
  docs: 'Documents',
  others: 'Others',
};

export const FILE_TYPE_EXTENSIONS = {
  photos: ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tiff'],
  videos: ['.mp4', '.mov', '.avi', '.mkv', '.3gp', '.webm', '.m4v', '.ts'],
  pdfs: ['.pdf'],
  docs: [
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.txt', '.rtf', '.odt', '.ods', '.odp', '.csv', '.md',
  ],
};

export const getFileTypes = async () => {
  const v = await AsyncStorage.getItem('file_types');
  return v ? JSON.parse(v) : ['all'];
};
export const setFileTypes = (types) =>
  AsyncStorage.setItem('file_types', JSON.stringify(types));

// ─────────────────────────────────────────────
// Sync schedule
// ─────────────────────────────────────────────
export const getSyncInterval = async () =>
  parseInt((await AsyncStorage.getItem('sync_interval')) || '15');
export const setSyncInterval = (minutes) =>
  AsyncStorage.setItem('sync_interval', String(minutes));

export const getSyncPaused = async () =>
  (await AsyncStorage.getItem('sync_paused')) === 'true';
export const setSyncPaused = (paused) =>
  AsyncStorage.setItem('sync_paused', String(paused));

// ─────────────────────────────────────────────
// Upload tracking
// ─────────────────────────────────────────────
export const isUploaded = async (relativePath, modifiedTime) => {
  const v = await AsyncStorage.getItem(`uploaded_${relativePath}`);
  return v === String(modifiedTime);
};

export const markUploaded = (relativePath, modifiedTime) =>
  AsyncStorage.setItem(`uploaded_${relativePath}`, String(modifiedTime));

/** Clear upload cache for files inside a specific folder (force re-upload). */
export const clearFolderUploads = async (folderName) => {
  const keys = await AsyncStorage.getAllKeys();
  const toRemove = keys.filter((k) =>
    k.startsWith(`uploaded_${folderName}/`) || k === `uploaded_${folderName}`
  );
  if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
  return toRemove.length;
};

/** Clear ALL upload cache (force full re-backup). */
export const clearAllUploads = async () => {
  const keys = await AsyncStorage.getAllKeys();
  const toRemove = keys.filter((k) => k.startsWith('uploaded_'));
  if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);
  return toRemove.length;
};

// ─────────────────────────────────────────────
// Folder management
// ─────────────────────────────────────────────
export const getFolders = async () => {
  const v = await AsyncStorage.getItem('folders');
  return v ? JSON.parse(v) : [];
};

export const addFolder = async (uri, name) => {
  const folders = await getFolders();
  if (folders.find((f) => f.uri === uri)) return folders;
  const updated = [...folders, { uri, name, addedAt: Date.now() }];
  await AsyncStorage.setItem('folders', JSON.stringify(updated));
  return updated;
};

export const removeFolder = async (uri) => {
  const folders = await getFolders();
  const updated = folders.filter((f) => f.uri !== uri);
  await AsyncStorage.setItem('folders', JSON.stringify(updated));
  return updated;
};

// ─────────────────────────────────────────────
// Sync statistics
// ─────────────────────────────────────────────
export const getLastSyncTime = async () => {
  const v = await AsyncStorage.getItem('last_sync_time');
  return v ? parseInt(v) : null;
};
export const setLastSyncTime = (ts) =>
  AsyncStorage.setItem('last_sync_time', String(ts));

export const getTotalSynced = async () =>
  parseInt((await AsyncStorage.getItem('total_synced')) || '0');

export const incrementTotalSynced = async (count) => {
  const current = await getTotalSynced();
  await AsyncStorage.setItem('total_synced', String(current + count));
};