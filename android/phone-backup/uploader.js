import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getApiKey, getServerPort, getDeviceId } from './settings';

async function getServerConfig() {
  const [serverIp, apiKey, serverPort, deviceId] = await Promise.all([
    getServerIp(),
    getApiKey(),
    getServerPort(),
    getDeviceId(),
  ]);

  if (!serverIp) throw new Error('No server IP configured');
  return { serverIp, apiKey, serverPort, deviceId };
}

export async function checkServerFiles(files) {
  const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
  const url = `http://${serverIp}:${serverPort}/files/check`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      device_id: deviceId,
      files: files.map((file) => ({
        relative_path: file.relativePath,
        modified_time: file.modifiedTime,
        size: file.size || 0,
        external_id: file.id,
      })),
    }),
  });

  if (res.status === 401) throw new Error('Invalid API key');
  if (!res.ok) throw new Error(`Server check failed (${res.status})`);

  const body = await res.json();
  return {
    files: Array.isArray(body.files) ? body.files : [],
    deviceTotalFiles: body.device_total_files || 0,
    deviceTotalSize: body.device_total_size || 0,
  };
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
        external_id: item.id || '',
        sha256: item.sha256 || '',
        device_id: await getDeviceId(),
      },
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    onProgress && onProgress(item.size || 0);

    // Any 200 response means the server accepted the file successfully
    if (res.status === 200) {
      const body = JSON.parse(res.body);
      return {
        success: true,
        deviceTotalFiles: body.device_total_files || 0,
        deviceTotalSize: body.device_total_size || 0,
      };
    }

    // 401 = wrong API key — throw so the caller can surface this prominently
    if (res.status === 401) throw new Error('Invalid API key');

    return { success: false };
  } finally {
    // Always clean up the cache file, even on failure
    await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
  }
}
