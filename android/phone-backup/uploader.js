import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getApiKey } from './settings';

export async function uploadFile(item) {
  const serverIp = await getServerIp();
  const apiKey = await getApiKey();
  const url = `http://${serverIp}:8000/upload`;

  const res = await FileSystem.uploadAsync(url, item.uri, {
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

  return res.status === 200;
}