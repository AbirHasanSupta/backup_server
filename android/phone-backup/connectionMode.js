import { DeviceEventEmitter } from 'react-native';
import { getServerIp, getServerPort, formatHostForUrl } from './settings';
import { setP2PEnabled } from './p2pSettings';
import { startP2PServer, stopP2PServer, reconcileP2PMediaWithServer } from './p2pServer';

// In-memory reachability cache
let _serverAvailable = null; // null = unknown, true = reachable, false = offline
let _lastCheckTime = 0;
let _isChecking = false;
const CACHE_TTL_MS = 10_000; // 10 seconds cache validity

/**
 * Returns true if the central desktop backup server is currently reachable.
 * If cached recently, returns cached value immediately. Otherwise does a fast ping probe.
 *
 * @param {{ force?: boolean, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function isServerAvailable(options = {}) {
  const now = Date.now();
  if (!options.force && _serverAvailable !== null && now - _lastCheckTime < CACHE_TTL_MS) {
    return _serverAvailable;
  }
  return await checkServerReachable(options);
}

/**
 * Returns true if the app is currently operating in Server Mode.
 * Returns false if the app is operating in P2P Mode.
 * Either Server or P2P is active — never both at the same time.
 *
 * @returns {Promise<boolean>}
 */
export async function isServerMode() {
  const ip = await getServerIp();
  if (!ip || ip.trim() === '') {
    if (_serverAvailable !== false) {
      await setServerAvailable(false, { silent: true });
    }
    return false;
  }
  return await isServerAvailable();
}

/**
 * Returns true if the app is currently operating in P2P Mode.
 *
 * @returns {Promise<boolean>}
 */
export async function isP2PMode() {
  return !(await isServerMode());
}

/**
 * Fast probe to test if the desktop server is responsive.
 * Uses a strict, lightweight timeout (default 1500ms) with zero mesh sweeping.
 *
 * @param {{ timeoutMs?: number, force?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function checkServerReachable(options = {}) {
  if (_isChecking && !options.force && _serverAvailable !== null) {
    return _serverAvailable;
  }

  const ip = await getServerIp();
  if (!ip || ip.trim() === '') {
    await setServerAvailable(false);
    return false;
  }

  const timeoutMs = options.timeoutMs || 1500;
  const port = await getServerPort();
  const host = formatHostForUrl(ip);

  _isChecking = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`http://${host}:${port}/ping`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);
    _isChecking = false;

    const reachable = res.ok;
    await setServerAvailable(reachable);
    return reachable;
  } catch (_err) {
    clearTimeout(timer);
    _isChecking = false;
    await setServerAvailable(false);
    return false;
  }
}

/**
 * Explicitly sets server availability and strictly enforces mutual exclusivity:
 *
 * 1. Server AVAILABLE -> Server Mode is active.
 *    - P2P daemon is STOPPED.
 *    - P2P mode is DISABLED.
 *
 * 2. Server UNAVAILABLE -> P2P Mode is active.
 *    - P2P daemon is STARTED.
 *    - P2P mode is ENABLED.
 *
 * @param {boolean} available
 * @param {{ silent?: boolean }} [options]
 */
export async function setServerAvailable(available, options = {}) {
  const nextAvailable = Boolean(available);
  const prevAvailable = _serverAvailable;

  _serverAvailable = nextAvailable;
  _lastCheckTime = Date.now();

  try {
    if (nextAvailable) {
      // Server available: disable P2P daemon and mode
      await setP2PEnabled(false);
      await stopP2PServer().catch(() => {});
      if (prevAvailable === false) {
        // Reconcile any P2P media captured while in offline P2P mode
        reconcileP2PMediaWithServer().catch(() => {});
      }
    } else {
      // Server offline: enable P2P daemon and mode
      await setP2PEnabled(true);
      await startP2PServer().catch(() => {});
    }
  } catch (err) {
    console.warn('[ConnectionMode] Error toggling P2P daemon:', err?.message);
  }

  if (prevAvailable !== nextAvailable && !options.silent) {
    DeviceEventEmitter.emit('app_mode_changed', {
      mode: nextAvailable ? 'server' : 'p2p',
      serverAvailable: nextAvailable,
      timestamp: Date.now(),
    });
  }
}

/**
 * Initializes the connection mode on app launch.
 */
export async function initConnectionMode() {
  return await checkServerReachable({ timeoutMs: 1500, force: true });
}
