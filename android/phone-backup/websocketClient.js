import { DeviceEventEmitter } from 'react-native';
import {
  getServerIp,
  getServerPort,
  getDeviceId,
  getDeviceToken,
  getApiKey,
  setDeviceToken,
  formatHostForUrl,
} from './settings';

/**
 * websocketClient.js — Real-Time WebSocket Gateway Client.
 *
 * Provides bidirectional live event streaming with the backup server:
 * - Immediate pairing approval notifications
 * - Live upload & sync progress updates
 * - Instant new share post, reaction, and comment alerts
 * - Video preview and rewind reel readiness signals
 *
 * Eliminates aggressive 3-second HTTP polling while retaining seamless
 * reconnection and graceful fallback.
 */

let _socket = null;
let _pingInterval = null;
let _reconnectTimeout = null;
let _reconnectAttempts = 0;
let _isConnecting = false;
let _manuallyClosed = false;

const _listeners = new Map();

export function onWebSocketEvent(event, callback) {
  if (!_listeners.has(event)) {
    _listeners.set(event, new Set());
  }
  _listeners.get(event).add(callback);
  return () => offWebSocketEvent(event, callback);
}

export function offWebSocketEvent(event, callback) {
  if (_listeners.has(event)) {
    _listeners.get(event).delete(callback);
    if (_listeners.get(event).size === 0) {
      _listeners.delete(event);
    }
  }
}

function _emitEvent(event, data) {
  // 1. Direct callback listeners
  if (_listeners.has(event)) {
    _listeners.get(event).forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.warn(`[WebSocket] Listener error for event '${event}':`, err);
      }
    });
  }
  if (_listeners.has('*')) {
    _listeners.get('*').forEach((cb) => {
      try {
        cb(event, data);
      } catch (err) {
        console.warn(`[WebSocket] Wildcard listener error:`, err);
      }
    });
  }

  // 2. React Native DeviceEventEmitter for app-wide reactive state updates
  try {
    DeviceEventEmitter.emit(`ws_${event}`, data);
    DeviceEventEmitter.emit('ws_event', { event, data });
  } catch {}
}

export function isWebSocketConnected() {
  return _socket !== null && _socket.readyState === WebSocket.OPEN;
}

export function sendWebSocketMessage(action, payload = {}) {
  if (isWebSocketConnected()) {
    try {
      _socket.send(JSON.stringify({ action, payload }));
      return true;
    } catch (err) {
      console.warn('[WebSocket] Send failed:', err);
      return false;
    }
  }
  return false;
}

export function sendTypingStatus(mediaId, isTyping = true, username = null) {
  return sendWebSocketMessage('typing', {
    media_id: mediaId,
    is_typing: !!isTyping,
    username,
  });
}

export function sendReadReceipt(mediaId) {
  return sendWebSocketMessage('read_receipt', {
    media_id: mediaId,
    read_at: Math.floor(Date.now() / 1000),
  });
}

export async function connectWebSocket() {
  if (_socket && (_socket.readyState === WebSocket.OPEN || _socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (_isConnecting) return;

  _manuallyClosed = false;
  _isConnecting = true;

  try {
    const [rawIp, port, deviceId, deviceToken, apiKey] = await Promise.all([
      getServerIp(),
      getServerPort(),
      getDeviceId(),
      getDeviceToken(),
      getApiKey(),
    ]);

    if (!rawIp || !port || !deviceId) {
      _isConnecting = false;
      return;
    }

    const host = formatHostForUrl(rawIp);
    const wsUrl = `ws://${host}:${port}/ws/${encodeURIComponent(deviceId)}`;

    console.log(`[WebSocket] Connecting to ${wsUrl} (client: ${deviceId})...`);
    // React Native supports custom WebSocket headers.  Keep credentials out
    // of the URL so they are not retained in proxy/access logs.
    const ws = new WebSocket(wsUrl, [], {
      headers: { Authorization: `Bearer ${deviceToken || apiKey}` },
    });

    ws.onopen = () => {
      console.log(`[WebSocket] Connected successfully to ${host}:${port}`);
      _socket = ws;
      _isConnecting = false;
      _reconnectAttempts = 0;
      _emitEvent('connected', { host, port, deviceId });

      // Start keepalive heartbeat ping every 25 seconds
      if (_pingInterval) clearInterval(_pingInterval);
      _pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ action: 'ping' }));
          } catch {}
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const eventType = payload.event;
        const data = payload.data || payload;

        if (eventType === 'pong') return;

        // Built-in event handling
        if (eventType === 'pairing_approved' && data.token) {
          setDeviceToken(data.token).catch(() => {});
          DeviceEventEmitter.emit('device_pairing_approved', data);
        } else if (eventType === 'sync_progress') {
          DeviceEventEmitter.emit('sync_progress', data);
        } else if (eventType === 'new_share' || eventType === 'new_post') {
          DeviceEventEmitter.emit('feed_updated', data);
        } else if (eventType === 'new_reaction' || eventType === 'new_comment') {
          DeviceEventEmitter.emit('social_updated', data);
        } else if (eventType === 'file_uploaded') {
          DeviceEventEmitter.emit('file_uploaded', data);
        } else if (eventType === 'typing_status') {
          DeviceEventEmitter.emit('typing_status', data);
        } else if (eventType === 'read_receipt') {
          DeviceEventEmitter.emit('read_receipt', data);
        }

        _emitEvent(eventType || 'message', data);
      } catch (parseErr) {
        // Non-JSON message
        _emitEvent('raw_message', event.data);
      }
    };

    ws.onerror = (err) => {
      console.warn('[WebSocket] Socket encountered error:', err?.message || err);
      _emitEvent('error', err);
    };

    ws.onclose = (event) => {
      console.log(`[WebSocket] Closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
      _cleanup();
      _emitEvent('disconnected', { code: event.code });

      if (!_manuallyClosed) {
        _scheduleReconnect();
      }
    };
  } catch (err) {
    console.warn('[WebSocket] Setup exception:', err);
    _cleanup();
    if (!_manuallyClosed) {
      _scheduleReconnect();
    }
  }
}

function _cleanup() {
  _isConnecting = false;
  if (_pingInterval) {
    clearInterval(_pingInterval);
    _pingInterval = null;
  }
  _socket = null;
}

function _scheduleReconnect() {
  if (_reconnectTimeout) clearTimeout(_reconnectTimeout);
  _reconnectAttempts++;
  // Exponential backoff: 1s, 2s, 4s, 8s, max 15s
  const delay = Math.min(15000, Math.pow(2, _reconnectAttempts - 1) * 1000);
  console.log(`[WebSocket] Scheduling reconnect attempt #${_reconnectAttempts} in ${delay}ms...`);
  _reconnectTimeout = setTimeout(() => {
    connectWebSocket();
  }, delay);
}

export function disconnectWebSocket() {
  _manuallyClosed = true;
  if (_reconnectTimeout) {
    clearTimeout(_reconnectTimeout);
    _reconnectTimeout = null;
  }
  if (_socket) {
    try {
      _socket.close();
    } catch {}
  }
  _cleanup();
}
