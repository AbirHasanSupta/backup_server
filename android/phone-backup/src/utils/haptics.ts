import { Platform } from 'react-native';

type HapticsModule = typeof import('expo-haptics');
type AndroidHaptic = Parameters<HapticsModule['performAndroidHapticsAsync']>[0];

let hapticsModule: HapticsModule | null = null;
try {
  // Optional native module — older dev clients and web should no-op.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hapticsModule = require('expo-haptics') as HapticsModule;
} catch {
  hapticsModule = null;
}

function canHaptic(): boolean {
  return Platform.OS !== 'web' && hapticsModule != null;
}

function run(fn: () => Promise<void>): void {
  fn().catch(() => {});
}

function hasAndroidHaptics(mod: HapticsModule): boolean {
  return Platform.OS === 'android' && typeof mod.performAndroidHapticsAsync === 'function';
}

function play(
  androidType: (mod: HapticsModule) => AndroidHaptic,
  ios: (mod: HapticsModule) => Promise<void>,
): void {
  if (!canHaptic() || !hapticsModule) return;
  const mod = hapticsModule;
  if (hasAndroidHaptics(mod)) {
    run(() => mod.performAndroidHapticsAsync(androidType(mod)));
    return;
  }
  run(() => ios(mod));
}

export function hapticLight(): void {
  play(
    (mod) => mod.AndroidHaptics.Keyboard_Tap,
    (mod) => mod.impactAsync(mod.ImpactFeedbackStyle.Light),
  );
}

export function hapticMedium(): void {
  play(
    (mod) => mod.AndroidHaptics.Confirm,
    (mod) => mod.impactAsync(mod.ImpactFeedbackStyle.Medium),
  );
}

export function hapticLongPress(): void {
  play(
    (mod) => mod.AndroidHaptics.Long_Press,
    (mod) => mod.impactAsync(mod.ImpactFeedbackStyle.Medium),
  );
}

export function hapticSelection(): void {
  play(
    (mod) => mod.AndroidHaptics.Segment_Tick,
    (mod) => mod.selectionAsync(),
  );
}

export function hapticSuccess(): void {
  play(
    (mod) => mod.AndroidHaptics.Confirm,
    (mod) => mod.notificationAsync(mod.NotificationFeedbackType.Success),
  );
}

export function hapticWarning(): void {
  play(
    (mod) => mod.AndroidHaptics.Gesture_End,
    (mod) => mod.notificationAsync(mod.NotificationFeedbackType.Warning),
  );
}

export function hapticError(): void {
  play(
    (mod) => mod.AndroidHaptics.Reject,
    (mod) => mod.notificationAsync(mod.NotificationFeedbackType.Error),
  );
}
