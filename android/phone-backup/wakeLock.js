import { NativeModules, Platform } from 'react-native';

const WakeLockModule = NativeModules.PhoneBackupWakeLock;
const SAFETY_AUTO_RELEASE_MS = 45 * 60 * 1000; // 45 minutes safety auto-release
let autoReleaseTimer = null;

export async function acquireSyncWakeLock() {
  if (Platform.OS !== 'android' || !WakeLockModule?.acquire) return false;

  try {
    await WakeLockModule.acquire();
    if (autoReleaseTimer) clearTimeout(autoReleaseTimer);
    autoReleaseTimer = setTimeout(() => {
      console.warn('[WakeLock] Safety auto-release timeout reached (45m). Releasing wake lock.');
      releaseSyncWakeLock(true).catch(() => {});
    }, SAFETY_AUTO_RELEASE_MS);
    return true;
  } catch (err) {
    console.warn('[WakeLock] Could not acquire sync wake lock:', err?.message);
    return false;
  }
}

export async function releaseSyncWakeLock(acquired) {
  if (autoReleaseTimer) {
    clearTimeout(autoReleaseTimer);
    autoReleaseTimer = null;
  }
  if (!acquired || Platform.OS !== 'android' || !WakeLockModule?.release) return;

  try {
    await WakeLockModule.release();
  } catch (err) {
    console.warn('[WakeLock] Could not release sync wake lock:', err?.message);
  }
}
