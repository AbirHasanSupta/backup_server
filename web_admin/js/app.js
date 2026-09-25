/**
 * app.js — Main state manager, router & tab switcher for the Phone Backup Admin Panel.
 *
 * Architecture:
 * - Modules are imported as ES modules (no bundler needed).
 * - Each tab is a section of the single index.html, shown/hidden by CSS class.
 * - Data fetching and rendering is done per-tab with auto-refresh polling.
 */

import { api, getApiKey, setApiKey, clearApiKey } from './api.js';
import { wsConnect, wsDisconnect, wsIsConnected } from './ws.js';

// ── Utility helpers ────────────────────────────────────────────────────────────

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

export function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function el(id) { return document.getElementById(id); }
function qs(sel, ctx = document) { return ctx.querySelector(sel); }
function qsa(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

// ── Tab management ─────────────────────────────────────────────────────────────

const TABS = ['dashboard', 'devices', 'post', 'posts', 'shared-folders', 'storage', 'logs', 'settings', 'history'];
let _currentTab = null;
let _tabRefreshTimers = {};

function showTab(tabId) {
  if (_currentTab === tabId) return;
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

  // Trigger per-tab load
  loadTab(tabId);

  // Update URL hash
  location.hash = tabId;
}

window.showTab = showTab;

function loadTab(tabId) {
  clearTimeout(_tabRefreshTimers[tabId]);
  switch (tabId) {
    case 'dashboard':   loadDashboard();    break;
    case 'devices':     loadDevices();      break;
    case 'post':        loadPostForm();     break;
    case 'posts':       loadPosts();        break;
    case 'shared-folders': loadSharedFolders(); break;
    case 'storage':     loadStorage();      break;
    case 'logs':        /* live via WS */   loadLogs();   break;
    case 'settings':    loadSettings();     break;
    case 'history':     loadHistory();      break;
  }
}

// ── Authentication ─────────────────────────────────────────────────────────────

let _authenticated = false;

async function tryLogin(key) {
  setApiKey(key);
  try {
    await api.get('/api/devices');
    _authenticated = true;
    el('login-modal').classList.add('hidden');
    el('app-shell').classList.remove('hidden');
    wsConnect();
    initWebSocketListeners();
    initPendingConnectionPoller();
    showTab(location.hash.slice(1) || 'dashboard');
    return true;
  } catch (e) {
    clearApiKey();
    _authenticated = false;
    el('login-error').textContent = e.status === 403 || e.status === 401
      ? 'Invalid API key. Please try again.'
      : `Connection error: ${e.message}`;
    return false;
  }
}

function logout() {
  wsDisconnect();
  clearApiKey();
  _authenticated = false;
  el('app-shell').classList.add('hidden');
  el('login-modal').classList.remove('hidden');
  el('login-key-input').value = '';
  el('login-error').textContent = '';
}
window.logout = logout;

// ── Status Bar ─────────────────────────────────────────────────────────────────

let _wsConnected = false;

function updateStatusBar(online) {
  const dot = el('status-dot');
  const lbl = el('status-label');
  if (online) {
    dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
    lbl.textContent = 'Server Online';
  } else {
    dot.className = 'w-2.5 h-2.5 rounded-full bg-red-400';
    lbl.textContent = 'Server Offline';
  }
}

function updateWsBadge(connected) {
  _wsConnected = connected;
  const badge = el('ws-badge');
  if (!badge) return;
  badge.textContent = connected ? 'Live ●' : 'Offline ○';
  badge.className = connected
    ? 'text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-mono'
    : 'text-xs px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-400 font-mono';
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

let _dashInterval = null;

async function loadDashboard() {
  clearInterval(_dashInterval);
  await refreshDashboard();
  _dashInterval = setInterval(refreshDashboard, 15000);
}

async function refreshDashboard() {
  if (_currentTab !== 'dashboard') { clearInterval(_dashInterval); return; }
  try {
    const [statusRes, devRes] = await Promise.all([
      api.get('/api/status', { device_id: undefined }),
      api.get('/api/devices'),
    ]);
    updateStatusBar(statusRes.status === 'online');
    renderDashboard(statusRes, devRes.devices || []);
  } catch (e) {
    updateStatusBar(false);
  }
}

function renderDashboard(status, devices) {
  el('dash-version').textContent = status.server_version || '—';
  el('dash-device-count').textContent = devices.length;
  el('dash-ips').textContent = (status.all_ips || []).join(' · ') || '—';

  const activity = status.current_activity;
  el('dash-activity').textContent = activity ? activity.message : 'Idle';

  // Tailscale
  const ts = status.tailscale;
  const tsEl = el('dash-tailscale');
  if (ts && ts.ip) {
    tsEl.textContent = `${ts.ip} (${ts.hostname || ''})`;
    tsEl.parentElement.classList.remove('hidden');
  } else {
    tsEl.parentElement.classList.add('hidden');
  }

  // Device list on dashboard
  const listEl = el('dash-device-list');
  if (!listEl) return;
  listEl.innerHTML = devices.slice(0, 6).map(d => `
    <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 transition">
      <div>
        <div class="text-sm font-medium text-zinc-100">${escHtml(d.display_name || d.device_name)}</div>
        <div class="text-xs text-zinc-500">${escHtml(d.device_model || '')} · ${fmtRel(d.last_seen)}</div>
      </div>
      <div class="text-xs text-zinc-500">${escHtml(d.device_ip || '')}</div>
    </div>
  `).join('');
  if (devices.length > 6) {
    listEl.insertAdjacentHTML('beforeend', `<div class="text-center text-xs text-zinc-500 py-1">+${devices.length - 6} more devices</div>`);
  }
}

// ── Devices ────────────────────────────────────────────────────────────────────

let _devices = [];

async function loadDevices() {
  el('devices-content').innerHTML = loadingSpinner();
  try {
    const res = await api.get('/api/devices');
    _devices = res.devices || [];
    renderDevices(_devices);
  } catch (e) {
    el('devices-content').innerHTML = errorBanner(e.message);
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

  const con = el('devices-content');
  if (!filtered.length) {
    con.innerHTML = emptyState('No devices found', q ? 'Try a different search term.' : 'Connect a device from the mobile app to get started.');
    return;
  }

  con.innerHTML = filtered.map(d => {
    const name = escHtml(d.display_name || d.device_name || 'Unknown');
    const model = escHtml(d.device_model || '');
    const ip = escHtml(d.device_ip || '');
    const lastSeen = fmtRel(d.last_seen);
    const files = (d.total_files || 0).toLocaleString();
    const storage = fmtBytes(d.total_size || 0);
    const did = escHtml(d.device_id);
    return `
    <div class="card group" data-device-id="${did}">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center shrink-0 text-blue-400">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
          </div>
          <div class="min-w-0">
            <div class="font-semibold text-zinc-100 truncate">${name}</div>
            <div class="text-xs text-zinc-400">${model}${model && ip ? ' · ' : ''}${ip}</div>
          </div>
        </div>
        <div class="flex gap-2 shrink-0">
          <button onclick="openRenameDevice('${did}')" class="btn-secondary text-xs">Rename</button>
          <button onclick="confirmRevokeDevice('${did}', '${name}')" class="btn-danger text-xs">Revoke</button>
        </div>
      </div>
      <div class="mt-3 pt-3 border-t border-zinc-700/50 grid grid-cols-3 gap-2 text-xs text-zinc-400">
        <div><span class="block font-medium text-zinc-200">${files}</span>Files backed up</div>
        <div><span class="block font-medium text-zinc-200">${storage}</span>Storage used</div>
        <div><span class="block font-medium text-zinc-200">${lastSeen}</span>Last seen</div>
      </div>
    </div>`;
  }).join('');
}

window.openRenameDevice = function(deviceId) {
  const d = _devices.find(x => x.device_id === deviceId);
  if (!d) return;
  const current = d.username || d.device_name || '';
  openModal('rename-modal');
  el('rename-modal-title').textContent = `Rename: ${d.display_name || d.device_name}`;
  el('rename-input').value = current;
  el('rename-save-btn').onclick = async () => {
    const newName = el('rename-input').value.trim();
    if (!newName) return;
    try {
      await api.post(`/api/devices/${deviceId}/username`, { username: newName });
      closeModal('rename-modal');
      loadDevices();
      showToast('Device renamed successfully');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

window.confirmRevokeDevice = function(deviceId, displayName) {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Revoke Device Access';
  el('confirm-modal-body').textContent = `Remove "${displayName}" and all access permissions? This cannot be undone.`;
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Revoke Access';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.delete(`/api/devices/${deviceId}`);
      closeModal('confirm-modal');
      loadDevices();
      showToast('Device revoked');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

// ── Pending Connection Approvals ───────────────────────────────────────────────

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
  el('pairing-device-name').textContent = req.name || 'Unknown device';
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
    if (accepted) { loadDevices(); showToast('Device approved and connected'); }
    else showToast('Device rejected');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Post to Devices ────────────────────────────────────────────────────────────

let _postDevices = [];
let _postFiles = [];

async function loadPostForm() {
  try {
    const res = await api.get('/api/devices');
    _postDevices = (res.devices || []).filter(d => d.device_id !== 'desktop-server');
    renderPostDeviceSelector();
  } catch (e) {
    el('post-devices-list').innerHTML = errorBanner(e.message);
  }
}

function renderPostDeviceSelector() {
  const con = el('post-devices-list');
  const allId = 'chk-all-devices';
  con.innerHTML = `
    <label class="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-zinc-700/40 transition">
      <input type="checkbox" id="${allId}" class="rounded" onchange="toggleAllDevices(this)">
      <span class="text-sm font-medium text-zinc-200">All Devices</span>
    </label>
    ${_postDevices.map(d => `
    <label class="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-zinc-700/40 transition">
      <input type="checkbox" class="rounded device-chk" value="${escHtml(d.device_id)}">
      <span class="text-sm text-zinc-300">${escHtml(d.display_name || d.device_name)}</span>
      <span class="text-xs text-zinc-500 ml-auto">${escHtml(d.device_model || '')}</span>
    </label>`).join('')}`;
}

window.toggleAllDevices = function(cb) {
  qsa('.device-chk').forEach(c => c.checked = cb.checked);
};

// File drop zone
function initDropZone() {
  const zone = el('drop-zone');
  if (!zone) return;
  zone.addEventListener('click', () => el('post-file-input').click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('ring-2', 'ring-blue-500'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('ring-2', 'ring-blue-500'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('ring-2', 'ring-blue-500');
    handleFileSelect([...e.dataTransfer.files]);
  });
  el('post-file-input').addEventListener('change', e => handleFileSelect([...e.target.files]));
}

function handleFileSelect(files) {
  _postFiles = [..._postFiles, ...files];
  renderPostFileList();
}

function renderPostFileList() {
  const con = el('post-file-list');
  if (!_postFiles.length) { con.innerHTML = ''; return; }
  con.innerHTML = _postFiles.map((f, i) => `
    <div class="flex items-center gap-2 py-1.5 px-2 rounded bg-zinc-800/60">
      <div class="w-7 h-7 rounded bg-zinc-700 flex items-center justify-center text-xs text-zinc-400">
        ${f.type.startsWith('video/') ? '🎥' : '🖼'}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-xs text-zinc-200 truncate">${escHtml(f.name)}</div>
        <div class="text-xs text-zinc-500">${fmtBytes(f.size)}</div>
      </div>
      <button onclick="removePostFile(${i})" class="text-zinc-500 hover:text-red-400 transition text-xs">✕</button>
    </div>`).join('');
}

window.removePostFile = function(i) {
  _postFiles.splice(i, 1);
  renderPostFileList();
};

window.submitDirectPost = async function() {
  const caption = el('post-caption').value.trim();
  const selectedAll = el('chk-all-devices')?.checked;
  const selectedDevices = selectedAll
    ? _postDevices.map(d => d.device_id)
    : qsa('.device-chk:checked').map(c => c.value);

  if (!_postFiles.length) { showToast('Please select files to share', 'error'); return; }
  if (!selectedDevices.length) { showToast('Please select at least one target device', 'error'); return; }

  const btn = el('post-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Posting…';
  const bar = el('post-progress');
  bar.classList.remove('hidden');

  try {
    const form = new FormData();
    form.append('shared_by_device_id', 'desktop-server');
    form.append('target_device_ids', JSON.stringify(selectedDevices));
    form.append('caption', caption);
    _postFiles.forEach(f => form.append('files', f));

    await api.postForm('/api/share/direct-post/create', form);
    showToast(`Posted ${_postFiles.length} file(s) to ${selectedDevices.length} device(s)!`);
    _postFiles = [];
    el('post-caption').value = '';
    el('post-file-input').value = '';
    qsa('.device-chk').forEach(c => c.checked = false);
    renderPostFileList();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post to Devices';
    bar.classList.add('hidden');
  }
};

// ── Posts (Feed) ───────────────────────────────────────────────────────────────

let _postsPage = 0;
const POSTS_PAGE_SIZE = 20;
let _allPosts = [];

async function loadPosts() {
  el('posts-content').innerHTML = loadingSpinner();
  _postsPage = 0;
  _allPosts = [];
  await fetchMorePosts();
}

async function fetchMorePosts() {
  try {
    const res = await api.get('/api/feed', {
      device_id: 'desktop-server',
      offset: _postsPage * POSTS_PAGE_SIZE,
      limit: POSTS_PAGE_SIZE,
    });
    const items = res.items || [];
    _allPosts = [..._allPosts, ...items];
    renderPosts(_allPosts, res.has_more);
    if (items.length) _postsPage++;
  } catch (e) {
    el('posts-content').innerHTML = errorBanner(e.message);
  }
}

function renderPosts(posts, hasMore) {
  if (!posts.length) {
    el('posts-content').innerHTML = emptyState('No posts yet', 'Use "Post to Devices" to share photos and videos with connected devices.');
    return;
  }
  const q = (el('posts-search')?.value || '').trim().toLowerCase();
  const filtered = q ? posts.filter(p => (p.caption || '').toLowerCase().includes(q) || (p.shared_by || '').toLowerCase().includes(q)) : posts;

  el('posts-content').innerHTML = filtered.map(p => {
    const gid = p.share_group_id || p.group_id || '';
    const caption = escHtml(p.caption || p.group_caption || '');
    const by = escHtml(p.shared_by || p.shared_by_name || 'Desktop');
    const date = fmtTs(p.created_at);
    const fileCount = p.item_count || 1;
    const kind = p.post_kind || 'photo';
    const targets = (p.target_names || []).map(escHtml).join(', ') || 'All devices';
    const thumbId = p.share_id || p.id;
    const thumbUrl = thumbId ? `/api/share/${thumbId}/thumbnail?device_id=desktop-server` : null;
    return `
    <div class="card" data-group-id="${escHtml(gid)}">
      <div class="flex gap-3">
        ${thumbUrl ? `<div class="w-16 h-16 rounded-lg overflow-hidden bg-zinc-800 shrink-0 cursor-pointer" onclick="openMediaPreview(${thumbId})">
          <img src="${thumbUrl}&token=${encodeURIComponent(getApiKey())}" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='<div class=\'w-full h-full flex items-center justify-center text-2xl\'>${kind === 'video' ? '🎥' : '🖼️'}</div>'">
        </div>` : ''}
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-zinc-100 truncate">${caption || '<em class="text-zinc-500">No caption</em>'}</div>
          <div class="text-xs text-zinc-400 mt-0.5">${fileCount} file${fileCount !== 1 ? 's' : ''} · ${by} · ${date}</div>
          <div class="text-xs text-zinc-500 mt-0.5">→ ${targets}</div>
        </div>
        <div class="flex gap-2 items-start shrink-0">
          <button onclick="openEditCaption('${escHtml(gid)}')" class="btn-secondary text-xs">Edit Caption</button>
          <button onclick="confirmDeletePost('${escHtml(gid)}')" class="btn-danger text-xs">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const loadMoreBtn = el('posts-load-more');
  if (loadMoreBtn) loadMoreBtn.classList.toggle('hidden', !hasMore);
}

window.openEditCaption = function(groupId) {
  const post = _allPosts.find(p => (p.share_group_id || p.group_id) === groupId);
  openModal('caption-modal');
  el('caption-input').value = post?.caption || post?.group_caption || '';
  el('caption-save-btn').onclick = async () => {
    const caption = el('caption-input').value.trim();
    try {
      await api.post(`/api/share/group/${groupId}/edit_caption?device_id=desktop-server`, { caption });
      closeModal('caption-modal');
      loadPosts();
      showToast('Caption updated');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

window.confirmDeletePost = function(groupId) {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Delete Post';
  el('confirm-modal-body').textContent = 'Delete this post and remove it from all device feeds? This cannot be undone.';
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Delete Post';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.post(`/api/share/group/${groupId}/delete?device_id=desktop-server`);
      closeModal('confirm-modal');
      loadPosts();
      showToast('Post deleted');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

window.openMediaPreview = function(shareId) {
  const key = getApiKey();
  const url = `/api/share/${shareId}/download?device_id=desktop-server&token=${encodeURIComponent(key)}`;
  openModal('media-modal');
  const cont = el('media-modal-content');
  cont.innerHTML = `<div class="flex items-center justify-center p-4"><div class="text-zinc-400 text-sm">Loading…</div></div>`;
  // Try as image first
  const img = new Image();
  img.onload = () => {
    cont.innerHTML = `<img src="${url}" class="max-h-[70vh] max-w-full rounded-lg object-contain mx-auto">`;
  };
  img.onerror = () => {
    cont.innerHTML = `<video src="${url}" controls class="max-h-[70vh] max-w-full rounded-lg mx-auto"></video>`;
  };
  img.src = url;
};

// ── Shared Folders ─────────────────────────────────────────────────────────────

let _sharedFolders = [];

async function loadSharedFolders() {
  el('shared-content').innerHTML = loadingSpinner();
  try {
    const res = await api.get('/api/shared/list');
    _sharedFolders = res.shared_dirs || [];
    renderSharedFolders();
  } catch (e) {
    el('shared-content').innerHTML = errorBanner(e.message);
  }
}

function renderSharedFolders() {
  const con = el('shared-content');
  if (!_sharedFolders.length) {
    con.innerHTML = emptyState('No shared folders', 'Add shared folder paths in Settings to make them visible to devices.');
    return;
  }
  con.innerHTML = _sharedFolders.map((d, i) => {
    const label = escHtml(d.label || d.path || d.id);
    const path = escHtml(d.path || '');
    const tags = (d.device_ids || ['all']);
    const tagStr = tags.includes('all') || !tags.length ? 'All Devices' : tags.join(', ');
    return `
    <div class="card">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
          </div>
          <div class="min-w-0">
            <div class="font-medium text-zinc-100 truncate">${label}</div>
            <div class="text-xs text-zinc-500 truncate">${path}</div>
          </div>
        </div>
        <div class="text-xs text-zinc-400 px-2 py-1 rounded bg-zinc-800">→ ${escHtml(tagStr)}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Storage ────────────────────────────────────────────────────────────────────

async function loadStorage() {
  el('storage-content').innerHTML = loadingSpinner();
  try {
    const devRes = await api.get('/api/devices');
    const devices = devRes.devices || [];
    renderStorageBreakdown(devices);
  } catch (e) {
    el('storage-content').innerHTML = errorBanner(e.message);
  }
}

function renderStorageBreakdown(devices) {
  const totalFiles = devices.reduce((s, d) => s + (d.total_files || 0), 0);
  const totalBytes = devices.reduce((s, d) => s + (d.total_size || 0), 0);

  el('storage-content').innerHTML = `
    <div class="grid grid-cols-2 gap-4 mb-6">
      <div class="card text-center">
        <div class="text-3xl font-bold text-blue-400">${fmtBytes(totalBytes)}</div>
        <div class="text-xs text-zinc-400 mt-1">Total backup storage used</div>
      </div>
      <div class="card text-center">
        <div class="text-3xl font-bold text-emerald-400">${totalFiles.toLocaleString()}</div>
        <div class="text-xs text-zinc-400 mt-1">Total files backed up</div>
      </div>
    </div>
    <div class="card mb-4">
      <div class="text-sm font-semibold text-zinc-200 mb-3">Storage by Device</div>
      ${devices.length === 0 ? '<div class="text-zinc-500 text-sm">No devices.</div>' : devices.map(d => {
        const pct = totalBytes > 0 ? Math.round((d.total_size || 0) / totalBytes * 100) : 0;
        return `
        <div class="mb-3">
          <div class="flex justify-between text-xs text-zinc-300 mb-1">
            <span>${escHtml(d.display_name || d.device_name)}</span>
            <span>${fmtBytes(d.total_size || 0)} · ${(d.total_files || 0).toLocaleString()} files</span>
          </div>
          <div class="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div class="h-full bg-blue-500 rounded-full transition-all" style="width:${pct}%"></div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="card">
      <div class="text-sm font-semibold text-zinc-200 mb-3">Phone Cleanup Audit</div>
      <p class="text-xs text-zinc-400 mb-3">Files that are safely backed up and can be cleaned from phone storage. Select a device to analyze.</p>
      <div class="flex gap-2 flex-wrap">
        ${devices.map(d => `
        <button onclick="loadCleanupCandidates('${escHtml(d.device_id)}')"
          class="btn-secondary text-xs">${escHtml(d.display_name || d.device_name)}</button>`).join('')}
      </div>
      <div id="cleanup-results" class="mt-4"></div>
    </div>`;
}

window.loadCleanupCandidates = async function(deviceId) {
  const con = el('cleanup-results');
  con.innerHTML = loadingSpinner('text-sm');
  try {
    const res = await api.get('/api/cleanup/candidates', { source_id: deviceId });
    const candidates = res.candidates || [];
    if (!candidates.length) {
      con.innerHTML = '<div class="text-xs text-zinc-400 py-2">No cleanup candidates found — all backed up files are already clean.</div>';
      return;
    }
    con.innerHTML = `
      <div class="text-xs text-zinc-300 mb-2">${res.count} files · ${fmtBytes(res.total_size)} can be freed</div>
      <div class="max-h-48 overflow-y-auto space-y-1 mb-3">
        ${candidates.slice(0, 50).map(c => `
        <div class="flex justify-between text-xs px-2 py-1 rounded bg-zinc-800/60">
          <span class="text-zinc-300 truncate">${escHtml(c.path || c.relative_path || '')}</span>
          <span class="text-zinc-500 ml-2 shrink-0">${fmtBytes(c.size || 0)}</span>
        </div>`).join('')}
        ${candidates.length > 50 ? `<div class="text-xs text-zinc-500 text-center py-1">+${candidates.length - 50} more</div>` : ''}
      </div>
      <div class="text-xs text-zinc-500">Cleanup is performed from the mobile app. This is a read-only audit view.</div>`;
  } catch (e) {
    con.innerHTML = errorBanner(e.message, 'sm');
  }
};

// ── Live Logs ──────────────────────────────────────────────────────────────────

let _logLines = [];
const MAX_LOG_LINES = 500;
let _logFilter = '';
let _logAutoScroll = true;

async function loadLogs() {
  // Fetch existing logs from API
  try {
    const res = await api.get('/api/logs');
    const logs = res.logs || [];
    _logLines = logs.map(l => ({ time: l.time, message: l.message, level: detectLevel(l.message) }));
    renderLogLines();
  } catch (_) {}
}

window.addEventListener('ws:log', e => {
  const { message, time } = e.detail;
  _logLines.push({ time, message, level: detectLevel(message) });
  if (_logLines.length > MAX_LOG_LINES) _logLines.shift();
  appendLogLine(_logLines[_logLines.length - 1]);
});

function detectLevel(msg) {
  if (!msg) return 'info';
  const m = msg.toLowerCase();
  if (m.includes('error') || m.includes('❌') || m.includes('failed') || m.includes('exception')) return 'error';
  if (m.includes('warn') || m.includes('⚠️')) return 'warn';
  return 'info';
}

function logLineHtml(entry) {
  const t = new Date(entry.time * 1000).toLocaleTimeString();
  const cls = entry.level === 'error' ? 'text-red-400' : entry.level === 'warn' ? 'text-amber-400' : 'text-emerald-400';
  return `<div class="flex gap-2 text-xs font-mono leading-5">
    <span class="text-zinc-500 shrink-0">${t}</span>
    <span class="${cls}">${escHtml(entry.message)}</span>
  </div>`;
}

function renderLogLines() {
  const con = el('log-output');
  if (!con) return;
  const filter = _logFilter.toLowerCase();
  const visible = filter ? _logLines.filter(l => l.message.toLowerCase().includes(filter) || l.level === filter) : _logLines;
  con.innerHTML = visible.map(logLineHtml).join('');
  if (_logAutoScroll) con.scrollTop = con.scrollHeight;
}

function appendLogLine(entry) {
  const con = el('log-output');
  if (!con) return;
  const filter = _logFilter.toLowerCase();
  if (filter && !entry.message.toLowerCase().includes(filter)) return;
  con.insertAdjacentHTML('beforeend', logLineHtml(entry));
  if (_logAutoScroll) con.scrollTop = con.scrollHeight;
}

window.clearLogs = async function() {
  try {
    await api.post('/api/logs/clear');
    _logLines = [];
    renderLogLines();
    showToast('Logs cleared');
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.setLogFilter = function(val) {
  _logFilter = val;
  renderLogLines();
};

window.toggleAutoScroll = function(cb) {
  _logAutoScroll = cb.checked;
};

// ── Settings ───────────────────────────────────────────────────────────────────

let _settingsConfig = {};

async function loadSettings() {
  el('settings-content').innerHTML = loadingSpinner();
  try {
    const res = await api.get('/api/config');
    _settingsConfig = res.config || res;
    renderSettings();
  } catch (e) {
    el('settings-content').innerHTML = errorBanner(e.message);
  }
}

function renderSettings() {
  const c = _settingsConfig;
  el('settings-content').innerHTML = `
    <div class="space-y-5">
      <div class="card">
        <div class="section-header mb-3">Server</div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label">Host</label>
            <input id="cfg-host" class="input" value="${escHtml(c.HOST || '0.0.0.0')}">
          </div>
          <div>
            <label class="label">Port</label>
            <input id="cfg-port" type="number" class="input" value="${escHtml(String(c.PORT || 8000))}">
          </div>
          <div class="col-span-2">
            <label class="label">Desktop / Server Display Name</label>
            <input id="cfg-desktop-name" class="input" value="${escHtml(c.DESKTOP_NAME || '')}">
          </div>
        </div>
      </div>

      <div class="card">
        <div class="section-header mb-3">Storage</div>
        <div>
          <label class="label">Backup Root Directory</label>
          <input id="cfg-backup-root" class="input" value="${escHtml(c.BACKUP_ROOT || '')}">
        </div>
      </div>

      <div class="card">
        <div class="section-header mb-3">Security</div>
        <div>
          <label class="label">API Secret Key</label>
          <div class="flex gap-2">
            <input id="cfg-api-key" type="password" class="input flex-1" value="${escHtml(c.API_KEY || '')}">
            <button onclick="toggleApiKeyVis()" class="btn-secondary text-xs shrink-0" id="api-key-vis-btn">Show</button>
          </div>
        </div>
        <div class="mt-3 flex items-center gap-3">
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" id="cfg-require-approval" class="sr-only peer" ${c.REQUIRE_APPROVAL ? 'checked' : ''}>
            <div class="w-10 h-5 bg-zinc-600 rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5"></div>
          </label>
          <span class="text-sm text-zinc-300">Require approval for new device connections</span>
        </div>
      </div>

      <div class="card">
        <div class="section-header mb-3">Shared Folders</div>
        <p class="text-xs text-zinc-400 mb-3">Folders added here are visible to connected devices through the Files tab. Changes require server restart.</p>
        <div id="shared-dirs-list" class="space-y-2 mb-3">
          ${(c.SHARED_DIRS || []).map((d, i) => `
          <div class="flex gap-2 items-center" data-shared-idx="${i}">
            <input class="input flex-1 text-xs" value="${escHtml(d.label || d.path || '')}" placeholder="Label" data-field="label" data-idx="${i}">
            <input class="input flex-1 text-xs" value="${escHtml(d.path || '')}" placeholder="/path/to/folder" data-field="path" data-idx="${i}">
            <button onclick="removeSharedDir(${i})" class="btn-danger text-xs shrink-0">Remove</button>
          </div>`).join('')}
        </div>
        <button onclick="addSharedDir()" class="btn-secondary text-xs">+ Add Folder</button>
      </div>

      <button onclick="saveSettings()" class="btn-primary w-full py-3">Save Settings & Restart Server</button>
      <p class="text-xs text-zinc-500 text-center">Server will restart automatically to apply network and security changes.</p>
    </div>`;
}

window.toggleApiKeyVis = function() {
  const inp = el('cfg-api-key');
  const btn = el('api-key-vis-btn');
  const hidden = inp.type === 'password';
  inp.type = hidden ? 'text' : 'password';
  btn.textContent = hidden ? 'Hide' : 'Show';
};

window.addSharedDir = function() {
  _settingsConfig.SHARED_DIRS = _settingsConfig.SHARED_DIRS || [];
  _settingsConfig.SHARED_DIRS.push({ id: `shared_${Date.now()}`, label: '', path: '' });
  renderSettings();
};

window.removeSharedDir = function(i) {
  (_settingsConfig.SHARED_DIRS || []).splice(i, 1);
  renderSettings();
};

window.saveSettings = async function() {
  // Collect shared dirs from DOM
  const dirs = [];
  qsa('[data-shared-idx]').forEach(row => {
    const idx = parseInt(row.dataset.sharedIdx);
    const existing = (_settingsConfig.SHARED_DIRS || [])[idx] || {};
    const label = row.querySelector('[data-field="label"]')?.value.trim() || '';
    const path = row.querySelector('[data-field="path"]')?.value.trim() || '';
    if (path) dirs.push({ ...existing, label, path });
  });

  const payload = {
    ..._settingsConfig,
    HOST: el('cfg-host')?.value.trim() || '0.0.0.0',
    PORT: parseInt(el('cfg-port')?.value || '8000'),
    DESKTOP_NAME: el('cfg-desktop-name')?.value.trim() || '',
    BACKUP_ROOT: el('cfg-backup-root')?.value.trim() || '',
    API_KEY: el('cfg-api-key')?.value.trim() || _settingsConfig.API_KEY,
    REQUIRE_APPROVAL: el('cfg-require-approval')?.checked ?? true,
    SHARED_DIRS: dirs,
  };

  try {
    await api.post('/api/config', payload);
    showToast('Settings saved. Server is restarting…');
    // If API key changed, update local storage
    if (payload.API_KEY !== _settingsConfig.API_KEY) {
      setApiKey(payload.API_KEY);
    }
    setTimeout(loadSettings, 2000);
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// ── Sync History ───────────────────────────────────────────────────────────────

let _histPage = 0;
const HIST_PAGE_SIZE = 30;
let _allHistory = [];

async function loadHistory() {
  el('history-content').innerHTML = loadingSpinner();
  _histPage = 0;
  _allHistory = [];
  await fetchMoreHistory();
}

async function fetchMoreHistory() {
  try {
    const res = await api.get('/api/sync/history', {
      offset: _histPage * HIST_PAGE_SIZE,
      limit: HIST_PAGE_SIZE,
    });
    const sessions = res.sessions || [];
    _allHistory = [..._allHistory, ...sessions];
    renderHistory(_allHistory, res.has_more);
    if (sessions.length) _histPage++;
  } catch (e) {
    el('history-content').innerHTML = errorBanner(e.message);
  }
}

function renderHistory(sessions, hasMore) {
  if (!sessions.length) {
    el('history-content').innerHTML = emptyState('No sync history yet', 'Sync sessions will appear here after devices back up files.');
    return;
  }
  el('history-content').innerHTML = `
    <table class="w-full text-sm text-left">
      <thead>
        <tr class="text-xs text-zinc-500 border-b border-zinc-700">
          <th class="pb-2 font-medium">Device</th>
          <th class="pb-2 font-medium">Files</th>
          <th class="pb-2 font-medium">Size</th>
          <th class="pb-2 font-medium">Time</th>
          <th class="pb-2 font-medium">Duration</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-zinc-800">
        ${sessions.map(s => `
        <tr class="hover:bg-zinc-800/40 transition">
          <td class="py-2 pr-3 font-medium text-zinc-200">${escHtml(s.device_name || s.device_id || '—')}</td>
          <td class="py-2 pr-3 text-zinc-300">${(s.file_count || 0).toLocaleString()}</td>
          <td class="py-2 pr-3 text-zinc-300">${fmtBytes(s.total_bytes || 0)}</td>
          <td class="py-2 pr-3 text-zinc-400">${fmtTs(s.started_at)}</td>
          <td class="py-2 text-zinc-400">${s.duration_seconds ? `${Math.round(s.duration_seconds)}s` : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  const btn = el('history-load-more');
  if (btn) btn.classList.toggle('hidden', !hasMore);
}

window.clearSyncHistory = async function() {
  openModal('confirm-modal');
  el('confirm-modal-title').textContent = 'Clear Sync History';
  el('confirm-modal-body').textContent = 'Remove all sync session history records? Backed-up files are not affected.';
  el('confirm-ok-btn').className = 'btn-danger';
  el('confirm-ok-btn').textContent = 'Clear History';
  el('confirm-ok-btn').onclick = async () => {
    try {
      await api.post('/api/sync/history/clear');
      closeModal('confirm-modal');
      loadHistory();
      showToast('Sync history cleared');
    } catch (e) {
      showToast(e.message, 'error');
    }
  };
};

// ── WebSocket listeners ────────────────────────────────────────────────────────

function initWebSocketListeners() {
  window.addEventListener('ws:connected', () => updateWsBadge(true));
  window.addEventListener('ws:disconnected', () => updateWsBadge(false));
}

// ── Modal system ───────────────────────────────────────────────────────────────

function openModal(id) {
  el(id)?.classList.remove('hidden');
  el(id)?.classList.add('flex');
}

function closeModal(id) {
  el(id)?.classList.remove('flex');
  el(id)?.classList.add('hidden');
}

window.openModal = openModal;
window.closeModal = closeModal;

// Close modal on backdrop click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.remove('flex');
    e.target.classList.add('hidden');
  }
});

// ── Toast notifications ────────────────────────────────────────────────────────

function showToast(message, type = 'success') {
  const container = el('toast-container');
  const toast = document.createElement('div');
  const color = type === 'error' ? 'bg-red-500/90' : type === 'warn' ? 'bg-amber-500/90' : 'bg-emerald-600/90';
  toast.className = `${color} text-white text-sm px-4 py-2.5 rounded-lg shadow-lg backdrop-blur-sm transition-all duration-300 max-w-xs`;
  toast.textContent = message;
  container?.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
}
window.showToast = showToast;

// ── UI primitives ──────────────────────────────────────────────────────────────

function loadingSpinner(size = '') {
  return `<div class="flex items-center justify-center py-12 text-zinc-500 gap-2">
    <svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
    <span class="text-sm">Loading…</span>
  </div>`;
}

function emptyState(title, subtitle = '') {
  return `<div class="flex flex-col items-center justify-center py-16 text-center gap-2">
    <div class="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mb-1">
      <svg class="w-6 h-6 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0H4"/></svg>
    </div>
    <div class="text-zinc-300 font-medium">${title}</div>
    ${subtitle ? `<div class="text-sm text-zinc-500 max-w-xs">${subtitle}</div>` : ''}
  </div>`;
}

function errorBanner(msg, size = '') {
  return `<div class="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
    <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"/></svg>
    ${escHtml(msg)}
  </div>`;
}

// ── Search bindings ────────────────────────────────────────────────────────────

function bindSearch(inputId, fn) {
  const inp = el(inputId);
  if (!inp) return;
  let timer;
  inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(fn, 250); });
}

// ── Boot ───────────────────────────────────────────────────────────────────────

async function boot() {
  // Wire up nav buttons
  qsa('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Wire up login form
  el('login-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const key = el('login-key-input').value.trim();
    if (!key) { el('login-error').textContent = 'Please enter your API key.'; return; }
    el('login-btn').disabled = true;
    el('login-btn').textContent = 'Connecting…';
    await tryLogin(key);
    el('login-btn').disabled = false;
    el('login-btn').textContent = 'Login';
  });

  // Search bindings
  bindSearch('devices-search', () => renderDevices(_devices));
  bindSearch('posts-search', () => renderPosts(_allPosts, false));

  // Drop zone
  initDropZone();

  // Auto-login if key is stored
  const stored = getApiKey();
  if (stored) {
    const ok = await tryLogin(stored);
    if (!ok) {
      el('login-error').textContent = 'Saved API key is invalid. Please log in again.';
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
