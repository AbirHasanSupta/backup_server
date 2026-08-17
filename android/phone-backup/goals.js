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
  const scanned = await scan(null, null, snapshotCache, {
    incremental: false,
    shouldStop: () => !!shouldStop?.(),
  });
  if (scanned?.stopped || shouldStop?.()) return cachedFiles || [];

  cachedFiles = Array.isArray(scanned) ? scanned : [];
  cachedAt = Date.now();
  return cachedFiles;
}

export async function computeGoalProgress(goal, shouldStop) {
  const files = await collectAllLocalFiles(shouldStop);
  if (shouldStop?.()) return null;

  const getYear = (mtime) => {
    if (!mtime) return null;
    const ms = mtime > 1e11 ? mtime : mtime * 1000;
    return new Date(ms).getFullYear();
  };

  const inYear = files.filter((f) => getYear(f.modifiedTime) === goal.year);
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
  const results = [];
  for (const goal of goals) {
    if (shouldStop?.()) break;
    const progress = await computeGoalProgress(goal, shouldStop);
    if (!progress) break;
    if (progress.percent >= 100 && progress.total > 0 && !goal.completedAt) {
      await markGoalCompleted(goal.id);
      goal.completedAt = Date.now();
      goal.notifiedComplete = true;
      await showGoalCompleteNotification(goal).catch(() => {});
    }
    results.push({ goal, progress });
  }
  return results;
}