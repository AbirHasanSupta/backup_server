import * as FileSystem from 'expo-file-system/legacy';
import {
  getServerIp,
  getApiKey,
  getServerPort,
  getDeviceId,
  getDeviceToken,
  resolveReachableServer,
  applyServerUploadCacheRecovery,
  saveServerProfile,
} from './settings';
import { getPendingShareNotifications, markShareNotificationsSeen } from './downloader';
import { showNewSharePostNotification } from './notificationService';

function isNetworkError(err) {
  // AbortError is an intentional cancel (user timeout or explicit abort) — not a mesh roaming
  // failure. Do not trigger failover for these; let the caller handle them explicitly.
  if (err?.name === 'AbortError' || err?.code === 20 /* DOMException.ABORT_ERR */) return false;

  const msg = (err?.message || String(err || '')).toLowerCase();
  return (
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnrefused') ||
    msg.includes('noroutetohost') ||
    msg.includes('socketexception') ||
    msg.includes('host unreachable') ||
    msg.includes('failed to connect') ||
    msg.includes('software caused connection abort') ||
    msg.includes('connection refused') ||
    msg.includes('unknownhost') ||
    msg.includes('enotfound')
  );
}

async function withAutoFailover(action) {
  try {
    return await action();
  } catch (err) {
    if (isNetworkError(err)) {
      console.log('[Uploader] Network error encountered. Attempting mesh failover re-resolution...');
      const resolved = await resolveReachableServer().catch(() => ({ ok: false }));
      if (resolved.ok) {
        console.log(`[Uploader] Re-executing request against reachable server IP: ${resolved.ip}`);
        return await action();
      }
    }
    throw err;
  }
}

/**
 * Returns true only for files with a real extension that are not hidden system
 * files (names starting with a dot are OS/system internals like .sys_install_s_time.cfg).
 */
function hasProperExtension(name) {
  const n = name || '';
  if (n.startsWith('.')) return false;          // hidden / system file — skip
  const dot = n.lastIndexOf('.');
  return dot > 0 && dot < n.length - 1;
}

/**
 * Converts a raw native / network exception into a short, human-readable
 * message that is safe to display in the app UI.
 * Technical details (module names, stack traces, rejected-promise noise) are
 * stripped out so users never see "ExponentFileSystem.uploadAsync has been
 * rejected" or similar internal strings.
 */
function toUserFriendlyError(err) {
  const raw = (err?.message || String(err || '')).trim();

  // Content type / MIME type resolution errors
  if (
    raw.includes('guessContentTypeFromName') ||
    raw.includes('guessContentType') ||
    raw.includes('must not be null')
  ) {
    return 'File format error — unable to determine file type for upload';
  }

  // Null pointer / reference errors
  if (
    raw.includes('NullPointerException') ||
    raw.includes('null reference') ||
    raw.includes('cannot read property') ||
    raw.includes('undefined is not')
  ) {
    return 'File error — unable to read file details';
  }

  // Native module rejection noise — never show technical class names or method calls
  if (
    raw.includes('ExponentFileSystem') ||
    raw.includes('uploadAsync') ||
    raw.includes('has been rejected') ||
    raw.includes('NativeModule') ||
    raw.includes('Invariant Violation')
  ) {
    const caused = raw.match(/(?:Caused by|caused by)[:\s]+(.+?)(?:\n|$)/i);
    if (caused && caused[1]) {
      return toUserFriendlyError({ message: caused[1] });
    }
    return 'File could not be uploaded (inaccessible or removed)';
  }

  // Java / Android exception class names
  if (raw.includes('FileNotFoundException') || raw.includes('ENOENT') || raw.includes('No such file')) {
    return 'File not found — it may have been moved or deleted';
  }
  if (raw.includes('SecurityException') || raw.includes('Permission') || raw.includes('EPERM') || raw.includes('EACCES')) {
    return 'Permission denied — check folder access in Settings';
  }
  if (raw.includes('SocketException') || raw.includes('ConnectException') || raw.includes('ECONNREFUSED') || raw.includes('ECONNRESET') || raw.includes('ETIMEDOUT') || raw.includes('Network')) {
    return 'Network error — check Wi-Fi and server connection';
  }
  if (raw.includes('OutOfMemory') || raw.includes('ENOMEM')) {
    return 'Not enough memory to upload this file';
  }
  if (raw.includes('IOException')) {
    return 'File read error — the file may be corrupted or in use';
  }

  // Catch-all for code-level/technical errors
  if (/java\.|android\.|com\.|Exception|TypeError|ReferenceError|IllegalState|IllegalArgument|NullPointer|Method|Class/i.test(raw)) {
    return 'File could not be uploaded — system error';
  }

  // Generic long messages: truncate to keep them readable
  if (raw.length > 120) {
    return raw.substring(0, 117).replace(/\n.*$/, '').trim() + '…';
  }

  return raw || 'Upload failed';
}



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
  const [serverIp, apiKey, serverPort, deviceId, deviceToken] = await Promise.all([
    getServerIp(),
    getApiKey(),
    getServerPort(),
    getDeviceId(),
    getDeviceToken(),
  ]);

  if (!serverIp) throw new Error('No server IP configured');
  return { serverIp, apiKey: deviceToken || apiKey, serverPort, deviceId };
}

function removedDeviceError() {
  return new Error('This phone was removed from the desktop app. Reconnect from Settings to resume backup.');
}

/**
 * Best-effort check for newly shared posts targeting this device; fires a
 * local notification per post and marks it seen. Never throws — this rides
 * along on the periodic status check and must not disrupt it on failure.
 */
export async function checkAndNotifyNewShares() {
  try {
    const { posts } = await getPendingShareNotifications();
    if (!Array.isArray(posts) || posts.length === 0) return;
    for (const post of posts) {
      await showNewSharePostNotification(post);
    }
    await markShareNotificationsSeen(posts.map((p) => p.group_id));
  } catch {
    // Notifications are supplementary — silently ignore failures
  }
}

export async function checkDeviceConnection(options = {}) {
  let retrying = false;
  return withAutoFailover(async () => {
    const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
    const params = new URLSearchParams({ device_id: deviceId });
    // On retry (after mesh failover), do not reuse the original AbortSignal since it may
    // already be aborted (e.g. a 6-second UI timeout fired while resolveReachableServer ran).
    const signal = retrying ? undefined : options.signal;
    retrying = true;
    const res = await fetch(`http://${serverIp}:${serverPort}/status?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });

    if (res.status === 401) throw new Error('Invalid API key');
    if (!res.ok) throw new Error(`Server status failed (${res.status})`);

    const body = await readJsonResponse(res, 'Server status failed');
    if (body.device_connected === true) {
      checkAndNotifyNewShares();
    }
    if (Array.isArray(body.all_ips) && body.all_ips.length > 0) {
      saveServerProfile({
        ip: serverIp,
        port: serverPort,
        serverId: body.server_id || '',
        all_ips: body.all_ips,
        candidateIps: body.all_ips,
        hostname: body.hostname || '',
      }).catch(() => {});
    }
    return {
      connected: body.device_connected === true,
      serverVersion: body.server_version || '',
    };
  });
}

export async function checkServerFiles(files, options = {}) {
  return withAutoFailover(async () => {
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
        verify_disk: options.verifyDisk === true,
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
  });
}

/**
 * Download the server's upload index for this device.
 * Used after reinstall to rebuild the local upload cache without re-uploading files.
 */
let uploadCachePromise = null;

function createFetchTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export async function fetchServerUploadCache() {
  if (!uploadCachePromise) {
    uploadCachePromise = withAutoFailover(async () => {
      const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
      const params = new URLSearchParams({ device_id: deviceId });
      const res = await fetch(`http://${serverIp}:${serverPort}/sync/upload-cache?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: createFetchTimeoutSignal(120000),
      });

      if (res.status === 401) throw new Error('Invalid API key');
      if (res.status === 403) throw removedDeviceError();
      if (!res.ok) throw new Error(`Server upload cache failed (${res.status})`);

      const body = await readJsonResponse(res, 'Server upload cache failed');
      const files = Array.isArray(body.files) ? body.files : [];
      return {
        files,
        count: body.count ?? files.length,
        totalSize: body.total_size || 0,
      };
    }).finally(() => {
      uploadCachePromise = null;
    });
  }
  return uploadCachePromise;
}

/** Best-effort prefetch after reinstall connect; rebuilds local cache so the first sync is fast. */
export function prefetchServerUploadCache() {
  return fetchServerUploadCache()
    .then((cache) => applyServerUploadCacheRecovery(cache))
    .catch(() => undefined);
}

/**
 * Uploads a single file to the backup server.
 *
 * @param {{ uri: string, relativePath: string, modifiedTime: number, size: number, name: string }} item
 * @param {(bytes: number) => void} [onProgress]
 * @returns {Promise<boolean>} true if uploaded or already on server, false on failure
 */
export async function uploadFile(item, onProgress, options = {}) {
  const name = item.name || item.relativePath.split('/').pop() || '';
  if (!hasProperExtension(name)) {
    // Hidden system files (e.g. .sys_install_s_time.cfg) or extension-less
    // entries are silently skipped — they are not user files.
    return { success: true, status: 'skipped', deviceTotalFiles: 0, deviceTotalSize: 0 };
  }

  const verifyDisk = options.verifyDisk === true ? 'true' : 'false';
  const safeName = (item.name || item.relativePath.split('/').pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const cacheUri = `${FileSystem.cacheDirectory}upload_tmp_${uniqueId}_${safeName}`;

  // ── Step 1: Copy SAF file to a local cache path ───────────────────────────
  // Some SAF URIs (system files, recently-deleted files, restricted paths) can
  // not be read. Treat those as graceful skips rather than hard failures.
  try {
    if (item.uri && item.uri.startsWith('content://')) {
      await FileSystem.StorageAccessFramework.copyAsync({ from: item.uri, to: cacheUri });
    } else {
      await FileSystem.copyAsync({ from: item.uri, to: cacheUri });
    }
  } catch (copyErr) {
    try {
      await FileSystem.copyAsync({ from: item.uri, to: cacheUri });
    } catch {
      // Log the raw technical detail to the Expo console / dev tools only.
      console.warn(
        '[Uploader] Could not read file for upload (skipped):',
        item.relativePath,
        copyErr?.message
      );
      // Translate to a user-friendly error and re-throw so the worker counts it.
      throw new Error(toUserFriendlyError(copyErr));
    }
  }

  // ── Step 2: Upload via HTTP (with mesh auto-failover) ───────────────────────
  try {
    const doUpload = async () => {
      const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
      const params = new URLSearchParams({
        relative_path: item.relativePath,
        modified_time: String(item.modifiedTime),
        size: String(item.size || 0),
        external_id: item.id || '',
        sha256: item.sha256 || '',
        device_id: deviceId,
        verify_disk: verifyDisk,
      });
      const rawUrl = `http://${serverIp}:${serverPort}/upload/raw?${params.toString()}`;
      const multipartUrl = `http://${serverIp}:${serverPort}/upload`;

      const uploadRaw = () => FileSystem.uploadAsync(rawUrl, cacheUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        mimeType: 'application/octet-stream',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/octet-stream',
        },
      });

      const uploadMultipart = () => FileSystem.uploadAsync(multipartUrl, cacheUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType: 'application/octet-stream',
        parameters: {
          relative_path: item.relativePath,
          modified_time: String(item.modifiedTime),
          size: String(item.size || 0),
          external_id: item.id || '',
          sha256: item.sha256 || '',
          device_id: deviceId,
          verify_disk: verifyDisk,
        },
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (FileSystem.FileSystemUploadType.BINARY_CONTENT) {
        let response = await uploadRaw();
        if ([404, 405, 414, 422].includes(response.status)) {
          response = await uploadMultipart();
        }
        return response;
      }
      return await uploadMultipart();
    };

    let res;
    try {
      res = await withAutoFailover(doUpload);
    } catch (uploadErr) {
      // Raw native rejection from ExponentFileSystem — sanitize before propagating.
      console.warn(
        '[Uploader] uploadAsync native error (sanitized for UI):',
        item.relativePath,
        uploadErr?.message
      );
      throw new Error(toUserFriendlyError(uploadErr));
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

/**
 * Post a completed sync session summary to the server so the desktop History
 * page shows per-device audit records without relying solely on the phone.
 * This is best-effort: a network failure here must never break the sync flow.
 *
 * @param {object} session  — fields matching SyncSessionRequest on the server
 */
export async function postSyncSession(session) {
  try {
    const { serverIp, apiKey, serverPort, deviceId } = await getServerConfig();
    await fetch(`http://${serverIp}:${serverPort}/sync/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...session, device_id: session.device_id ?? deviceId }),
    });
  } catch {
    // Intentionally silenced — server history is supplementary; local history is primary
  }
}
