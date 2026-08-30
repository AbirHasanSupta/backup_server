import { getDeviceId, getUsername, setDeviceToken, saveServerProfile, setRecoverySyncPending } from './settings';
import { prefetchServerUploadCache } from './uploader';

/**
 * connectToServer.js
 *
 * Sends a POST /connect request to the backup server, registering this device.
 * The server may show an Accept/Reject dialog (if REQUIRE_APPROVAL is enabled).
 *
 * Returns:
 *   { status: 'accepted' | 'rejected' | 'error', reason?: string }
 */

// Lazy-load expo-device: requires native module, not available in Expo Go.
/** @type {import('expo-device') | null} */
let Device = null;
try {
  Device = require('expo-device');
} catch (e) {
  console.warn('[connectToServer] expo-device not available, device name will be generic:', e?.message);
}

const CONNECT_TIMEOUT_MS = 35_000; // slightly longer than server's 30s timeout

async function readConnectionResponse(res) {
  try {
    const body = await res.json();
    return body && typeof body.status === 'string'
      ? body
      : { status: 'error', reason: 'Server returned an invalid connection response.' };
  } catch {
    return { status: 'error', reason: 'Server returned an invalid connection response.' };
  }
}


/**
 * @param {string} serverIp
 * @param {number} serverPort
 * @param {string} apiKey
 * @returns {Promise<{status: string, reason?: string}>}
 */
export async function connectToServer(serverIp, serverPort, apiKey) {
  const deviceName =
    Device?.deviceName ||
    Device?.modelName ||
    `Android Device`;

  // modelName is the hardware model (e.g. "Pixel 7") — stable across reinstalls
  const deviceModel = Device?.modelName || null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  try {
    const deviceId = await getDeviceId();
    const username = await getUsername();
    const res = await fetch(`http://${serverIp}:${serverPort}/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        device_name: deviceName,
        device_id: deviceId,
        device_model: deviceModel,
        username: username || null,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { status: 'error', reason: `HTTP ${res.status}` };
    }

    const result = await readConnectionResponse(res);
    // Store per-device token if server provided one
    if (result.status === 'accepted') {
      if (result.token) {
        await setDeviceToken(result.token);
      }
      if (result.recovery_available) {
        await setRecoverySyncPending(true);
        void prefetchServerUploadCache();
      } else {
        await setRecoverySyncPending(false);
      }
      await saveServerProfile({
        serverId: result.server_id || '',
        ip: serverIp,
        port: serverPort,
        apiKey,
        deviceToken: result.token || '',
        all_ips: Array.isArray(result.all_ips) ? result.all_ips : [serverIp],
        candidateIps: Array.isArray(result.all_ips) ? result.all_ips : [serverIp],
        hostname: result.hostname || '',
      });
    }
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      return { status: 'error', reason: 'Request timed out — server did not respond in time.' };
    }
    const msg = (err?.message || String(err || '')).trim();
    if (/NoRouteToHost|ConnectException|SocketException|ECONNREFUSED|Host unreachable|Network request failed/i.test(msg)) {
      return { status: 'error', reason: 'Server unreachable — check that the desktop server is running and on the same Wi-Fi.' };
    }
    return { status: 'error', reason: msg || 'Could not connect to server' };
  }
}