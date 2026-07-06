import * as Network from 'expo-network';

const SERVER_PORT = 8000;
const TIMEOUT_MS = 1200;
const BATCH_SIZE = 25;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function probeServer(ip) {
  const data = await fetchWithTimeout(
    `http://${ip}:${SERVER_PORT}/ping`,
    TIMEOUT_MS
  );
  if (data && data.status === 'ok') {
    return {
      ip,
      port: SERVER_PORT,
      name: data.name || ip,
      version: data.version || '?',
    };
  }
  return null;
}

function buildSubnetIps(deviceIp) {
  const parts = deviceIp.split('.');
  if (parts.length !== 4) return [];
  const subnet = parts.slice(0, 3).join('.');
  const ips = [];
  for (let i = 1; i <= 254; i++) {
    ips.push(`${subnet}.${i}`);
  }
  return ips;
}

/**
 * Scans the current LAN subnet for backup servers.
 * @param {(progress: number, found: Array) => void} onProgress
 * @returns {Promise<Array<{ip, port, name, version}>>}
 */
export async function discoverServers(onProgress) {
  const state = await Network.getNetworkStateAsync();
  if (!state.isConnected) throw new Error('Not connected to a network');

  const deviceIp = await Network.getIpAddressAsync();
  if (!deviceIp || deviceIp === '0.0.0.0') {
    throw new Error('Could not determine device IP address');
  }

  const ips = buildSubnetIps(deviceIp);
  const found = [];
  let scanned = 0;
  const total = ips.length;

  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    const batch = ips.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(probeServer));
    results.forEach((r) => {
      if (r) found.push(r);
    });
    scanned += batch.length;
    onProgress && onProgress(Math.round((scanned / total) * 100), [...found]);
  }

  return found;
}

export function getDeviceIp() {
  return Network.getIpAddressAsync();
}
