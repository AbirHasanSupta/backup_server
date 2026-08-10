import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getServerPort, getApiKey, getDeviceId, getDeviceToken } from './settings';

export async function getConfig() {
  const [ip, port, apiKey, deviceId, deviceToken] = await Promise.all([
    getServerIp(), getServerPort(), getApiKey(), getDeviceId(), getDeviceToken(),
  ]);
  return { ip, port, key: deviceToken || apiKey, deviceId };
}

export function buildPreviewUrl(config, relativePath, sourceMode, sourceId) {
  if (!config || !config.ip || !config.port) return '';
  if (sourceMode === 'shared' && sourceId) {
    return `http://${config.ip}:${config.port}/shared/${encodeURIComponent(sourceId)}/download?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
  }
  return `http://${config.ip}:${config.port}/files/download?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

/**
 * Fetch the list of backed-up files for this device from the server.
 * @returns {Promise<Array<{path: string, size: number, modified_time: number, sha256: string, uploaded_time: number}>>}
 */
export async function listServerFiles() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/files/list?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`List failed (${res.status})`);
  return (await res.json()).files;
}

/**
 * Download a single file from the server.
 * @param {string} relativePath  — the path key as stored in the server DB
 * @param {string} destUri       — local file URI to write into
 * @param {(written: number, total: number) => void} [onProgress]
 * @returns {Promise<FileSystem.FileSystemDownloadResult>}
 */
export async function downloadFile(relativePath, destUri, onProgress) {
  const { ip, port, key, deviceId } = await getConfig();
  const url =
    `http://${ip}:${port}/files/download` +
    `?relative_path=${encodeURIComponent(relativePath)}` +
    `&device_id=${encodeURIComponent(deviceId)}`;

  const downloadResumable = FileSystem.createDownloadResumable(
    url,
    destUri,
    { headers: { Authorization: `Bearer ${key}` } },
    (progress) => {
      onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite);
    },
  );
  return downloadResumable.downloadAsync();
}

/**
 * Build the full authenticated URL for a file — used by the preview modal
 * to pass directly to expo-av (video/audio) or FileSystem.downloadAsync (images).
 *
 * @param {string} relativePath — the path key as stored in the server DB
 * @returns {Promise<string>}   — a fully-qualified http:// URL with auth baked-in
 *                                 NOTE: auth is sent via query param as a fallback
 *                                 because expo-av does not support custom headers on
 *                                 Android. The server must accept ?token= as well.
 */
export async function getFilePreviewUrl(relativePath) {
  const { ip, port, key, deviceId } = await getConfig();
  return (
    `http://${ip}:${port}/files/download` +
    `?relative_path=${encodeURIComponent(relativePath)}` +
    `&device_id=${encodeURIComponent(deviceId)}` +
    `&token=${encodeURIComponent(key)}`
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Shared Directories  (read-only folders configured in the Desktop app)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the list of shared sources configured on the server.
 * @returns {Promise<Array<{id: string, label: string}>>}
 */
export async function listSharedSources() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/shared/list?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Shared list failed (${res.status})`);
  return (await res.json()).sources ?? [];
}

/**
 * List all files inside a shared directory source.
 * @param {string} sourceId — the source id from listSharedSources()
 * @returns {Promise<Array<{path: string, size: number, modified_time: number}>>}
 */
export async function listSharedFiles(sourceId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/files?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Shared files failed (${res.status})`);
  const data = await res.json();
  if (data.warning) console.warn('[SharedDir]', data.warning);
  return data.files ?? [];
}

/**
 * Download a file from a shared directory.
 * @param {string} sourceId      — the source id
 * @param {string} relativePath  — path relative to the shared dir root
 * @param {string} destUri       — local file URI to write into
 * @param {(written: number, total: number) => void} [onProgress]
 */
export async function downloadSharedFile(sourceId, relativePath, destUri, onProgress) {
  const { ip, port, key, deviceId } = await getConfig();
  const url =
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/download` +
    `?relative_path=${encodeURIComponent(relativePath)}` +
    `&device_id=${encodeURIComponent(deviceId)}`;

  const downloadResumable = FileSystem.createDownloadResumable(
    url,
    destUri,
    { headers: { Authorization: `Bearer ${key}` } },
    (progress) => {
      onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite);
    },
  );
  return downloadResumable.downloadAsync();
}


/**
 * Build the full authenticated URL for a shared file preview
 * (auth via ?token= query param since expo-av doesn't support custom headers on Android).
 * @param {string} sourceId
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
export async function getSharedFilePreviewUrl(sourceId, relativePath) {
  const { ip, port, key, deviceId } = await getConfig();
  return (
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/download` +
    `?relative_path=${encodeURIComponent(relativePath)}` +
    `&device_id=${encodeURIComponent(deviceId)}` +
    `&token=${encodeURIComponent(key)}`
  );
}