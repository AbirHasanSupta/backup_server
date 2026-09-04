import { getServerPort, getSavedServers } from './settings';

const TIMEOUT_MS = 1200;
const BATCH_SIZE = 45;

// Common mesh node & router subnets across various manufacturers:
// TP-Link Deco = 192.168.68.x, Google Nest = 192.168.86.x, Asus = 192.168.50.x,
// Xiaomi = 192.168.31.x, Huawei/ZTE = 192.168.100.x, Tenda/Mercusys = 192.168.4.x / 192.168.10.x, etc.
const COMMON_MESH_SUBNETS = [
  '192.168.0',
  '192.168.1',
  '192.168.10',
  '192.168.2',
  '192.168.68',
  '192.168.86',
  '192.168.50',
  '192.168.31',
  '192.168.100',
  '192.168.4',
  '192.168.11',
  '192.168.8',
  '192.168.12',
  '192.168.20',
  '192.168.88',
  '192.168.178',
  '192.168.254',
  '172.16.0',
  '172.20.0',
  '172.31.0',
  '10.0.0',
  '10.0.1',
  '10.0.2',
  '10.1.1',
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

function isNumericIp(str) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(str || '') || /^\[?[a-fA-F0-9:]+\]?$/.test(str || '');
}

function extractSubnet(ip) {
  const parts = String(ip || '').replace(/^https?:\/\//i, '').replace(/:\d+$/, '').trim().split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : null;
}

async function probeServer(ip, port, timeoutMs = TIMEOUT_MS) {
  const data = await fetchWithTimeout(`http://${ip}:${port}/ping`, timeoutMs);
  if (data && data.status === 'ok') {
    const allIps = Array.isArray(data.all_ips) && data.all_ips.length > 0 ? data.all_ips : [ip];
    return {
      serverId: data.server_id || '',
      ip,
      port,
      name: (data.name && String(data.name).trim()) || ip,
      hostname: data.hostname || '',
      version: data.version || '?',
      certFingerprint: data.cert_fingerprint || '',
      all_ips: allIps,
      candidateIps: Array.from(new Set([ip, ...allIps].filter(Boolean))),
    };
  }
  return null;
}

/**
 * Builds prioritized waves of target IPs to discover servers across mesh nodes and multi-subnets.
 */
export function buildMultiSubnetIps(deviceIp, savedServers = []) {
  const seen = new Set();
  const waves = {
    wave1: [], // Exact saved IPs, candidate IPs, hostnames, and known gateways (.1)
    wave2: [], // Primary subnet and saved server subnets (full sweeps)
    wave3: [], // Common secondary mesh subnets
  };

  const add = (waveKey, rawIp) => {
    if (!rawIp) return;
    const cleanIp = String(rawIp).replace(/^https?:\/\//i, '').replace(/:\d+$/, '').trim();
    if (cleanIp && !seen.has(cleanIp)) {
      seen.add(cleanIp);
      waves[waveKey].push(cleanIp);
    }
  };

  const primarySubnet = extractSubnet(deviceIp);
  const knownSubnets = new Set();
  if (primarySubnet) knownSubnets.add(primarySubnet);

  // 1. Wave 1: Saved server profiles & known candidate IPs
  savedServers.forEach((s) => {
    if (s.ip) {
      add('wave1', s.ip);
      const sub = extractSubnet(s.ip);
      if (sub) knownSubnets.add(sub);
    }
    if (Array.isArray(s.candidateIps)) {
      s.candidateIps.forEach((cip) => {
        add('wave1', cip);
        const sub = extractSubnet(cip);
        if (sub) knownSubnets.add(sub);
      });
    }
    if (s.hostname) {
      add('wave1', s.hostname);
      if (!s.hostname.endsWith('.local')) add('wave1', `${s.hostname}.local`);
    }
  });

  // Gateways for all known subnets in wave 1
  knownSubnets.forEach((sub) => {
    add('wave1', `${sub}.1`);
  });

  // 2. Wave 2: Full host sweeps of primary subnet and saved server subnets
  knownSubnets.forEach((sub) => {
    // Probe common host ranges first (.100-.150, .2-.99, .151-.254)
    for (let i = 100; i <= 150; i++) add('wave2', `${sub}.${i}`);
    for (let i = 2; i <= 99; i++) add('wave2', `${sub}.${i}`);
    for (let i = 151; i <= 254; i++) add('wave2', `${sub}.${i}`);
  });

  // 3. Wave 3: Secondary Mesh Node Subnets
  for (const subnet of COMMON_MESH_SUBNETS) {
    if (!knownSubnets.has(subnet)) {
      add('wave3', `${subnet}.1`);
      for (let i = 100; i <= 150; i++) add('wave3', `${subnet}.${i}`);
      add('wave3', `${subnet}.200`);
      for (let i = 2; i <= 99; i++) add('wave3', `${subnet}.${i}`);
      for (let i = 151; i <= 254; i++) add('wave3', `${subnet}.${i}`);
    }
  }

  return [...waves.wave1, ...waves.wave2, ...waves.wave3];
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Scans the local network (including across mesh nodes and multi-subnets) for backup servers.
 *
 * @param {(progress: number, found: Array) => void} onProgress
 * @param {{ shouldStop?: () => boolean, signal?: AbortSignal, maxSubnets?: number }} [options]
 * @returns {Promise<Array<{serverId, ip, port, name, version, all_ips, candidateIps}>>}
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
  const foundMap = new Map();
  let scanned = 0;
  const total = ips.length;

  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    if (options.shouldStop?.() || options.signal?.aborted) break;
    const batch = ips.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((ip) => probeServer(ip, port)));
    if (options.shouldStop?.() || options.signal?.aborted) break;

    results.forEach((r) => {
      if (r) {
        let existingKey = null;
        for (const [k, existing] of foundMap.entries()) {
          // If both have serverIds and they differ, they are definitely different machines
          if (r.serverId && existing.serverId && r.serverId !== existing.serverId) {
            continue;
          }

          const sameServerId = r.serverId && existing.serverId && r.serverId === existing.serverId;
          const sameHostname = r.hostname && existing.hostname && r.hostname.toLowerCase() === existing.hostname.toLowerCase() && r.port === existing.port;
          const sameName = r.name && existing.name && r.name.toLowerCase() === existing.name.toLowerCase() && r.port === existing.port;
          const overlappingIps = (r.candidateIps || []).some(
            (cip) => cip && (existing.ip === cip || (existing.candidateIps || []).includes(cip))
          ) && r.port === existing.port;

          if (sameServerId || sameHostname || sameName || overlappingIps) {
            existingKey = k;
            break;
          }
        }

        if (existingKey) {
          const existing = foundMap.get(existingKey);
          const mergedCandidates = Array.from(new Set([
            ...(existing.candidateIps || [existing.ip]),
            ...(r.candidateIps || [r.ip]),
          ].filter(Boolean)));

          // Prioritize the IP that actively responded in the current scan on this mesh node
          const chosenIp = r.ip || existing.ip;

          const resolvedName = (existing.name && !isNumericIp(existing.name) && existing.name !== existing.ip)
            ? existing.name
            : (r.name && !isNumericIp(r.name) && r.name !== r.ip ? r.name : (existing.name || r.name));

          const updated = {
            ...existing,
            ...r,
            ip: chosenIp,
            name: resolvedName,
            serverId: existing.serverId || r.serverId || '',
            hostname: existing.hostname || r.hostname || '',
            candidateIps: mergedCandidates,
          };
          foundMap.set(existingKey, updated);
        } else {
          const key = r.serverId ? `id:${r.serverId}:${r.port}` : (r.hostname ? `host:${r.hostname}:${r.port}` : `${r.name || r.ip}:${r.port}`);
          foundMap.set(key, r);
        }
      }
    });

    scanned += batch.length;
    const progressPct = Math.min(100, Math.round((scanned / total) * 100));
    onProgress && onProgress(progressPct, Array.from(foundMap.values()));
  }

  return Array.from(foundMap.values());
}

export function getDeviceIp() {
  if (!Network) return Promise.resolve(null);
  return Network.getIpAddressAsync();
}
