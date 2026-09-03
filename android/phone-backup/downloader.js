import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getServerPort, getApiKey, getDeviceId, getDeviceToken, resolveReachableServer } from './settings';

export async function getConfig() {
  const [ip, port, apiKey, deviceId, deviceToken] = await Promise.all([
    getServerIp(), getServerPort(), getApiKey(), getDeviceId(), getDeviceToken(),
  ]);
  return { ip, port, key: deviceToken || apiKey, deviceId };
}

export function buildPreviewUrl(config, relativePath, sourceMode, sourceId) {
  if (!config || !config.ip || !config.port) return '';
  if (sourceMode === 'shared' && sourceId) {
    return `http://${config.ip}:${config.port}/shared/${encodeURIComponent(sourceId)}/download?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
  }
  return `http://${config.ip}:${config.port}/files/download?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildVideoPreviewUrl(config, relativePath, sourceMode, sourceId) {
  if (!config || !config.ip || !config.port) return '';
  if (sourceMode === 'shared' && sourceId) {
    return `http://${config.ip}:${config.port}/shared/${encodeURIComponent(sourceId)}/preview?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
  }
  return `http://${config.ip}:${config.port}/files/preview?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildThumbnailUrl(config, relativePath, sourceMode, sourceId) {
  if (!config || !config.ip || !config.port) return '';
  if (sourceMode === 'shared' && sourceId) {
    return `http://${config.ip}:${config.port}/shared/${encodeURIComponent(sourceId)}/thumbnail?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
  }
  return `http://${config.ip}:${config.port}/files/thumbnail?relative_path=${encodeURIComponent(relativePath)}&device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

// Device-to-device share serving — addressed by share_id (no relative_path exposed).
export function buildShareDownloadUrl(config, shareId) {
  if (!config || !config.ip || !config.port) return '';
  return `http://${config.ip}:${config.port}/share/${encodeURIComponent(shareId)}/download?device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildSharePreviewUrl(config, shareId) {
  if (!config || !config.ip || !config.port) return '';
  return `http://${config.ip}:${config.port}/share/${encodeURIComponent(shareId)}/preview?device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export function buildShareThumbnailUrl(config, shareId) {
  if (!config || !config.ip || !config.port) return '';
  return `http://${config.ip}:${config.port}/share/${encodeURIComponent(shareId)}/thumbnail?device_id=${encodeURIComponent(config.deviceId)}&token=${encodeURIComponent(config.key)}`;
}

export async function warmVideoPreviews(relativePaths, sourceMode, sourceId) {
  if (!relativePaths || relativePaths.length === 0) return { ok: true, scheduled: 0 };
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
 * On a network-level failure (not an HTTP error), attempts a fast-path mesh
 * re-discovery (candidate-only, no full subnet sweep) and retries once with
 * the newly resolved IP.
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
    // Only attempt re-discovery on network failures (not on 4xx / 5xx HTTP).
    if (!isNetworkFailure(firstErr)) throw firstErr;

    // Attempt a fast candidate-only re-discovery (~2 s max, no subnet sweep).
    let resolved;
    try {
      resolved = await resolveReachableServer({ subnetSweep: false });
    } catch {
      throw firstErr; // re-discovery itself failed; surface the original error
    }

    if (!resolved.ok) throw firstErr;

    // Retry once with the freshly resolved IP (buildRequest re-reads AsyncStorage).
    return attempt();
  }
}

export async function listSharedSources() {
  const { ip, port, key, deviceId } = await getConfig();
  const data = await fetchJsonWithTimeout(
    `http://${ip}:${port}/shared/list?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  return data.sources ?? [];
}

export async function listSharedFiles(sourceId, prefix = '') {
  const { ip, port, key, deviceId } = await getConfig();
  const query = prefix ? `&prefix=${encodeURIComponent(prefix)}` : '';
  const data = await fetchJsonWithTimeout(
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/files?device_id=${encodeURIComponent(deviceId)}${query}`,
    { headers: { Authorization: `Bearer ${key}` } },
    30000,
  );
  if (data.warning) console.warn('[SharedDir]', data.warning);
  return data.files ?? [];
}

export async function listServerFiles(prefix = '') {
  const { ip, port, key, deviceId } = await getConfig();
  const data = await fetchJsonWithTimeout(
    `http://${ip}:${port}/files/list?device_id=${encodeURIComponent(deviceId)}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`,
    { headers: { Authorization: `Bearer ${key}` } },
    30000,
  );
  return data.files ?? [];
}

export async function searchFiles(query) {
  const { ip, port, key, deviceId } = await getConfig();
  const data = await fetchJsonWithTimeout(
    `http://${ip}:${port}/files/search?device_id=${encodeURIComponent(deviceId)}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${key}` } },
    15000,
  );
  return data.files ?? [];
}

export async function searchSharedFiles(sourceId, query) {
  const { ip, port, key, deviceId } = await getConfig();
  const data = await fetchJsonWithTimeout(
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/search?q=${encodeURIComponent(query)}&device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
    15000,
  );
  return data.files ?? [];
}

export async function browseFiles(prefix = '') {
  const { ip, port, key, deviceId } = await getConfig();
  return fetchJsonWithTimeout(
    `http://${ip}:${port}/files/browse?device_id=${encodeURIComponent(deviceId)}&prefix=${encodeURIComponent(prefix)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
}

export async function browseSharedFiles(sourceId, prefix = '') {
  const { ip, port, key, deviceId } = await getConfig();
  return fetchJsonWithTimeout(
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/browse?device_id=${encodeURIComponent(deviceId)}&prefix=${encodeURIComponent(prefix)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
}


/**
 * Download a single file from the server.
 * @param {string} relativePath  — the path key as stored in the server DB
 * @param {string} destUri       — local file URI to write into
 * @param {(written: number, total: number) => void} [onProgress]
 * @returns {Promise<FileSystem.FileSystemDownloadResult>}
 */
export async function downloadFile(relativePath, destUri, onProgress) {
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
}

/**
 * Download a device-to-device shared file by share_id.
 * @param {number} shareId
 * @param {string} destUri - Local file URI to save to
 * @param {(bytesWritten: number, totalBytes: number) => void} [onProgress]
 * @returns {Promise<FileSystem.FileSystemDownloadResult>}
 */
export async function downloadShareFile(shareId, destUri, onProgress) {
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
}


/**
 * Build the full authenticated URL for a shared file preview
 * (auth via ?token= query param since expo-video doesn't support custom headers on Android).
 * @param {string} sourceId
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
export async function getSharedFilePreviewUrl(sourceId, relativePath) {
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
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/today?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch memories (${res.status})`);
  return await res.json();
}

/**
 * Fetch memories for today and the previous 6 days from the server.
 * @returns {Promise<{days: Array<{date: {month: number, day: number, year: number}, days_ago: number, is_today: boolean, groups: Array<{year: number, years_ago: number, items: Array<any>}>}>}>}
 */
export async function getRecentMemories(days = 7) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/recent?device_id=${encodeURIComponent(deviceId)}&days=${encodeURIComponent(days)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch recent memories (${res.status})`);
  return await res.json();
}

/**
 * Parse JSON body; treat empty / literal null as null (flashback & roulette).
 * @param {Response} res
 */
async function readJsonOrNull(res) {
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
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/quiz?device_id=${encodeURIComponent(deviceId)}&count=${encodeURIComponent(count)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch quiz round (${res.status})`);
  return await res.json();
}

/**
 * Fetch a single random backed-up photo/video for Photo Roulette.
 * @returns {Promise<null | {source_type: string, source_id: string, source_label: string, relative_path: string, size: number, capture_time: number|null, is_video: boolean, year: number|null}>}
 */
export async function getRouletteItem() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/roulette?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch roulette item (${res.status})`);
  return await readJsonOrNull(res);
}

/**
 * Fetch clustered "Memories from this place" groups (GPS EXIF-derived).
 */
export async function getPlaceClusters() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/places?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch places (${res.status})`);
  return await readJsonOrNull(res);
}

/**
 * Fetch all items within a single place cluster.
 * @param {string} clusterKey
 */
export async function getPlaceItems(clusterKey) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/places/${encodeURIComponent(clusterKey)}?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch place items (${res.status})`);
  return await readJsonOrNull(res);
}

/**
 * Trigger media reindexing on the server.
 */
export async function triggerMemoriesReindex() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/reindex?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    },
  );
  if (!res.ok) throw new Error(`Reindex failed (${res.status})`);
  return await res.json();
}

/**
 * Fetch a single weighted-random flashback memory ("N years ago this week").
 * @returns {Promise<null | {source_type: string, source_id: string, source_label: string, relative_path: string, size: number, capture_time: number|null, is_video: boolean, year: number, years_ago: number}>}
 */
export async function getRandomFlashback() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/flashback?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch flashback (${res.status})`);
  return await readJsonOrNull(res);
}

/**
 * Fetch aggregate "year in review" stats for a given year.
 * @param {number} year
 */
export async function getYearWrapped(year) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/wrapped?device_id=${encodeURIComponent(deviceId)}&year=${encodeURIComponent(year)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch year wrapped (${res.status})`);
  return await res.json();
}

/**
 * Kick off server-side Rewind Reel generation for a year (optionally scoped to a month).
 * @param {number} year
 * @param {number} [month]
 */
export async function generateRewindReel(year, month) {
  const { ip, port, key, deviceId } = await getConfig();
  const params = new URLSearchParams({ device_id: deviceId, year: String(year) });
  if (month) params.set('month', String(month));
  const res = await fetch(
    `http://${ip}:${port}/memories/rewind/generate?${params.toString()}`,
    { method: 'POST', headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to start reel generation (${res.status})`);
  return await res.json();
}

/**
 * Poll Rewind Reel build status for a year (optionally scoped to a month).
 * @param {number} year
 * @param {number} [month]
 * @returns {Promise<{status: string, ready: boolean}>}
 */
export async function getRewindReelStatus(year, month) {
  const { ip, port, key, deviceId } = await getConfig();
  const params = new URLSearchParams({ device_id: deviceId, year: String(year) });
  if (month) params.set('month', String(month));
  const res = await fetch(
    `http://${ip}:${port}/memories/rewind/status?${params.toString()}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to check reel status (${res.status})`);
  return await res.json();
}

/**
 * Build the authenticated streaming URL for a ready Rewind Reel.
 * @param {ServerConfig} config
 * @param {number} year
 * @param {number} [month]
 */
export function buildRewindReelStreamUrl(config, year, month) {
  if (!config || !config.ip || !config.port) return '';
  const params = new URLSearchParams({
    device_id: config.deviceId,
    year: String(year),
    token: config.key,
  });
  if (month) params.set('month', String(month));
  return `http://${config.ip}:${config.port}/memories/rewind/stream?${params.toString()}`;
}

/**
 * Download a ready Rewind Reel to local storage (e.g. to save to the device gallery).
 * @param {number} year
 * @param {number|undefined} month
 * @param {string} destUri
 * @param {(written: number, total: number) => void} [onProgress]
 */
export async function downloadRewindReel(year, month, destUri, onProgress) {
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
}

/**
 * Fetch auto-generated trip albums for the current or specified source.
 * @param {string} [sourceId]
 * @returns {Promise<{trips: Array<{id: number, source_id: string, title: string, start_time: number, end_time: number, center_lat: number, center_lon: number, media_count: number, cover_media_id: number|null, cover: any}>}>}
 */
export async function getTrips(sourceId) {
  const { ip, port, key, deviceId } = await getConfig();
  const target = sourceId || deviceId;
  const res = await fetch(
    `http://${ip}:${port}/api/trips?source_id=${encodeURIComponent(target)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch trips (${res.status})`);
  return await readJsonOrNull(res);
}

/**
 * Fetch all media items in a specific trip.
 * @param {number} tripId
 * @returns {Promise<{trip: any, media: Array<any>}>}
 */
export async function getTripMedia(tripId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/trips/${encodeURIComponent(tripId)}/media?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch trip media (${res.status})`);
  return await readJsonOrNull(res);
}

/**
 * Re-trigger trip clustering on the server for a device.
 * @param {string} [sourceId]
 */
export async function reclusterTrips(sourceId) {
  const { ip, port, key, deviceId } = await getConfig();
  const target = sourceId || deviceId;
  const res = await fetch(
    `http://${ip}:${port}/api/trips/recluster?source_id=${encodeURIComponent(target)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to recluster trips (${res.status})`);
  return await res.json();
}

/**
 * Toggle emoji reaction on a media item.
 * @param {number} mediaId
 * @param {string} emoji
 * @returns {Promise<{status: 'added'|'removed', media_id: number, emoji: string, counts: Record<string, number>, user_reactions: string[]}>}
 */
export async function reactToMedia(mediaId, emoji) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/react`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ source_id: deviceId, emoji }),
    },
  );
  if (!res.ok) throw new Error(`Failed to react (${res.status})`);
  return await res.json();
}

/**
 * Fetch reactions for a media item.
 * @param {number} mediaId
 */
export async function getMediaReactions(mediaId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/reactions?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch reactions (${res.status})`);
  return await res.json();
}

/**
 * Fetch chronological media feed with reactions for a shared folder.
 * @param {string} sourceId
 */
export async function getSharedFeed(sourceId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/shared/${encodeURIComponent(sourceId)}/feed?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch shared feed (${res.status})`);
  return await res.json();
}

/**
 * Push this device's username to the server (idempotent, safe to call on save or reconnect).
 * @param {string} username
 */
export async function updateUsernameOnServer(username) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/devices/${encodeURIComponent(deviceId)}/username`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ username: username || null }),
    },
  );
  if (!res.ok) throw new Error(`Failed to update username (${res.status})`);
  return await res.json();
}

/**
 * List accepted devices this device can share to (safe fields only — never a token).
 * Uses mesh-aware retry for resilience against mid-session mesh roaming.
 * @returns {Promise<{devices: {device_id: string, device_name: string, device_model: string}[]}>}
 */
export async function listShareTargetDevices() {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/api/share/devices?device_id=${encodeURIComponent(deviceId)}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
}

/**
 * Share files with one or more devices on the network.
 * @param {string[]} targetDeviceIds
 * @param {string} caption
 * @param {{source_type: string, source_key: string, relative_path: string, size?: number, modified_time?: number}[]} items
 */
export async function createDeviceShare(targetDeviceIds, caption, items, options = {}) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
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
  );
  if (!res.ok) throw new Error(`Failed to share (${res.status})`);
  return await res.json();
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
  const { ip, port, key, deviceId } = await getConfig();
  const imagesBase64 = await Promise.all(
    imageUris.map(async (uri) => {
      const cleanUri = uri.startsWith('file://') ? uri : `file://${uri}`;
      return await FileSystem.readAsStringAsync(cleanUri, {
        encoding: FileSystem.EncodingType?.Base64 || 'base64',
      });
    })
  );

  const res = await fetch(
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
  );
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      if (body?.detail) {
        detail = typeof body.detail === 'string' ? `: ${body.detail}` : `: ${JSON.stringify(body.detail)}`;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(`Failed to share quiz result (${res.status})${detail}`);
  }
  return await res.json();
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

  // Pre-flight: ensure the current IP is reachable before building the FormData
  // payload. If the device has roamed to a new mesh AP, resolve the new IP now
  // so the upload goes to the correct address on the first attempt.
  let config = await getConfig();
  try {
    const preflightController = new AbortController();
    const preflightTimer = setTimeout(() => preflightController.abort(), 3000);
    try {
      const preflight = await fetch(`http://${config.ip}:${config.port}/ping`, {
        method: 'GET',
        signal: preflightController.signal,
      });
      clearTimeout(preflightTimer);
      if (!preflight.ok) throw new Error(`Preflight ${preflight.status}`);
    } catch (innerErr) {
      clearTimeout(preflightTimer);
      throw innerErr;
    }
  } catch (preflightErr) {
    if (isNetworkFailure(preflightErr)) {
      try {
        const resolved = await resolveReachableServer({ subnetSweep: false });
        if (resolved.ok) {
          // Re-read config after mesh re-discovery committed the new IP.
          config = await getConfig();
        }
      } catch {
        // If re-discovery itself fails, proceed with the existing IP and let the
        // actual upload surface a meaningful error to the user.
      }
    }
  }

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
      // Fallback for tricky SAF content:// URIs: copy to temp cache first
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
      base64: base64Data,
    });
  }

  if (onProgress) {
    onProgress('Creating feed post…');
  }

  const res = await fetch(
    `http://${ip}:${port}/api/share/direct-post/create`,
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
        files: filesPayload,
      }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      if (body?.detail) {
        detail = typeof body.detail === 'string' ? `: ${body.detail}` : `: ${JSON.stringify(body.detail)}`;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(`Failed to create post (${res.status})${detail}`);
  }
  return await res.json();
}

/**
 * Fetch the unified feed: device-to-device shares (received + own sent), grouped by post.
 * Uses mesh-aware retry so a mid-session AP roam doesn't surface a hard error.
 * @param {number} [offset=0] - Pagination offset
 * @param {number} [limit=50] - Max posts per page
 * @returns {Promise<{items: Array<any>, has_more: boolean}>}
 */
export async function getFeed(offset = 0, limit = 50) {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/api/feed?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  }, 20000);
}

/**
 * Fetch randomized reels feed (every shared video, flattened out of its post group).
 * @param {number} [offset=0]
 * @param {number} [limit=30]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getReelsFeed(offset = 0, limit = 30, seed = 0) {
  const { ip, port, key, deviceId } = await getConfig();
  if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
  try {
    return await fetchJsonWithTimeout(
      `http://${ip}:${port}/api/reels?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}&seed=${seed}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
  } catch (err) {
    const match = String(err?.message || '').match(/Request failed \((\d+)\)/);
    if (match) {
      const status = Number(match[1]);
      if (status === 401 || status === 403) throw new Error('Your device is not authorized. Re-pair it in Settings.');
      if (status >= 500) throw new Error('Server had a problem loading reels. Try again shortly.');
      throw new Error(`Couldn't load reels (${status}).`);
    }
    throw err;
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
  const { ip, port, key, deviceId } = await getConfig();
  if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
  const res = await fetch(
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
  );
  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      if (err?.detail) detail = `: ${err.detail}`;
    } catch {}
    throw new Error(`Failed to repost reel (${res.status})${detail}`);
  }
  return await res.json();
}

/**
 * Cancel / undo a user's repost of a reel.
 * @param {number} shareId
 * @returns {Promise<{ok: boolean, share_id: number}>}
 */
export async function cancelRepostReel(shareId) {
  const { ip, port, key, deviceId } = await getConfig();
  if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
  const res = await fetch(
    `http://${ip}:${port}/api/reels/repost/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        device_id: deviceId,
        share_id: shareId,
      }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      if (err?.detail) detail = `: ${err.detail}`;
    } catch {}
    throw new Error(`Failed to cancel repost (${res.status})${detail}`);
  }
  return await res.json();
}

/**
 * Toggle bookmark/save state for a reel.
 * @param {string} reelId
 * @param {number} shareId
 * @param {number} [mediaId]
 * @returns {Promise<{ok: boolean, saved: boolean, reel_id: string}>}
 */
export async function toggleSaveReel(reelId, shareId, mediaId = null) {
  const { ip, port, key, deviceId } = await getConfig();
  if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
  const res = await fetch(
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
  );
  if (!res.ok) throw new Error(`Failed to update saved reel (${res.status})`);
  return await res.json();
}

/**
 * Fetch saved/bookmarked reels for this device.
 * @param {number} [offset=0]
 * @param {number} [limit=50]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getSavedReels(offset = 0, limit = 50) {
  const { ip, port, key, deviceId } = await getConfig();
  if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
  return await fetchJsonWithTimeout(
    `http://${ip}:${port}/api/reels/saved?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
}

/**
 * Fetch liked reels for this device.
 * @param {number} [offset=0]
 * @param {number} [limit=50]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getLikedReels(offset = 0, limit = 50) {
  const { ip, port, key, deviceId } = await getConfig();
  if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
  return await fetchJsonWithTimeout(
    `http://${ip}:${port}/api/reels/liked?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
}

/**
 * Fetch reposted reels created by this device.
 * @param {number} [offset=0]
 * @param {number} [limit=50]
 * @returns {Promise<{reels: Array<any>, has_more: boolean, total: number}>}
 */
export async function getRepostedReels(offset = 0, limit = 50) {
  const { ip, port, key, deviceId } = await getConfig();
  if (!ip || !port) throw new Error('Server not set up. Add it in Settings.');
  return await fetchJsonWithTimeout(
    `http://${ip}:${port}/api/reels/reposted?device_id=${encodeURIComponent(deviceId)}&offset=${offset}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
}

/**
 * Post groups shared to this device that it hasn't been notified about yet.
 * @returns {Promise<{posts: Array<{group_id: string, shared_by: string, caption?: string, post_title?: string, item_count: number, created_at: number}>}>}
 */
export async function getPendingShareNotifications() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/notifications/pending?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch notifications (${res.status})`);
  return await res.json();
}

/**
 * Mark post groups as seen so they are not notified about again.
 * @param {string[]} groupIds
 */
export async function markShareNotificationsSeen(groupIds) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/notifications/seen`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ device_id: deviceId, group_ids: groupIds }),
    },
  );
  if (!res.ok) throw new Error(`Failed to mark notifications seen (${res.status})`);
  return await res.json();
}

/**
 * Get the list of target devices for a share group (owner only).
 * @param {string} groupId
 * @returns {Promise<{targets: {target_device_id: string, device_name: string, device_model: string}[]}>}
 */
export async function getShareGroupTargets(groupId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/targets?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch share targets (${res.status})`);
  return await res.json();
}

/**
 * Fetch all accepted devices (for recipient management in Manage Post).
 * @returns {Promise<{devices: {device_id: string, device_name: string, display_name: string}[]}>}
 */
export async function getAllDevices() {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/devices?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`Failed to fetch devices (${res.status})`);
  return await res.json();
}

/**
 * Add a device as a recipient of a share group (owner only).
 * @param {string} groupId
 * @param {string} targetDeviceId
 */
export async function addShareGroupTarget(groupId, targetDeviceId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/add_target?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ device_id: targetDeviceId }),
    },
  );
  if (!res.ok) throw new Error(`Failed to add share target (${res.status})`);
  return await res.json();
}

/**
 * Edit the caption of a share group (owner only).
 * @param {string} groupId
 * @param {string|null} caption
 */
export async function editShareGroupCaption(groupId, caption) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/edit_caption?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ caption: caption ?? null }),
    },
  );
  if (!res.ok) throw new Error(`Failed to edit caption (${res.status})`);
  return await res.json();
}

/**
 * Delete a share group (owner only — removes post from all recipients' feeds).
 * @param {string} groupId
 */
export async function deleteShareGroup(groupId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/delete?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    },
  );
  if (!res.ok) throw new Error(`Failed to delete share group (${res.status})`);
  return await res.json();
}

/**
 * Delete a single share by its share_id (owner only).
 * @param {number} shareId
 */
export async function deleteShare(shareId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/share/${encodeURIComponent(shareId)}/delete?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    },
  );
  if (!res.ok) throw new Error(`Failed to delete share (${res.status})`);
  return await res.json();
}

/**
 * Remove a specific target device from a share group.
 * Sharer or recipient self-removal (hide).
 * @param {string} groupId
 * @param {string} targetDeviceId - The device_id to remove access for
 */
export async function removeShareTarget(groupId, targetDeviceId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/share/group/${encodeURIComponent(groupId)}/remove_target?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ device_id: targetDeviceId }),
    },
  );
  if (!res.ok) throw new Error(`Failed to remove share target (${res.status})`);
  return await res.json();
}

/**
 * Remove a specific target device from a share by share_id.
 * @param {number} shareId
 * @param {string} targetDeviceId
 */
export async function removeShareTargetByShareId(shareId, targetDeviceId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/share/${encodeURIComponent(shareId)}/remove_target?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ device_id: targetDeviceId }),
    },
  );
  if (!res.ok) throw new Error(`Failed to remove share target (${res.status})`);
  return await res.json();
}



/**
 * Fetch comments for a media item.
 * Uses mesh-aware retry for resilience against mid-session mesh roaming.
 * @param {number} mediaId
 */
export async function getComments(mediaId) {
  return fetchJsonWithMeshRetry(async () => {
    const { ip, port, key, deviceId } = await getConfig();
    return {
      url: `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/comments?device_id=${encodeURIComponent(deviceId)}`,
      options: { headers: { Authorization: `Bearer ${key}` } },
    };
  });
}

/**
 * Add a comment to a media item.
 * @param {number} mediaId
 * @param {string} text
 */
export async function addComment(mediaId, text) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/media/${encodeURIComponent(mediaId)}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ source_id: deviceId, text }),
    },
  );
  if (!res.ok) throw new Error(`Failed to add comment (${res.status})`);
  return await res.json();
}

/**
 * Delete one of your own comments (author-only on the server).
 * @param {number} commentId
 */
export async function deleteComment(commentId) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/api/comments/${encodeURIComponent(commentId)}/delete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ source_id: deviceId }),
    },
  );
  if (!res.ok) throw new Error(`Failed to delete comment (${res.status})`);
  return await res.json();
}