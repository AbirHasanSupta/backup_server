import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getApiKey, getServerPort } from './settings';

/**
 * Uploads a single file to the backup server.
 *
 * @param {{ uri: string, relativePath: string, modifiedTime: number, size: number, name: string }} item
 * @param {(bytes: number) => void} [onProgress]
 * @returns {Promise<boolean>} true if uploaded or already on server, false on failure
 */
export async function uploadFile(item, onProgress) {
  const [serverIp, apiKey, serverPort] = await Promise.all([
    getServerIp(),
    getApiKey(),
    getServerPort(),
  ]);

  if (!serverIp) throw new Error('No server IP configured');

  const url = `http://${serverIp}:${serverPort}/upload`;
  const safeName = (item.name || item.relativePath.split('/').pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const cacheUri = `${FileSystem.cacheDirectory}${Date.now()}_${safeName}`;

  // Copy SAF file to a local cache path that expo-file-system can upload
  await FileSystem.StorageAccessFramework.copyAsync({ from: item.uri, to: cacheUri });

  try {
    const res = await FileSystem.uploadAsync(url, cacheUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      parameters: {
        relative_path: item.relativePath,
        modified_time: String(item.modifiedTime),
        size: String(item.size || 0),
      },
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    onProgress && onProgress(item.size || 0);

    // 200 = uploaded, treat "skipped" (already on server) as success too
    if (res.status === 200) {
      try {
        const body = JSON.parse(res.body || '{}');
        // Both "uploaded" and "skipped" mean the file is safe on the server
        return body.status === 'uploaded' || body.status === 'skipped';
      } catch {
        return true; // non-JSON 200 → assume success
      }
    }

    // 401 = wrong API key — throw so the caller can surface this prominently
    if (res.status === 401) throw new Error('Invalid API key');

    return false;
  } finally {
    // Always clean up the cache file, even on failure
    await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
  }
}