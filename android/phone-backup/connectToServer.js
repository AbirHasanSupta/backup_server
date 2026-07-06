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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  try {
    const res = await fetch(`http://${serverIp}:${serverPort}/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ device_name: deviceName }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { status: 'error', reason: `HTTP ${res.status}` };
    }

    return await res.json(); // { status: 'accepted' | 'rejected', reason?: ... }
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      return { status: 'error', reason: 'Request timed out — server did not respond in time.' };
    }
    return { status: 'error', reason: err?.message || 'Network error' };
  }
}
