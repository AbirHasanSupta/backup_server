import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFolders, loadScanSnapshot, isUploadedBatch } from './settings';
import { scan } from './scanner';
import { showGoalCompleteNotification } from './notificationService';

const GOALS_KEY = 'backup_goals_v1';
const FILES_STALE_MS = 2 * 60 * 1000;

let cachedFiles = null;
let cachedAt = 0;

function newId() {
  return `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readGoals() {
  const raw = await AsyncStorage.getItem(GOALS_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeGoals(goals) {
  await AsyncStorage.setItem(GOALS_KEY, JSON.stringify(goals)).catch(() => {});
}

export async function getGoals() {
  return readGoals();
}

export async function addGoal(year) {
  const goals = await readGoals();
  if (goals.some((g) => g.year === year)) return goals;
  goals.push({
    id: newId(),
    year,
    createdAt: Date.now(),
    completedAt: null,
    notifiedComplete: false,
  });
  goals.sort((a, b) => b.year - a.year);
  await writeGoals(goals);
  return goals;
}

export async function removeGoal(id) {
  const goals = (await readGoals()).filter((g) => g.id !== id);
  await writeGoals(goals);
  return goals;
}

export async function markGoalCompleted(id) {
  const goals = await readGoals();
  const goal = goals.find((g) => g.id === id);
  if (goal && !goal.completedAt) {
    goal.completedAt = Date.now();
    goal.notifiedComplete = true;
    await writeGoals(goals);
  }
  return goals;
}

export function invalidateGoalsFileCache() {
  cachedFiles = null;
  cachedAt = 0;
}

async function collectAllLocalFiles(shouldStop) {
  const now = Date.now();
  if (cachedFiles && now - cachedAt < FILES_STALE_MS) return cachedFiles;

  const folders = await getFolders();
  if (!folders.length) return [];

  const snapshotCache = await loadScanSnapshot();
  const filesMap = new Map();
  for (const [path, meta] of snapshotCache.entries()) {
    filesMap.set(path, {
      relativePath: path,
      modifiedTime: meta.mtime,
      size: meta.size,
    });
  }

  // If snapshot exists, populate cachedFiles instantly so UI renders immediately
  if (snapshotCache.size > 0) {
    cachedFiles = Array.from(filesMap.values());
    cachedAt = Date.now();
    // Refresh newly added files in non-blocking scan
    scan(null, null, snapshotCache, { incremental: true, noMetadata: true }).then((scanned) => {
      if (Array.isArray(scanned) && scanned.length > 0) {
        for (const f of scanned) {
          if (f?.relativePath && !filesMap.has(f.relativePath)) {
            filesMap.set(f.relativePath, {
              relativePath: f.relativePath,
              modifiedTime: f.modifiedTime || 0,
              size: f.size || 0,
            });
          }
        }
        cachedFiles = Array.from(filesMap.values());
        cachedAt = Date.now();
      }
    }).catch(() => {});
    return cachedFiles;
  }

  // Initial scan before any snapshot
  const scanned = await scan(null, null, null, {
    incremental: false,
    noMetadata: true,
    shouldStop: () => !!shouldStop?.(),
  });

  if (Array.isArray(scanned)) {
    for (const f of scanned) {
      if (f?.relativePath && !filesMap.has(f.relativePath)) {
        filesMap.set(f.relativePath, {
          relativePath: f.relativePath,
          modifiedTime: f.modifiedTime || 0,
          size: f.size || 0,
        });
      }
    }
  }

  cachedFiles = Array.from(filesMap.values());
  cachedAt = Date.now();
  return cachedFiles;
}

function getFileYear(file) {
  const mtime = file?.modifiedTime;
  if (mtime && mtime > 0) {
    const ms = mtime > 1e11 ? mtime : mtime * 1000;
    const y = new Date(ms).getFullYear();
    if (y >= 1990 && y <= 2100) return y;
  }
  const match = String(file?.relativePath || file?.name || '').match(/\b(20[0-2][0-9])\b/);
  if (match) return parseInt(match[1], 10);
  return null;
}

export async function computeGoalProgress(goal, shouldStop) {
  const files = await collectAllLocalFiles(shouldStop);
  if (shouldStop?.()) return null;

  const inYear = files.filter((f) => getFileYear(f) === goal.year);
  if (!inYear.length) return { total: 0, backedUp: 0, percent: 0 };

  const trusted = await isUploadedBatch(inYear);
  if (shouldStop?.()) return null;

  const backedUp = inYear.filter((f) =>
    trusted.has(`${f.relativePath}|${f.modifiedTime}|${f.size || 0}`)
  ).length;

  return {
    total: inYear.length,
    backedUp,
    percent: Math.round((backedUp / inYear.length) * 100),
  };
}

export async function computeAllGoalsProgress(shouldStop) {
  const goals = await readGoals();
  if (!goals.length) return [];
  const files = await collectAllLocalFiles(shouldStop);
  if (shouldStop?.()) return [];

  const results = [];
  let goalsChanged = false;

  for (const goal of goals) {
    if (shouldStop?.()) break;
    const inYear = files.filter((f) => getFileYear(f) === goal.year);
    if (!inYear.length) {
      const progress = { total: 0, backedUp: 0, percent: 0 };
      goal.lastProgress = progress;
      goalsChanged = true;
      results.push({ goal, progress });
      continue;
    }

    const trusted = await isUploadedBatch(inYear);
    if (shouldStop?.()) break;

    const backedUp = inYear.filter((f) =>
      trusted.has(`${f.relativePath}|${f.modifiedTime}|${f.size || 0}`)
    ).length;

    const progress = {
      total: inYear.length,
      backedUp,
      percent: Math.round((backedUp / inYear.length) * 100),
    };

    goal.lastProgress = progress;
    goalsChanged = true;

    if (progress.percent >= 100 && progress.total > 0 && !goal.completedAt) {
      goal.completedAt = Date.now();
      goal.notifiedComplete = true;
      await showGoalCompleteNotification(goal).catch(() => {});
    }
    results.push({ goal, progress });
  }

  if (goalsChanged) {
    await writeGoals(goals);
  }
  return results;
}