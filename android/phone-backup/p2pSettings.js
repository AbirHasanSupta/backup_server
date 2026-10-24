import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { getDeviceId, getUsername } from './settings';

let Device = null;
try {
  Device = require('expo-device');
} catch (_e) {
  // Graceful fallback for non-native environments
}

const P2P_KEYS = {
  P2P_ENABLED: 'p2p_enabled_v1',
  P2P_PORT: 'p2p_port_v1',
  P2P_PAIRED_PEERS: 'p2p_paired_peers_v1',
  P2P_SECRET: 'p2p_device_secret_v1',
  P2P_LOCAL_FEED: 'p2p_local_feed_v1',
};

const DEFAULT_P2P_PORT = 8088;
const PROTOCOL_VERSION = 1;

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseStoredInteger(raw, fallback) {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function generateRandomHex(length = 32) {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ─── P2P Enablement ─────────────────────────────────────────────────────────

export async function isP2PEnabled() {
  const val = await AsyncStorage.getItem(P2P_KEYS.P2P_ENABLED);
  // Default to enabled (true) if not set
  return val === null ? true : val === 'true';
}

export async function setP2PEnabled(enabled) {
  await AsyncStorage.setItem(P2P_KEYS.P2P_ENABLED, enabled ? 'true' : 'false');
  DeviceEventEmitter.emit('p2p-settings-updated', { p2pEnabled: enabled });
}

// ─── P2P Port ───────────────────────────────────────────────────────────────

export async function getP2PPort() {
  const port = parseStoredInteger(
    await AsyncStorage.getItem(P2P_KEYS.P2P_PORT),
    DEFAULT_P2P_PORT
  );
  return port >= 1024 && port <= 65535 ? port : DEFAULT_P2P_PORT;
}

export async function setP2PPort(port) {
  const targetPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_P2P_PORT;
  await AsyncStorage.setItem(P2P_KEYS.P2P_PORT, String(targetPort));
  DeviceEventEmitter.emit('p2p-settings-updated', { p2pPort: targetPort });
}

// ─── Device Secret ──────────────────────────────────────────────────────────

export async function getP2PDeviceSecret() {
  let secret = await AsyncStorage.getItem(P2P_KEYS.P2P_SECRET);
  if (!secret) {
    secret = generateRandomHex(32);
    await AsyncStorage.setItem(P2P_KEYS.P2P_SECRET, secret);
  }
  return secret;
}

// ─── Local Peer Identity ────────────────────────────────────────────────────

export async function getLocalPeerIdentity() {
  const [deviceId, username, port, enabled] = await Promise.all([
    getDeviceId(),
    getUsername(),
    getP2PPort(),
    isP2PEnabled(),
  ]);

  const deviceName =
    Device?.deviceName ||
    Device?.modelName ||
    'Android Device';

  const deviceModel = Device?.modelName || null;

  return {
    deviceId,
    deviceName,
    deviceModel,
    username: username || '',
    port,
    p2pEnabled: enabled,
    protocolVersion: PROTOCOL_VERSION,
  };
}

// ─── Paired Peers Management ────────────────────────────────────────────────

/**
 * Returns list of securely paired peer devices.
 * @returns {Promise<Array<{peerId: string, deviceName: string, username: string, ip: string, port: number, pairedAt: number, lastSeen: number, authSecret?: string}>>}
 */
export async function getPairedPeers() {
  const raw = await AsyncStorage.getItem(P2P_KEYS.P2P_PAIRED_PEERS);
  const peers = safeJsonParse(raw, []);
  return Array.isArray(peers) ? peers : [];
}

/**
 * Saves or updates a paired peer device.
 */
export async function savePairedPeer(peer) {
  if (!peer || !peer.peerId) return [];
  const peers = await getPairedPeers();
  const existingIdx = peers.findIndex((p) => p.peerId === peer.peerId);

  const updatedPeer = {
    peerId: peer.peerId,
    deviceName: (peer.deviceName || '').trim() || 'Nearby Peer',
    username: (peer.username || '').trim(),
    ip: (peer.ip || '').trim(),
    port: peer.port || DEFAULT_P2P_PORT,
    authSecret: peer.authSecret || (existingIdx >= 0 ? peers[existingIdx].authSecret : '') || '',
    pairedAt: peer.pairedAt || (existingIdx >= 0 ? peers[existingIdx].pairedAt : Date.now()),
    lastSeen: peer.lastSeen || Date.now(),
  };

  if (existingIdx >= 0) {
    peers[existingIdx] = { ...peers[existingIdx], ...updatedPeer, lastSeen: Date.now() };
  } else {
    peers.push(updatedPeer);
  }

  await AsyncStorage.setItem(P2P_KEYS.P2P_PAIRED_PEERS, JSON.stringify(peers));
  DeviceEventEmitter.emit('p2p-peers-updated', peers);
  return peers;
}

/**
 * Removes a paired peer.
 */
export async function removePairedPeer(peerId) {
  const peers = await getPairedPeers();
  const filtered = peers.filter((p) => p.peerId !== peerId);
  await AsyncStorage.setItem(P2P_KEYS.P2P_PAIRED_PEERS, JSON.stringify(filtered));
  DeviceEventEmitter.emit('p2p-peers-updated', filtered);
  return filtered;
}

/**
 * Updates a peer's network address and last-seen timestamp upon successful contact.
 */
export async function updatePeerLastSeen(peerId, ip, port) {
  const peers = await getPairedPeers();
  const existing = peers.find((p) => (peerId && p.peerId === peerId) || (ip && p.ip === ip));
  if (existing) {
    existing.lastSeen = Date.now();
    if (ip) existing.ip = ip;
    if (port) existing.port = port;
    await AsyncStorage.setItem(P2P_KEYS.P2P_PAIRED_PEERS, JSON.stringify(peers));
    DeviceEventEmitter.emit('p2p-peers-updated', peers);
  }
}

// ─── Local P2P Feed & Storage ───────────────────────────────────────────────

/**
 * Get locally cached peer shares received over direct P2P.
 * @returns {Promise<Array<any>>}
 */
export async function getLocalP2PFeed() {
  const raw = await AsyncStorage.getItem(P2P_KEYS.P2P_LOCAL_FEED);
  const items = safeJsonParse(raw, []);
  return Array.isArray(items) ? items : [];
}

/**
 * Appends or updates a feed item received from a peer.
 */
export async function saveP2PFeedItem(feedItem) {
  if (!feedItem || !feedItem.id) return [];
  const feed = await getLocalP2PFeed();
  const existingIdx = feed.findIndex((item) => item.id === feedItem.id);

  if (existingIdx >= 0) {
    feed[existingIdx] = { ...feed[existingIdx], ...feedItem };
  } else {
    // Newest first
    feed.unshift({ ...feedItem, receivedAt: Date.now() });
  }

  // Keep up to 200 recent P2P posts locally
  const trimmed = feed.slice(0, 200);
  await AsyncStorage.setItem(P2P_KEYS.P2P_LOCAL_FEED, JSON.stringify(trimmed));
  DeviceEventEmitter.emit('p2p-feed-updated', trimmed);
  return trimmed;
}

/**
 * Removes a P2P feed item by ID.
 */
export async function removeP2PFeedItem(feedItemId) {
  const feed = await getLocalP2PFeed();
  const idStr = String(feedItemId);
  const filtered = feed.filter((item) => item.id !== idStr && String(item.group_id) !== idStr);
  await AsyncStorage.setItem(P2P_KEYS.P2P_LOCAL_FEED, JSON.stringify(filtered));
  DeviceEventEmitter.emit('p2p-feed-updated', filtered);
  return filtered;
}

export const deleteP2PFeedItem = removeP2PFeedItem;
