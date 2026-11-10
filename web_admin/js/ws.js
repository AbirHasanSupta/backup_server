/**
 * ws.js — WebSocket manager for real-time server events.
 *
 * Connects to /ws/admin-panel with the API key as query param.
 * Dispatches custom DOM events that any module can listen to.
 *
 * Events dispatched on `window`:
 *   - ws:log         { message, time }
 *   - ws:upload      { device_id, filename, progress, done }
 *   - ws:new_share   { group_id, caption, shared_by, target_device_ids }
 *   - ws:reaction    { media_id, reaction, device_id }
 *   - ws:comment     { media_id, comment, device_id }
 *   - ws:typing      { media_id, device_id, username, is_typing }
 *   - ws:pairing_approved { device_id, token }
 *   - ws:connected
 *   - ws:disconnected
 */

import { getApiKey } from './api.js';

const WS_CLIENT_ID = 'admin-panel';
let _ws = null;
let _reconnectTimer = null;
let _intentionalClose = false;
const RECONNECT_DELAY_MS = 3000;

function dispatch(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

  const key = getApiKey();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/${WS_CLIENT_ID}?token=${encodeURIComponent(key)}`;

  _ws = new WebSocket(url);

  _ws.onopen = () => {
    _intentionalClose = false;
    dispatch('ws:connected');
    _startPing();
  };

  _ws.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch (_) { return; }
    const event = data.event || data.type || '';
    switch (event) {
      case 'log':
        dispatch('ws:log', { message: data.message, time: data.timestamp || Date.now() / 1000 });
        break;
      case 'upload_progress':
        dispatch('ws:upload', {
          device_id: data.device_id,
          filename: data.filename,
          progress: data.progress,
          done: data.done,
        });
        break;
      case 'new_share':
        dispatch('ws:new_share', {
          group_id: data.group_id,
          caption: data.caption,
          shared_by: data.shared_by,
          shared_by_device_id: data.shared_by_device_id,
          target_device_ids: data.target_device_ids || [],
          post_kind: data.post_kind,
        });
        break;
      case 'new_reaction':
        dispatch('ws:reaction', {
          media_id: data.media_id,
          reaction: data.reaction,
          device_id: data.device_id,
          counts: data.counts,
        });
        break;
      case 'new_comment':
        dispatch('ws:comment', {
          media_id: data.media_id,
          comment: data.comment,
          device_id: data.device_id,
        });
        break;
      case 'typing':
        dispatch('ws:typing', {
          media_id: data.media_id,
          device_id: data.device_id,
          username: data.username,
          is_typing: data.is_typing,
        });
        break;
      case 'pairing_approved':
        dispatch('ws:pairing_approved', { device_id: data.device_id, token: data.token });
        break;
      case 'pong':
        break;
      default:
        // Forward as generic event for other consumers
        if (event) dispatch(`ws:${event}`, data);
    }
  };

  _ws.onerror = () => {};

  _ws.onclose = () => {
    dispatch('ws:disconnected');
    _ws = null;
    if (!_intentionalClose) {
      _reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  };
}

let _pingInterval = null;
function _startPing() {
  clearInterval(_pingInterval);
  _pingInterval = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ action: 'ping' }));
    }
  }, 25000);
}

export function wsConnect() {
  _intentionalClose = false;
  connect();
}

export function wsDisconnect() {
  _intentionalClose = true;
  clearTimeout(_reconnectTimer);
  clearInterval(_pingInterval);
  if (_ws) { _ws.close(); _ws = null; }
}

export function wsIsConnected() {
  return _ws && _ws.readyState === WebSocket.OPEN;
}
