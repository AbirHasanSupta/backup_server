/**
 * app.js — Phone Backup Server Web Admin & Console Engine.
 * Complete 1:1 parity with desktop_app.py UI and features.
 *
 * IMPORTANT: All dynamic data (paths, captions, device IDs, URLs) is stored in
 * `data-*` attributes and looked up from in-memory arrays. NEVER interpolate
 * raw strings directly into onclick="..." attributes — Windows paths contain
 * backslashes, device names contain apostrophes, captions contain newlines,
 * all of which break HTML attribute parsing and cause silent JS errors.
 */

import { api, getApiKey, setApiKey, clearApiKey } from './api.js';
import { wsConnect, wsDisconnect, wsIsConnected } from './ws.js';

// ── Utility Formatting & Helpers ───────────────────────────────────────────────

export function fmtBytes(n) {
  n = Math.max(0, n || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtTs(ts) {
  if (!ts) return 'Never';
  return new Date(ts * 1000).toLocaleString();
}

export function fmtRel(ts) {
  if (!ts) return 'Never';
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 0) return 'Just now';
  if (secs < 60) return 'Just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 30) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function formatDuration(secs) {
  if (!secs && secs !== 0) return '—';
  secs = Math.round(secs);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

export function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

export function el(id) { return document.getElementById(id); }
export function qs(sel, ctx = document) { return ctx.querySelector(sel); }
export function qsa(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

window.el = el;
window.fmtBytes = fmtBytes;

// ── Theme Management ───────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('pb_theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'light') {
    html.classList.remove('dark');
    const icon = el('theme-icon');
    if (icon) icon.textContent = '☀️';
  } else {
    html.classList.add('dark');
    const icon = el('theme-icon');
    if (icon) icon.textContent = '🌙';
  }
  localStorage.setItem('pb_theme', theme);
}

window.toggleTheme = function() {
  const isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
};

// ── Uptime & Status Timer ──────────────────────────────────────────────────────

let _serverStartTime = Date.now() / 1000;
let _uptimeInterval = null;

function startUptimeTicker() {
  clearInterval(_uptimeInterval);
  _uptimeInterval = setInterval(() => {
    const elapsed = Math.floor(Date.now() / 1000 - _serverStartTime);
    const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    const upEl = el('uptime-display');
    if (upEl) upEl.textContent = `Uptime: ${hrs}:${mins}:${secs}`;
  }, 1000);
}

function updateStatusBar(online, host = '0.0.0.0', port = 8000) {
  const dot = el('status-dot');
  const lbl = el('status-label');
  const ep = el('sidebar-endpoint');
  const dashStatus = el('dash-status-pill');
  const proto = location.protocol;
  const hostName = location.hostname || '127.0.0.1';
  const displayPort = port || location.port || 8000;
  const url = `${proto}//${hostName}:${displayPort}`;

  if (ep) ep.textContent = url;
  window._primaryServerUrl = url;

  if (online) {
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
    if (lbl) lbl.textContent = 'Server Online';
    if (dashStatus) {
      dashStatus.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-semibold';
      dashStatus.textContent = 'Running';
    }
  } else {
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-red-400';
    if (lbl) lbl.textContent = 'Server Offline';
    if (dashStatus) {
      dashStatus.className = 'text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 font-semibold';
      dashStatus.textContent = 'Offline';
    }
  }
}

function updateWsBadge(connected) {
  const badge = el('ws-badge');
  if (!badge) return;
  badge.textContent = connected ? 'Live ●' : 'Offline ○';
  badge.className = connected
    ? 'text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-mono'
    : 'text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-700 text-zinc-400 font-mono';
}

window.copyServerUrl = function() {
  const url = window._primaryServerUrl || location.origin;
  navigator.clipboard.writeText(url).then(() => {
    showToast(`Copied ${url} to clipboard!`);
  }).catch(() => {
    showToast(`Server URL: ${url}`);
  });
};

window.restartServer = async function() {
  try {
    await api.post('/api/admin/server/restart');
    showToast('Server configuration reloaded.');
    loadDashboard();
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ── Tab Management ──────────────────────────────────────────────────────────────

const TABS = ['dashboard', 'devices', 'post_to_devices', 'posts', 'shared_folders', 'settings', 'logs', 'history'];
let _currentTab = null;

export function showTab(tabId) {
  if (!TABS.includes(tabId)) tabId = 'dashboard';
  _currentTab = tabId;

  // Update nav pills
  qsa('[data-tab]').forEach(btn => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('tab-active', active);
  });

  // Show/hide panels
  qsa('[data-panel]').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
  });

  // Load active tab data
  loadTab(tabId);
  location.hash = tabId;
}
window.showTab = showTab;

function loadTab(tabId) {
  switch (tabId) {
    case 'dashboard':       loadDashboard();       break;
    case 'devices':         loadDevices();         break;
    case 'post_to_devices': loadPostForm();        break;
    case 'posts':           loadPosts();           break;
    case 'shared_folders':  loadSharedFolders();   break;
    case 'settings':        loadSettings();        break;
    case 'logs':            loadLogs();            break;
    case 'history':         loadHistory();         break;
  }
}

// ── Authentication ──────────────────────────────────────────────────────────────

let _authenticated = false;

async function tryLogin(key) {
  setApiKey(key);
  try {
    const res = await api.get('/api/admin/status');
    _authenticated = true;
    _serverStartTime = Date.now() / 1000 - (res.uptime_seconds || 0);
    startUptimeTicker();

    el('login-modal').classList.add('hidden');
    el('app-shell').classList.remove('hidden');

    wsConnect();
    initWebSocketListeners();
    initPendingConnectionPoller();

    const initialTab = location.hash.slice(1) || 'dashboard';
    showTab(initialTab);
    return true;
  } catch (e) {
    clearApiKey();
    _authenticated = false;
    el('login-error').textContent = e.status === 403 || e.status === 401
      ? 'Invalid API key. Please check your credentials.'
      : `Connection error: ${e.message}`;
    return false;
  }
}

export function logout() {
  wsDisconnect();
  clearApiKey();
  _authenticated = false;
  el('app-shell').classList.add('hidden');
  el('login-modal').classList.remove('hidden');
  el('login-key-input').value = '';
  el('login-error').textContent = '';
}
window.logout = logout;

// ── 1. DASHBOARD ────────────────────────────────────────────────────────────────

let _dashInterval = null;
let _recentActivities = [];

async function loadDashboard() {
  clearInterval(_dashInterval);
  await refreshDashboard();
  _dashInterval = setInterval(refreshDashboard, 15000);
}

async function refreshDashboard() {
  if (_currentTab !== 'dashboard') { clearInterval(_dashInterval); return; }
  try {
    const [statusRes, devRes] = await Promise.all([
      api.get('/api/admin/status'),
      api.get('/api/admin/devices'),
    ]);

    updateStatusBar(statusRes.status === 'online', statusRes.host, statusRes.port);
    renderDashboard(statusRes, devRes.devices || []);
  } catch (e) {
    updateStatusBar(false);
  }
}

function renderDashboard(status, devices) {
  el('dash-version').textContent = `v${status.server_version || '2.1.0'}`;
  el('dash-hostport').textContent = `${status.host || '0.0.0.0'}:${status.port || 8000}`;
  el('dash-device-count').textContent = devices.length;
  el('dash-active-count').textContent = `${status.active_devices || 0} active now`;

  el('dash-storage-total').textContent = status.total_storage_formatted || fmtBytes(status.total_storage_bytes || 0);
  el('dash-files-total').textContent = `${(status.total_files || 0).toLocaleString()} files backed up`;

  const bRoot = status.backup_root || '—';
  window._currentBackupRoot = status.backup_root || '';
  el('dash-backup-root').textContent = bRoot;
  el('dash-backup-root').title = bRoot;

  // Render IP Chips — use data-url attribute instead of inline onclick string
  const ipContainer = el('dash-ip-chips');
  if (ipContainer) {
    const ips = status.all_ips || [];
    const port = status.port || 8000;
    const proto = location.protocol;
    if (!ips.length) {
      ipContainer.innerHTML = '<span class="text-xs text-zinc-500">No external IP addresses detected.</span>';
    } else {
      ipContainer.innerHTML = ips.map(ip => {
        const fullUrl = `${proto}//${ip}:${port}`;
        return `
        <div class="chip cursor-pointer" data-action="copy-url" data-url="${escHtml(fullUrl)}" title="Click to copy URL">
          <span>🌐</span>
          <span class="font-mono font-medium">${escHtml(ip)}:${port}</span>
          <span class="text-[10px] text-zinc-400">📋</span>
        </div>`;
      }).join('');
    }

    const ts = status.tailscale;
    if (ts && ts.ips && ts.ips.length) {
      const tsUrl = `${proto}//${ts.ips[0]}:${port}`;
      ipContainer.insertAdjacentHTML('beforeend', `
        <div class="chip border-blue-500/40 bg-blue-500/10 text-blue-300 cursor-pointer" data-action="copy-url" data-url="${escHtml(tsUrl)}" title="Tailscale MagicDNS / IP">
          <span>🔒 Tailscale:</span>
          <span class="font-mono">${escHtml(ts.ips[0])}:${port}</span>
        </div>`);
    }
  }

  // Recent Devices List
  const listEl = el('dash-device-list');
  if (listEl) {
    if (!devices.length) {
      listEl.innerHTML = '<div class="text-xs text-zinc-500 py-6 text-center">No paired devices. Connect a phone from the mobile app.</div>';
    } else {
      listEl.innerHTML = devices.slice(0, 6).map(d => {
        const name = escHtml(d.display_name || d.device_name || 'Device');
        const model = escHtml(d.device_model || '');
        const ip = escHtml(d.device_ip || '');
        const lastSeen = d.is_online ? '<span class="text-emerald-400 font-medium">Online now</span>' : fmtRel(d.last_seen);
        return `
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-800 transition">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs font-bold shrink-0">📱</div>
            <div class="min-w-0">
              <div class="text-xs font-semibold text-zinc-200 truncate">${name}</div>
              <div class="text-[11px] text-zinc-500 truncate">${model}${model && ip ? ' · ' : ''}${ip}</div>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-[11px]">${lastSeen}</div>
            <div class="text-[10px] text-zinc-500">${(d.total_files || 0).toLocaleString()} files · ${d.formatted_size}</div>
          </div>
        </div>`;
      }).join('');
    }
  }

  renderDashboardActivities();
}

function renderDashboardActivities() {
  const actEl = el('dash-activity-list');
  if (!actEl) return;
  if (!_recentActivities.length) {
    actEl.innerHTML = '<div class="text-xs text-zinc-500 py-6 text-center">Server idle. Waiting for device backups or share events.</div>';
    return;
  }
  actEl.innerHTML = _recentActivities.slice(0, 8).map(a => `
    <div class="flex items-center gap-2.5 text-xs py-1.5 px-2 rounded-lg bg-zinc-800/40">
      <span class="text-zinc-500 font-mono text-[11px] shrink-0">${new Date(a.time * 1000).toLocaleTimeString()}</span>
      <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ${a.badgeClass}">${a.badge}</span>
      <span class="text-zinc-300 truncate">${escHtml(a.text)}</span>
    </div>
  `).join('');
}

// ── 2. DEVICES ──────────────────────────────────────────────────────────────────

let _devices = [];

async function loadDevices() {
  const con = el('devices-content');
  if (con) con.innerHTML = loadingSpinner();
  try {
    const res = await api.get('/api/admin/devices');
    _devices = res.devices || [];
    renderDevices(_devices);
  } catch (e) {
    if (con) con.innerHTML = errorBanner(e.message);
  }
}

function renderDevices(devices) {
  const q = (el('devices-search')?.value || '').trim().toLowerCase();
  const filtered = q
    ? devices.filter(d =>
        (d.display_name || d.device_name || '').toLowerCase().includes(q) ||
        (d.device_model || '').toLowerCase().includes(q) ||
        (d.device_ip || '').toLowerCase().includes(q))
    : devices;

  const countBadge = el('devices-count-badge');
  if (countBadge) countBadge.textContent = `${filtered.length} device${filtered.length !== 1 ? 's' : ''}`;

  const con = el('devices-content');
  if (!con) return;

  if (!filtered.length) {
    con.innerHTML = emptyState('No devices found', q ? 'Try a different search query.' : 'Connect a mobile device from the app to begin backing up files.');
    return;
  }

  // Use data-device-id attribute — NO dynamic data inside onclick strings
  con.innerHTML = filtered.map(d => {
    const name = escHtml(d.display_name || d.device_name || 'Unknown Device');
    const model = escHtml(d.device_model || 'Mobile Device');
    const ip = escHtml(d.device_ip || '—');
    const did = escHtml(d.device_id);
    const isOnline = d.is_online;
    const onlineBadge = isOnline
      ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400">Online now</span>'
      : `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-400">${fmtRel(d.last_seen)}</span>`;

    const files = (d.total_files || 0).toLocaleString();
    const storage = d.formatted_size || fmtBytes(d.total_size || 0);

    return `
    <div class="card flex flex-col justify-between group" data-device-id="${did}">
      <div>
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-11 h-11 rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0 shadow-sm">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="font-bold text-sm text-zinc-100 truncate">${name}</span>
                <button data-action="rename-device" data-device-id="${did}" title="Edit username" class="text-zinc-400 hover:text-blue-400 text-xs px-1 rounded transition">✎</button>
              </div>
              <div class="text-xs text-zinc-400 mt-0.5 truncate">${model} · <span class="font-mono">${ip}</span></div>
            </div>
          </div>
          <div>${onlineBadge}</div>
        </div>

        <div class="mt-4 pt-3 border-t border-zinc-800 grid grid-cols-3 gap-2 text-center text-xs">
          <div class="bg-zinc-900/60 p-2 rounded-xl border border-zinc-800/60">
            <div class="font-bold text-zinc-100 text-sm">${files}</div>
            <div class="text-[10px] text-zinc-500 uppercase font-semibold mt-0.5">Files</div>
          </div>
          <div class="bg-zinc-900/60 p-2 rounded-xl border border-zinc-800/60">
            <div class="font-bold text-emerald-400 text-sm">${storage}</div>
            <div class="text-[10px] text-zinc-500 uppercase font-semibold mt-0.5">Storage</div>
          </div>
          <div class="bg-zinc-900/60 p-2 rounded-xl border border-zinc-800/60">
            <div class="font-bold text-zinc-200 text-sm">${fmtRel(d.last_seen)}</div>
            <div class="text-[10px] text-zinc-500 uppercase font-semibold mt-0.5">Last Seen</div>
          </div>
        </div>
      </div>

      <div class="mt-4 pt-3 border-t border-zinc-800/60 flex items-center justify-between gap-1.5 flex-wrap">
        <div class="flex gap-1.5">
          <button data-action="browse-device-files" data-device-id="${did}" class="btn-secondary text-xs py-1.5 px-2.5">
            🔍 Browse Files
          </button>
          <button data-action="open-backup-folder" data-device-id="${did}" class="btn-secondary text-xs py-1.5 px-2.5" title="Explore backup folder on server">
            📁 Backup Folder
          </button>
          <button data-action="post-to-device" data-device-id="${did}" class="btn-secondary text-xs py-1.5 px-2.5 text-blue-400 hover:text-blue-300" title="Compose direct post to this device">
            ✉️ Send Post
          </button>
        </div>
        <button data-action="revoke-device" data-device-id="${did}" class="btn-danger text-xs py-1.5 px-2.5">
          Revoke
        </button>
      </div>
    </div>`;
  }).join('');
}

// Devices event delegation — handles all device card button clicks safely
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const deviceId = btn.dataset.deviceId;

  switch (action) {
    case 'copy-url':
      navigator.clipboard.writeText(btn.dataset.url || '').then(() => showToast(`Copied ${btn.dataset.url}`));
      break;
    case 'rename-device':
      openRenameDevice(deviceId);
      break;
    case 'browse-device-files':
      openDeviceFilesModal(deviceId);
      break;
    case 'open-backup-folder': {
      const d = _devices.find(x => x.device_id === deviceId);
      openExplorerAt(d ? (d.backup_folder || window._currentBackupRoot || '') : '');
      break;
    }
    case 'post-to-device':
      window._preselectedPostDeviceId = deviceId;
      showTab('post_to_devices');
      break;
    case 'revoke-device': {
      const d = _devices.find(x => x.device_id === deviceId);
      confirmRevokeDevice(deviceId, d ? (d.display_name || d.device_name || deviceId) : deviceId);
      break;
    }
    case 'open-shared-folder': {
      const sf = _sharedFolders.find(x => x.id === btn.dataset.folderId);
      openExplorerAt(sf ? sf.path || '' : '');
      break;
    }
    case 'manage-shared-folder-access':
      openManageSharedFolderAccess(btn.dataset.folderId);
      break;
    case 'remove-shared-folder': {
      const sf2 = _sharedFolders.find(x => x.id === btn.dataset.folderId);
      confirmRemoveSharedFolder(btn.dataset.folderId, sf2 ? (sf2.label || sf2.path || '') : '');
      break;
    }
    case 'edit-caption': {
      const gid = btn.dataset.groupId;
      const post = _postsData.find(p => p.group_id === gid);
      openEditCaptionModal(gid, post ? (post.caption || '') : '');
      break;
    }
    case 'edit-post-files':
      openEditFilesModal(btn.dataset.groupId);
      break;
    case 'manage-post-access':
      openManageAccessModal(btn.dataset.groupId);
      break;
    case 'delete-post':
      confirmDeletePost(btn.dataset.groupId);
      break;
    case 'preview-media': {
      const url = btn.dataset.url;
      const cat = btn.dataset.cat || 'photos';
      openMediaPreviewUrl(url, cat);
      break;
    }
    case 'copy-file-path':
      navigator.clipboard.writeText(btn.dataset.path || '').then(() => showToast('Path copied to clipboard!'));
      break;
    case 'fs-navigate':
      fsNavigateTo(btn.dataset.path);
      break;
    case 'fs-select-folder':
      fsSelectFolder(btn.dataset.path);
      break;
  }
});

function openRenameDevice(deviceId) {
  const d = _devices.find(x => x.device_id === deviceId);
  if (!d) return;
  openModal('rename-modal');
  el('rename-modal-title').textContent = `Rename: ${d.display_name || d.device_name}`;
  el('rename-input').value = d.username || d.device_name || '';
  el('rename-save-btn').onclick = async () => {
    const newName = el('rename-input').value.trim();
    try {
      await api.post(`/api/admin/devices/${deviceId}/username`, { username: newName });
      closeModal('rename-modal');
      loadDevices();
      showToast('Device username updated.');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
}
window.openRenameDevice = openRenameDevice;

function confirmRevokeDevice(deviceId, displayName) {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Revoke Device Access';
  el('confirm-modal-body').textContent = `Are you sure you want to remove "${displayName}" and revoke its pairing credentials? Backed up files on disk remain safe.`;
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Revoke Access';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.delete(`/api/admin/devices/${deviceId}`);
      closeModal('confirm-modal');
      loadDevices();
      showToast(`Device ${displayName} revoked.`);
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
}
window.confirmRevokeDevice = confirmRevokeDevice;

// ── 3. DEVICE BACKUP FILES EXPLORER MODAL ───────────────────────────────────────

let _currentModalDeviceId = null;
let _currentDeviceFiles = [];

async function openDeviceFilesModal(deviceId) {
  _currentModalDeviceId = deviceId;
  const d = _devices.find(x => x.device_id === deviceId) || { display_name: deviceId, backup_folder: '' };

  openModal('device-files-modal');
  el('device-files-modal-title').textContent = `Backup Files · ${d.display_name || d.device_name}`;
  el('device-files-modal-subtitle').textContent = `Search and explore backed up files for this device.`;

  el('device-files-open-folder-btn').onclick = () => {
    openExplorerAt(d.backup_folder || window._currentBackupRoot || '');
  };

  el('device-files-search').value = '';
  el('device-files-cat').value = 'all';

  await fetchDeviceFiles(deviceId, '', 'all');
}
window.openDeviceFilesModal = openDeviceFilesModal;

async function fetchDeviceFiles(deviceId, q = '', cat = 'all') {
  const listEl = el('device-files-list');
  const statusEl = el('device-files-status');
  if (statusEl) statusEl.textContent = 'Searching records…';
  if (listEl) listEl.innerHTML = loadingSpinner();

  try {
    const res = await api.get(`/api/admin/devices/${deviceId}/files`, { q, category: cat, limit: 300 });
    _currentDeviceFiles = res.files || [];
    if (statusEl) statusEl.textContent = `Found ${_currentDeviceFiles.length} item(s)`;
    el('device-files-summary').textContent = `${res.total || _currentDeviceFiles.length} total files`;
    renderDeviceFiles();
  } catch (e) {
    if (listEl) listEl.innerHTML = errorBanner(e.message);
    if (statusEl) statusEl.textContent = 'Error loading files.';
  }
}

window.renderDeviceFiles = function() {
  const listEl = el('device-files-list');
  if (!listEl) return;

  if (!_currentDeviceFiles.length) {
    listEl.innerHTML = emptyState('No backup files found', 'No files matched your search filters.');
    return;
  }

  // Use data-* attributes — paths may contain backslashes, single quotes, etc.
  listEl.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      ${_currentDeviceFiles.map((f, idx) => {
        const name = escHtml(f.name);
        const relPath = escHtml(f.path);
        const size = f.formatted_size;
        const date = fmtTs(f.modified_time);
        const cat = f.category || 'file';
        const icon = cat === 'photos' ? '🖼️' : cat === 'videos' ? '🎥' : cat === 'audio' ? '🎵' : '📄';
        const canPreview = cat === 'photos' || cat === 'videos';

        return `
        <div class="p-2.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-10 h-10 rounded-lg bg-zinc-800 overflow-hidden flex items-center justify-center text-lg shrink-0">
              ${f.thumbnail_url && canPreview
                ? `<img src="${escHtml(f.thumbnail_url)}" class="w-full h-full object-cover" onerror="this.parentElement.textContent='${icon}'">`
                : icon}
            </div>
            <div class="min-w-0">
              <div class="text-xs font-semibold text-zinc-100 truncate" title="${name}">${name}</div>
              <div class="text-[10px] text-zinc-500 truncate" title="${relPath}">${relPath}</div>
              <div class="text-[10px] text-zinc-400 mt-0.5">${size} · ${date}</div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button data-action="copy-file-path" data-path="${escHtml(f.path)}" title="Copy Path" class="btn-secondary text-[11px] py-1 px-2">
              📋
            </button>
            ${canPreview ? `
            <button data-action="preview-media" data-url="${escHtml(f.download_url)}" data-cat="${cat}" title="Preview Media" class="btn-secondary text-[11px] py-1 px-2">
              👁️
            </button>` : ''}
            <a href="${escHtml(f.download_url)}" download="${name}" title="Download File" class="btn-secondary text-[11px] py-1 px-2">
              ⬇
            </a>
          </div>
        </div>`;
      }).join('')}
    </div>`;
};

// ── 4. POST TO DEVICES ──────────────────────────────────────────────────────────

let _postSelectedFiles = [];
let _postDevices = [];

async function loadPostForm() {
  try {
    const res = await api.get('/api/admin/devices');
    _postDevices = (res.devices || []).filter(d => d.device_id !== 'desktop-server');
    renderPostDeviceSelector();
  } catch (e) {
    el('post-devices-list').innerHTML = errorBanner(e.message);
  }
}

function renderPostDeviceSelector() {
  const con = el('post-devices-list');
  if (!con) return;

  const preselected = window._preselectedPostDeviceId;
  window._preselectedPostDeviceId = null;

  con.innerHTML = `
    <label class="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-zinc-800/60 transition bg-zinc-900/50 border border-zinc-800/80 mb-1">
      <input type="checkbox" id="post-chk-all-devices" class="rounded" onchange="toggleAllPostDevices(this)">
      <span class="text-xs font-bold text-zinc-100">All Paired Devices</span>
      <span class="text-[11px] text-zinc-500 ml-auto">${_postDevices.length} devices</span>
    </label>
    <div class="space-y-1">
      ${_postDevices.map(d => {
        const did = escHtml(d.device_id);
        const name = escHtml(d.display_name || d.device_name);
        const model = escHtml(d.device_model || '');
        const checked = preselected === d.device_id ? 'checked' : '';
        return `
        <label class="flex items-center gap-2.5 cursor-pointer px-2.5 py-1.5 rounded-lg hover:bg-zinc-800/40 transition">
          <input type="checkbox" class="rounded post-device-chk" value="${did}" ${checked} onchange="updatePostTargetsSummary()">
          <span class="text-xs text-zinc-200">${name}</span>
          <span class="text-[11px] text-zinc-500 ml-auto">${model}</span>
        </label>`;
      }).join('')}
    </div>`;

  updatePostTargetsSummary();
}

window.toggleAllPostDevices = function(cb) {
  qsa('.post-device-chk').forEach(c => c.checked = cb.checked);
  updatePostTargetsSummary();
};

window.updatePostTargetsSummary = function() {
  const totalChecked = qsa('.post-device-chk:checked').length;
  const isAll = el('post-chk-all-devices')?.checked;
  const summaryEl = el('post-targets-summary');
  if (summaryEl) {
    summaryEl.textContent = isAll ? 'All devices selected' : `${totalChecked} device${totalChecked !== 1 ? 's' : ''} selected`;
  }
};

function initDropZone() {
  const zone = el('drop-zone');
  const input = el('post-file-input');
  if (!zone || !input) return;

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('border-blue-500', 'bg-blue-500/5'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('border-blue-500', 'bg-blue-500/5'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('border-blue-500', 'bg-blue-500/5');
    if (e.dataTransfer.files.length) handlePostFiles([...e.dataTransfer.files]);
  });
  input.addEventListener('change', e => {
    if (e.target.files.length) handlePostFiles([...e.target.files]);
  });
}

function handlePostFiles(files) {
  _postSelectedFiles = [..._postSelectedFiles, ...files];
  renderPostFileList();
}

function renderPostFileList() {
  const con = el('post-file-list');
  const summary = el('post-files-summary');
  const clearBtn = el('post-clear-files-btn');
  if (!con) return;

  if (!_postSelectedFiles.length) {
    con.innerHTML = '';
    if (summary) summary.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
    return;
  }

  if (clearBtn) clearBtn.classList.remove('hidden');
  const totalBytes = _postSelectedFiles.reduce((s, f) => s + f.size, 0);
  if (summary) {
    summary.textContent = `${_postSelectedFiles.length} file(s) selected (${fmtBytes(totalBytes)})`;
    summary.classList.remove('hidden');
  }

  // Use data-index — File objects can't be stored as strings
  con.innerHTML = _postSelectedFiles.map((f, i) => {
    const isVid = f.type.startsWith('video/') || f.name.match(/\.(mp4|mov|avi|mkv)$/i);
    const isImg = f.type.startsWith('image/') || f.name.match(/\.(jpg|jpeg|png|heic|webp|gif)$/i);
    const isAudio = f.type.startsWith('audio/') || f.name.match(/\.(mp3|m4a|wav|flac|aac)$/i);
    const icon = isVid ? '🎥' : isImg ? '🖼️' : isAudio ? '🎵' : '📄';

    return `
    <div class="flex items-center justify-between p-2 rounded-xl bg-zinc-800/80 border border-zinc-700/60 text-xs">
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="text-base">${icon}</span>
        <div class="min-w-0">
          <div class="font-semibold text-zinc-100 truncate">${escHtml(f.name)}</div>
          <div class="text-[10px] text-zinc-400">${fmtBytes(f.size)}</div>
        </div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button onclick="movePostFile(${i}, -1)" ${i === 0 ? 'disabled' : ''} class="p-1 text-zinc-400 hover:text-white disabled:opacity-30">▲</button>
        <button onclick="movePostFile(${i}, 1)" ${i === _postSelectedFiles.length - 1 ? 'disabled' : ''} class="p-1 text-zinc-400 hover:text-white disabled:opacity-30">▼</button>
        <button onclick="removePostFile(${i})" class="p-1 text-zinc-400 hover:text-red-400 transition ml-1">✕</button>
      </div>
    </div>`;
  }).join('');
}

window.movePostFile = function(i, dir) {
  const target = i + dir;
  if (target < 0 || target >= _postSelectedFiles.length) return;
  const temp = _postSelectedFiles[i];
  _postSelectedFiles[i] = _postSelectedFiles[target];
  _postSelectedFiles[target] = temp;
  renderPostFileList();
};

window.removePostFile = function(i) {
  _postSelectedFiles.splice(i, 1);
  renderPostFileList();
};

window.clearPostFiles = function() {
  _postSelectedFiles = [];
  renderPostFileList();
};

window.submitDirectPost = async function() {
  if (!_postSelectedFiles.length) {
    showToast('Please select at least one file to post.', 'warn');
    return;
  }

  const allChecked = el('post-chk-all-devices')?.checked;
  const selectedDevices = allChecked
    ? _postDevices.map(d => d.device_id)
    : qsa('.post-device-chk:checked').map(c => c.value);

  if (!selectedDevices.length) {
    showToast('Please select at least one target device.', 'warn');
    return;
  }

  const caption = el('post-caption')?.value.trim() || '';
  const btn = el('post-submit-btn');
  const bar = el('post-progress');

  btn.disabled = true;
  btn.textContent = 'Posting to Devices…';
  if (bar) bar.classList.remove('hidden');

  try {
    const formData = new FormData();
    formData.append('shared_by_device_id', 'desktop-server');
    formData.append('target_device_ids', JSON.stringify(selectedDevices));
    formData.append('caption', caption);
    _postSelectedFiles.forEach(f => formData.append('files', f));

    await api.postForm('/api/share/direct-post/create', formData);
    showToast(`Successfully posted ${_postSelectedFiles.length} file(s) to ${selectedDevices.length} device(s)!`);

    _postSelectedFiles = [];
    renderPostFileList();
    if (el('post-caption')) el('post-caption').value = '';
    if (el('post-file-input')) el('post-file-input').value = '';
    qsa('.post-device-chk').forEach(c => c.checked = false);
    if (el('post-chk-all-devices')) el('post-chk-all-devices').checked = false;
    updatePostTargetsSummary();

    showTab('posts');
  } catch (e) {
    showToast(`Post failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Post to Selected Devices';
    if (bar) bar.classList.add('hidden');
  }
};

// ── 5. POSTS MANAGEMENT ─────────────────────────────────────────────────────────

let _postsPage = 0;
const POSTS_PER_PAGE = 20;
let _postsData = [];
let _postsTotal = 0;

async function loadPosts() {
  const con = el('posts-content');
  if (con) con.innerHTML = loadingSpinner();

  populatePostDeviceFilter();

  try {
    const q = (el('posts-search')?.value || '').trim();
    const devFilter = el('posts-device-filter')?.value || 'all';

    const res = await api.get('/api/admin/posts', {
      q,
      device_filter: devFilter,
      offset: _postsPage * POSTS_PER_PAGE,
      limit: POSTS_PER_PAGE,
    });

    _postsData = res.posts || [];
    _postsTotal = res.total || 0;
    renderPosts();
  } catch (e) {
    if (con) con.innerHTML = errorBanner(e.message);
  }
}

function populatePostDeviceFilter() {
  const sel = el('posts-device-filter');
  if (!sel || sel.children.length > 1) return;
  _devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.device_id;
    opt.textContent = `Recipient: ${d.display_name || d.device_name}`;
    sel.appendChild(opt);
  });
}

function renderPosts() {
  const con = el('posts-content');
  if (!con) return;

  const totalPages = Math.max(1, Math.ceil(_postsTotal / POSTS_PER_PAGE));
  el('posts-page-lbl').textContent = `Page ${_postsPage + 1} of ${totalPages} (${_postsTotal} total)`;
  el('posts-prev-btn').disabled = _postsPage <= 0;
  el('posts-next-btn').disabled = _postsPage >= totalPages - 1;

  if (!_postsData.length) {
    con.innerHTML = emptyState('No posts found', 'Create posts from the "Post to Devices" tab to share media with paired devices.');
    return;
  }

  // All dynamic strings go in data-* attributes, NOT inside onclick="..."
  con.innerHTML = _postsData.map(p => {
    const gid = escHtml(p.group_id);
    const caption = escHtml(p.caption || '(no caption)');
    const author = escHtml(p.shared_by || 'Desktop Server');
    const date = fmtTs(p.created_at);
    const timeAgo = fmtRel(p.created_at);
    const targetNames = p.target_names && p.target_names.length ? p.target_names.join(', ') : 'All Devices';

    const items = p.items || [];
    const previewItems = items.slice(0, 6);

    return `
    <div class="card space-y-3" data-group-id="${gid}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-bold text-sm text-zinc-100">${caption}</div>
          <div class="text-xs text-zinc-400 mt-0.5">
            <span>${items.length} file${items.length !== 1 ? 's' : ''}</span>
            <span class="mx-1.5">·</span>
            <span>By ${author}</span>
            <span class="mx-1.5">·</span>
            <span class="text-blue-400 font-medium">To: ${escHtml(targetNames)}</span>
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-xs text-zinc-400">${date}</div>
          <div class="text-[10px] text-zinc-500">${timeAgo}</div>
        </div>
      </div>

      ${previewItems.length ? `
      <div class="flex items-center gap-2 overflow-x-auto py-1">
        ${previewItems.map(it => {
          const isVid = it.name.match(/\.(mp4|mov|avi|mkv)$/i);
          const cat = isVid ? 'videos' : 'photos';
          return `
          <div class="relative w-16 h-16 rounded-lg bg-zinc-800 overflow-hidden shrink-0 cursor-pointer border border-zinc-700/60 group/item"
               data-action="preview-media" data-url="${escHtml(it.download_url)}" data-cat="${cat}">
            <img src="${escHtml(it.thumbnail_url)}" class="w-full h-full object-cover pointer-events-none" onerror="this.style.display='none'">
            ${isVid ? '<div class="absolute inset-0 bg-black/40 flex items-center justify-center text-white text-xs pointer-events-none">▶</div>' : ''}
          </div>`;
        }).join('')}
        ${items.length > 6 ? `<div class="w-16 h-16 rounded-lg bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center text-xs text-zinc-400 font-semibold shrink-0">+${items.length - 6} more</div>` : ''}
      </div>` : ''}

      <div class="pt-2 border-t border-zinc-800/60 flex items-center justify-between gap-2 flex-wrap">
        <div class="flex gap-2">
          <button data-action="edit-caption" data-group-id="${gid}" class="btn-secondary text-xs py-1 px-2.5">
            ✏️ Edit Caption
          </button>
          <button data-action="edit-post-files" data-group-id="${gid}" class="btn-secondary text-xs py-1 px-2.5">
            📁 Edit Files (${items.length})
          </button>
          <button data-action="manage-post-access" data-group-id="${gid}" class="btn-secondary text-xs py-1 px-2.5">
            👥 Manage Access
          </button>
        </div>
        <button data-action="delete-post" data-group-id="${gid}" class="btn-danger text-xs py-1 px-2.5">
          Delete Post
        </button>
      </div>
    </div>`;
  }).join('');
}

window.postsPrevPage = function() {
  if (_postsPage > 0) { _postsPage--; loadPosts(); }
};
window.postsNextPage = function() {
  _postsPage++;
  loadPosts();
};

// Edit Caption — receives raw strings from _postsData lookup, not from HTML
function openEditCaptionModal(groupId, currentCaption) {
  openModal('caption-modal');
  el('caption-input').value = currentCaption || '';
  el('caption-save-btn').onclick = async () => {
    const caption = el('caption-input').value.trim();
    try {
      await api.post(`/api/admin/posts/${groupId}/caption`, { caption });
      closeModal('caption-modal');
      loadPosts();
      showToast('Caption updated.');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
}
window.openEditCaptionModal = openEditCaptionModal;

// Manage Post Access
async function openManageAccessModal(groupId) {
  openModal('post-access-modal');
  const listEl = el('post-access-devices-list');
  listEl.innerHTML = loadingSpinner();

  try {
    const [targetsRes, devsRes] = await Promise.all([
      api.get(`/api/admin/posts/${groupId}/targets`),
      api.get('/api/admin/devices'),
    ]);

    const currentTargetIds = new Set((targetsRes.targets || []).map(t => t.target_device_id));
    const allDevs = (devsRes.devices || []).filter(d => d.device_id !== 'desktop-server');

    listEl.innerHTML = allDevs.map(d => {
      const checked = currentTargetIds.has(d.device_id) ? 'checked' : '';
      return `
      <label class="flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-zinc-800/60 cursor-pointer">
        <input type="checkbox" class="rounded post-access-dev-chk" value="${escHtml(d.device_id)}" ${checked} onchange="updatePostAccessCount()">
        <span class="text-xs text-zinc-200">${escHtml(d.display_name || d.device_name)}</span>
        <span class="text-[11px] text-zinc-500 ml-auto">${escHtml(d.device_model || '')}</span>
      </label>`;
    }).join('');

    updatePostAccessCount();

    el('post-access-save-btn').onclick = async () => {
      const selected = qsa('.post-access-dev-chk:checked').map(c => c.value);
      try {
        await api.post(`/api/admin/posts/${groupId}/targets`, { target_device_ids: selected });
        closeModal('post-access-modal');
        loadPosts();
        showToast('Post recipient access updated.');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };
  } catch (e) {
    listEl.innerHTML = errorBanner(e.message);
  }
}
window.openManageAccessModal = openManageAccessModal;

window.togglePostAccessAll = function(cb) {
  qsa('.post-access-dev-chk').forEach(c => c.checked = cb.checked);
  updatePostAccessCount();
};

window.updatePostAccessCount = function() {
  const count = qsa('.post-access-dev-chk:checked').length;
  el('post-access-count').textContent = `${count} selected`;
};

// Edit Post Files Modal
let _editingPostGroupId = null;
let _editingPostItems = [];

async function openEditFilesModal(groupId) {
  _editingPostGroupId = groupId;
  openModal('post-files-modal');
  const listEl = el('post-edit-files-list');
  listEl.innerHTML = loadingSpinner();

  try {
    const res = await api.get(`/api/admin/posts/${groupId}/items`);
    _editingPostItems = res.items || [];
    renderEditPostFilesList();

    el('post-edit-file-input').onchange = async e => {
      if (!e.target.files.length) return;
      const formData = new FormData();
      [...e.target.files].forEach(f => formData.append('files', f));
      try {
        await api.postForm(`/api/admin/posts/${groupId}/items/upload`, formData);
        showToast('Added files to post.');
        openEditFilesModal(groupId);
        loadPosts();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    el('post-edit-files-save-btn').onclick = async () => {
      try {
        await api.post(`/api/admin/posts/${groupId}/items/update`, { items: _editingPostItems });
        closeModal('post-files-modal');
        loadPosts();
        showToast('Post files updated.');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };
  } catch (e) {
    listEl.innerHTML = errorBanner(e.message);
  }
}
window.openEditFilesModal = openEditFilesModal;

function renderEditPostFilesList() {
  const listEl = el('post-edit-files-list');
  if (!listEl) return;

  if (!_editingPostItems.length) {
    listEl.innerHTML = '<div class="text-xs text-zinc-500 py-8 text-center">No files in this post. Click "+ Add Files" below.</div>';
    return;
  }

  listEl.innerHTML = _editingPostItems.map((it, i) => `
    <div class="flex items-center justify-between p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs">
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="text-base">${it.name.match(/\.(mp4|mov)$/i) ? '🎥' : '🖼️'}</span>
        <div class="min-w-0">
          <div class="font-semibold text-zinc-200 truncate">${escHtml(it.name)}</div>
          <div class="text-[10px] text-zinc-500">${it.formatted_size}</div>
        </div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button onclick="moveEditPostItem(${i}, -1)" ${i === 0 ? 'disabled' : ''} class="p-1 text-zinc-400 hover:text-white disabled:opacity-30">▲</button>
        <button onclick="moveEditPostItem(${i}, 1)" ${i === _editingPostItems.length - 1 ? 'disabled' : ''} class="p-1 text-zinc-400 hover:text-white disabled:opacity-30">▼</button>
        <button onclick="removeEditPostItem(${i})" class="p-1 text-zinc-400 hover:text-red-400 ml-1">✕</button>
      </div>
    </div>
  `).join('');
}

window.moveEditPostItem = function(i, dir) {
  const target = i + dir;
  if (target < 0 || target >= _editingPostItems.length) return;
  const temp = _editingPostItems[i];
  _editingPostItems[i] = _editingPostItems[target];
  _editingPostItems[target] = temp;
  renderEditPostFilesList();
};

window.removeEditPostItem = function(i) {
  _editingPostItems.splice(i, 1);
  renderEditPostFilesList();
};

function confirmDeletePost(groupId) {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Delete Post';
  el('confirm-modal-body').textContent = 'Delete this post and remove it from all device feeds? This cannot be undone.';
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Delete Post';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.delete(`/api/admin/posts/${groupId}`);
      closeModal('confirm-modal');
      loadPosts();
      showToast('Post deleted.');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
}
window.confirmDeletePost = confirmDeletePost;

// ── 6. SHARED FOLDERS ───────────────────────────────────────────────────────────

let _sharedFolders = [];

async function loadSharedFolders() {
  const con = el('shared-content');
  if (con) con.innerHTML = loadingSpinner();
  try {
    const res = await api.get('/api/admin/shared-folders');
    _sharedFolders = res.shared_dirs || [];
    renderSharedFolders();
  } catch (e) {
    if (con) con.innerHTML = errorBanner(e.message);
  }
}

function renderSharedFolders() {
  const con = el('shared-content');
  if (!con) return;

  if (!_sharedFolders.length) {
    con.innerHTML = emptyState('No shared folders configured', 'Add a folder from your server to share its contents with paired devices.');
    return;
  }

  // Folder paths and labels go in data-* attributes only
  con.innerHTML = _sharedFolders.map(d => {
    const id = escHtml(d.id);
    const label = escHtml(d.label || d.path || 'Shared Folder');
    const path = escHtml(d.path || '');
    const tags = d.device_ids || ['all'];
    const isAll = !tags.length || tags.includes('all');
    const tagDisplay = isAll ? 'All Devices' : `${tags.length} device(s)`;
    const inReels = d.available_in_reels !== false;

    return `
    <div class="card flex flex-col justify-between" data-shared-id="${id}">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 text-lg shrink-0">📁</div>
          <div class="min-w-0">
            <div class="font-bold text-sm text-zinc-100 truncate">${label}</div>
            <div class="text-xs font-mono text-zinc-400 truncate mt-0.5" title="${path}">${path}</div>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-[11px] px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-300 font-medium">→ ${escHtml(tagDisplay)}</span>
          ${inReels ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-semibold">Reels Active</span>' : ''}
        </div>
      </div>

      <div class="mt-4 pt-3 border-t border-zinc-800/60 flex items-center justify-between gap-2">
        <div class="flex gap-2">
          <button data-action="open-shared-folder" data-folder-id="${id}" class="btn-secondary text-xs py-1 px-2.5">
            📁 Browse Folder
          </button>
          <button data-action="manage-shared-folder-access" data-folder-id="${id}" class="btn-secondary text-xs py-1 px-2.5">
            👥 Manage Access
          </button>
        </div>
        <button data-action="remove-shared-folder" data-folder-id="${id}" class="btn-danger text-xs py-1 px-2.5">
          Remove
        </button>
      </div>
    </div>`;
  }).join('');
}

window.openAddSharedFolderModal = function() {
  openModal('shared-folder-modal');
  el('shared-modal-title').textContent = 'Add Shared Folder';
  el('shared-path-input').value = '';
  el('shared-label-input').value = '';
  el('shared-all-devices-chk').checked = true;
  el('shared-reels-chk').checked = true;

  renderSharedFolderDevicesChecklist(['all']);

  el('shared-save-btn').onclick = async () => {
    const path = el('shared-path-input').value.trim();
    const label = el('shared-label-input').value.trim();
    const isAll = el('shared-all-devices-chk').checked;
    const deviceIds = isAll ? ['all'] : qsa('.shared-dev-chk:checked').map(c => c.value);
    const availableInReels = el('shared-reels-chk').checked;

    if (!path) { showToast('Please select or specify a server folder path.', 'warn'); return; }

    try {
      await api.post('/api/admin/shared-folders/add', {
        path,
        label,
        device_ids: deviceIds,
        available_in_reels: availableInReels,
      });
      closeModal('shared-folder-modal');
      loadSharedFolders();
      showToast('Shared folder added successfully.');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

function openManageSharedFolderAccess(folderId) {
  const f = _sharedFolders.find(x => x.id === folderId);
  if (!f) return;

  openModal('shared-folder-modal');
  el('shared-modal-title').textContent = `Manage Folder Access: ${f.label || f.path}`;
  el('shared-path-input').value = f.path || '';
  el('shared-label-input').value = f.label || '';
  const currentTags = f.device_ids || ['all'];
  const isAll = !currentTags.length || currentTags.includes('all');
  el('shared-all-devices-chk').checked = isAll;
  el('shared-reels-chk').checked = f.available_in_reels !== false;

  renderSharedFolderDevicesChecklist(currentTags);

  el('shared-save-btn').onclick = async () => {
    const path = el('shared-path-input').value.trim();
    const label = el('shared-label-input').value.trim();
    const isAllNow = el('shared-all-devices-chk').checked;
    const deviceIds = isAllNow ? ['all'] : qsa('.shared-dev-chk:checked').map(c => c.value);
    const availableInReels = el('shared-reels-chk').checked;

    try {
      await api.post('/api/admin/shared-folders/update', {
        id: folderId,
        path,
        label,
        device_ids: deviceIds,
        available_in_reels: availableInReels,
      });
      closeModal('shared-folder-modal');
      loadSharedFolders();
      showToast('Shared folder updated.');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
}
window.openManageSharedFolderAccess = openManageSharedFolderAccess;

function renderSharedFolderDevicesChecklist(selected) {
  const con = el('shared-devices-checklist');
  if (!con) return;
  const isAll = !selected.length || selected.includes('all');
  const selSet = new Set(selected);

  con.innerHTML = _devices.map(d => {
    const checked = isAll || selSet.has(d.device_id) ? 'checked' : '';
    const disabled = isAll ? 'disabled' : '';
    return `
    <label class="flex items-center gap-2 cursor-pointer text-xs p-1 rounded hover:bg-zinc-800">
      <input type="checkbox" class="rounded shared-dev-chk" value="${escHtml(d.device_id)}" ${checked} ${disabled}>
      <span class="text-zinc-200">${escHtml(d.display_name || d.device_name)}</span>
      <span class="text-[10px] text-zinc-500 ml-auto">${escHtml(d.device_model || '')}</span>
    </label>`;
  }).join('');
}

window.toggleSharedAllDevices = function(cb) {
  qsa('.shared-dev-chk').forEach(c => {
    c.disabled = cb.checked;
    if (cb.checked) c.checked = true;
  });
};

function confirmRemoveSharedFolder(folderId, label) {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Remove Shared Folder';
  el('confirm-modal-body').textContent = `Stop sharing "${label}" with connected devices? Files on disk are not affected.`;
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Remove';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.post('/api/admin/shared-folders/delete', { id: folderId });
      closeModal('confirm-modal');
      loadSharedFolders();
      showToast('Shared folder removed.');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
}
window.confirmRemoveSharedFolder = confirmRemoveSharedFolder;

// ── 7. SETTINGS & MAINTENANCE ───────────────────────────────────────────────────

let _settingsConfig = {};
let _cacheStats = {};

async function loadSettings() {
  const con = el('settings-content');
  if (con) con.innerHTML = loadingSpinner();
  try {
    const [cfgRes, cacheRes] = await Promise.all([
      api.get('/api/config'),
      api.get('/api/admin/cache/stats'),
    ]);
    _settingsConfig = cfgRes.config || {};
    _cacheStats = cacheRes || {};
    renderSettings();
  } catch (e) {
    if (con) con.innerHTML = errorBanner(e.message);
  }
}

function renderSettings() {
  const c = _settingsConfig;
  const cs = _cacheStats;

  const prevCache = cs.preview_cache || {};
  const rewindCache = cs.rewind_cache || {};
  const thumbCache = cs.thumbnail_cache || {};
  const memIndex = cs.memory_index || {};

  el('settings-content').innerHTML = `
    <div class="space-y-6">

      <!-- Server & Network -->
      <div class="card space-y-4">
        <div class="section-header">Server Network Configuration</div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label class="label">Host</label>
            <input id="cfg-host" class="input font-mono" value="${escHtml(c.HOST || '0.0.0.0')}">
          </div>
          <div>
            <label class="label">Port</label>
            <input id="cfg-port" type="number" class="input font-mono" value="${escHtml(String(c.PORT || 8000))}">
          </div>
          <div>
            <label class="label">Server Display Name</label>
            <input id="cfg-desktop-name" class="input" value="${escHtml(c.DESKTOP_NAME || '')}">
          </div>
        </div>
      </div>

      <!-- Backup Root Storage -->
      <div class="card space-y-3">
        <div class="section-header">Backup Storage Directory</div>
        <label class="label">Backup Root Folder</label>
        <div class="flex gap-2">
          <input id="cfg-backup-root" class="input font-mono flex-1" value="${escHtml(c.BACKUP_ROOT || '')}" placeholder="e.g. C:\\Backups or /storage">
          <button type="button" onclick="openFsPickerFor('cfg-backup-root')" class="btn-secondary text-xs">📁 Browse</button>
          <button type="button" onclick="openExplorerAt(el('cfg-backup-root').value)" class="btn-secondary text-xs">Explore</button>
        </div>
        <p class="text-[11px] text-zinc-500">Destination folder where all device backups are stored.</p>
      </div>

      <!-- Cache & Index Maintenance -->
      <div class="card space-y-4">
        <div class="section-header">Preview &amp; Cache Maintenance</div>

        <div class="space-y-2 pb-3 border-b border-zinc-800">
          <label class="label">Video Preview Cache Directory</label>
          <div class="flex gap-2">
            <input id="cfg-preview-cache-dir" class="input font-mono text-xs flex-1" value="${escHtml(c.VIDEO_PREVIEW_CACHE_DIR || '')}">
            <button type="button" onclick="openFsPickerFor('cfg-preview-cache-dir')" class="btn-secondary text-xs">📁 Browse</button>
            <button type="button" onclick="relocatePreviewCache()" class="btn-secondary text-xs">Relocate</button>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div class="p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold text-zinc-200">Video Preview Cache</div>
              <div class="text-[11px] text-zinc-400 mt-0.5">${prevCache.files || 0} files · ${prevCache.formatted_bytes || '0 B'}</div>
            </div>
            <button onclick="clearCache('preview')" class="btn-secondary text-xs py-1 px-2 text-red-400">Clean Cache</button>
          </div>

          <div class="p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold text-zinc-200">Rewind Reels Cache</div>
              <div class="text-[11px] text-zinc-400 mt-0.5">${rewindCache.files || 0} reels · ${rewindCache.formatted_bytes || '0 B'}</div>
            </div>
            <button onclick="clearCache('rewind')" class="btn-secondary text-xs py-1 px-2 text-red-400">Clean Cache</button>
          </div>

          <div class="p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold text-zinc-200">Thumbnail Cache</div>
              <div class="text-[11px] text-zinc-400 mt-0.5">${thumbCache.files || 0} images · ${thumbCache.formatted_bytes || '0 B'}</div>
            </div>
            <button onclick="clearCache('thumbnail')" class="btn-secondary text-xs py-1 px-2 text-red-400">Clean Cache</button>
          </div>

          <div class="p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold text-zinc-200">Memory Index</div>
              <div class="text-[11px] text-zinc-400 mt-0.5">${(memIndex.files || 0).toLocaleString()} indexed · last ${memIndex.last_indexed_text || 'never'}</div>
            </div>
            <button onclick="reindexMemoriesAction()" class="btn-secondary text-xs py-1 px-2 text-blue-400">Reindex</button>
          </div>
        </div>
      </div>

      <!-- Security & Access -->
      <div class="card space-y-4">
        <div class="section-header">Security &amp; Origins</div>
        <div>
          <label class="label">API Secret Key</label>
          <div class="flex gap-2">
            <input id="cfg-api-key" type="password" class="input font-mono flex-1" value="${escHtml(c.API_KEY || '')}">
            <button onclick="toggleApiKeyVisibility()" id="api-key-vis-btn" class="btn-secondary text-xs">Show</button>
          </div>
        </div>

        <div class="flex items-center gap-3 pt-1">
          <input type="checkbox" id="cfg-require-approval" class="rounded" ${c.REQUIRE_APPROVAL ? 'checked' : ''}>
          <label for="cfg-require-approval" class="text-xs text-zinc-200 font-medium cursor-pointer">
            Require admin approval for new device connection requests
          </label>
        </div>

        <div>
          <label class="label">Allowed CORS Origins (Optional)</label>
          <input id="cfg-cors" class="input text-xs font-mono" value="${escHtml(c.CORS_ORIGINS || '')}" placeholder="e.g. https://myadmin.lan, http://localhost:3000">
        </div>
      </div>

      <button onclick="saveAllSettings()" class="btn-primary w-full py-3.5 text-base font-semibold shadow-lg shadow-blue-600/20">
        💾 Save Settings &amp; Reload Configuration
      </button>
    </div>`;
}

window.toggleApiKeyVisibility = function() {
  const inp = el('cfg-api-key');
  const btn = el('api-key-vis-btn');
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  btn.textContent = isPass ? 'Hide' : 'Show';
};

window.relocatePreviewCache = async function() {
  const dest = el('cfg-preview-cache-dir')?.value.trim();
  if (!dest) { showToast('Please enter a destination directory.', 'warn'); return; }
  try {
    const res = await api.post('/api/admin/cache/preview/relocate', { destination: dest });
    showToast(`Relocated ${res.moved_files} files (${res.formatted_bytes}) to ${dest}`);
    loadSettings();
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.clearCache = async function(type) {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = `Clean ${type.toUpperCase()} Cache`;
  el('confirm-modal-body').textContent = `Remove all server-generated cached ${type} data? Original backup media files are never affected.`;
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Clean Cache';
  el('confirm-ok-btn').onclick = async () => {
    try {
      const res = await api.post(`/api/admin/cache/${type}/clear`);
      closeModal('confirm-modal');
      showToast(`Cleaned ${res.files} cached file(s) (${res.formatted_bytes})`);
      loadSettings();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

window.reindexMemoriesAction = async function() {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Clean & Reindex Memory Index';
  el('confirm-modal-body').textContent = 'Reset and rebuild the memory timeline and clustering index from backup files? Backups remain safe.';
  el('confirm-ok-btn').className = 'btn-primary';
  el('confirm-ok-btn').textContent = 'Reindex Memories';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.post('/api/admin/memories/reindex');
      closeModal('confirm-modal');
      showToast('Memory reindexing started.');
      loadSettings();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

window.saveAllSettings = async function() {
  const payload = {
    ..._settingsConfig,
    HOST: el('cfg-host')?.value.trim() || '0.0.0.0',
    PORT: parseInt(el('cfg-port')?.value || '8000'),
    DESKTOP_NAME: el('cfg-desktop-name')?.value.trim() || '',
    BACKUP_ROOT: el('cfg-backup-root')?.value.trim() || '',
    VIDEO_PREVIEW_CACHE_DIR: el('cfg-preview-cache-dir')?.value.trim() || '',
    API_KEY: el('cfg-api-key')?.value.trim() || _settingsConfig.API_KEY,
    REQUIRE_APPROVAL: el('cfg-require-approval')?.checked ?? true,
    CORS_ORIGINS: el('cfg-cors')?.value.trim() || '',
  };

  try {
    await api.post('/api/config', payload);
    showToast('Settings saved successfully.');
    if (payload.API_KEY !== _settingsConfig.API_KEY) {
      setApiKey(payload.API_KEY);
    }
    setTimeout(loadSettings, 1000);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ── 8. LIVE LOGS ────────────────────────────────────────────────────────────────

let _logLines = [];
let _logFilter = '';
let _logAutoScroll = true;

async function loadLogs() {
  try {
    const res = await api.get('/api/logs');
    _logLines = (res.logs || []).map(l => ({
      time: l.time,
      message: l.message,
      level: detectLogLevel(l.message),
    }));
    renderLogLines();
  } catch (_) {}
}

function detectLogLevel(msg) {
  if (!msg) return 'info';
  const m = msg.toLowerCase();
  if (m.includes('error') || m.includes('failed') || m.includes('exception') || m.includes('❌')) return 'error';
  if (m.includes('warn') || m.includes('⚠️') || m.includes('retry')) return 'warn';
  return 'info';
}

function renderLogLines() {
  const con = el('log-output');
  if (!con) return;

  const filter = _logFilter.toLowerCase();
  const visible = filter
    ? _logLines.filter(l => l.message.toLowerCase().includes(filter) || l.level === filter)
    : _logLines;

  con.innerHTML = visible.map(l => {
    const t = new Date(l.time * 1000).toLocaleTimeString();
    const color = l.level === 'error' ? 'text-red-400 font-semibold' : l.level === 'warn' ? 'text-amber-400' : 'text-zinc-300';
    return `<div class="flex gap-2.5 leading-relaxed"><span class="text-zinc-500 shrink-0 select-none">${t}</span><span class="${color}">${escHtml(l.message)}</span></div>`;
  }).join('');

  if (_logAutoScroll) con.scrollTop = con.scrollHeight;
}

window.setLogFilter = function(val) {
  _logFilter = val;
  qsa('.log-pill-btn').forEach(btn => {
    const active = (!val && btn.textContent === 'All') || btn.textContent.toLowerCase().includes(val);
    btn.classList.toggle('ring-1', active);
    btn.classList.toggle('ring-blue-500', active);
  });
  renderLogLines();
};

window.toggleAutoScroll = function(cb) {
  _logAutoScroll = cb.checked;
};

window.copyAllLogs = function() {
  const text = _logLines.map(l => `[${new Date(l.time * 1000).toISOString()}] ${l.message}`).join('\n');
  navigator.clipboard.writeText(text).then(() => showToast('All logs copied to clipboard!'));
};

window.clearServerLogs = async function() {
  try {
    await api.post('/api/logs/clear');
    _logLines = [];
    renderLogLines();
    showToast('Logs cleared.');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ── 9. SYNC HISTORY ─────────────────────────────────────────────────────────────

let _histPage = 0;
const HIST_PER_PAGE = 30;
let _histSessions = [];
let _histTotal = 0;

async function loadHistory() {
  const con = el('history-content');
  if (con) con.innerHTML = loadingSpinner();

  populateHistDeviceFilter();

  try {
    const devId = el('hist-device-filter')?.value || '';
    const res = await api.get('/api/sync/history', {
      offset: _histPage * HIST_PER_PAGE,
      limit: HIST_PER_PAGE,
      device_id: devId || undefined,
    });

    _histSessions = res.sessions || [];
    _histTotal = res.total || _histSessions.length;
    renderHistory();
  } catch (e) {
    if (con) con.innerHTML = errorBanner(e.message);
  }
}

function populateHistDeviceFilter() {
  const sel = el('hist-device-filter');
  if (!sel || sel.children.length > 1) return;
  _devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.device_id;
    opt.textContent = `Device: ${d.display_name || d.device_name}`;
    sel.appendChild(opt);
  });
}

function renderHistory() {
  const con = el('history-content');
  if (!con) return;

  const totalPages = Math.max(1, Math.ceil(_histTotal / HIST_PER_PAGE));
  el('hist-page-lbl').textContent = `Page ${_histPage + 1} of ${totalPages}`;
  el('hist-prev-btn').disabled = _histPage <= 0;
  el('hist-next-btn').disabled = _histPage >= totalPages - 1;
  el('hist-total-badge').textContent = `${_histTotal} sync session(s) recorded`;

  if (!_histSessions.length) {
    con.innerHTML = emptyState('No sync history recorded', 'Sync session records will appear here after devices back up files.');
    return;
  }

  con.innerHTML = `
    <table class="w-full text-left text-xs">
      <thead class="bg-zinc-900 border-b border-zinc-800 text-zinc-400 font-semibold uppercase text-[10px] tracking-wider">
        <tr>
          <th class="p-3">Device</th>
          <th class="p-3">Files Backed Up</th>
          <th class="p-3">Total Transferred</th>
          <th class="p-3">Started At</th>
          <th class="p-3">Duration</th>
          <th class="p-3 text-right">Status</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-zinc-800/60 font-medium">
        ${_histSessions.map(s => {
          const dev = escHtml(s.device_name || s.device_id || 'Device');
          const files = (s.file_count || 0).toLocaleString();
          const size = fmtBytes(s.total_bytes || 0);
          const start = fmtTs(s.started_at);
          const dur = formatDuration(s.duration_seconds);
          const isError = s.status === 'failed' || s.errors > 0;
          const statusPill = isError
            ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/20 text-red-400">Failed</span>'
            : '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400">Completed</span>';

          return `
          <tr class="hover:bg-zinc-800/30 transition">
            <td class="p-3 text-zinc-100">${dev}</td>
            <td class="p-3 text-zinc-300 font-mono">${files}</td>
            <td class="p-3 text-emerald-400 font-mono">${size}</td>
            <td class="p-3 text-zinc-400">${start}</td>
            <td class="p-3 text-zinc-400 font-mono">${dur}</td>
            <td class="p-3 text-right">${statusPill}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

window.histPrevPage = function() {
  if (_histPage > 0) { _histPage--; loadHistory(); }
};
window.histNextPage = function() {
  _histPage++;
  loadHistory();
};

window.clearSyncHistoryModal = function() {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Clear Sync History';
  el('confirm-modal-body').textContent = 'Remove all sync session history audit records? Backed-up files are not affected.';
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Clear All';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.post('/api/sync/history/clear');
      closeModal('confirm-modal');
      loadHistory();
      showToast('Sync history cleared.');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

// ── 10. SERVER FILESYSTEM EXPLORER MODAL ─────────────────────────────────────────

let _fsTargetInputId = null;
let _fsCurrentPath = '';
let _fsParentPath = null;
let _fsSelectedPath = '';

window.openFsPickerFor = async function(inputId) {
  _fsTargetInputId = inputId;
  const currentVal = el(inputId)?.value.trim();
  openModal('fs-explorer-modal');
  await fsNavigateTo(currentVal || '');
};

// openExplorerAt — opens the FS explorer for browsing (not picking)
// Path comes from data-* attribute lookups or direct values, NOT from inline onclick strings
async function openExplorerAt(path) {
  _fsTargetInputId = null;
  openModal('fs-explorer-modal');
  await fsNavigateTo(path || '');
}
window.openExplorerAt = openExplorerAt;

window.fsNavigateTo = async function(path) {
  const listEl = el('fs-dir-list');
  if (listEl) listEl.innerHTML = loadingSpinner();

  try {
    const res = await api.get('/api/admin/fs/browse', { path: path || undefined });
    _fsCurrentPath = res.current_path;
    _fsParentPath = res.parent_path;
    _fsSelectedPath = res.current_path;

    el('fs-path-input').value = res.current_path;
    el('fs-parent-btn').disabled = !res.parent_path;
    el('fs-selected-path-display').textContent = `Selected: ${res.current_path}`;

    // Roots chips — use data-action="fs-navigate" data-path
    const rootsEl = el('fs-roots-chips');
    if (rootsEl && res.roots) {
      rootsEl.innerHTML = res.roots.map(r => `
        <button type="button" data-action="fs-navigate" data-path="${escHtml(r)}" class="chip text-[11px] py-0.5 px-2">
          📁 ${escHtml(r)}
        </button>`).join('');
    }

    renderFsDirectoryEntries(res.directories || [], res.files || []);
  } catch (e) {
    if (listEl) listEl.innerHTML = errorBanner(e.message);
  }
};
const fsNavigateTo = window.fsNavigateTo;

window.fsNavigateParent = function() {
  if (_fsParentPath) fsNavigateTo(_fsParentPath);
};

function renderFsDirectoryEntries(dirs, files) {
  const listEl = el('fs-dir-list');
  if (!listEl) return;

  if (!dirs.length && !files.length) {
    listEl.innerHTML = '<div class="text-xs text-zinc-500 py-10 text-center">Empty directory.</div>';
    return;
  }

  // Use data-action="fs-select-folder" data-path — paths may contain backslashes
  listEl.innerHTML = `
    <table class="w-full text-left text-xs">
      <thead class="bg-zinc-925 text-zinc-500 font-semibold border-b border-zinc-800 text-[10px] uppercase tracking-wider">
        <tr>
          <th class="p-2.5">Name</th>
          <th class="p-2.5">Size</th>
          <th class="p-2.5 text-right">Modified</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-zinc-800/40">
        ${dirs.map(d => `
        <tr class="hover:bg-blue-500/10 cursor-pointer transition select-none group" data-action="fs-select-folder" data-path="${escHtml(d.path)}">
          <td class="p-2.5 flex items-center gap-2 font-medium text-zinc-200">
            <span class="text-base text-amber-400">📁</span>
            <span class="truncate">${escHtml(d.name)}</span>
          </td>
          <td class="p-2.5 text-zinc-500 text-[11px]">Folder</td>
          <td class="p-2.5 text-right text-zinc-500 text-[11px]">${fmtTs(d.modified_time)}</td>
        </tr>`).join('')}
        ${files.map(f => `
        <tr class="hover:bg-zinc-800/30 transition text-zinc-400">
          <td class="p-2.5 flex items-center gap-2">
            <span class="text-base text-zinc-500">📄</span>
            <span class="truncate text-zinc-300">${escHtml(f.name)}</span>
          </td>
          <td class="p-2.5 font-mono text-[11px] text-zinc-500">${f.formatted_size}</td>
          <td class="p-2.5 text-right text-zinc-500 text-[11px]">${fmtTs(f.modified_time)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function fsSelectFolder(folderPath) {
  _fsSelectedPath = folderPath;
  el('fs-selected-path-display').textContent = `Selected: ${folderPath}`;
  fsNavigateTo(folderPath);
}
window.fsSelectFolder = fsSelectFolder;

window.fsConfirmSelection = function() {
  if (_fsTargetInputId && el(_fsTargetInputId)) {
    el(_fsTargetInputId).value = _fsSelectedPath;
  }
  closeModal('fs-explorer-modal');
  showToast(`Selected: ${_fsSelectedPath}`);
};

window.fsPromptNewFolder = async function() {
  const name = prompt('Enter new folder name:');
  if (!name) return;
  try {
    await api.post('/api/admin/fs/mkdir', {
      parent_path: _fsCurrentPath,
      folder_name: name,
    });
    showToast(`Created folder "${name}"`);
    fsNavigateTo(_fsCurrentPath);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ── 11. WEBSOCKET & PAIRING APPROVALS ───────────────────────────────────────────

let _pendingPollInterval = null;

function initPendingConnectionPoller() {
  clearInterval(_pendingPollInterval);
  _pendingPollInterval = setInterval(pollPendingConnections, 3000);
}

async function pollPendingConnections() {
  try {
    const res = await api.get('/api/pending-connections');
    const pending = res.pending || [];
    if (pending.length > 0) {
      showPairingBanner(pending[0]);
    } else {
      hidePairingBanner();
    }
  } catch (_) {}
}

function showPairingBanner(req) {
  const banner = el('pairing-banner');
  if (!banner) return;
  el('pairing-device-name').textContent = req.name || req.display_name || 'Mobile Phone';
  el('pairing-device-ip').textContent = req.ip || '';
  el('pairing-approve-btn').onclick = () => resolveConnection(req.id, true);
  el('pairing-reject-btn').onclick = () => resolveConnection(req.id, false);
  banner.classList.remove('hidden');
}

function hidePairingBanner() {
  el('pairing-banner')?.classList.add('hidden');
}

async function resolveConnection(reqId, accepted) {
  try {
    await api.post('/api/pending-connections/resolve', { req_id: reqId, accepted });
    hidePairingBanner();
    if (accepted) {
      loadDevices();
      showToast('Device approved and connected successfully.');
    } else {
      showToast('Device pairing request rejected.');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function initWebSocketListeners() {
  window.addEventListener('ws:connected', () => updateWsBadge(true));
  window.addEventListener('ws:disconnected', () => updateWsBadge(false));

  window.addEventListener('ws:log', e => {
    const { message, time } = e.detail;
    const level = detectLogLevel(message);
    _logLines.push({ time, message, level });
    if (_logLines.length > 600) _logLines.shift();

    if (_currentTab === 'logs') {
      const con = el('log-output');
      if (con) {
        const filter = _logFilter.toLowerCase();
        if (!filter || message.toLowerCase().includes(filter) || level === filter) {
          const t = new Date(time * 1000).toLocaleTimeString();
          const color = level === 'error' ? 'text-red-400 font-semibold' : level === 'warn' ? 'text-amber-400' : 'text-zinc-300';
          con.insertAdjacentHTML('beforeend', `<div class="flex gap-2.5 leading-relaxed"><span class="text-zinc-500 shrink-0 select-none">${t}</span><span class="${color}">${escHtml(message)}</span></div>`);
          if (_logAutoScroll) con.scrollTop = con.scrollHeight;
        }
      }
    }

    _recentActivities.unshift({
      time,
      badge: level.toUpperCase(),
      badgeClass: level === 'error' ? 'bg-red-500/20 text-red-400' : level === 'warn' ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400',
      text: message,
    });
    if (_recentActivities.length > 30) _recentActivities.pop();
    if (_currentTab === 'dashboard') renderDashboardActivities();
  });

  window.addEventListener('ws:upload', e => {
    const { filename, progress, done } = e.detail;
    if (done) {
      showToast(`Backup received: ${filename}`);
      if (_currentTab === 'dashboard') refreshDashboard();
      if (_currentTab === 'devices') loadDevices();
    }
  });

  window.addEventListener('ws:new_share', e => {
    showToast(`New share group created: ${e.detail.caption || 'Shared post'}`);
    if (_currentTab === 'posts') loadPosts();
  });
}

// ── 12. MODAL & PREVIEW SYSTEM ───────────────────────────────────────────────────

export function openModal(id) {
  el(id)?.classList.remove('hidden');
  el(id)?.classList.add('flex');
}

export function closeModal(id) {
  el(id)?.classList.remove('flex');
  el(id)?.classList.add('hidden');
}

window.openModal = openModal;
window.closeModal = closeModal;

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.remove('flex');
    e.target.classList.add('hidden');
  }
});

function openMediaPreviewUrl(url, cat = 'photos') {
  openModal('media-modal');
  const cont = el('media-modal-content');
  if (!cont) return;

  if (cat === 'videos' || (url && url.match(/\.(mp4|mov|mkv|webm)$/i))) {
    cont.innerHTML = `<video src="${escHtml(url)}" controls autoplay class="max-h-[75vh] max-w-full rounded-xl shadow-2xl mx-auto"></video>`;
  } else {
    cont.innerHTML = `<img src="${escHtml(url)}" class="max-h-[75vh] max-w-full rounded-xl object-contain shadow-2xl mx-auto">`;
  }
}
window.openMediaPreviewUrl = openMediaPreviewUrl;

// ── 13. UI NOTIFICATIONS & PRIMITIVES ───────────────────────────────────────────

export function showToast(message, type = 'success') {
  const container = el('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  const color = type === 'error' ? 'bg-red-600/95 text-white' : type === 'warn' ? 'bg-amber-600/95 text-white' : 'bg-emerald-600/95 text-white';
  toast.className = `${color} text-xs font-semibold px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md transition-all duration-300 max-w-sm flex items-center gap-2 pointer-events-auto select-none`;
  toast.innerHTML = `<span>${type === 'error' ? '⚠️' : type === 'warn' ? 'ℹ️' : '✓'}</span> <span>${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
}
window.showToast = showToast;

function loadingSpinner(extra = '') {
  return `<div class="flex items-center justify-center py-12 text-zinc-500 gap-2.5 ${extra}">
    <svg class="animate-spin w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
    <span class="text-xs font-semibold text-zinc-400">Loading…</span>
  </div>`;
}

function emptyState(title, subtitle = '') {
  return `<div class="flex flex-col items-center justify-center py-16 text-center gap-2">
    <div class="w-12 h-12 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center mb-1 text-xl">📦</div>
    <div class="text-zinc-200 font-bold text-sm">${title}</div>
    ${subtitle ? `<div class="text-xs text-zinc-500 max-w-sm">${subtitle}</div>` : ''}
  </div>`;
}

function errorBanner(msg) {
  return `<div class="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
    <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"/></svg>
    <span>${escHtml(msg)}</span>
  </div>`;
}

// ── 14. BOOTSTRAP ──────────────────────────────────────────────────────────────

async function boot() {
  initTheme();

  // Wire nav tab clicks
  qsa('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Wire login form
  el('login-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const key = el('login-key-input').value.trim();
    if (!key) { el('login-error').textContent = 'Please enter your API key.'; return; }
    el('login-btn').disabled = true;
    el('login-btn').textContent = 'Connecting…';
    await tryLogin(key);
    el('login-btn').disabled = false;
    el('login-btn').textContent = 'Connect to Server';
  });

  // Search bindings
  let devTimer;
  el('devices-search')?.addEventListener('input', () => {
    clearTimeout(devTimer);
    devTimer = setTimeout(() => renderDevices(_devices), 200);
  });

  let postTimer;
  el('posts-search')?.addEventListener('input', () => {
    clearTimeout(postTimer);
    postTimer = setTimeout(() => { _postsPage = 0; loadPosts(); }, 250);
  });

  let devFilesTimer;
  el('device-files-search')?.addEventListener('input', () => {
    clearTimeout(devFilesTimer);
    devFilesTimer = setTimeout(() => {
      const q = el('device-files-search').value.trim();
      const cat = el('device-files-cat').value;
      fetchDeviceFiles(_currentModalDeviceId, q, cat);
    }, 250);
  });

  // Init dropzone
  initDropZone();

  // Auto-login with saved key
  const storedKey = getApiKey();
  if (storedKey) {
    const ok = await tryLogin(storedKey);
    if (!ok) {
      el('login-error').textContent = 'Saved session expired. Please log in again.';
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
