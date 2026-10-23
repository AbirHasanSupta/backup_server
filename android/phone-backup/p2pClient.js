import * as FileSystem from 'expo-file-system/legacy';
import { formatHostForUrl, parseServerAddress } from './settings';
import {
  getLocalPeerIdentity,
  getP2PDeviceSecret,
  savePairedPeer,
  updatePeerLastSeen,
} from './p2pSettings';

const REQUEST_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 60_000;

async function postJson(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      let errorDetail = `HTTP ${res.status}`;
      try {
        const errorJson = await res.json();
        if (errorJson?.detail) errorDetail += `: ${errorJson.detail}`;
      } catch {}
      throw new Error(errorDetail);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function getJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function buildBaseUrl(ip, port) {
  const parsed = parseServerAddress(ip, port);
  const host = parsed.host;
  const targetPort = parsed.port || port;
  return `http://${formatHostForUrl(host)}:${targetPort}`;
}

// ─── Public P2P Client API ───────────────────────────────────────────────────

/**
 * Pings a peer device and verifies responsiveness.
 */
export async function pingPeer(ip, port) {
  const baseUrl = buildBaseUrl(ip, port);
  const data = await getJson(`${baseUrl}/p2p/ping`, 4000);
  if (data?.device_id) {
    updatePeerLastSeen(data.device_id, ip, port).catch(() => {});
  }
  return data;
}

/**
 * Initiates an AirDrop-style pairing request with a nearby peer device.
 * Generates a 4-digit verification PIN so both users see the same confirmation code.
 */
export async function requestPairing(ip, port) {
  const [localIdentity, localSecret] = await Promise.all([
    getLocalPeerIdentity(),
    getP2PDeviceSecret(),
  ]);

  const baseUrl = buildBaseUrl(ip, port);
  const pin = Math.floor(1000 + Math.random() * 9000).toString();

  const response = await postJson(`${baseUrl}/p2p/pair`, {
    action: 'request',
    device_id: localIdentity.deviceId,
    device_name: localIdentity.deviceName,
    device_model: localIdentity.deviceModel,
    username: localIdentity.username,
    port: localIdentity.port,
    secret_hash: localSecret.slice(0, 16),
    pin,
  });

  return {
    ...response,
    pin,
  };
}

/**
 * Confirms pairing after user approval on both devices.
 */
export async function confirmPairing(ip, port, peerId, pin) {
  const [localIdentity, localSecret] = await Promise.all([
    getLocalPeerIdentity(),
    getP2PDeviceSecret(),
  ]);

  const baseUrl = buildBaseUrl(ip, port);
  const response = await postJson(`${baseUrl}/p2p/pair`, {
    action: 'confirm',
    device_id: localIdentity.deviceId,
    peer_id: peerId,
    pin,
    auth_secret: localSecret,
  });

  if (response?.status === 'accepted') {
    await savePairedPeer({
      peerId,
      deviceName: response.peer_device_name || 'Paired Peer',
      username: response.peer_username || '',
      ip,
      port,
      authSecret: response.peer_auth_secret || '',
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    });
  }

  return response;
}

/**
 * Sends a Direct Post or Share directly to another phone without using the central server.
 *
 * @param {string} peerIp IP of the receiving phone
 * @param {number} peerPort Port of the receiving phone
 * @param {{
 *   shareId?: string,
 *   caption?: string,
 *   postKind?: string,
 *   files: Array<{ name: string, base64?: string, uri?: string, size?: number, modifiedTime?: number }>
 * }} payload
 * @param {(progressText: string) => void} [onProgress]
 */
export async function sendDirectShareToPeer(peerIp, peerPort, payload, onProgress) {
  const localIdentity = await getLocalPeerIdentity();
  const baseUrl = buildBaseUrl(peerIp, peerPort);
  const shareId = payload.shareId || `p2p_share_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const filesPayload = [];
  const filesList = payload.files || [];

  for (let i = 0; i < filesList.length; i++) {
    const file = filesList[i];
    const fileName = file.name || `file_${i + 1}`;

    // Prefer high-speed zero-RAM binary stream directly from disk via uploadAsync
    if (file.uri) {
      if (onProgress) onProgress(`Transferring file ${i + 1}/${filesList.length}: ${fileName}…`);
      try {
        const uploadUrl = `${baseUrl}/p2p/upload?share_id=${encodeURIComponent(shareId)}&name=${encodeURIComponent(fileName)}`;
        const uploadRes = await FileSystem.uploadAsync(uploadUrl, file.uri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Device-Id': localIdentity.deviceId,
          },
        });
        if (uploadRes && uploadRes.status === 200) {
          let resBody = {};
          try {
            resBody = JSON.parse(uploadRes.body || '{}');
          } catch {}
          filesPayload.push({
            name: fileName,
            fileName: resBody.fileName || fileName,
            size: resBody.size || file.size || 0,
            modified_time: file.modifiedTime || Date.now(),
          });
          continue;
        }
      } catch (uploadErr) {
        console.warn(`[P2PClient] Direct binary stream failed for ${fileName}, falling back:`, uploadErr?.message);
      }
    }

    // Fallback: Read as base64 if uploadAsync was not applicable or failed
    let base64Data = file.base64;
    if (!base64Data && file.uri) {
      if (onProgress) onProgress(`Reading file ${i + 1}/${filesList.length}…`);
      base64Data = await FileSystem.readAsStringAsync(file.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }

    filesPayload.push({
      name: fileName,
      size: file.size || 0,
      modified_time: file.modifiedTime || Date.now(),
      base64: base64Data,
    });
  }

  if (onProgress) onProgress(`Finalizing direct share on ${peerIp}…`);

  const response = await postJson(
    `${baseUrl}/p2p/share`,
    {
      share_id: shareId,
      shared_by_device_id: localIdentity.deviceId,
      shared_by_device_name: localIdentity.deviceName,
      shared_by_username: localIdentity.username,
      caption: payload.caption || '',
      post_kind: payload.postKind || 'direct_post',
      created_at: Date.now(),
      files: filesPayload,
    },
    TRANSFER_TIMEOUT_MS
  );

  updatePeerLastSeen(payload.peerId || '', peerIp, peerPort).catch(() => {});
  return {
    ...response,
    shareId,
  };
}

/**
 * Fetches recent feed items shared by a peer phone.
 */
export async function fetchPeerFeed(peerIp, peerPort) {
  const localIdentity = await getLocalPeerIdentity();
  const baseUrl = buildBaseUrl(peerIp, peerPort);
  return await getJson(`${baseUrl}/p2p/feed?device_id=${encodeURIComponent(localIdentity.deviceId)}`);
}

/**
 * Downloads a media file directly from a peer phone into local cache/storage.
 */
export async function downloadPeerMediaFile(peerIp, peerPort, filename, destUri) {
  const baseUrl = buildBaseUrl(peerIp, peerPort);
  const downloadUrl = `${baseUrl}/p2p/files/${encodeURIComponent(filename)}`;

  const downloadResult = await FileSystem.downloadAsync(downloadUrl, destUri);
  return downloadResult;
}
