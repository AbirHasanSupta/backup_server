import { NativeModules, Platform } from 'react-native';

const WakeLockModule = NativeModules.PhoneBackupWakeLock;

export async function acquireSyncWakeLock() {
  if (Platform.OS !== 'android' || !WakeLockModule?.acquire) return false;

  try {
    await WakeLockModule.acquire();
    return true;
  } catch (err) {
    console.warn('[WakeLock] Could not acquire sync wake lock:', err?.message);
    return false;
  }
}

export async function releaseSyncWakeLock(acquired) {
  if (!acquired || Platform.OS !== 'android' || !WakeLockModule?.release) return;

  try {
    await WakeLockModule.release();
  } catch (err) {
    console.warn('[WakeLock] Could not release sync wake lock:', err?.message);
  }
}
