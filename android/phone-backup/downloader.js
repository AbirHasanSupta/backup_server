import * as FileSystem from 'expo-file-system/legacy';
import { getServerIp, getServerPort, getApiKey, getDeviceId, getDeviceToken } from './settings';

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
    throw err;
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
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function getPlaceClusters(options = {}) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/places?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` }, signal: options.signal },
  );
  if (!res.ok) throw new Error(`Failed to fetch places (${res.status})`);
  return await readJsonOrNull(res);
}

/**
 * Fetch all items within a single place cluster.
 * @param {string} clusterKey
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function getPlaceItems(clusterKey, options = {}) {
  const { ip, port, key, deviceId } = await getConfig();
  const res = await fetch(
    `http://${ip}:${port}/memories/places/${encodeURIComponent(clusterKey)}?device_id=${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${key}` }, signal: options.signal },
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