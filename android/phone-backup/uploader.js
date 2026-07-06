import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getApiKey, getServerPort } from './settings';

/**
 * Uploads a single file to the backup server.
 * @param {Object} item - { uri, relativePath, modifiedTime, size, name }
 * @param {(bytes: number) => void} [onProgress]
 * @returns {Promise<boolean>} true if uploaded successfully
 */
export async function uploadFile(item, onProgress) {
  const [serverIp, apiKey, serverPort] = await Promise.all([
    getServerIp(),
    getApiKey(),
    getServerPort(),
  ]);

  if (!serverIp) throw new Error('No server IP configured');

  const url = `http://${serverIp}:${serverPort}/upload`;
  const safeName = item.name || item.relativePath.split('/').pop();
  const cacheUri = `${FileSystem.cacheDirectory}${Date.now()}_${safeName}`;

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
    return res.status === 200;
  } finally {
    await FileSystem.deleteAsync(cacheUri, { idempotent: true });
  }
}