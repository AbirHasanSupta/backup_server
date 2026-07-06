import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getApiKey } from './settings';

export async function uploadFile(item) {
  const serverIp = await getServerIp();
  const apiKey = await getApiKey();
  const url = `http://${serverIp}:8000/upload`;

  const fileName = item.relativePath.split('/').pop();
  const cacheUri = `${FileSystem.cacheDirectory}${Date.now()}_${fileName}`;
  await FileSystem.StorageAccessFramework.copyAsync({ from: item.uri, to: cacheUri });

  const res = await FileSystem.uploadAsync(url, cacheUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    parameters: {
      relative_path: item.relativePath,
      modified_time: String(item.modifiedTime),
      size: String(item.size)
    },
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  await FileSystem.deleteAsync(cacheUri, { idempotent: true });

  return res.status === 200;
}