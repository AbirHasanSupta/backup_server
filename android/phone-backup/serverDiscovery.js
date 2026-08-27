import { getServerPort, getSavedServers } from './settings';

const TIMEOUT_MS = 1500;
const BATCH_SIZE = 40;

// Common mesh node & router subnets across various manufacturers
// (TP-Link Deco = 192.168.68.x, Google Nest = 192.168.86.x, Asus = 192.168.50.x, etc.)
const COMMON_MESH_SUBNETS = [
  '192.168.0',
  '192.168.1',
  '192.168.2',
  '192.168.68',
  '192.168.86',
  '192.168.50',
  '192.168.8',
  '192.168.178',
  '10.0.0',
  '10.0.1',
];

// ─── Lazy native module guard ──────────────────────────────────────────────────
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

async function probeServer(ip, port, timeoutMs = TIMEOUT_MS) {
  const data = await fetchWithTimeout(`http://${ip}:${port}/ping`, timeoutMs);
  if (data && data.status === 'ok') {
    const allIps = Array.isArray(data.all_ips) && data.all_ips.length > 0 ? data.all_ips : [ip];
    return {
      ip,
      port,
      name: data.name || ip,
      hostname: data.hostname || '',
      version: data.version || '?',
      certFingerprint: data.cert_fingerprint || '',
      all_ips: allIps,
      candidateIps: Array.from(new Set([ip, ...allIps])),
    };
  }
  return null;
}

export function buildMultiSubnetIps(deviceIp, savedServers = []) {
  const ipList = [];
  const seen = new Set();

  const addIp = (ip) => {
    if (ip && !seen.has(ip)) {
      seen.add(ip);
      ipList.push(ip);
    }
  };

  // 1. High priority: Saved servers and known candidates
  savedServers.forEach((s) => {
    if (s.ip) addIp(s.ip);
    if (Array.isArray(s.candidateIps)) {
      s.candidateIps.forEach((cip) => addIp(cip));
    }
  });

  // 2. Primary Subnet (where device is currently assigned)
  const parts = (deviceIp || '').split('.');
  const primarySubnet = parts.length === 4 ? parts.slice(0, 3).join('.') : null;

  if (primarySubnet) {
    for (let i = 1; i <= 254; i++) {
      addIp(`${primarySubnet}.${i}`);
    }
  }

  // 3. Secondary Mesh Node Subnets
  // Scan high-probability host pools (.1, .100–.150, .200, then rest)
  for (const subnet of COMMON_MESH_SUBNETS) {
    if (subnet !== primarySubnet) {
      addIp(`${subnet}.1`);
      for (let i = 100; i <= 150; i++) addIp(`${subnet}.${i}`);
      addIp(`${subnet}.200`);
      for (let i = 2; i <= 99; i++) addIp(`${subnet}.${i}`);
      for (let i = 151; i <= 254; i++) addIp(`${subnet}.${i}`);
    }
  }

  return ipList;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Scans the local network (including across mesh nodes and multi-subnets) for backup servers.
 *
 * @param {(progress: number, found: Array) => void} onProgress
 * @param {{ shouldStop?: () => boolean, signal?: AbortSignal, maxSubnets?: number }} [options]
 * @returns {Promise<Array<{ip, port, name, version, all_ips, candidateIps}>>}
 */
export async function discoverServers(onProgress, options = {}) {
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

  const [port, savedServers] = await Promise.all([
    getServerPort(),
    getSavedServers(),
  ]);

  const ips = buildMultiSubnetIps(deviceIp, savedServers);
  const foundMap = new Map(); // key by server name or ip:port
  let scanned = 0;
  const total = ips.length;

  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    if (options.shouldStop?.() || options.signal?.aborted) break;
    const batch = ips.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((ip) => probeServer(ip, port)));
    if (options.shouldStop?.() || options.signal?.aborted) break;

    results.forEach((r) => {
      if (r) {
        const key = r.name && r.name !== r.ip ? r.name : `${r.ip}:${r.port}`;
        if (foundMap.has(key)) {
          const existing = foundMap.get(key);
          const mergedCandidates = Array.from(new Set([
            ...(existing.candidateIps || [existing.ip]),
            ...(r.candidateIps || [r.ip]),
          ]));
          foundMap.set(key, { ...existing, candidateIps: mergedCandidates });
        } else {
          foundMap.set(key, r);
        }
      }
    });

    scanned += batch.length;
    onProgress && onProgress(Math.min(100, Math.round((scanned / total) * 100)), Array.from(foundMap.values()));
  }

  return Array.from(foundMap.values());
}

export function getDeviceIp() {
  if (!Network) return Promise.resolve(null);
  return Network.getIpAddressAsync();
}