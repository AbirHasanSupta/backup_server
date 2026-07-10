import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getApiKey, getServerPort, getDeviceId } from './settings';

async function readJsonResponse(res, context) {
  try {
    return await res.json();
  } catch {
    throw new Error(`${context}: invalid server response`);
  }
}

function parseUploadBody(body) {
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error('Upload succeeded but the server returned invalid JSON');
  }
}

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

function removedDeviceError() {
  return new Error('This phone was removed from the desktop app. Reconnect from Settings to resume backup.');
}

export async function checkDeviceConnection(options = {}) {
  const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
  const params = new URLSearchParams({ device_id: deviceId });
  const res = await fetch(`http://${serverIp}:${serverPort}/status?${params.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: options.signal,
  });

  if (res.status === 401) throw new Error('Invalid API key');
  if (!res.ok) throw new Error(`Server status failed (${res.status})`);

  const body = await readJsonResponse(res, 'Server status failed');
  return {
    connected: body.device_connected === true,
    serverVersion: body.server_version || '',
  };
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
  if (res.status === 403) throw removedDeviceError();
  if (!res.ok) throw new Error(`Server check failed (${res.status})`);

  const body = await readJsonResponse(res, 'Server check failed');
  if (!Array.isArray(body.files)) {
    throw new Error('Server check failed: invalid file list response');
  }
  return {
    files: body.files,
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
  const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();

  const params = new URLSearchParams({
    relative_path: item.relativePath,
    modified_time: String(item.modifiedTime),
    size: String(item.size || 0),
    external_id: item.id || '',
    sha256: item.sha256 || '',
    device_id: deviceId,
  });
  const rawUrl = `http://${serverIp}:${serverPort}/upload/raw?${params.toString()}`;
  const multipartUrl = `http://${serverIp}:${serverPort}/upload`;
  const safeName = (item.name || item.relativePath.split('/').pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const cacheUri = `${FileSystem.cacheDirectory}${uniqueId}_${safeName}`;

  // Copy SAF file to a local cache path that expo-file-system can upload
  await FileSystem.StorageAccessFramework.copyAsync({ from: item.uri, to: cacheUri });

  try {
    const uploadRaw = () => FileSystem.uploadAsync(rawUrl, cacheUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/octet-stream',
      },
    });

    const uploadMultipart = () => FileSystem.uploadAsync(multipartUrl, cacheUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      parameters: {
        relative_path: item.relativePath,
        modified_time: String(item.modifiedTime),
        size: String(item.size || 0),
        external_id: item.id || '',
        sha256: item.sha256 || '',
        device_id: deviceId,
      },
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    let res;
    if (FileSystem.FileSystemUploadType.BINARY_CONTENT) {
      res = await uploadRaw();
      if ([404, 405, 414, 422].includes(res.status)) {
        res = await uploadMultipart();
      }
    } else {
      res = await uploadMultipart();
    }

    onProgress && onProgress(item.size || 0);

    // Any 200 response means the server accepted the file successfully
    if (res.status === 200) {
      const body = parseUploadBody(res.body);
      return {
        success: true,
        status: body.status || 'uploaded',
        deviceTotalFiles: body.device_total_files || 0,
        deviceTotalSize: body.device_total_size || 0,
      };
    }

    // 401 = wrong API key — throw so the caller can surface this prominently
    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 403) throw removedDeviceError();

    return { success: false };
  } finally {
    // Always clean up the cache file, even on failure
    await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
  }
}
