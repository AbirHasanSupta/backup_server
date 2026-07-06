import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Colors, TextScale } from '@/constants/theme';

const RING_SIZE = 220;
const INNER_SIZE = 180;

interface Props {
  isActive: boolean;
  progress: number; // 0–100
  uploaded: number;
  total: number;
}

export function SyncProgressRing({ isActive, progress, uploaded, total }: Props) {
  // Outer glow pulse
  const glowScale = useSharedValue(1);
  const glowOpacity = useSharedValue(0);

  // Spinner rotation
  const spinnerRotation = useSharedValue(0);
  const spinnerOpacity = useSharedValue(0);

  // Inner ring scale pulse
  const ringScale = useSharedValue(1);

  useEffect(() => {
    if (isActive) {
      glowScale.value = withRepeat(
        withSequence(
          withTiming(1.18, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
          withTiming(1.0, { duration: 1100, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
      glowOpacity.value = withRepeat(
        withSequence(
          withTiming(0.7, { duration: 900 }),
          withTiming(0.25, { duration: 900 })
        ),
        -1,
        true
      );
      spinnerRotation.value = withRepeat(
        withTiming(360, { duration: 1400, easing: Easing.linear }),
        -1,
        false
      );
      spinnerOpacity.value = withTiming(1, { duration: 300 });
      ringScale.value = withRepeat(
        withSequence(
          withTiming(1.03, { duration: 1000 }),
          withTiming(1.0, { duration: 1000 })
        ),
        -1,
        true
      );
    } else {
      glowScale.value = withTiming(1, { duration: 500 });
      glowOpacity.value = withTiming(0, { duration: 500 });
      spinnerOpacity.value = withTiming(0, { duration: 300 });
      ringScale.value = withTiming(1, { duration: 400 });
    }
  }, [isActive]);

  const glowStyle = useAnimatedStyle(() => ({
    transform: [{ scale: glowScale.value }],
    opacity: glowOpacity.value,
  }));

  const spinnerStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinnerRotation.value}deg` }],
    opacity: spinnerOpacity.value,
  }));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
  }));

  const progressPct = Math.round(progress);

  return (
    <View style={styles.container}>
      {/* Outer glow ring */}
      <Animated.View style={[styles.glow, glowStyle]} />

      {/* Spinner arc (rotating) */}
      <Animated.View style={[styles.spinner, spinnerStyle]} />

      {/* Main ring */}
      <Animated.View style={[styles.ring, isActive && styles.ringActive, ringStyle]}>
        {/* Inner solid circle */}
        <View style={styles.inner}>
          {isActive ? (
            <View style={styles.centerContent}>
              <Text style={styles.progressNumber}>{progressPct}</Text>
              <Text style={styles.progressSymbol}>%</Text>
              <Text style={styles.progressLabel}>
                {total > 0
                  ? `${uploaded} / ${total} files`
                  : 'Scanning…'}
              </Text>
            </View>
          ) : (
            <View style={styles.centerContent}>
              <Text style={styles.idleIcon}>☁️</Text>
              <Text style={styles.idleLabel}>Ready</Text>
            </View>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    backgroundColor: Colors.primaryGlow,
  },
  spinner: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 3,
    borderColor: Colors.transparent,
    borderTopColor: Colors.primaryLight,
    borderRightColor: Colors.primaryLight,
  },
  ring: {
    width: RING_SIZE - 8,
    height: RING_SIZE - 8,
    borderRadius: (RING_SIZE - 8) / 2,
    borderWidth: 2,
    borderColor: Colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  ringActive: {
    borderColor: Colors.primary,
  },
  inner: {
    width: INNER_SIZE,
    height: INNER_SIZE,
    borderRadius: INNER_SIZE / 2,
    backgroundColor: Colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerContent: {
    alignItems: 'center',
    gap: 2,
  },
  progressNumber: {
    fontSize: TextScale.xxl,
    fontWeight: '700',
    color: Colors.text,
    lineHeight: 36,
  },
  progressSymbol: {
    fontSize: TextScale.sm,
    fontWeight: '600',
    color: Colors.primaryLight,
    marginTop: -4,
  },
  progressLabel: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  idleIcon: {
    fontSize: 40,
  },
  idleLabel: {
    fontSize: TextScale.sm,
    color: Colors.textSecondary,
    marginTop: 6,
    fontWeight: '500',
  },
});
