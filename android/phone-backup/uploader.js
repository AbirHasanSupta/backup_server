import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getApiKey, getServerPort } from './settings';

async function getServerConfig() {
  const [serverIp, apiKey, serverPort] = await Promise.all([
    getServerIp(),
    getApiKey(),
    getServerPort(),
  ]);

  if (!serverIp) throw new Error('No server IP configured');
  return { serverIp, apiKey, serverPort };
}

export async function checkServerFiles(files) {
  const { serverIp, apiKey, serverPort } = await getServerConfig();
  const url = `http://${serverIp}:${serverPort}/files/check`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: files.map((file) => ({
        relative_path: file.relativePath,
        modified_time: file.modifiedTime,
        size: file.size || 0,
      })),
    }),
  });

  if (res.status === 401) throw new Error('Invalid API key');
  if (!res.ok) throw new Error(`Server check failed (${res.status})`);

  const body = await res.json();
  return Array.isArray(body.files) ? body.files : [];
}

/**
 * Uploads a single file to the backup server.
 *
 * @param {{ uri: string, relativePath: string, modifiedTime: number, size: number, name: string }} item
 * @param {(bytes: number) => void} [onProgress]
 * @returns {Promise<boolean>} true if uploaded or already on server, false on failure
 */
export async function uploadFile(item, onProgress) {
  const { serverIp, apiKey, serverPort } = await getServerConfig();

  const url = `http://${serverIp}:${serverPort}/upload`;
  const safeName = (item.name || item.relativePath.split('/').pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const cacheUri = `${FileSystem.cacheDirectory}${uniqueId}_${safeName}`;

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
