import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getServerPort, getApiKey, getDeviceId, getDeviceToken } from './settings';

async function getConfig() {
  const [ip, port, apiKey, deviceId, deviceToken] = await Promise.all([
    getServerIp(), getServerPort(), getApiKey(), getDeviceId(), getDeviceToken(),
  ]);
  return { ip, port, key: deviceToken || apiKey, deviceId };
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