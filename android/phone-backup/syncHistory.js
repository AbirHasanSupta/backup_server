import AsyncStorage from '@react-native-async-storage/async-storage';

const SYNC_HISTORY_KEY = 'sync_history_v1';
const MAX_SESSIONS = 50;

/**
 * @typedef {Object} SyncSession
 * @property {string}   id
 * @property {number}   startedAt       epoch ms
 * @property {number}   endedAt         epoch ms
 * @property {number}   durationMs
 * @property {'completed'|'stopped'|'force_stopped'|'failed'} outcome
 * @property {'manual'|'auto'} trigger
 * @property {number}   scanned
 * @property {number}   checked
 * @property {number}   uploaded
 * @property {number}   skipped
 * @property {number}   errors
 * @property {number}   totalFiles
 * @property {number}   totalSize
 * @property {string[]} uploadedFiles   up to 20 basenames
 * @property {string[]} errorDetails    up to 10 messages
 * @property {string[]} folders
 */

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/**
 * Load the full history array (newest first).
 * @returns {Promise<SyncSession[]>}
 */
export async function getSyncHistory() {
  const raw = await AsyncStorage.getItem(SYNC_HISTORY_KEY).catch(() => null);
  const arr = safeJsonParse(raw, []);
  return Array.isArray(arr) ? arr : [];
}

/**
 * Prepend a new session and trim to MAX_SESSIONS.
 * @param {Partial<SyncSession>} session
 */
export async function appendSyncSession(session) {
  try {
    const existing = await getSyncHistory();
    const entry = {
      id:            session.id            ?? String(Date.now()),
      startedAt:     session.startedAt     ?? Date.now(),
      endedAt:       session.endedAt       ?? Date.now(),
      durationMs:    session.durationMs    ?? 0,
      outcome:       session.outcome       ?? 'completed',
      trigger:       session.trigger       ?? 'manual',
      scanned:       session.scanned       ?? 0,
      checked:       session.checked       ?? 0,
      uploaded:      session.uploaded      ?? 0,
      skipped:       session.skipped       ?? 0,
      errors:        session.errors        ?? 0,
      totalFiles:    session.totalFiles    ?? 0,
      totalSize:     session.totalSize     ?? 0,
      uploadedFiles: (session.uploadedFiles ?? []).slice(0, 20),
      errorDetails:  (session.errorDetails  ?? []).slice(0, 10),
      folders:       session.folders       ?? [],
    };
    const updated = [entry, ...existing].slice(0, MAX_SESSIONS);
    await AsyncStorage.setItem(SYNC_HISTORY_KEY, JSON.stringify(updated));
    return entry;
  } catch (err) {
    console.warn('[SyncHistory] Failed to save session:', err?.message);
    return null;
  }
}

/**
 * Remove all stored sessions.
 */
export async function clearSyncHistory() {
  await AsyncStorage.removeItem(SYNC_HISTORY_KEY).catch(() => {});
}
