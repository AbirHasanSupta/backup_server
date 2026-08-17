import AsyncStorage from '@react-native-async-storage/async-storage';

const STREAK_KEY = 'backup_streak_v1';
const RISK_NOTIFIED_KEY = 'backup_streak_risk_notified_date';

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  const ms = new Date(`${toStr}T00:00:00`).getTime() - new Date(`${fromStr}T00:00:00`).getTime();
  return Math.round(ms / 86400000);
}

async function readRaw() {
  const raw = await AsyncStorage.getItem(STREAK_KEY).catch(() => null);
  if (!raw) return { currentStreak: 0, longestStreak: 0, lastSyncDate: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      currentStreak: Number(parsed.currentStreak) || 0,
      longestStreak: Number(parsed.longestStreak) || 0,
      lastSyncDate: parsed.lastSyncDate || null,
    };
  } catch {
    return { currentStreak: 0, longestStreak: 0, lastSyncDate: null };
  }
}

async function writeRaw(data) {
  await AsyncStorage.setItem(STREAK_KEY, JSON.stringify(data)).catch(() => {});
}

export async function getStreakData() {
  const data = await readRaw();
  const today = todayStr();
  if (data.lastSyncDate && daysBetween(data.lastSyncDate, today) >= 2) {
    data.currentStreak = 0;
    await writeRaw(data);
  }
  return {
    ...data,
    atRisk: data.currentStreak > 0 && data.lastSyncDate !== today,
  };
}

export async function recordSyncCompleted() {
  const data = await readRaw();
  const today = todayStr();
  if (data.lastSyncDate === today) return data;

  const isConsecutive = !!data.lastSyncDate && daysBetween(data.lastSyncDate, today) === 1;
  data.currentStreak = isConsecutive ? data.currentStreak + 1 : 1;
  data.longestStreak = Math.max(data.longestStreak, data.currentStreak);
  data.lastSyncDate = today;
  await writeRaw(data);
  return data;
}

export async function getLastStreakRiskNotifiedDate() {
  return (await AsyncStorage.getItem(RISK_NOTIFIED_KEY).catch(() => null)) || '';
}

export async function setLastStreakRiskNotifiedDate(dateStr) {
  await AsyncStorage.setItem(RISK_NOTIFIED_KEY, dateStr).catch(() => {});
}
