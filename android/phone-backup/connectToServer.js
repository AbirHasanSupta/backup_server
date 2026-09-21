import {
  getConnectionMode,
  getDeviceId,
  getUsername,
  setUsername,
  setDeviceToken,
  saveServerProfile,
  setRecoverySyncPending,
  isUploadCacheInitialized,
  clearRecoverySyncPending,
  formatHostForUrl,
  parseServerAddress,
  isPrivateNetworkAddress,
} from './settings';
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
 * @returns {Promise<{status: string, reason?: string, username?: string | null, device_name?: string | null, token?: string, server_id?: string, all_ips?: string[], candidateIps?: string[], tailscale?: any, hostname?: string, recovery_available?: boolean, files_backed_up?: number}>}
 */
export async function connectToServer(serverIp, serverPort, apiKey) {
  const deviceName =
    Device?.deviceName ||
    Device?.modelName ||
    `Android Device`;

  // modelName is the hardware model (e.g. "Pixel 7") — stable across reinstalls
  const deviceModel = Device?.modelName || null;

  const parsed = parseServerAddress(serverIp, serverPort);
  const cleanIp = parsed.host;
  const port = parsed.port || serverPort;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  let isPrivate = false;

  try {
    const configuredMode = await getConnectionMode();
    isPrivate = configuredMode === 'private-network' || isPrivateNetworkAddress(cleanIp);
    const connectionMode = isPrivate ? 'private-network' : 'lan';

    const deviceId = await getDeviceId();
    const username = await getUsername();
    const hostTarget = formatHostForUrl(cleanIp);
    const res = await fetch(`http://${hostTarget}:${port}/connect`, {
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
      if (result.username) {
        await setUsername(result.username);
      }
      if (result.recovery_available) {
        await setRecoverySyncPending(true);
        void prefetchServerUploadCache();
      } else if (await isUploadCacheInitialized()) {
        // Only clear a stale recovery flag once the local cache is already populated.
        await clearRecoverySyncPending();
      }
      const unifiedCandidates = [
        cleanIp,
        ...(Array.isArray(result.tailscale?.ips) ? result.tailscale.ips : []),
        result.tailscale?.dns_name || '',
        ...(Array.isArray(result.all_ips) ? result.all_ips : []),
      ].filter(Boolean);
      await saveServerProfile({
        serverId: result.server_id || '',
        ip: cleanIp,
        port,
        apiKey,
        deviceToken: result.token || '',
        all_ips: Array.isArray(result.all_ips) ? result.all_ips : [cleanIp],
        candidateIps: unifiedCandidates,
        tailscale: result.tailscale || null,
        hostname: result.hostname || '',
        connectionMode,
      });

      // Warm real-time WebSocket event connection
      try {
        const { connectWebSocket } = require('./websocketClient');
        void connectWebSocket();
      } catch {}
    }
    return result;

  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      return { status: 'error', reason: 'Request timed out — server did not respond in time.' };
    }
    const msg = (err?.message || String(err || '')).trim();
    if (/NoRouteToHost|ConnectException|SocketException|ECONNREFUSED|Host unreachable|Network request failed/i.test(msg)) {
      return {
        status: 'error',
        reason: isPrivate
          ? 'Server unreachable — check that the desktop server is running and connected to Tailscale or WireGuard.'
          : 'Server unreachable — check that the desktop server is running and on the same Wi-Fi.',
      };
    }
    return { status: 'error', reason: msg || 'Could not connect to server' };
  }
}
