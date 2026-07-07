import { getServerPort } from './settings';

const TIMEOUT_MS = 2500;
const BATCH_SIZE = 30;

// ─── Lazy native module guard ──────────────────────────────────────────────────
//
// `expo-network` requires the native 'ExpoNetwork' module which is only present
// in a compiled dev-client or production build — not in Expo Go.
// Same lazy require() pattern used in notificationService.js and backgroundTask.js.
//
// • If native module is absent → Network stays null, discoverServers() throws a
//   user-friendly error that the UI will display in the discovery sheet.
// • If native module is present → full LAN scanning works normally.

/** @type {import('expo-network') | null} */
let Network = null;

try {
  Network = require('expo-network');
} catch (e) {
  console.warn(
    '[ServerDiscovery] Native module "ExpoNetwork" not available — ' +
    'server discovery disabled. Build a dev client: eas build --profile development --platform android\n' +
    'Reason:', e?.message
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return await res.json();
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function probeServer(ip, port) {
  const data = await fetchWithTimeout(`http://${ip}:${port}/ping`, TIMEOUT_MS);
  if (data && data.status === 'ok') {
    return { ip, port, name: data.name || ip, version: data.version || '?' };
  }
  return null;
}

function buildSubnetIps(deviceIp) {
  const parts = deviceIp.split('.');
  if (parts.length !== 4) return [];
  const subnet = parts.slice(0, 3).join('.');
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`);
  return ips;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Scans the current LAN subnet for backup servers.
 * Uses the user-configured port (default 8000) so custom ports are found.
 *
 * @param {(progress: number, found: Array) => void} onProgress
 * @returns {Promise<Array<{ip, port, name, version}>>}
 */
export async function discoverServers(onProgress) {
  if (!Network) {
    throw new Error(
      'Network scanning is not available in Expo Go. ' +
      'Build a development client with: eas build --profile development --platform android'
    );
  }

  const state = await Network.getNetworkStateAsync();
  if (!state.isConnected) throw new Error('Not connected to a network');

  const deviceIp = await Network.getIpAddressAsync();
  if (!deviceIp || deviceIp === '0.0.0.0') {
    throw new Error('Could not determine device IP address');
  }

  // Use the configured port so non-default setups are discoverable
  const port = await getServerPort();

  const ips = buildSubnetIps(deviceIp);
  const found = [];
  let scanned = 0;
  const total = ips.length;

  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    const batch = ips.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((ip) => probeServer(ip, port)));
    results.forEach((r) => { if (r) found.push(r); });
    scanned += batch.length;
    onProgress && onProgress(Math.round((scanned / total) * 100), [...found]);
  }

  return found;
}

export function getDeviceIp() {
  if (!Network) return Promise.resolve(null);
  return Network.getIpAddressAsync();
}
