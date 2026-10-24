import { NativeModules, DeviceEventEmitter } from 'react-native';
import { formatHostForUrl, parseServerAddress, isLocalLanSubnet } from './settings';
import {
  getP2PPort,
  getPairedPeers,
  getLocalPeerIdentity,
  updatePeerLastSeen,
} from './p2pSettings';
import { getDeviceIp } from './serverDiscovery';
import { syncFeedWithPeer } from './p2pClient';

const PROBE_TIMEOUT_MS = 1200;
const SWEEP_TIMEOUT_MS = 800;
const BATCH_SIZE = 25;

let Network = null;
try {
  Network = require('expo-network');
} catch (_e) {
  console.warn('[P2PDiscovery] Native module "ExpoNetwork" not available');
}

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

function extractSubnet(ip) {
  const parsed = parseServerAddress(ip);
  const parts = String(parsed.host || '').split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : null;
}

/**
 * Probes a candidate IP/port to see if another phone is listening with the P2P server daemon.
 *
 * @param {string} ip Candidate IP address
 * @param {number} port Candidate P2P port
 * @param {string} localDeviceId ID of the current device to prevent self-discovery
 * @param {Array<any>} pairedPeers List of currently paired peer devices
 * @param {number} [timeoutMs=PROBE_TIMEOUT_MS]
 * @returns {Promise<{peerId: string, deviceName: string, username: string, ip: string, port: number, isPaired: boolean, protocolVersion: number} | null>}
 */
export async function probePeer(ip, port, localDeviceId, pairedPeers = [], timeoutMs = PROBE_TIMEOUT_MS) {
  if (!ip) return null;
  const parsed = parseServerAddress(ip, port);
  const host = parsed.host;
  if (!host) return null;
  const targetHost = formatHostForUrl(host);
  const targetPort = parsed.port || port;

  const data = await fetchWithTimeout(`http://${targetHost}:${targetPort}/p2p/ping`, timeoutMs);
  if (!data) return null;

  // Verify that it is a phone-backup P2P peer
  const isP2PService = data.service === 'phone-backup-p2p' || (data.status === 'ok' && data.device_id && data.p2p_port);
  if (!isP2PService) return null;

  const peerId = data.device_id;
  // Ignore self-probes
  if (localDeviceId && peerId === localDeviceId) {
    return null;
  }

  const isPaired = pairedPeers.some((p) => p.peerId === peerId);
  if (isPaired) {
    updatePeerLastSeen(peerId, host, targetPort).catch(() => {});
    syncFeedWithPeer(host, targetPort).catch(() => {});
  }

  return {
    peerId,
    deviceName: (data.device_name && String(data.device_name).trim()) || 'Nearby Peer',
    username: (data.username && String(data.username).trim()) || '',
    ip: host,
    port: targetPort,
    isPaired,
    protocolVersion: data.protocol_version || 1,
  };
}

/**
 * Builds prioritized waves of target IPs for peer discovery on the local Wi-Fi.
 */
export function buildP2PSubnetWaves(deviceIp, pairedPeers = []) {
  const seen = new Set();
  if (deviceIp) {
    const selfParsed = parseServerAddress(deviceIp);
    if (selfParsed.host) seen.add(selfParsed.host);
  }
  const waves = {
    wave1: [], // Known paired peers + gateway
    wave2: [], // Primary local Wi-Fi subnet sweep
  };

  const add = (waveKey, rawIp) => {
    if (!rawIp) return;
    const parsed = parseServerAddress(rawIp);
    const cleanIp = parsed.host;
    if (cleanIp && !seen.has(cleanIp)) {
      seen.add(cleanIp);
      waves[waveKey].push(cleanIp);
    }
  };

  const primarySubnet = extractSubnet(deviceIp);

  // 1. Wave 1: Previously known/paired peer IPs
  pairedPeers.forEach((p) => {
    if (p.ip) add('wave1', p.ip);
  });

  // Local gateway
  if (primarySubnet && isLocalLanSubnet(`${primarySubnet}.1`)) {
    add('wave1', `${primarySubnet}.1`);
  }

  // 2. Wave 2: Full host sweep of primary subnet
  if (primarySubnet) {
    // Probe common mobile DHCP ranges first (.100-.150, .2-.99, .151-.254)
    for (let i = 100; i <= 150; i++) add('wave2', `${primarySubnet}.${i}`);
    for (let i = 2; i <= 99; i++) add('wave2', `${primarySubnet}.${i}`);
    for (let i = 151; i <= 254; i++) add('wave2', `${primarySubnet}.${i}`);
  }

  return waves;
}

/**
 * Scans the local Wi-Fi network for nearby peer phones.
 *
 * @param {(progress: number, found: Array) => void} [onProgress]
 * @param {{ shouldStop?: () => boolean, signal?: AbortSignal, p2pPort?: number }} [options]
 * @returns {Promise<Array<{peerId: string, deviceName: string, username: string, ip: string, port: number, isPaired: boolean}>>}
 */
export async function discoverPeers(onProgress, options = {}) {
  if (!Network) {
    throw new Error('Network scanning requires native Network module.');
  }

  const state = await Network.getNetworkStateAsync();
  if (!state.isConnected) {
    throw new Error('Not connected to a local Wi-Fi network');
  }

  const [deviceIp, defaultPort, pairedPeers, localIdentity] = await Promise.all([
    getDeviceIp(),
    getP2PPort(),
    getPairedPeers(),
    getLocalPeerIdentity(),
  ]);

  if (!deviceIp || deviceIp === '0.0.0.0') {
    throw new Error('Could not determine local device Wi-Fi IP address');
  }

  // Phase 0: Broadcast UDP beacon on port 8822 for instant peer response
  const P2PServerModule = NativeModules.PhoneBackupP2PServer;
  if (P2PServerModule?.broadcastUdpBeacon) {
    P2PServerModule.broadcastUdpBeacon().catch(() => {});
  }

  const targetPort = options.p2pPort || defaultPort;
  const waves = buildP2PSubnetWaves(deviceIp, pairedPeers);
  const total = waves.wave1.length + waves.wave2.length;
  const foundMap = new Map();
  let scanned = 0;

  const processResults = (results) => {
    results.forEach((peer) => {
      if (peer && peer.peerId) {
        foundMap.set(peer.peerId, peer);
      }
    });
    const currentList = Array.from(foundMap.values());
    DeviceEventEmitter.emit('p2p-peers-discovered', currentList);
    const progressPct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 100;
    onProgress && onProgress(progressPct, currentList);
  };

  // Phase 1: Wave 1 (known paired peers)
  if (waves.wave1.length > 0) {
    const wave1Results = await Promise.all(
      waves.wave1.map((ip) => probePeer(ip, targetPort, localIdentity.deviceId, pairedPeers, PROBE_TIMEOUT_MS))
    );
    scanned += waves.wave1.length;
    processResults(wave1Results);
  }

  // Phase 2: Wave 2 (subnet sweep)
  for (let i = 0; i < waves.wave2.length; i += BATCH_SIZE) {
    if (options.shouldStop?.() || options.signal?.aborted) break;
    const batch = waves.wave2.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((ip) => probePeer(ip, targetPort, localIdentity.deviceId, pairedPeers, SWEEP_TIMEOUT_MS))
    );
    if (options.shouldStop?.() || options.signal?.aborted) break;

    scanned += batch.length;
    processResults(results);
  }

  const finalPeers = Array.from(foundMap.values());
  DeviceEventEmitter.emit('p2p-peers-discovered', finalPeers);
  return finalPeers;
}
