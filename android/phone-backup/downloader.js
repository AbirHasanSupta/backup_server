// ─────────────────────────────────────────────────────────────────────────────
// Fast UI In-Memory SWR Cache (Parallel Instant Navigation)
// ─────────────────────────────────────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  getServerIp,
  getServerPort,
  getApiKey,
  getDeviceId,
  getDeviceToken,
  resolveReachableServer,
  formatHostForUrl,
  formatDisplayName,
} from './settings';
import { DeviceEventEmitter, NativeModules } from 'react-native';
import { getPairedPeers, getLocalP2PFeed, saveP2PFeedItem, getLocalPeerIdentity, deleteP2PFeedItem } from './p2pSettings';
import { sendDirectShareToPeer, sendDirectReaction, sendDirectComment } from './p2pClient';
import { isServerMode, setServerAvailable } from './connectionMode';

const P2PServerModule = NativeModules.PhoneBackupP2PServer;
const DRIVE_SOURCES_KEY = 'google_drive_shared_folders_v1';
const DRIVE_API_KEY_STORAGE_KEY = 'google_drive_api_key_v1';
const DRIVE_EXPORT_FORMATS = {
  'application/vnd.google-apps.document': ['application/pdf', '.pdf'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  'application/vnd.google-apps.drawing': ['application/pdf', '.pdf'],
};
let DRIVE_API_KEY = Constants.expoConfig?.extra?.googleDriveApiKey || '';

async function getDriveApiKey() {
  if (DRIVE_API_KEY) return DRIVE_API_KEY;
  DRIVE_API_KEY = (await AsyncStorage.getItem(DRIVE_API_KEY_STORAGE_KEY)) || '';
  return DRIVE_API_KEY;
}

function driveFolderId(link) {
  const value = String(link || '').trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  const match = value.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('Enter a Google Drive folder link.');
  return match[1];
}

async function driveRequest(path, params = {}) {
  const apiKey = await getDriveApiKey();
  if (!apiKey) throw new Error('To use a Drive folder without a connected server, add a Google Drive API key below.');
  const query = new URLSearchParams({ ...params, key: apiKey }).toString();
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}?${query}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Google Drive request failed (${response.status}).`);
  return body;
}

async function getLocalDriveSources() {
  try {
    const value = JSON.parse((await AsyncStorage.getItem(DRIVE_SOURCES_KEY)) || '[]');
    return Array.isArray(value) ? value.filter(s => s && typeof s.id === 'string' && typeof s.folderId === 'string') : [];
  }
  catch { return []; }
}

export async function getLocalDriveSharedSources() {
  const sources = await getLocalDriveSources();
  let changed = false;
  await Promise.all(sources.map(async source => {
    if (String(source.label || '').trim().toLowerCase() !== 'google drive folder') return;
    try {
      const metadata = await driveRequest(`files/${encodeURIComponent(source.folderId)}`, {
        fields: 'id,name,mimeType', supportsAllDrives: 'true',
      });
      if (metadata.name) {
        source.label = metadata.name;
        changed = true;
      }
    } catch {
      // Keep the saved entry visible even if Drive is temporarily unavailable.
    }
  }));
  if (changed) {
    await AsyncStorage.setItem(DRIVE_SOURCES_KEY, JSON.stringify(sources)).catch(() => {});
  }
  return sources.map(s => ({
    id: s.id, label: s.label, type: 'google_drive', local: true,
    drive_folder_id: s.folderId,
  }));
}

async function listDriveChildren(folderId) {
  const output = [];
  let pageToken;
  do {
    const page = await driveRequest('files', {
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    output.push(...(page.files || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return output;
}

const _uiMemoryCache = {
  feed: null,
  reelsFeed: {},
  browse: {},
  browseShared: {},
  recentMemories: {},
  todaysMemories: null,
  /** YYYY-MM-DD of the phone calendar when memories cache was filled. */
  _memoriesDateKey: null,
  placeClusters: null,
  placeItems: {},
  quizRound: null,
  roulette: null,
  wrapped: {},
  trips: {},
  tripMedia: {},
};

const PLACES_DISK_KEY = 'places_trips_cache_v1:clusters';
const PLACE_ITEMS_DISK_PREFIX = 'places_trips_cache_v1:items:';
const TRIPS_DISK_PREFIX = 'places_trips_cache_v1:trips:';
const TRIP_MEDIA_DISK_PREFIX = 'places_trips_cache_v1:trip_media:';

let _placesTripsHydratePromise = null;
let _placesTripsHydrateGen = 0;

function _persistJson(key, value) {
  AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {});
}

function _removeDiskKey(key) {
  AsyncStorage.removeItem(key).catch(() => {});
}

async function _readJson(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function _clearDiskByPrefixes(prefixes, exactKeys = []) {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const toRemove = allKeys.filter(
      (k) => exactKeys.includes(k) || prefixes.some((p) => k.startsWith(p)),
    );
    if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
  } catch {
    for (const k of exactKeys) _removeDiskKey(k);
  }
}

/**
 * Hydrate places/trips memory cache from AsyncStorage (survives app restart).
 * Safe to call repeatedly; only one disk load runs at a time.
 * Invalidate bumps the generation so an in-flight hydrate cannot restore stale data.
 */
export function hydratePlacesTripsCache() {
  if (_placesTripsHydratePromise) return _placesTripsHydratePromise;
  const gen = _placesTripsHydrateGen;
  _placesTripsHydratePromise = (async () => {
    try {
      const clusters = await _readJson(PLACES_DISK_KEY);
      if (gen !== _placesTripsHydrateGen) return null;
      if (clusters && Array.isArray(clusters.places) && !_uiMemoryCache.placeClusters) {
        _uiMemoryCache.placeClusters = clusters;
      }

      const allKeys = await AsyncStorage.getAllKeys().catch(() => []);
      if (gen !== _placesTripsHydrateGen) return null;

      const itemKeys = allKeys.filter((k) => k.startsWith(PLACE_ITEMS_DISK_PREFIX));
      const tripKeys = allKeys.filter((k) => k.startsWith(TRIPS_DISK_PREFIX));
      const mediaKeys = allKeys.filter((k) => k.startsWith(TRIP_MEDIA_DISK_PREFIX));

      if (itemKeys.length) {
        const pairs = await AsyncStorage.multiGet(itemKeys);
        if (gen !== _placesTripsHydrateGen) return null;
        for (const [key, raw] of pairs) {
          if (!raw) continue;
          try {
            const clusterKey = key.slice(PLACE_ITEMS_DISK_PREFIX.length);
            if (!_uiMemoryCache.placeItems[clusterKey]) {
              _uiMemoryCache.placeItems[clusterKey] = JSON.parse(raw);
            }
          } catch { /* ignore corrupt entries */ }
        }
      }

      if (tripKeys.length) {
        const pairs = await AsyncStorage.multiGet(tripKeys);
        if (gen !== _placesTripsHydrateGen) return null;
        for (const [key, raw] of pairs) {
          if (!raw) continue;
          try {
            let sourceId = key.slice(TRIPS_DISK_PREFIX.length);
            if (sourceId === '_default') sourceId = '';
            const parsed = JSON.parse(raw);
            if (!_uiMemoryCache.trips[sourceId]) {
              _uiMemoryCache.trips[sourceId] = parsed;
            }
            if (sourceId && !_uiMemoryCache.trips['']) {
              _uiMemoryCache.trips[''] = parsed;
            }
          } catch { /* ignore */ }
        }
      }

      if (mediaKeys.length) {
        const pairs = await AsyncStorage.multiGet(mediaKeys);
        if (gen !== _placesTripsHydrateGen) return null;
        for (const [key, raw] of pairs) {
          if (!raw) continue;
          try {
            const tripId = key.slice(TRIP_MEDIA_DISK_PREFIX.length);
            if (!_uiMemoryCache.tripMedia[tripId]) {
              _uiMemoryCache.tripMedia[tripId] = JSON.parse(raw);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.warn('[Downloader] Places/trips cache hydrate failed:', err);
    }
    if (gen !== _placesTripsHydrateGen) return null;
    return {
      placeClusters: _uiMemoryCache.placeClusters,
      trips: _uiMemoryCache.trips[''] || Object.values(_uiMemoryCache.trips)[0] || null,
    };
  })();
  return _placesTripsHydratePromise;
}

/** Clear detail caches only (keep list caches). Used after a successful list refresh. */
export async function invalidatePlacesTripsDetailCache() {
  _uiMemoryCache.placeItems = {};
  _uiMemoryCache.tripMedia = {};
  await _clearDiskByPrefixes([PLACE_ITEMS_DISK_PREFIX, TRIP_MEDIA_DISK_PREFIX]);
}

/** Clear in-memory + disk places/trips caches. */
export async function invalidatePlacesTripsCache() {
  _placesTripsHydrateGen += 1;
  _placesTripsHydratePromise = null;
  _uiMemoryCache.placeClusters = null;
  _uiMemoryCache.placeItems = {};
  _uiMemoryCache.trips = {};
  _uiMemoryCache.tripMedia = {};
  await _clearDiskByPrefixes(
    [PLACE_ITEMS_DISK_PREFIX, TRIPS_DISK_PREFIX, TRIP_MEDIA_DISK_PREFIX],
    [PLACES_DISK_KEY],
  );
}

export function getCachedFeed() {
  return _uiMemoryCache.feed;
}

export function invalidateFeedCache() {
  _uiMemoryCache.feed = null;
  _uiMemoryCache.reelsFeed = {};
}

export function getCachedReelsFeed(section = 'for-you') {
  return _uiMemoryCache.reelsFeed[section] || null;
}

export function getCachedBrowseFiles(prefix = '') {
  return _uiMemoryCache.browse[prefix] || null;
}

export function getCachedBrowseSharedFiles(sourceId, prefix = '') {
  const key = `${sourceId}:${prefix}`;
  return _uiMemoryCache.browseShared[key] || null;
}

export function getCachedRecentMemories(days = 7) {
  _ensureMemoriesCacheFresh();
  return _uiMemoryCache.recentMemories[days] || null;
}

export function getCachedTodaysMemories() {
  _ensureMemoriesCacheFresh();
  return _uiMemoryCache.todaysMemories;
}

export function invalidateMemoriesCache() {
  _uiMemoryCache.recentMemories = {};
  _uiMemoryCache.todaysMemories = null;
  _uiMemoryCache._memoriesDateKey = null;
}

function _localDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Query params so Docker (often UTC) resolves On-This-Day on the phone's calendar. */
function _clientCalendarQuery() {
  const localDate = _localDateKey();
  const tzOffset = new Date().getTimezoneOffset();
  return `local_date=${encodeURIComponent(localDate)}&tz_offset_minutes=${encodeURIComponent(tzOffset)}`;
}

function _ensureMemoriesCacheFresh() {
  const key = _localDateKey();
  if (_uiMemoryCache._memoriesDateKey !== key) {
    // Drop yesterday's payload, but do NOT stamp the new date key until a
    // successful fetch — otherwise a failed midnight refresh looks "fresh"
    // with an empty cache and silent focus reloads stop retrying meaningfully.
    _uiMemoryCache.recentMemories = {};
    _uiMemoryCache.todaysMemories = null;
  }
}

export function getCachedPlaceClusters() {
  return _uiMemoryCache.placeClusters;
}

export function getCachedPlaceItems(clusterKey) {
  return _uiMemoryCache.placeItems[clusterKey] || null;
}

export function getCachedQuizRound() {
  return _uiMemoryCache.quizRound;
}

export function getCachedRouletteItem() {
  return _uiMemoryCache.roulette;
}

export function getCachedYearWrapped(year) {
  return _uiMemoryCache.wrapped[year] || null;
}

export function getCachedTrips(sourceId = '') {
  return _uiMemoryCache.trips[sourceId] || null;
}

export function getCachedTripMedia(tripId) {
  return _uiMemoryCache.tripMedia[tripId] || _uiMemoryCache.tripMedia[String(tripId)] || null;
}

export async function getConfig() {
  const [rawIp, port, apiKey, deviceId, deviceToken] = await Promise.all([
    getServerIp(), getServerPort(), getApiKey(), getDeviceId(), getDeviceToken(),
  ]);
  const ip = formatHostForUrl(rawIp);
  return { ip, rawIp, port, key: deviceToken || apiKey, deviceId };
}

export function buildPreviewUrl(config, relativePath, sourceMode, sourceId) {
  if (sourceMode === 'shared' && isLocalDriveSource(sourceId)) {
    const fileId = String(relativePath).split('/')[0];
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
  }
  if (!config || !config.ip || !config.port) return '';
  const host = formatHostForUrl(config.ip);
  if (sourceMode === 'shared' && sourceId) {
    return `http://${host}:${config.port}/shared/${encodeURIComponent(sourceId)}/download?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
  }
  return `http://${host}:${config.port}/files/download?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildVideoPreviewUrl(config, relativePath, sourceMode, sourceId) {
  if (sourceMode === 'shared' && isLocalDriveSource(sourceId)) {
    const fileId = String(relativePath).split('/')[0];
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(DRIVE_API_KEY)}`;
  }
  if (!config || !config.ip || !config.port) return '';
  const host = formatHostForUrl(config.ip);
  if (sourceMode === 'shared' && sourceId) {
    return `http://${host}:${config.port}/shared/${encodeURIComponent(sourceId)}/preview?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
  }
  return `http://${host}:${config.port}/files/preview?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildThumbnailUrl(config, relativePath, sourceMode, sourceId) {
  if (sourceMode === 'shared' && isLocalDriveSource(sourceId)) {
    const fileId = String(relativePath).split('/')[0];
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w640`;
  }
  if (!config || !config.ip || !config.port) return '';
  const host = formatHostForUrl(config.ip);
  if (sourceMode === 'shared' && sourceId) {
    return `http://${host}:${config.port}/shared/${encodeURIComponent(sourceId)}/thumbnail?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
  }
  return `http://${host}:${config.port}/files/thumbnail?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

// Device-to-device share serving — addressed by share_id (no relative_path exposed).
export function buildShareDownloadUrl(config, shareId) {
  if (!config || !config.ip || !config.port) return '';
  const host = formatHostForUrl(config.ip);
  return `http://${host}:${config.port}/share/${encodeURIComponent(shareId)}/download?device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildSharePreviewUrl(config, shareId) {
  if (typeof shareId === 'string' && (shareId.startsWith('file:') || shareId.startsWith('content:') || shareId.startsWith('http:') || shareId.startsWith('https:'))) {
    return shareId;
  }
  if (!config || !config.ip || !config.port) return '';
  const host = formatHostForUrl(config.ip);
  return `http://${host}:${config.port}/share/${encodeURIComponent(shareId)}/preview?device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildShareThumbnailUrl(config, shareId) {
  if (typeof shareId === 'string' && (shareId.startsWith('file:') || shareId.startsWith('content:') || shareId.startsWith('http:') || shareId.startsWith('https:'))) {
    return shareId;
  }
  if (!config || !config.ip || !config.port) return '';
  const host = formatHostForUrl(config.ip);
  return `http://${host}:${config.port}/share/${encodeURIComponent(shareId)}/thumbnail?device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export async function warmVideoPreviews(relativePaths, sourceMode, sourceId) {
  if (!relativePaths || relativePaths.length === 0) return { ok: true, scheduled: 0 };
  if (sourceMode === 'shared' && isLocalDriveSource(sourceId)) return { ok: true, scheduled: 0 };
  const { ip, port, key, deviceId } = await getConfig();

  const basePath = (sourceMode === 'shared' && sourceId)
    ? `/shared/${encodeURIComponent(sourceId)}/warm_previews`
    : `/files/warm_previews`;

  const url = `http://${ip}:${port}${basePath}?device_id=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relative_paths: relativePaths }),
  });

  // Endpoint schedules work in background and should return quickly.
  try {
    return await res.json();
  } catch {
    return { ok: res.ok, scheduled: 0 };
  }
}


function isNetworkFailure(err) {
  // AbortError covers both explicit aborts and our timeout-triggered aborts.
  if (err?.name === 'AbortError') return true;
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('network') || msg.includes('fetch failed') || msg.includes('failed to fetch')
    || msg.includes('unknownhost') || msg.includes('econnrefused') || msg.includes('enotfound')
    || msg.includes('connection abort') || msg.includes('timeout') || msg.includes('timed out');
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new Error('Request timed out — server is busy, try again.');
    if (isNetworkFailure(err)) throw new Error("Can't reach the server. Check it's running and you're on the right network.");
    throw err;
  }
}

/**
 * Mesh-aware fetch wrapper.
 * On a network-level failure (not an HTTP error), attempts multi-pass mesh
 * re-discovery and retries with the newly resolved IP.
 *
 * @param {() => Promise<{url: string, options?: object}>} buildRequest
 *   Async factory that reads the CURRENT config and returns { url, options }.
 *   Called on each attempt so the URL always uses the most-recently committed IP.
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<any>} — parsed JSON
 */
async function fetchJsonWithMeshRetry(buildRequest, timeoutMs = 15000) {
  const attempt = async () => {
    const { url, options = {} } = await buildRequest();
    return fetchJsonWithTimeout(url, options, timeoutMs);
  };

  try {
    return await attempt();
  } catch (firstErr) {
    if (!isNetworkFailure(firstErr)) throw firstErr;

    // Pass 1: Quick mesh failover resolution
    console.log('[Downloader] Network failure. Attempting mesh failover resolution (pass 1)...');
    await new Promise((r) => setTimeout(r, 300));
    let resolved = await resolveReachableServer({ timeoutMs: 2000 }).catch(() => ({ ok: false }));
    if (resolved.ok) {
      try {
        return await attempt();
      } catch (retryErr) {
        if (!isNetworkFailure(retryErr)) throw retryErr;
      }
    }

    // Pass 2: Forced mesh failover resolution with sweep
    console.log('[Downloader] Attempting forced mesh failover resolution (pass 2)...');
    await new Promise((r) => setTimeout(r, 800));
    resolved = await resolveReachableServer({ force: true, timeoutMs: 2500, subnetSweep: true }).catch(() => ({ ok: false }));
    if (resolved.ok) {
      return await attempt();
    }

    throw firstErr;
  }
}

export async function withDownloadMeshRetry(downloadAttempt) {
  try {
    return await downloadAttempt();
  } catch (err) {
    if (isNetworkFailure(err)) {
      await new Promise((r) => setTimeout(r, 300));
      let resolved = await resolveReachableServer({ timeoutMs: 2000 }).catch(() => ({ ok: false }));
      if (resolved.ok) {
        try {
          return await downloadAttempt();
        } catch (retryErr) {
          if (!isNetworkFailure(retryErr)) throw retryErr;
        }
      }

      await new Promise((r) => setTimeout(r, 800));
      resolved = await resolveReachableServer({ force: true, timeoutMs: 2500, subnetSweep: true }).catch(() => ({ ok: false }));
      if (resolved.ok) {
        return await downloadAttempt();
      }
    }
    throw err;
  }
}

export async function listSharedSources() {
  const localSources = await getLocalDriveSources();
  const localEntries = localSources.map(s => ({ id: s.id, label: s.label, type: 'google_drive', local: true }));
  if (!(await isServerMode())) return localEntries;
  if (!(await getServerIp())) return localEntries;
  try {
    const remote = await fetchJsonWithMeshRetry(async () => {
      const { ip, port, key, deviceId } = await getConfig();
      return {
        url: `http://${ip}:${port}/shared/list?device_id=${encodeURIComponent(deviceId)}`,
        options: { headers: { Authorization: `Bearer ${key}` } },
      };
    });
    const remoteSources = remote.sources ?? [];
    for (const source of remoteSources) {
      if (source.type !== 'google_drive' || !source.drive_folder_id || !source.drive_link) continue;
      if (!localSources.some(local => local.folderId === source.drive_folder_id)) {
        localSources.push({
          id: `local_drive_${source.drive_folder_id}`,
          folderId: source.drive_folder_id,
          link: source.drive_link,
          label: source.label || 'Google Drive Folder',
        });
      }
    }
    await AsyncStorage.setItem(DRIVE_SOURCES_KEY, JSON.stringify(localSources)).catch(() => {});
    const remoteIds = new Set(remoteSources.map(s => s.id));
    const remoteDriveIds = new Set(remoteSources.map(s => s.drive_folder_id).filter(Boolean));
    return [...remoteSources, ...localEntries.filter(s => !remoteIds.has(s.id) && !remoteDriveIds.has(localSources.find(local => local.id === s.id)?.folderId))];
  } catch {
    if (localEntries.length) return localEntries;
    throw new Error('Could not load shared folders. Check that the server is running and try again.');
  }
}

export async function addGoogleDriveSource(link, label = '', apiKey = '') {
  const folderId = driveFolderId(link);
  if (apiKey.trim()) {
    DRIVE_API_KEY = apiKey.trim();
    await AsyncStorage.setItem(DRIVE_API_KEY_STORAGE_KEY, DRIVE_API_KEY);
  }
  if (await isServerMode()) {
    try {
      const saved = await fetchJsonWithMeshRetry(async () => {
        const { ip, port, key, deviceId } = await getConfig();
        return {
          url: `http://${ip}:${port}/shared/google-drive/add?device_id=${encodeURIComponent(deviceId)}`,
          options: {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ link: String(link).trim(), label: String(label).trim() || 'Google Drive Folder' }),
          },
        };
      });
      const resolvedLabel = saved.entry.label || String(label).trim() || 'Google Drive Folder';
      const sources = await getLocalDriveSources();
      if (!sources.some(s => s.folderId === folderId)) {
        sources.push({ id: `local_drive_${folderId}`, folderId, link: String(link).trim(), label: resolvedLabel });
        await AsyncStorage.setItem(DRIVE_SOURCES_KEY, JSON.stringify(sources));
      }
      return { id: saved.entry.id, label: resolvedLabel, type: 'google_drive' };
    } catch {
      // A disconnected server or a server without a Drive key still allows
      // the app to use this folder directly in offline/P2P mode.
    }
  }
  const folder = await driveRequest(`files/${encodeURIComponent(folderId)}`, {
    fields: 'id,name,mimeType', supportsAllDrives: 'true',
  });
  if (folder.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('That link is not a Google Drive folder. Paste a folder link.');
  }
  await listDriveChildren(folderId); // Validate public access before saving it.
  const sources = await getLocalDriveSources();
  const id = `local_drive_${folderId}`;
  const existing = sources.find(s => s.id === id);
  if (existing) {
    if (String(existing.label || '').trim().toLowerCase() === 'google drive folder' && folder.name) {
      existing.label = folder.name;
      await AsyncStorage.setItem(DRIVE_SOURCES_KEY, JSON.stringify(sources));
    }
    return { id, label: existing.label, type: 'google_drive', local: true };
  }
  const resolvedLabel = String(label).trim() || folder.name || 'Google Drive Folder';
  sources.push({ id, folderId, link: String(link).trim(), label: resolvedLabel });
  await AsyncStorage.setItem(DRIVE_SOURCES_KEY, JSON.stringify(sources));
  return { id, label: resolvedLabel, type: 'google_drive', local: true };
}

export async function removeGoogleDriveSource(sourceId) {
  const sources = await getLocalDriveSources();
  const next = sources.filter(source => source.id !== sourceId);
  await AsyncStorage.setItem(DRIVE_SOURCES_KEY, JSON.stringify(next));
  return next.length !== sources.length;
}

function isLocalDriveSource(sourceId) {
  return String(sourceId || '').startsWith('local_drive_');
}

async function driveContentUrl(fileId) {
  const metadata = await driveRequest(`files/${encodeURIComponent(fileId)}`, {
    fields: 'mimeType,webContentLink,exportLinks', supportsAllDrives: 'true',
  });
  const exportFormat = DRIVE_EXPORT_FORMATS[metadata.mimeType];
  if (exportFormat) {
    if (metadata.exportLinks?.[exportFormat[0]]) return metadata.exportLinks[exportFormat[0]];
    const key = await getDriveApiKey();
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportFormat[0])}&key=${encodeURIComponent(key)}`;
  }
  if (metadata.webContentLink) return metadata.webContentLink;
  const key = await getDriveApiKey();
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(key)}`;
}

function driveFilePath(item, parentPath = '') {
  const name = driveDisplayName(item.name || 'file', item.mimeType);
  const relativePath = parentPath ? `${parentPath}/${name}` : name;
  return `${item.id}/${relativePath}`;
}

function driveDisplayName(name, mimeType) {
  const format = DRIVE_EXPORT_FORMATS[mimeType];
  return format && !String(name).toLowerCase().endsWith(format[1]) ? `${name}${format[1]}` : name;
}

function driveTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

async function driveFilesForFolder(folderId) {
  const result = [];
  const queue = [{ id: folderId, parentPath: '' }];
  while (queue.length) {
    const { id: current, parentPath } = queue.pop();
    const children = await listDriveChildren(current);
    for (const item of children) {
      const relativePath = parentPath ? `${parentPath}/${item.name}` : item.name;
      if (item.mimeType === 'application/vnd.google-apps.folder') queue.push({ id: item.id, parentPath: relativePath });
      else result.push({ path: driveFilePath(item, parentPath), name: driveDisplayName(item.name, item.mimeType), drive_id: item.id, size: Number(item.size || 0), modified_time: driveTimestamp(item.modifiedTime) });
    }
  }
  return result;
}

export async function listSharedFiles(sourceId, prefix = '') {
  if (isLocalDriveSource(sourceId)) {
    const folderId = prefix ? prefix.split('/')[0] : sourceId.slice('local_drive_'.length);
    return driveFilesForFolder(folderId);
  }
  const query = prefix ? `&prefix=${encodeURIComponent(prefix)}` : '';
  const data = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/files?device_id=${encodeURIComponent(deviceId)}${query}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  }, 30000);
  if (data.warning) console.warn('[SharedDir]', data.warning);
  return data.files ?? [];
}

export async function listServerFiles(prefix = '') {
  const data = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/files/list?device_id=${encodeURIComponent(deviceId)}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  }, 30000);
  return data.files ?? [];
}

export async function searchFiles(query) {
  const data = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/files/search?device_id=${encodeURIComponent(deviceId)}&q=${encodeURIComponent(query)}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  }, 15000);
  return data.files ?? [];
}

export async function searchSharedFiles(sourceId, query) {
  if (isLocalDriveSource(sourceId)) {
    const all = await listSharedFiles(sourceId);
    return all.filter(f => f.name.toLowerCase().includes(String(query || '').toLowerCase()));
  }
  const data = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/search?q=${encodeURIComponent(query)}&device_id=${encodeURIComponent(deviceId)}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  }, 15000);
  return data.files ?? [];
}

export async function browseFiles(prefix = '') {
  const isServer = await isServerMode();
  if (!isServer) {
    return { folders: [], files: [] };
  }
  try {
    const res = await fetchJsonWithMeshRetry(async () => {
      const { ip, port, key, deviceId } = await getConfig();
      return {
        url: `http://${ip}:${port}/files/browse?device_id=${encodeURIComponent(deviceId)}&prefix=${encodeURIComponent(prefix)}`,
        options: { headers: { Authorization: `Bearer ${key}` } },
      };
    });
    if (res && (Array.isArray(res.folders) || Array.isArray(res.files))) {
      _uiMemoryCache.browse[prefix] = res;
    }
    return res;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
    }
    throw err;
  }
}

export async function browseSharedFiles(sourceId, prefix = '') {
  if (isLocalDriveSource(sourceId)) {
    const folderId = prefix ? prefix.split('/')[0] : sourceId.slice('local_drive_'.length);
    const parentPath = prefix ? prefix.split('/').slice(1).join('/') : '';
    const children = await listDriveChildren(folderId);
    return {
      folders: children.filter(f => f.mimeType === 'application/vnd.google-apps.folder').map(f => ({ name: f.name, path: `${f.id}/${parentPath ? `${parentPath}/` : ''}${f.name}` })),
      files: children.filter(f => f.mimeType !== 'application/vnd.google-apps.folder').map(f => ({ name: driveDisplayName(f.name, f.mimeType), path: driveFilePath(f, parentPath), size: Number(f.size || 0), modified_time: driveTimestamp(f.modifiedTime) })),
    };
  }
  const isServer = await isServerMode();
  if (!isServer) {
    return { folders: [], files: [] };
  }
  try {
    const res = await fetchJsonWithMeshRetry(async () => {
      const { ip, port, key, deviceId } = await getConfig();
      return {
        url: `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/browse?device_id=${encodeURIComponent(deviceId)}&prefix=${encodeURIComponent(prefix)}`,
        options: { headers: { Authorization: `Bearer ${key}` } },
      };
    });
    if (res && (Array.isArray(res.folders) || Array.isArray(res.files))) {
      _uiMemoryCache.browseShared[`${sourceId}:${prefix}`] = res;
    }
    return res;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
    }
    throw err;
  }
}


/**
 * Download a single file from the server.
 * @param {string} relativePath  — the path key as stored in the server DB
 * @param {string} destUri       — local file URI to write into
 * @param {(written: number, total: number) => void} [onProgress]
 * @returns {Promise<FileSystem.FileSystemDownloadResult>}
 */
export async function downloadFile(relativePath, destUri, onProgress) {
  return withDownloadMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const url =
      `http://${ip}:${port}/files/download` +
      `?relative_path=${encodeURIComponent(relativePath)}` +
      `&device_id=${encodeURIComponent(deviceId)}`;

    const downloadResumable = FileSystem.createDownloadResumable(
      url,
      destUri,
      { headers: { Authorization: `Bearer ${key}` } },
      (progress) => {
        onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite);
      },
    );
    return downloadResumable.downloadAsync();
  });
}

/**
 * Build the full authenticated URL for a file — used by the preview modal
 * to pass directly to expo-video (video) or FileSystem.downloadAsync (images).
 *
 * @param {string} relativePath — the path key as stored in the server DB
 * @returns {Promise<string>}   — a fully-qualified http:// URL with auth baked-in
 *                                 NOTE: auth is sent via query param as a fallback
 *                                 because expo-video does not support custom headers on
 *                                 Android. The server must accept ?token= as well.
 */
export async function getFilePreviewUrl(relativePath) {
  const { ip, port, key, deviceId } = await getConfig();
  return (
    `http://${ip}:${port}/files/download` +
    `?relative_path=${encodeURIComponent(relativePath)}` +
    `&device_id=${encodeURIComponent(deviceId)}` +
    `&token=${encodeURIComponent(key)}`
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Shared Directories  (read-only folders configured in the Desktop app)
// ─────────────────────────────────────────────────────────────────────────────


/**
 * Download a file from a shared directory.
 * @param {string} sourceId      — the source id
 * @param {string} relativePath  — path relative to the shared dir root
 * @param {string} destUri       — local file URI to write into
 * @param {(written: number, total: number) => void} [onProgress]
 */
export async function downloadSharedFile(sourceId, relativePath, destUri, onProgress) {
  if (isLocalDriveSource(sourceId)) {
    const fileId = String(relativePath).split('/')[0];
    const url = await driveContentUrl(fileId);
    const result = await FileSystem.createDownloadResumable(url, destUri, {}, progress => {
      onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite);
    }).downloadAsync();
    if (!result || result.status < 200 || result.status >= 300) throw new Error(`Google Drive download failed (${result?.status || 'unknown'}).`);
    return result;
  }
  return withDownloadMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const url =
      `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/download` +
      `?relative_path=${encodeURIComponent(relativePath)}` +
      `&device_id=${encodeURIComponent(deviceId)}`;

    const downloadResumable = FileSystem.createDownloadResumable(
      url,
      destUri,
      { headers: { Authorization: `Bearer ${key}` } },
      (progress) => {
        onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite);
      },
    );
    return downloadResumable.downloadAsync();
  });
}

/**
 * Download a device-to-device shared file by share_id.
 * @param {number} shareId
 * @param {string} destUri - Local file URI to save to
 * @param {(bytesWritten: number, totalBytes: number) => void} [onProgress]
 * @returns {Promise<FileSystem.FileSystemDownloadResult>}
 */
export async function downloadShareFile(shareId, destUri, onProgress) {
  const isP2P = typeof shareId === 'string' && shareId.startsWith('p2p_');
  if (isP2P) {
    try {
      const feed = await getLocalP2PFeed();
      const targetPost = (feed || []).find(p => String(p.id) === String(shareId) || (p.files || []).some(f => String(f.id) === String(shareId)));
      const file = (targetPost?.files || []).find(f => f.uri) || (targetPost?.uri ? targetPost : null);
      if (file?.uri) {
        await FileSystem.copyAsync({ from: file.uri, to: destUri });
        onProgress?.(1, 1);
        return { uri: destUri, status: 200, headers: {}, mimeType: null };
      }
    } catch (err) {
      console.warn('[Downloader] P2P downloadShareFile copy failed:', err?.message);
    }
  }

  return withDownloadMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const url =
      `http://${ip}:${port}/share/${encodeURIComponent(shareId)}/download` +
      `?device_id=${encodeURIComponent(deviceId)}` +
      `&token=${encodeURIComponent(key)}`;
    const downloadResumable = FileSystem.createDownloadResumable(
      url,
      destUri,
      { headers: { Authorization: `Bearer ${key}` } },
      (progress) => {
        onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite);
      },
    );
    return downloadResumable.downloadAsync();
  });
}


/**
 * Build the full authenticated URL for a shared file preview
 * (auth via ?token= query param since expo-video doesn't support custom headers on Android).
 * @param {string} sourceId
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
export async function getSharedFilePreviewUrl(sourceId, relativePath) {
  if (isLocalDriveSource(sourceId)) {
    const fileId = String(relativePath).split('/')[0];
    return driveContentUrl(fileId);
  }
  const { ip, port, key, deviceId } = await getConfig();
  return (
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/download` +
    `?relative_path=${encodeURIComponent(relativePath)}` +
    `&device_id=${encodeURIComponent(deviceId)}` +
    `&token=${encodeURIComponent(key)}`
  );
}

/**
 * Fetch today's memories from the server.
 * @returns {Promise<{today: {month: number, day: number}, groups: Array<{year: number, years_ago: number, items: Array<any>}>}>}
 */
export async function getTodaysMemories() {
  _ensureMemoriesCacheFresh();
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/memories/today?device_id=${encodeURIComponent(deviceId)}&${_clientCalendarQuery()}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.todaysMemories = res;
  _uiMemoryCache._memoriesDateKey = _localDateKey();
  return res;
}

/**
 * Fetch memories for today and the previous 6 days from the server.
 * @returns {Promise<{days: Array<{date: {month: number, day: number, year: number}, days_ago: number, is_today: boolean, groups: Array<{year: number, years_ago: number, items: Array<any>}>}>}>}
 */
export async function getRecentMemories(days = 7) {
  _ensureMemoriesCacheFresh();
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/memories/recent?device_id=${encodeURIComponent(deviceId)}&days=${encodeURIComponent(days)}&${_clientCalendarQuery()}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.recentMemories[days] = res;
  _uiMemoryCache._memoriesDateKey = _localDateKey();
  return res;
}

/**
 * Parse JSON body; treat empty / literal null as null (flashback & roulette).
 * @param {Response} res
 */
export async function readJsonOrNull(res) {
  const text = await res.text();
  if (!text || text === 'null') return null;
  return JSON.parse(text);
}

/**
 * Fetch a round of "Guess the Year" quiz items built from backed-up photos.
 * @param {number} [count=10]
 * @returns {Promise<{items: Array<{source_type: string, source_id: string, relative_path: string, correct_year: number, options: number[]}>}>}
 */
export async function getQuizRound(count = 10) {
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/memories/quiz?device_id=${encodeURIComponent(deviceId)}&count=${encodeURIComponent(count)}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.quizRound = res;
  return res;
}

/**
 * Fetch a single random backed-up photo/video for Photo Roulette.
 * @returns {Promise<null | {source_type: string, source_id: string, source_label: string, relative_path: string, size: number, capture_time: number|null, is_video: boolean, year: number|null}>}
 */
export async function getRouletteItem() {
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/memories/roulette?device_id=${encodeURIComponent(deviceId)}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.roulette = res;
  return res;
}

/**
 * Fetch clustered "Memories from this place" groups (GPS EXIF-derived).
 * @param {{ force?: boolean }} [opts] - force=true bypasses client + server cache.
 */
export async function getPlaceClusters(opts = {}) {
  const force = !!opts?.force;
  if (!force && _uiMemoryCache.placeClusters) {
    return _uiMemoryCache.placeClusters;
  }
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const refresh = force ? '&refresh=1' : '';
    return {
      url: `http://${ip}:${port}/memories/places?device_id=${encodeURIComponent(deviceId)}${refresh}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.placeClusters = res;
  _persistJson(PLACES_DISK_KEY, res);
  return res;
}

/**
 * Fetch all items within a single place cluster.
 * @param {string} clusterKey
 * @param {{ force?: boolean }} [opts]
 */
export async function getPlaceItems(clusterKey, opts = {}) {
  const force = !!opts?.force;
  if (!force && _uiMemoryCache.placeItems[clusterKey]) {
    return _uiMemoryCache.placeItems[clusterKey];
  }
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const refresh = force ? '&refresh=1' : '';
    return {
      url: `http://${ip}:${port}/memories/places/${encodeURIComponent(clusterKey)}?device_id=${encodeURIComponent(deviceId)}${refresh}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.placeItems[clusterKey] = res;
  _persistJson(PLACE_ITEMS_DISK_PREFIX + clusterKey, res);
  return res;
}

/**
 * Trigger media reindexing on the server.
 * Also clears local places/trips caches so the next visit refetches after reindex.
 */
export async function triggerMemoriesReindex() {
  const result = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/memories/reindex?device_id=${encodeURIComponent(deviceId)}`,
      options: {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
      },
    };
  });
  await invalidatePlacesTripsCache().catch(() => {});
  return result;
}

/**
 * Fetch a single weighted-random flashback memory ("N years ago this week").
 * @returns {Promise<null | {source_type: string, source_id: string, source_label: string, relative_path: string, size: number, capture_time: number|null, is_video: boolean, year: number, years_ago: number}>}
 */
export async function getRandomFlashback() {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/memories/flashback?device_id=${encodeURIComponent(deviceId)}&${_clientCalendarQuery()}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
}

/**
 * Fetch aggregate "year in review" stats for a given year.
 * @param {number} year
 */
export async function getYearWrapped(year) {
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/memories/wrapped?device_id=${encodeURIComponent(deviceId)}&year=${encodeURIComponent(year)}&${_clientCalendarQuery()}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.wrapped[year] = res;
  return res;
}

/**
 * Kick off server-side Rewind Reel generation for a year (optionally scoped to a month).
 * @param {number} year
 * @param {number} [month]
 */
export async function generateRewindReel(year, month) {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const params = new URLSearchParams({ device_id: deviceId, year: String(year) });
    if (month) params.set('month', String(month));
    return {
      url: `http://${ip}:${port}/memories/rewind/generate?${params.toString()}`,
      options: { method: 'POST', headers: { Authorization: `Bearer ${key}` } },
    };
  });
}

/**
 * Poll Rewind Reel build status for a year (optionally scoped to a month).
 * @param {number} year
 * @param {number} [month]
 * @returns {Promise<{status: string, ready: boolean}>}
 */
export async function getRewindReelStatus(year, month) {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const params = new URLSearchParams({ device_id: deviceId, year: String(year) });
    if (month) params.set('month', String(month));
    return {
      url: `http://${ip}:${port}/memories/rewind/status?${params.toString()}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
}

/**
 * Build the authenticated streaming URL for a ready Rewind Reel.
 * @param {ServerConfig} config
 * @param {number} year
 * @param {number} [month]
 */
export function buildRewindReelStreamUrl(config, year, month) {
  if (!config || !config.ip || !config.port) return '';
  const host = formatHostForUrl(config.ip);
  const params = new URLSearchParams({
    device_id: config.deviceId,
    year: String(year),
    token: config.key,
  });
  if (month) params.set('month', String(month));
  return `http://${host}:${config.port}/memories/rewind/stream?${params.toString()}`;
}

/**
 * Download a ready Rewind Reel to local storage (e.g. to save to the device gallery).
 * @param {number} year
 * @param {number|undefined} month
 * @param {string} destUri
 * @param {(written: number, total: number) => void} [onProgress]
 */
export async function downloadRewindReel(year, month, destUri, onProgress) {
  return withDownloadMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const params = new URLSearchParams({ device_id: deviceId, year: String(year), token: key });
    if (month) params.set('month', String(month));
    const url = `http://${ip}:${port}/memories/rewind/stream?${params.toString()}`;

    const downloadResumable = FileSystem.createDownloadResumable(
      url,
      destUri,
      {},
      (progress) => {
        onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite);
      },
    );
    return downloadResumable.downloadAsync();
  });
}

/**
 * Fetch auto-generated trip albums for the current or specified source.
 * @param {string} [sourceId]
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{trips: Array<{id: number, source_id: string, title: string, start_time: number, end_time: number, center_lat: number, center_lon: number, media_count: number, cover_media_id: number|null, cover: any}>}>}
 */
export async function getTrips(sourceId, opts = {}) {
  // Support legacy call signature getTrips(opts) when first arg is options object.
  let targetSourceId = sourceId;
  let force = !!opts?.force;
  if (sourceId && typeof sourceId === 'object') {
    force = !!sourceId.force;
    targetSourceId = undefined;
  }

  const cacheKey = targetSourceId || '';
  if (!force && _uiMemoryCache.trips[cacheKey]) {
    return _uiMemoryCache.trips[cacheKey];
  }

  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const target = targetSourceId || deviceId;
    const refresh = force ? '&refresh=1' : '';
    return {
      url: `http://${ip}:${port}/api/trips?source_id=${encodeURIComponent(target)}${refresh}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.trips[cacheKey] = res;
  // Also mirror under '' so getCachedTrips() without args works after a device-scoped fetch.
  if (cacheKey) {
    _uiMemoryCache.trips[''] = res;
  }
  _persistJson(TRIPS_DISK_PREFIX + (cacheKey || '_default'), res);
  return res;
}

/**
 * Fetch all media items in a specific trip.
 * @param {number} tripId
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{trip: any, media: Array<any>}>}
 */
export async function getTripMedia(tripId, opts = {}) {
  const force = !!opts?.force;
  const idKey = String(tripId);
  if (!force && (_uiMemoryCache.tripMedia[idKey] || _uiMemoryCache.tripMedia[tripId])) {
    return _uiMemoryCache.tripMedia[idKey] || _uiMemoryCache.tripMedia[tripId];
  }
  const res = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const refresh = force ? '&refresh=1' : '';
    return {
      url: `http://${ip}:${port}/api/trips/${encodeURIComponent(tripId)}/media?device_id=${encodeURIComponent(deviceId)}${refresh}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
  _uiMemoryCache.tripMedia[idKey] = res;
  _uiMemoryCache.tripMedia[tripId] = res;
  _persistJson(TRIP_MEDIA_DISK_PREFIX + idKey, res);
  return res;
}

/**
 * Re-trigger trip clustering on the server for a device.
 * @param {string} [sourceId]
 */
export async function reclusterTrips(sourceId) {
  const result = await fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    const target = sourceId || deviceId;
    return {
      url: `http://${ip}:${port}/api/trips/recluster?source_id=${encodeURIComponent(target)}`,
      options: { method: 'POST', headers: { Authorization: `Bearer ${key}` } },
    };
  });
  // Server rebuilt trips — drop local trip caches so next reads refetch.
  _uiMemoryCache.trips = {};
  _uiMemoryCache.tripMedia = {};
  await _clearDiskByPrefixes([TRIPS_DISK_PREFIX, TRIP_MEDIA_DISK_PREFIX]);
  if (result?.trips) {
    const payload = { trips: result.trips };
    _uiMemoryCache.trips[''] = payload;
    _persistJson(TRIPS_DISK_PREFIX + '_default', payload);
  }
  return result;
}

/**
 * Toggle emoji reaction on a media item.
 * @param {number} mediaId
 * @param {string} emoji
 * @param {string} [scope='post']
 * @returns {Promise<{status: 'added'|'removed', media_id: number, emoji: string, scope?: string, counts: Record<string, number>, user_reactions: string[]}>}
 */
async function handleLocalP2PReaction(mediaId, emoji) {
  const feed = await getLocalP2PFeed();
  const localIdentity = await getLocalPeerIdentity().catch(() => ({
    deviceId: '',
    username: '',
    deviceName: 'Nearby Device',
  }));
  const idStr = String(mediaId || '');
  const targetPost = feed.find((p) => p.id === idStr || String(p.group_id) === idStr || (p.files || []).some((f) => f.name === idStr || f.fileName === idStr));

  const currentReactions = Array.isArray(targetPost?.user_reactions) ? targetPost.user_reactions : [];
  const hasReacted = currentReactions.includes(emoji);
  const updatedReactions = hasReacted
    ? currentReactions.filter((e) => e !== emoji)
    : [...currentReactions, emoji];

  const currentCounts = { ...(targetPost?.reaction_counts || {}) };
  const updatedCounts = {
    ...currentCounts,
    [emoji]: Math.max(0, (currentCounts[emoji] || 0) + (hasReacted ? -1 : 1)),
  };

  if (targetPost) {
    targetPost.user_reactions = updatedReactions;
    targetPost.reaction_counts = updatedCounts;
    const reactors = (Array.isArray(targetPost.reactors) ? targetPost.reactors : [])
      .filter((reactor) => typeof reactor === 'string' || (reactor && typeof reactor === 'object'))
      .map((reactor, index) => {
        if (typeof reactor !== 'string') return reactor;
        return {
          id: `${localIdentity.deviceId}:${reactor}:${index}`,
          media_id: targetPost.id,
          source_id: localIdentity.deviceId,
          emoji: reactor,
          created_at: targetPost.created_at || Date.now(),
          display_name: localIdentity.username || localIdentity.deviceName || 'You',
        };
      });
    const existingOwn = reactors.filter((r) => r.source_id === localIdentity.deviceId);
    const legacyOwn = currentReactions
      .filter((e) => !existingOwn.some((r) => r.emoji === e))
      .map((e) => ({
        id: `${localIdentity.deviceId}:${e}`,
        media_id: targetPost.id,
        source_id: localIdentity.deviceId,
        emoji: e,
        created_at: targetPost.created_at || Date.now(),
        display_name: localIdentity.username || localIdentity.deviceName || 'You',
        is_own: true,
      }));
    const normalizedReactors = [...reactors, ...legacyOwn];
    targetPost.reactors = hasReacted
      ? normalizedReactors.filter((r) => !(r.source_id === localIdentity.deviceId && r.emoji === emoji))
      : [
          ...normalizedReactors.filter((r) => !(r.source_id === localIdentity.deviceId && r.emoji === emoji)),
          {
            id: `${localIdentity.deviceId}:${emoji}`,
            media_id: targetPost.id,
            source_id: localIdentity.deviceId,
            emoji,
            created_at: Date.now(),
            display_name: localIdentity.username || localIdentity.deviceName || 'You',
            is_own: true,
          },
        ];
    await saveP2PFeedItem(targetPost);
  }

  // Broadcast reaction to paired peers
  try {
    const peers = await getPairedPeers();
    for (const peer of peers || []) {
      if (peer.ip && peer.port) {
        sendDirectReaction(peer.ip, peer.port, {
          share_id: targetPost ? targetPost.id : idStr,
          emoji,
          action: hasReacted ? 'remove' : 'add',
          reactor_device_id: localIdentity.deviceId,
          reactor_name: localIdentity.username || localIdentity.deviceName,
        }).catch(() => {});
      }
    }
  } catch {}

  DeviceEventEmitter.emit('reel-reaction-changed', {
    mediaId,
    reelId: String(mediaId),
    counts: updatedCounts,
    userReactions: updatedReactions,
  });

  // Also notify the feed tab so reaction counts update reactively
  DeviceEventEmitter.emit('feed_updated', { mediaId, source: 'p2p_reaction' });

  return {
    status: hasReacted ? 'removed' : 'added',
    media_id: mediaId,
    emoji,
    scope: 'post',
    counts: updatedCounts,
    user_reactions: updatedReactions,
  };
}

/**
 * React to a media or reel item.
 * @param {number|string} mediaId
 * @param {string} emoji
 * @param {string} [scope='post']
 */
export async function reactToMedia(mediaId, emoji, scope = 'post') {
  const isServer = await isServerMode();
  const isP2P = !mediaId || String(mediaId).startsWith('p2p_');

  if (!isServer || isP2P) {
    return handleLocalP2PReaction(mediaId, emoji);
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    const result = await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/react`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ source_id: deviceId, emoji, scope }),
      },
      3000
    );
    return result;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return handleLocalP2PReaction(mediaId, emoji);
    }
    throw err;
  }
}

/**
 * Fetch reactions for a media item.
 * @param {number|string} mediaId
 * @param {string} [scope='post']
 */
function getP2PReactors(targetPost, deviceId, mediaId) {
  const storedReactors = (Array.isArray(targetPost?.reactors) ? targetPost.reactors : [])
    .filter((reactor) => typeof reactor === 'string' || (reactor && typeof reactor === 'object'));
  const reactors = storedReactors.map((reactor, index) => {
    if (typeof reactor === 'string') {
      return {
        id: `${deviceId}:${reactor}:${index}`,
        media_id: targetPost?.id || mediaId,
        source_id: deviceId,
        emoji: reactor,
        created_at: targetPost?.created_at || Date.now(),
        display_name: 'You',
      };
    }
    const sourceId = reactor?.source_id || deviceId;
    return {
      ...reactor,
      id: reactor?.id ?? `${sourceId}:${reactor?.emoji || ''}:${index}`,
      media_id: reactor?.media_id ?? targetPost?.id ?? mediaId,
      source_id: sourceId,
      created_at: reactor?.created_at ?? targetPost?.created_at ?? Date.now(),
      display_name: reactor?.display_name || (sourceId === deviceId ? 'You' : 'Nearby Peer'),
      is_own: reactor?.is_own ?? sourceId === deviceId,
    };
  });
  const knownOwnEmojis = new Set(
    reactors.filter((reactor) => reactor.source_id === deviceId).map((reactor) => reactor.emoji)
  );
  for (const emoji of Array.isArray(targetPost?.user_reactions) ? targetPost.user_reactions : []) {
    if (knownOwnEmojis.has(emoji)) continue;
    reactors.push({
      id: `${deviceId}:${emoji}`,
      media_id: targetPost?.id || mediaId,
      source_id: deviceId,
      emoji,
      created_at: targetPost?.created_at || Date.now(),
      display_name: 'You',
    });
    knownOwnEmojis.add(emoji);
  }
  return reactors;
}

export async function getMediaReactions(mediaId, scope = 'post') {
  const isServer = await isServerMode();
  const isP2P = !mediaId || String(mediaId).startsWith('p2p_');

  if (!isServer || isP2P) {
    const feed = await getLocalP2PFeed();
    const { deviceId } = await getLocalPeerIdentity().catch(() => ({ deviceId: '' }));
    const idStr = String(mediaId || '');
    const targetPost = feed.find((p) => p.id === idStr || String(p.group_id) === idStr);
    const counts = targetPost?.reaction_counts || {};
    const reactors = getP2PReactors(targetPost, deviceId, mediaId);
    return {
      media_id: mediaId,
      counts,
      reactions: reactors,
    };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/reactions?device_id=${encodeURIComponent(deviceId)}&scope=${encodeURIComponent(scope)}`,
      { headers: { Authorization: `Bearer ${key}` } },
      3000
    );
  } catch (_err) {
    const feed = await getLocalP2PFeed();
    const { deviceId } = await getLocalPeerIdentity().catch(() => ({ deviceId: '' }));
    const idStr = String(mediaId || '');
    const targetPost = feed.find((p) => p.id === idStr || String(p.group_id) === idStr);
    const counts = targetPost?.reaction_counts || {};
    const reactors = getP2PReactors(targetPost, deviceId, mediaId);
    return {
      media_id: mediaId,
      counts,
      reactions: reactors,
    };
  }
}

/**
 * Fetch chronological media feed with reactions for a shared folder.
 * @param {string} sourceId
 */
export async function getSharedFeed(sourceId) {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/feed?device_id=${encodeURIComponent(deviceId)}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
}

/**
 * Push this device's username to the server (idempotent, safe to call on save or reconnect).
 * @param {string} username
 */
export async function updateUsernameOnServer(username) {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/devices/${encodeURIComponent(deviceId)}/username`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ username: username || null }),
      },
    };
  });
}

/** Canonical id of the desktop/main server — never a share recipient. */
export const DESKTOP_SHARE_DEVICE_ID = 'desktop-server';

/**
 * Local device ids plus the desktop server that must never appear in recipient lists.
 * @param {string[] | Set<string> | null | undefined} extraExcludeIds
 * @returns {Promise<Set<string>>}
 */
export async function resolveExcludedShareRecipientIds(extraExcludeIds = []) {
  const excluded = new Set([DESKTOP_SHARE_DEVICE_ID]);
  const extras = extraExcludeIds instanceof Set ? extraExcludeIds : extraExcludeIds || [];
  for (const id of extras) {
    if (id) excluded.add(id);
  }
  try {
    const { deviceId } = await getConfig();
    if (deviceId) excluded.add(deviceId);
  } catch {}
  try {
    const ident = await getLocalPeerIdentity();
    if (ident?.deviceId) excluded.add(ident.deviceId);
  } catch {}
  return excluded;
}

/**
 * Drop the current device and desktop/main server from a recipient/device list.
 * @template {{device_id?: string, target_device_id?: string}} T
 * @param {T[]} devices
 * @param {Set<string> | string[] | null | undefined} excludedIds
 * @returns {T[]}
 */
export function filterShareRecipientDevices(devices, excludedIds) {
  const excluded = new Set(excludedIds || []);
  excluded.add(DESKTOP_SHARE_DEVICE_ID);
  return (Array.isArray(devices) ? devices : []).filter((d) => {
    const id = d && (d.device_id || d.target_device_id);
    return Boolean(id) && !excluded.has(id);
  });
}

async function withShareRecipientFilter(devices, extraExcludeIds) {
  const excluded = await resolveExcludedShareRecipientIds(extraExcludeIds);
  return filterShareRecipientDevices(devices, excluded);
}

/**
 * List accepted devices this device can share to (safe fields only — never a token).
 * Mutual exclusivity: returns Server devices when in Server Mode, P2P peers when in P2P Mode.
 * Always omits the current device and the desktop/main server.
 * @returns {Promise<{devices: {device_id: string, device_name: string, device_model: string}[]}>}
 */
export async function listShareTargetDevices() {
  const isServer = await isServerMode();

  if (isServer) {
    try {
      const { ip, port, key, deviceId } = await getConfig();
      if (ip && port) {
        const res = await fetchJsonWithTimeout(
          `http://${ip}:${port}/api/share/devices?device_id=${encodeURIComponent(deviceId)}`,
          { headers: { Authorization: `Bearer ${key}` } },
          3000
        );
        if (Array.isArray(res?.devices)) {
          return { devices: await withShareRecipientFilter(res.devices) };
        }
      }
    } catch (err) {
      if (isNetworkFailure(err)) {
        await setServerAvailable(false);
      }
    }
  }

  // P2P MODE ONLY: Instantly return paired P2P peers (0ms). Zero server queries!
  let p2pDevices = [];
  try {
    const paired = await getPairedPeers();
    p2pDevices = (paired || []).map((p) => ({
      device_id: p.peerId,
      device_name: p.deviceName || 'Nearby Peer',
      device_model: 'P2P Wi-Fi Peer',
      username: p.username || '',
      display_name: formatDisplayName(p.username, p.deviceName) || p.deviceName || 'Nearby Peer',
      is_p2p: true,
      ip: p.ip,
      port: p.port,
    }));
  } catch {}

  return { devices: await withShareRecipientFilter(p2pDevices) };
}

/**
 * Share files with one or more devices on the network.
 * In Server Mode, routes to central server.
 * In P2P Mode, routes directly to peer phones over local Wi-Fi.
 * @param {string[]} targetDeviceIds
 * @param {string} caption
 * @param {{source_type: string, source_key: string, relative_path: string, size?: number, modified_time?: number, uri?: string}[]} items
 */
export async function createDeviceShare(targetDeviceIds, caption, items, options = {}) {
  const isServer = await isServerMode();

  if (isServer) {
    try {
      const { ip, port, key, deviceId } = await getConfig();
      const serverResult = await fetchJsonWithTimeout(
        `http://${ip}:${port}/api/share/create`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            shared_by_device_id: deviceId,
            target_device_ids: targetDeviceIds,
            caption: caption || null,
            items,
            post_kind: options.postKind || null,
            post_title: options.postTitle || null,
          }),
        },
        8000
      );
      invalidateFeedCache();
      return serverResult || { ok: true, count: items.length };
    } catch (err) {
      if (isNetworkFailure(err)) {
        await setServerAvailable(false);
      } else {
        throw err;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // P2P MODE ONLY: DIRECT PHONE-TO-PHONE SHARE
  // ═══════════════════════════════════════════════════════════════════════
  let p2pTargets = [];
  try {
    const paired = await getPairedPeers();
    p2pTargets = (paired || []).filter((p) => targetDeviceIds.includes(p.peerId));
  } catch {}

  if (p2pTargets.length === 0) {
    throw new Error('No paired P2P devices selected.');
  }

  const filesPayload = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const fileName = it.relative_path ? it.relative_path.split(/[\\/]/).pop() : `file_${i + 1}`;
    filesPayload.push({
      name: fileName,
      uri: it.uri || null,
      size: it.size || 0,
      modifiedTime: it.modified_time || Date.now(),
    });
  }

  const shareId = `p2p_share_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let p2pSuccessCount = 0;

  for (const peer of p2pTargets) {
    if (peer.ip && peer.port) {
      try {
        await sendDirectShareToPeer(peer.ip, peer.port, {
          shareId,
          caption: caption || '',
          files: filesPayload,
        });
        p2pSuccessCount++;
      } catch (err) {
        console.warn(`[Downloader] createDeviceShare P2P send to ${peer.peerId} failed:`, err?.message);
      }
    }
  }

  const localIdentity = await getLocalPeerIdentity();
  const ownPost = {
    id: shareId,
    shared_by_device_id: localIdentity.deviceId,
    shared_by_device_name: localIdentity.deviceName,
    shared_by_username: localIdentity.username,
    caption: caption || '',
    post_kind: options.postKind || 'direct_post',
    created_at: Date.now(),
    files: filesPayload.map((f) => ({
      ...f,
      thumbUri: f.thumbUri || f.thumb_uri || f.uri,
      thumb_uri: f.thumb_uri || f.thumbUri || f.uri,
    })),
    target_device_ids: targetDeviceIds,
    targets: p2pTargets.map((p) => ({
      device_id: p.peerId,
      target_device_id: p.peerId,
      device_name: p.deviceName || p.username || 'Peer Device',
    })),
    is_p2p: true,
    is_own_post: true,
    reaction_counts: {},
    user_reactions: [],
  };

  await saveP2PFeedItem(ownPost);
  invalidateFeedCache();
  DeviceEventEmitter.emit('p2p-feed-updated');
  DeviceEventEmitter.emit('feed_updated', ownPost);

  return { ok: true, count: items.length, p2p_sent: p2pSuccessCount, post: ownPost };
}

/**
 * Share a completed Guess-the-Year round to the device feed.
 * @param {string[]} targetDeviceIds
 * @param {string} caption
 * @param {number} score
 * @param {number} total
 * @param {{items: Array<any>}} quizData
 * @param {string[]} imageUris local file URIs (score card first, then each question)
 */
export async function createQuizShare(targetDeviceIds, caption, score, total, quizData, imageUris) {
  const isServer = await isServerMode();

  if (isServer) {
    const imagesBase64 = await Promise.all(
      imageUris.map(async (uri) => {
        const cleanUri = uri.startsWith('file://') ? uri : `file://${uri}`;
        return await FileSystem.readAsStringAsync(cleanUri, {
          encoding: FileSystem.EncodingType?.Base64 || 'base64',
        });
      })
    );

    try {
      const { ip, port, key, deviceId } = await getConfig();
      const result = await fetchJsonWithTimeout(
        `http://${ip}:${port}/api/share/quiz/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            shared_by_device_id: deviceId,
            target_device_ids: targetDeviceIds,
            caption: caption || '',
            score,
            total,
            quiz_data: quizData,
            images_base64: imagesBase64,
          }),
        },
        15000
      );
      invalidateFeedCache();
      return result || { ok: true };
    } catch (err) {
      if (isNetworkFailure(err)) {
        await setServerAvailable(false);
      } else {
        throw err;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // P2P MODE ONLY
  // ═══════════════════════════════════════════════════════════════════════
  let p2pTargets = [];
  try {
    const paired = await getPairedPeers();
    p2pTargets = (paired || []).filter((p) => targetDeviceIds.includes(p.peerId));
  } catch {}

  if (p2pTargets.length === 0) {
    throw new Error('No paired P2P devices selected.');
  }

  const filesPayload = [];
  for (let i = 0; i < imageUris.length; i++) {
    filesPayload.push({
      name: i === 0 ? 'scorecard.jpg' : `question_${i}.jpg`,
      uri: imageUris[i],
      size: 0,
      modifiedTime: Date.now(),
    });
  }

  const shareId = `p2p_quiz_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const postTitle = `Guess the Year · ${score}/${total} points`;
  let p2pSuccessCount = 0;

  for (const peer of p2pTargets) {
    if (peer.ip && peer.port) {
      try {
        await sendDirectShareToPeer(peer.ip, peer.port, {
          shareId,
          caption: caption || '',
          postKind: 'quiz',
          files: filesPayload,
        });
        p2pSuccessCount++;
      } catch (err) {
        console.warn(`[Downloader] createQuizShare P2P send to ${peer.peerId} failed:`, err?.message);
      }
    }
  }

  const localIdentity = await getLocalPeerIdentity();
  const ownPost = {
    id: shareId,
    shared_by_device_id: localIdentity.deviceId,
    shared_by_device_name: localIdentity.deviceName,
    shared_by_username: localIdentity.username,
    caption: caption || '',
    post_kind: 'quiz',
    post_title: postTitle,
    quiz_data: quizData,
    created_at: Date.now(),
    files: filesPayload.map((f) => ({
      ...f,
      thumbUri: f.thumbUri || f.uri,
      thumb_uri: f.thumb_uri || f.uri,
    })),
    target_device_ids: targetDeviceIds,
    targets: p2pTargets.map((p) => ({
      device_id: p.peerId,
      target_device_id: p.peerId,
      device_name: p.deviceName || p.username || 'Peer Device',
    })),
    is_p2p: true,
    is_own_post: true,
    reaction_counts: {},
    user_reactions: [],
  };

  await saveP2PFeedItem(ownPost);
  invalidateFeedCache();
  DeviceEventEmitter.emit('p2p-feed-updated');
  DeviceEventEmitter.emit('feed_updated', ownPost);

  return { ok: true, p2p_sent: p2pSuccessCount, post: ownPost };
}

export const DIRECT_POST_MAX_FILES = 300;
export const MAX_SHARE_POST_FILES = 300;
export const DIRECT_POST_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Upload files from the device file manager and create a feed post.
 * Files are stored in server app-data and deleted when the post is removed.
 * @param {string[]} targetDeviceIds
 * @param {string} caption
 * @param {{uri: string, name: string, size?: number, modifiedTime?: number}[]} files
 * @param {(statusText: string) => void} [onProgress]
 */
export async function createDirectPostShare(targetDeviceIds, caption, files, onProgress) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files selected');
  }
  if (!Array.isArray(targetDeviceIds) || targetDeviceIds.length === 0) {
    throw new Error('Select at least one target device');
  }
  if (files.length > DIRECT_POST_MAX_FILES) {
    throw new Error(`Too many files (max ${DIRECT_POST_MAX_FILES})`);
  }
  for (const file of files) {
    if ((file.size || 0) > DIRECT_POST_MAX_FILE_BYTES) {
      throw new Error(`${file.name || 'File'} exceeds the 100 MB limit`);
    }
  }

  const isServer = await isServerMode();

  if (!isServer) {
    // ═══════════════════════════════════════════════════════════════════════
    // P2P MODE: DIRECT PHONE-TO-PHONE OVER WI-FI (ZERO SERVER OVERHEAD)
    // ═══════════════════════════════════════════════════════════════════════
    let p2pTargets = [];
    try {
      const paired = await getPairedPeers();
      p2pTargets = (paired || []).filter((p) => targetDeviceIds.includes(p.peerId));
    } catch {}

    if (p2pTargets.length === 0) {
      throw new Error('No paired P2P devices selected. Pair a nearby phone first.');
    }

    if (onProgress) onProgress('Preparing files for direct Wi-Fi transfer…');

    const filesPayload = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const cleanUri = file.uri?.startsWith('file://') || file.uri?.startsWith('content://')
        ? file.uri
        : `file://${file.uri}`;

      const isVideo = /\.(mp4|mov|avi|mkv|webm|3gp|m4v)$/i.test(file.name || '') || /\.(mp4|mov|avi|mkv|webm|3gp|m4v)$/i.test(cleanUri);
      let thumbUri = null;
      if (isVideo && P2PServerModule?.getVideoThumbnail) {
        try {
          thumbUri = await P2PServerModule.getVideoThumbnail(cleanUri);
        } catch {}
      }

      filesPayload.push({
        name: file.name || `file_${i + 1}`,
        uri: cleanUri,
        thumbUri: thumbUri || cleanUri,
        thumb_uri: thumbUri || cleanUri,
        size: file.size || 0,
        modifiedTime: file.modifiedTime || Date.now(),
      });
    }

    const shareId = `p2p_post_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let p2pSuccessCount = 0;

    for (const peer of p2pTargets) {
      if (peer.ip && peer.port) {
        try {
          if (onProgress) onProgress(`Sending directly to ${peer.deviceName || peer.username}…`);
          await sendDirectShareToPeer(peer.ip, peer.port, {
            shareId,
            peerId: peer.peerId,
            caption: caption || '',
            files: filesPayload,
          }, onProgress);
          p2pSuccessCount++;
        } catch (err) {
          console.warn(`[Downloader] Direct P2P send to ${peer.peerId} failed:`, err?.message);
        }
      }
    }

    if (p2pSuccessCount === 0) {
      throw new Error('Could not reach target phone over Wi-Fi. Ensure both phones are on the same Wi-Fi network.');
    }

    // Save to sender's own local feed immediately
    const localIdentity = await getLocalPeerIdentity();
    const ownPost = {
      id: shareId,
      shared_by_device_id: localIdentity.deviceId,
      shared_by_device_name: localIdentity.deviceName,
      shared_by_username: localIdentity.username,
      caption: caption || '',
      post_kind: 'direct_post',
      created_at: Date.now(),
      files: filesPayload.map((f) => ({
        name: f.name,
        fileName: f.name,
        uri: f.uri,
        thumbUri: f.thumbUri || f.uri,
        thumb_uri: f.thumb_uri || f.uri,
        size: f.size,
      })),
      target_device_ids: targetDeviceIds,
      targets: p2pTargets.map((p) => ({
        device_id: p.peerId,
        target_device_id: p.peerId,
        device_name: p.deviceName || p.username || 'Peer Device',
      })),
      is_p2p: true,
      is_own_post: true,
      reaction_counts: {},
      user_reactions: [],
    };

    await saveP2PFeedItem(ownPost);
    invalidateFeedCache();

    // Trigger instant feed update events
    DeviceEventEmitter.emit('p2p-feed-updated');
    DeviceEventEmitter.emit('feed_updated', ownPost);

    return { ok: true, p2p_sent: p2pSuccessCount, shareId, post: ownPost };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SERVER MODE: UPLOAD TO SERVER APP-DATA DIRECT POST
  // ═══════════════════════════════════════════════════════════════════════
  const config = await getConfig();
  const { ip, port, key, deviceId } = config;

  const filesPayload = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress) {
      onProgress(`Reading file ${i + 1} of ${files.length}…`);
    }
    const cleanUri = file.uri?.startsWith('file://') || file.uri?.startsWith('content://')
      ? file.uri
      : `file://${file.uri}`;
    let base64Data;
    try {
      base64Data = await FileSystem.readAsStringAsync(cleanUri, {
        encoding: FileSystem.EncodingType?.Base64 || 'base64',
      });
    } catch (_readErr) {
      const tempCacheUri = `${FileSystem.cacheDirectory}direct_post_${Date.now()}_${i}_${(file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      try {
        if (cleanUri.startsWith('content://')) {
          await FileSystem.StorageAccessFramework.copyAsync({ from: cleanUri, to: tempCacheUri });
        } else {
          await FileSystem.copyAsync({ from: cleanUri, to: tempCacheUri });
        }
        base64Data = await FileSystem.readAsStringAsync(tempCacheUri, {
          encoding: FileSystem.EncodingType?.Base64 || 'base64',
        });
      } catch (_copyErr) {
        throw new Error(`Could not read file "${file.name || `file_${i + 1}`}".`);
      } finally {
        await FileSystem.deleteAsync(tempCacheUri, { idempotent: true }).catch(() => {});
      }
    }
    filesPayload.push({
      name: file.name || `file_${i + 1}`,
      size: file.size || 0,
      modifiedTime: file.modifiedTime || Date.now(),
      base64: base64Data,
    });
  }

  if (onProgress) onProgress('Creating feed post on server…');
  const res = await fetch(`http://${ip}:${port}/api/share/direct-post/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      shared_by_device_id: deviceId,
      target_device_ids: targetDeviceIds,
      caption: caption || '',
      files: filesPayload,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      if (body?.detail) {
        detail = typeof body.detail === 'string' ? `: ${body.detail}` : `: ${JSON.stringify(body.detail)}`;
      }
    } catch {}
    throw new Error(`Failed to create post (${res.status})${detail}`);
  }

  const serverResult = await res.json();
  invalidateFeedCache();
  return serverResult || { ok: true };
}

async function getLocalP2PFeedDisplayItems() {
  try {
    const [localFeed, localIdentity] = await Promise.all([
      getLocalP2PFeed(),
      getLocalPeerIdentity(),
    ]);
    return (localFeed || []).map((p2pItem) => {
      const isOwn = p2pItem.shared_by_device_id === localIdentity.deviceId || Boolean(p2pItem.is_own_post);
      const files = Array.isArray(p2pItem.files) ? p2pItem.files : [];
      const firstFile = files[0] || {};
      const firstCleanUri = firstFile.uri || null;
      const firstThumbUri = firstFile.thumb_uri || firstFile.thumbUri || firstCleanUri;
      return {
        kind: 'share',
        group_id: p2pItem.id,
        id: p2pItem.id,
        media_id: p2pItem.id,
        share_id: p2pItem.id,
        caption: p2pItem.caption || '',
        shared_by: isOwn
          ? (localIdentity.username || localIdentity.deviceName || 'You')
          : (p2pItem.shared_by_username || p2pItem.shared_by_device_name || 'Nearby Peer'),
        shared_by_device_id: p2pItem.shared_by_device_id,
        created_at: p2pItem.created_at || Date.now(),
        is_own_post: isOwn,
        is_p2p: true,
        post_kind: p2pItem.post_kind || 'direct_post',
        uri: firstCleanUri,
        thumb_uri: firstThumbUri,
        targets: p2pItem.targets || [],
        target_device_ids: p2pItem.target_device_ids || [],
        items: files.map((f, idx) => ({
          share_id: f.id || `${p2pItem.id}_${idx}`,
          media_id: f.id || `${p2pItem.id}_${idx}`,
          path: f.name || f.fileName,
          uri: f.uri,
          thumb_uri: f.thumb_uri || f.thumbUri || f.uri,
          size: f.size || 0,
          is_video: /\.(mp4|mov|avi|mkv|webm|3gp|m4v)$/i.test(f.name || f.fileName || ''),
          is_p2p: true,
        })),
        reaction_counts: p2pItem.reaction_counts || {},
        user_reactions: p2pItem.user_reactions || [],
        comment_count: p2pItem.comment_count || (p2pItem.comments?.length || 0),
      };
    });
  } catch {
    return [];
  }
}

async function getLocalP2PReels() {
  try {
    const localFeed = await getLocalP2PFeed();
    const p2pReels = [];
    for (const post of localFeed || []) {
      for (const f of post.files || []) {
        const isVideo = /\.(mp4|mov|avi|mkv|webm|3gp|m4v)$/i.test(f.name || f.fileName || '');
        if (isVideo) {
          p2pReels.push({
            // Use post.id directly (already has p2p_ prefix) to avoid double-prefixing (p2p_p2p_...)
            reel_id: String(post.id ? post.id : `p2p_${f.id || Math.random().toString(36).slice(2)}`),
            share_id: post.id,
            media_id: post.id,
            path: f.name || f.fileName || 'video.mp4',
            uri: f.uri,
            thumb_uri: f.thumb_uri || f.thumbUri || f.uri,
            caption: post.caption || '',
            shared_by: post.shared_by_username || post.shared_by_device_name || 'Nearby Peer',
            shared_by_device_id: post.shared_by_device_id || '',
            created_at: post.created_at || Date.now(),
            reaction_counts: post.reaction_counts || {},
            user_reactions: post.user_reactions || [],
            comment_count: post.comment_count || (post.comments?.length || 0),
            is_own_post: Boolean(post.is_own_post),
            is_p2p: true,
          });
        }
      }
    }
    return p2pReels;
  } catch {
    return [];
  }
}

/**
 * Fetch the feed: device-to-device shares (received + own sent), grouped by post.
 * In Server Mode: queries central backup server exclusively.
 * In P2P Mode: loads directly and instantly from local P2P feed (0ms).
 * Either Server or P2P is used — never both at the same time.
 * @param {number} [offset=0] - Pagination offset
 * @param {number} [limit=50] - Max posts per page
 * @returns {Promise<{items: Array<any>, has_more: boolean, total: number}>}
 */
export async function getFeed(offset = 0, limit = 50) {
  const isServer = await isServerMode();

  if (isServer) {
    try {
      const { ip, port, key, deviceId } = await getConfig();
      if (!ip || !port) return { items: [], has_more: false, total: 0 };
      const serverFeed = await fetchJsonWithTimeout(
        `http://${ip}:${port}/api/feed?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${key}` } },
        3500
      );
      if (offset === 0 && Array.isArray(serverFeed?.items)) {
        _uiMemoryCache.feed = serverFeed;
      }
      return serverFeed || { items: [], has_more: false, total: 0 };
    } catch (err) {
      if (isNetworkFailure(err)) {
        // Desktop server became unreachable: immediately activate P2P mode
        await setServerAvailable(false);
      } else {
        return { items: [], has_more: false, total: 0 };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // P2P MODE ONLY: ZERO SERVER WAITS, INSTANT LOCAL P2P FEED
  // ═══════════════════════════════════════════════════════════════════════
  const p2pPosts = await getLocalP2PFeedDisplayItems();
  const result = {
    items: p2pPosts,
    has_more: false,
    total: p2pPosts.length,
  };

  if (offset === 0) {
    _uiMemoryCache.feed = result;
  }
  return result;
}

/**
 * Fetch randomized reels feed.
 * In Server Mode: queries central server exclusively.
 * In P2P Mode: extracts shared video reels from local P2P feed instantly.
 * @param {number} [offset=0]
 * @param {number} [limit=30]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getReelsFeed(offset = 0, limit = 30, seed = 0) {
  const isServer = await isServerMode();

  if (isServer) {
    try {
      const { ip, port, key, deviceId } = await getConfig();
      if (!ip || !port) return { reels: [], has_more: false, total: 0 };
      const serverReels = await fetchJsonWithTimeout(
        `http://${ip}:${port}/api/reels?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}&seed=${seed}`,
        { headers: { Authorization: `Bearer ${key}` } },
        3500
      );
      if (offset === 0 && Array.isArray(serverReels?.reels)) {
        _uiMemoryCache.reelsFeed['for-you'] = serverReels;
      }
      return serverReels || { reels: [], has_more: false, total: 0 };
    } catch (err) {
      if (isNetworkFailure(err)) {
        await setServerAvailable(false);
      } else {
        return { reels: [], has_more: false, total: 0 };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // P2P MODE ONLY: INSTANT LOCAL P2P REELS (0ms)
  // ═══════════════════════════════════════════════════════════════════════
  const p2pReels = await getLocalP2PReels();
  const result = {
    reels: p2pReels,
    has_more: false,
    total: p2pReels.length,
  };

  if (offset === 0) {
    _uiMemoryCache.reelsFeed['for-you'] = result;
  }
  return result;
}

/**
 * Send batch playback telemetry to the server (fire-and-forget).
 * @param {Array<any>} events
 * @returns {Promise<{ok: boolean, recorded?: number}>}
 */
export async function sendReelTelemetry(events) {
  if (!events || events.length === 0) return { ok: true, recorded: 0 };
  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port || !deviceId) return { ok: false };
    const res = await fetch(`http://${ip}:${port}/api/reels/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        device_id: deviceId,
        events,
      }),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}


/**
 * Repost an existing reel to selected devices with access control.
 * @param {number} shareId
 * @param {string[]} targetDeviceIds
 * @param {string} [caption]
 * @returns {Promise<{ok: boolean, share_id: number, group_id: string}>}
 */
export async function repostReel(shareId, targetDeviceIds, caption = '') {
  const isServer = await isServerMode();

  if (isServer) {
    try {
      const { ip, port, key, deviceId } = await getConfig();
      if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
      const result = await fetchJsonWithTimeout(
        `http://${ip}:${port}/api/reels/repost`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            device_id: deviceId,
            share_id: shareId,
            target_device_ids: targetDeviceIds,
            caption: caption || null,
          }),
        },
        8000
      );
      invalidateFeedCache();
      return result;
    } catch (err) {
      if (isNetworkFailure(err)) {
        await setServerAvailable(false);
      } else {
        throw err;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // P2P MODE ONLY
  // ═══════════════════════════════════════════════════════════════════════
  let p2pTargets = [];
  try {
    const paired = await getPairedPeers();
    p2pTargets = (paired || []).filter((p) => targetDeviceIds.includes(p.peerId));
  } catch {}

  if (p2pTargets.length === 0) {
    throw new Error('No paired P2P devices selected.');
  }

  const feed = await getLocalP2PFeed();
  const idStr = String(shareId);
  const post = feed.find((p) => p.id === idStr || String(p.group_id) === idStr);
  const videoFile = (post?.files || []).find((f) => /\.(mp4|mov|avi|mkv|webm|3gp|m4v)$/i.test(f.name || f.fileName || ''));

  let p2pSuccessCount = 0;
  if (videoFile) {
    const repostShareId = `p2p_repost_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    for (const peer of p2pTargets) {
      if (peer.ip && peer.port) {
        try {
          await sendDirectShareToPeer(peer.ip, peer.port, {
            shareId: repostShareId,
            caption: caption || post?.caption || '',
            files: [videoFile],
          });
          p2pSuccessCount++;
        } catch {}
      }
    }

    const localIdentity = await getLocalPeerIdentity();
    const ownPost = {
      id: repostShareId,
      shared_by_device_id: localIdentity.deviceId,
      shared_by_device_name: localIdentity.deviceName,
      shared_by_username: localIdentity.username,
      caption: caption || post?.caption || '',
      post_kind: 'direct_post',
      created_at: Date.now(),
      files: [{
        ...videoFile,
        thumbUri: videoFile.thumbUri || videoFile.thumb_uri || videoFile.uri,
        thumb_uri: videoFile.thumb_uri || videoFile.thumbUri || videoFile.uri,
      }],
      target_device_ids: targetDeviceIds,
      targets: p2pTargets.map((p) => ({
        device_id: p.peerId,
        target_device_id: p.peerId,
        device_name: p.deviceName || p.username || 'Peer Device',
      })),
      is_p2p: true,
      is_own_post: true,
      reaction_counts: {},
      user_reactions: [],
    };
    await saveP2PFeedItem(ownPost);
    DeviceEventEmitter.emit('p2p-feed-updated');
    DeviceEventEmitter.emit('feed_updated', ownPost);
  }

  invalidateFeedCache();
  return { ok: true, share_id: shareId, p2p_sent: p2pSuccessCount };
}

/**
 * Cancel / undo a user's repost of a reel.
 * @param {number} shareId
 * @returns {Promise<{ok: boolean, share_id: number}>}
 */
export async function cancelRepostReel(shareId) {
  const isServer = await isServerMode();
  const isP2P = typeof shareId === 'string' && shareId.startsWith('p2p_');
  if (!isServer || isP2P) {
    try {
      await deleteP2PFeedItem(shareId);
      DeviceEventEmitter.emit('reel-repost-changed', { shareId, isReposted: false });
      DeviceEventEmitter.emit('p2p-feed-updated');
      DeviceEventEmitter.emit('feed_updated');
    } catch {}
    return { ok: true, share_id: shareId };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port) return { ok: false, error: 'No server config' };
    const res = await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/reels/repost/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          device_id: deviceId,
          share_id: shareId,
        }),
      },
      3000
    );
    return res;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return { ok: true, share_id: shareId };
    }
    throw err;
  }
}

/**
 * Toggle bookmark/save state for a reel.
 * @param {string} reelId
 * @param {number} shareId
 * @param {number} [mediaId]
 * @returns {Promise<{ok: boolean, saved: boolean, reel_id: string}>}
 */
export async function toggleSaveReel(reelId, shareId, mediaId = null) {
  const isServer = await isServerMode();
  const isP2P = (typeof shareId === 'string' && shareId.startsWith('p2p_')) || (typeof reelId === 'string' && reelId.startsWith('p2p_'));
  if (!isServer || isP2P) {
    try {
      const feed = await getLocalP2PFeed();
      const targetPost = (feed || []).find((p) => String(p.id) === String(shareId) || String(p.id) === String(reelId) || (p.files || []).some(f => String(f.id) === String(shareId)));
      if (targetPost) {
        targetPost.is_saved = !targetPost.is_saved;
        await saveP2PFeedItem(targetPost);
        DeviceEventEmitter.emit('reel-save-changed', {
          reelId: String(reelId),
          shareId,
          isSaved: Boolean(targetPost.is_saved),
        });
        return { ok: true, saved: Boolean(targetPost.is_saved), reel_id: String(reelId) };
      }
    } catch {}
    return { ok: true, saved: true, reel_id: String(reelId) };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/reels/save`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          device_id: deviceId,
          reel_id: String(reelId),
          share_id: shareId,
          media_id: mediaId,
        }),
      },
      3000
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return { ok: true, saved: true, reel_id: String(reelId) };
    }
    throw err;
  }
}

/**
 * Fetch saved/bookmarked reels for this device.
 * @param {number} [offset=0]
 * @param {number} [limit=50]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getSavedReels(offset = 0, limit = 50) {
  const isServer = await isServerMode();
  if (!isServer) {
    try {
      const p2pReels = await getLocalP2PReels();
      const saved = p2pReels.filter(r => r.is_saved);
      return { reels: saved, has_more: false, total: saved.length };
    } catch {
      return { reels: [], has_more: false, total: 0 };
    }
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port) return { reels: [], has_more: false, total: 0 };
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/reels/saved?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${key}` } },
      3500
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      const p2pReels = await getLocalP2PReels();
      const saved = p2pReels.filter(r => r.is_saved);
      return { reels: saved, has_more: false, total: saved.length };
    }
    return { reels: [], has_more: false, total: 0 };
  }
}

/**
 * Fetch liked reels for this device.
 * @param {number} [offset=0]
 * @param {number} [limit=50]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getLikedReels(offset = 0, limit = 50) {
  const isServer = await isServerMode();
  if (!isServer) {
    try {
      const p2pReels = await getLocalP2PReels();
      const liked = p2pReels.filter(r => Array.isArray(r.user_reactions) && r.user_reactions.length > 0);
      return { reels: liked, has_more: false, total: liked.length };
    } catch {
      return { reels: [], has_more: false, total: 0 };
    }
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port) return { reels: [], has_more: false, total: 0 };
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/reels/liked?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${key}` } },
      3500
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      const p2pReels = await getLocalP2PReels();
      const liked = p2pReels.filter(r => Array.isArray(r.user_reactions) && r.user_reactions.length > 0);
      return { reels: liked, has_more: false, total: liked.length };
    }
    return { reels: [], has_more: false, total: 0 };
  }
}

/**
 * Fetch reposted reels created by this device.
 * @param {number} [offset=0]
 * @param {number} [limit=50]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getRepostedReels(offset = 0, limit = 50) {
  const isServer = await isServerMode();
  if (!isServer) {
    try {
      const p2pReels = await getLocalP2PReels();
      const reposted = p2pReels.filter(r => r.is_repost || r.is_own_post);
      return { reels: reposted, has_more: false, total: reposted.length };
    } catch {
      return { reels: [], has_more: false, total: 0 };
    }
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port) return { reels: [], has_more: false, total: 0 };
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/reels/reposted?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${key}` } },
      3500
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      const p2pReels = await getLocalP2PReels();
      const reposted = p2pReels.filter(r => r.is_repost || r.is_own_post);
      return { reels: reposted, has_more: false, total: reposted.length };
    }
    return { reels: [], has_more: false, total: 0 };
  }
}

/**
 * Post groups shared to this device that it hasn't been notified about yet.
 * @returns {Promise<{posts: Array<{group_id: string, shared_by: string, caption?: string, post_title?: string, item_count: number, created_at: number}>}>}
 */
export async function getPendingShareNotifications() {
  const isServer = await isServerMode();
  if (!isServer) return { posts: [] };

  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port) return { posts: [] };
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/notifications/pending?device_id=${encodeURIComponent(deviceId)}`,
      { headers: { Authorization: `Bearer ${key}` } },
      3000
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
    }
    return { posts: [] };
  }
}

/**
 * Mark post groups as seen so they are not notified about again.
 * @param {string[]} groupIds
 */
export async function markShareNotificationsSeen(groupIds) {
  const isServer = await isServerMode();
  if (!isServer) return { ok: true };

  try {
    const { ip, port, key, deviceId } = await getConfig();
    if (!ip || !port) return { ok: true };
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/notifications/seen`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ device_id: deviceId, group_ids: groupIds }),
      },
      3000
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
    }
    return { ok: true };
  }
}

/**
 * Get the list of target devices for a share group (owner only).
 * @param {string} groupId
 * @returns {Promise<{targets: {target_device_id: string, device_name: string, device_model: string}[]}>}
 */
export async function getShareGroupTargets(groupId) {
  const isServer = await isServerMode();
  const isP2P = typeof groupId === 'string' && groupId.startsWith('p2p_');
  if (!isServer || isP2P) {
    try {
      const feed = await getLocalP2PFeed();
      const post = (feed || []).find((p) => String(p.id) === String(groupId) || String(p.group_id) === String(groupId));
      if (post && Array.isArray(post.targets) && post.targets.length > 0) {
        return {
          targets: post.targets.map((t) => ({
            target_device_id: t.device_id || t.target_device_id,
            device_name: t.device_name || t.target_device_id,
            device_model: t.device_model || '',
          })),
        };
      }
      if (post && Array.isArray(post.target_device_ids) && post.target_device_ids.length > 0) {
        const paired = await getPairedPeers();
        const targets = post.target_device_ids.map((id) => {
          const p = (paired || []).find((peer) => peer.peerId === id);
          return {
            target_device_id: id,
            device_name: p ? (p.deviceName || p.username || id) : id,
            device_model: '',
          };
        });
        return { targets };
      }
    } catch {}
    return { targets: [] };
  }

  try {
    return await fetchJsonWithMeshRetry(async () => {
      const { ip, port, key, deviceId } = await getConfig();
      return {
        url: `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/targets?device_id=${encodeURIComponent(deviceId)}`,
        options: { headers: { Authorization: `Bearer ${key}` } },
      };
    }, 4000);
  } catch (err) {
    if (isNetworkFailure(err)) {
      try {
        const feed = await getLocalP2PFeed();
        const post = (feed || []).find((p) => String(p.id) === String(groupId) || String(p.group_id) === String(groupId));
        if (post && (post.targets || post.target_device_ids)) {
          return {
            targets: (post.targets || []).map((t) => ({
              target_device_id: t.device_id || t.target_device_id,
              device_name: t.device_name || t.target_device_id,
              device_model: t.device_model || '',
            })),
          };
        }
      } catch {}
    }
    throw err;
  }
}

/**
 * Fetch all accepted devices (for recipient management in Manage Post).
 * Same source as share-target lists so own device and the desktop/main server
 * are never offered as recipients.
 * @returns {Promise<{devices: {device_id: string, device_name: string, display_name: string}[]}>}
 */
export async function getAllDevices() {
  return listShareTargetDevices();
}

/**
 * Add a device as a recipient of a share group (owner only).
 * @param {string} groupId
 * @param {string} targetDeviceId
 */
export async function addShareGroupTarget(groupId, targetDeviceId) {
  const isServer = await isServerMode();
  const isP2P = typeof groupId === 'string' && groupId.startsWith('p2p_');
  if (!isServer || isP2P) {
    try {
      const feed = await getLocalP2PFeed();
      const post = (feed || []).find((p) => String(p.id) === String(groupId) || String(p.group_id) === String(groupId));
      if (post) {
        post.target_device_ids = post.target_device_ids || [];
        if (!post.target_device_ids.includes(targetDeviceId)) {
          post.target_device_ids.push(targetDeviceId);
        }
        post.targets = post.targets || [];
        if (!post.targets.some((t) => (t.device_id || t.target_device_id) === targetDeviceId)) {
          post.targets.push({ device_id: targetDeviceId, target_device_id: targetDeviceId });
        }
        await saveP2PFeedItem(post);
      }
    } catch {}
    return { ok: true };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/add_target?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ device_id: targetDeviceId }),
      },
      3000
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return { ok: true };
    }
    throw err;
  }
}

/**
 * Edit the caption of a share group (owner only).
 * @param {string} groupId
 * @param {string|null} caption
 */
export async function editShareGroupCaption(groupId, caption) {
  const isServer = await isServerMode();
  const isP2P = typeof groupId === 'string' && groupId.startsWith('p2p_');
  if (!isServer || isP2P) {
    try {
      const feed = await getLocalP2PFeed();
      const post = (feed || []).find((p) => String(p.id) === String(groupId) || String(p.group_id) === String(groupId));
      if (post) {
        post.caption = caption ?? '';
        await saveP2PFeedItem(post);
      }
    } catch {}
    invalidateFeedCache();
    return { ok: true };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    const result = await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/edit_caption?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ caption: caption ?? null }),
      },
      3000
    );
    invalidateFeedCache();
    return result;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return { ok: true };
    }
    throw err;
  }
}

/**
 * Delete a share group (owner only — removes post from all recipients' feeds).
 * @param {string} groupId
 */
export async function deleteShareGroup(groupId) {
  const isServer = await isServerMode();
  const isP2P = typeof groupId === 'string' && groupId.startsWith('p2p_');

  if (!isServer || isP2P) {
    await deleteP2PFeedItem(groupId);
    invalidateFeedCache();
    DeviceEventEmitter.emit('p2p-feed-updated', { source: 'delete_group', groupId });
    DeviceEventEmitter.emit('feed_updated', { source: 'p2p_delete_group', groupId });
    return { ok: true };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    const result = await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/delete?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
      },
      3000
    );
    invalidateFeedCache();
    return result;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      await deleteP2PFeedItem(groupId);
      invalidateFeedCache();
      DeviceEventEmitter.emit('p2p-feed-updated', { source: 'delete_group', groupId });
      DeviceEventEmitter.emit('feed_updated', { source: 'p2p_delete_group', groupId });
      return { ok: true };
    }
    throw err;
  }
}

/**
 * Delete a single share by its share_id (owner only).
 * @param {number|string} shareId
 */
export async function deleteShare(shareId) {
  const isServer = await isServerMode();
  const isP2P = typeof shareId === 'string' && shareId.startsWith('p2p_');

  if (!isServer || isP2P) {
    await deleteP2PFeedItem(shareId);
    invalidateFeedCache();
    DeviceEventEmitter.emit('p2p-feed-updated', { source: 'delete_share', shareId });
    DeviceEventEmitter.emit('feed_updated', { source: 'p2p_delete_share', shareId });
    return { ok: true };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    const result = await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/share/${encodeURIComponent(shareId)}/delete?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
      },
      3000
    );
    invalidateFeedCache();
    return result;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      await deleteP2PFeedItem(shareId);
      invalidateFeedCache();
      DeviceEventEmitter.emit('p2p-feed-updated', { source: 'delete_share', shareId });
      DeviceEventEmitter.emit('feed_updated', { source: 'p2p_delete_share', shareId });
      return { ok: true };
    }
    throw err;
  }
}

/**
 * Remove a specific target device from a share group.
 * Sharer or recipient self-removal (hide).
 * @param {string} groupId
 * @param {string} targetDeviceId - The device_id to remove access for
 */
export async function removeShareTarget(groupId, targetDeviceId) {
  const isServer = await isServerMode();
  const isP2P = typeof groupId === 'string' && groupId.startsWith('p2p_');
  if (!isServer || isP2P) {
    try {
      const feed = await getLocalP2PFeed();
      const post = (feed || []).find((p) => String(p.id) === String(groupId) || String(p.group_id) === String(groupId));
      if (post) {
        if (Array.isArray(post.target_device_ids)) {
          post.target_device_ids = post.target_device_ids.filter((id) => id !== targetDeviceId);
        }
        if (Array.isArray(post.targets)) {
          post.targets = post.targets.filter((t) => (t.device_id || t.target_device_id) !== targetDeviceId);
        }
        await saveP2PFeedItem(post);
      }
    } catch {}
    invalidateFeedCache();
    return { ok: true };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    const result = await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/remove_target?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ device_id: targetDeviceId }),
      },
      3000
    );
    invalidateFeedCache();
    return result;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return { ok: true };
    }
    throw err;
  }
}

/**
 * Remove a specific target device from a share by share_id.
 * @param {number} shareId
 * @param {string} targetDeviceId
 */
export async function removeShareTargetByShareId(shareId, targetDeviceId) {
  const isServer = await isServerMode();
  const isP2P = typeof shareId === 'string' && shareId.startsWith('p2p_');
  if (!isServer || isP2P) {
    // In P2P mode, "hide" means remove the item from the local feed entirely
    try {
      await deleteP2PFeedItem(shareId);
      invalidateFeedCache();
      DeviceEventEmitter.emit('p2p-feed-updated', { source: 'hide_share', shareId });
      DeviceEventEmitter.emit('feed_updated', { source: 'p2p_hide_share', shareId });
    } catch {}
    return { ok: true };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    const result = await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/share/${encodeURIComponent(shareId)}/remove_target?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ device_id: targetDeviceId }),
      },
      3000
    );
    invalidateFeedCache();
    return result;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return { ok: true };
    }
    throw err;
  }
}

/**
 * Fetch comments for a media item.
 * Uses mesh-aware retry for resilience against mid-session mesh roaming.
 * @param {number|string} mediaId
 * @param {string} [scope='post']
 */
export async function getComments(mediaId, scope = 'post') {
  const isServer = await isServerMode();
  const isP2P = !mediaId || String(mediaId).startsWith('p2p_');

  if (!isServer || isP2P) {
    const feed = await getLocalP2PFeed();
    const idStr = String(mediaId || '');
    const targetPost = feed.find((p) => p.id === idStr || String(p.group_id) === idStr);
    const rawComments = targetPost?.comments || [];
    const normalizedComments = rawComments.map((c) => ({
      ...c,
      display_name: c.display_name || c.author_name || c.device_name || c.author_device_name || 'Nearby Peer',
      device_name: c.device_name || c.author_device_name || c.display_name || 'Nearby Peer',
      author_name: c.author_name || c.display_name || c.device_name || 'Nearby Peer',
      author_device_name: c.author_device_name || c.device_name || c.display_name || 'Nearby Peer',
    }));
    return {
      comments: normalizedComments,
      total: normalizedComments.length,
      media_id: mediaId,
    };
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/comments?device_id=${encodeURIComponent(deviceId)}&scope=${encodeURIComponent(scope)}`,
      { headers: { Authorization: `Bearer ${key}` } },
      3000
    );
  } catch (_err) {
    const feed = await getLocalP2PFeed();
    const idStr = String(mediaId || '');
    const targetPost = feed.find((p) => p.id === idStr || String(p.group_id) === idStr);
    const rawComments = targetPost?.comments || [];
    const normalizedComments = rawComments.map((c) => ({
      ...c,
      display_name: c.display_name || c.author_name || c.device_name || c.author_device_name || 'Nearby Peer',
      device_name: c.device_name || c.author_device_name || c.display_name || 'Nearby Peer',
      author_name: c.author_name || c.display_name || c.device_name || 'Nearby Peer',
      author_device_name: c.author_device_name || c.device_name || c.display_name || 'Nearby Peer',
    }));
    return {
      comments: normalizedComments,
      total: normalizedComments.length,
      media_id: mediaId,
    };
  }
}

async function handleLocalP2PAddComment(mediaId, text) {
  const [localIdentity, peers, feed] = await Promise.all([
    getLocalPeerIdentity(),
    getPairedPeers(),
    getLocalP2PFeed(),
  ]);

  const idStr = String(mediaId || '');
  const targetPost = feed.find((p) => p.id === idStr || String(p.group_id) === idStr);
  const displayName = localIdentity.username || localIdentity.deviceName || 'You';

  const commentId = `p2p_c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newComment = {
    id: commentId,
    comment_id: commentId,
    media_id: mediaId,
    source_id: localIdentity.deviceId,
    display_name: displayName,
    device_name: localIdentity.deviceName || displayName,
    author_name: displayName,
    author_device_name: localIdentity.deviceName || displayName,
    text,
    created_at: Date.now(),
    is_own: true,
  };

  if (targetPost) {
    if (!Array.isArray(targetPost.comments)) targetPost.comments = [];
    targetPost.comments.push(newComment);
    targetPost.comment_count = targetPost.comments.length;
    await saveP2PFeedItem(targetPost);
    // Notify reel cards so their comment count badge updates immediately
    DeviceEventEmitter.emit('reel-comment-changed', {
      reelId: String(targetPost.id),
      mediaId,
      delta: 1,
    });
  }

  for (const peer of peers || []) {
    if (peer.ip && peer.port) {
      sendDirectComment(peer.ip, peer.port, {
        share_id: targetPost ? targetPost.id : idStr,
        comment: newComment,
        action: 'add',
      }).catch(() => {});
    }
  }

  return newComment;
}

/**
 * Add a comment to a media or reel item.
 * @param {number|string} mediaId
 * @param {string} text
 * @param {string} [scope='post']
 */
export async function addComment(mediaId, text, scope = 'post') {
  const isServer = await isServerMode();
  const isP2P = !mediaId || String(mediaId).startsWith('p2p_');
  if (!isServer || isP2P) {
    return handleLocalP2PAddComment(mediaId, text);
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ source_id: deviceId, text, scope }),
      },
      3000
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return handleLocalP2PAddComment(mediaId, text);
    }
    throw err;
  }
}

async function handleLocalP2PDeleteComment(commentId) {
  const [peers, feed] = await Promise.all([
    getPairedPeers(),
    getLocalP2PFeed(),
  ]);

  for (const post of feed) {
    if (Array.isArray(post.comments)) {
      const idx = post.comments.findIndex((c) => c.id === commentId || c.comment_id === commentId);
      if (idx >= 0) {
        post.comments.splice(idx, 1);
        post.comment_count = post.comments.length;
        await saveP2PFeedItem(post);
        // Notify reel cards so their comment count badge updates immediately
        DeviceEventEmitter.emit('reel-comment-changed', {
          reelId: String(post.id),
          mediaId: post.id,
          delta: -1,
        });
        for (const peer of peers || []) {
          if (peer.ip && peer.port) {
            sendDirectComment(peer.ip, peer.port, {
              share_id: post.id,
              comment_id: commentId,
              action: 'delete',
            }).catch(() => {});
          }
        }
        break;
      }
    }
  }
  return { ok: true, comment_id: commentId };
}

/**
 * Delete a comment.
 * @param {number|string} commentId
 */
export async function deleteComment(commentId) {
  const isServer = await isServerMode();
  const isP2P = !commentId || String(commentId).startsWith('p2p_c_');
  if (!isServer || isP2P) {
    return handleLocalP2PDeleteComment(commentId);
  }

  try {
    const { ip, port, key, deviceId } = await getConfig();
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/comments/${encodeURIComponent(commentId)}/delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ source_id: deviceId }),
      },
      3000
    );
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      return handleLocalP2PDeleteComment(commentId);
    }
    throw err;
  }
}

/**
 * Fetch one private reel catalogue. Backup videos and videos from desktop
 * folders shared with this device deliberately remain separate from each other
 * and from the incoming-share feed.
 * @param {'backups' | 'shared'} source
 * @param {number} [offset=0] Zero-based page offset.
 * @param {number} [limit=30] Maximum number of reels to fetch.
 * @param {number} [seed=0] Session seed used for deterministic ordering.
 */
export async function getLibraryReels(source, offset = 0, limit = 30, seed = 0) {
  if (source !== 'backups' && source !== 'shared') {
    throw new Error('Invalid reel library source.');
  }

  // In P2P mode the desktop server is not available; return empty gracefully
  const isServer = await isServerMode();
  if (!isServer) {
    const cached = _uiMemoryCache.reelsFeed[source];
    if (cached) return cached;
    return { reels: [], has_more: false, total: 0 };
  }

  try {
    const res = await fetchJsonWithMeshRetry(async () => {
      const { ip, port, key, deviceId } = await getConfig();
      if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
      return {
        url: `http://${ip}:${port}/api/reels/shared-backups?device_id=${encodeURIComponent(deviceId)}&source=${source}&offset=${offset}&limit=${limit}&seed=${seed}`,
        options: { headers: { Authorization: `Bearer ${key}` } },
      };
    });
    if (offset === 0 && res && Array.isArray(res.reels)) {
      _uiMemoryCache.reelsFeed[source] = res;
    }
    return res;
  } catch (err) {
    if (isNetworkFailure(err)) {
      await setServerAvailable(false);
      const cached = _uiMemoryCache.reelsFeed[source];
      if (cached) return cached;
      return { reels: [], has_more: false, total: 0 };
    }
    throw err;
  }
}

/**
 * Save a shared reel to device photo/video library.
 * @param {number} shareId
 * @param {string} relativePath
 * @param {(progress: number) => void} [onProgress]
 */
export async function saveReelToDevice(shareId, relativePath, onProgress) {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('Media permission denied. Enable photo/video access in device settings.');
  }

  const isServer = await isServerMode();
  const isP2P = typeof shareId === 'string' && shareId.startsWith('p2p_');
  if (!isServer || isP2P) {
    try {
      const feed = await getLocalP2PFeed();
      const targetPost = (feed || []).find(p => String(p.id) === String(shareId) || (p.files || []).some(f => String(f.id) === String(shareId)));
      const file = (targetPost?.files || []).find(f => f.uri) || (targetPost?.uri ? targetPost : null);
      if (file?.uri) {
        await MediaLibrary.saveToLibraryAsync(file.uri);
        return true;
      }
    } catch {}
  }

  const ext = (relativePath || '').split('.').pop()?.toLowerCase() || 'mp4';
  const filename = `reel_${shareId}_${Date.now()}.${ext}`;
  const tmpUri = `${FileSystem.cacheDirectory}${filename}`;

  try {
    const result = await downloadShareFile(shareId, tmpUri, (written, total) => {
      if (total > 0) {
        onProgress?.(written / total);
      }
    });
    if (result && result.status >= 400) {
      throw new Error(`Download failed with server status ${result.status}`);
    }
    const info = await FileSystem.getInfoAsync(tmpUri);
    if (!info.exists || info.size === 0) {
      throw new Error('Downloaded video is empty or missing');
    }
    await MediaLibrary.saveToLibraryAsync(tmpUri);
    return true;
  } finally {
    await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
  }
}

