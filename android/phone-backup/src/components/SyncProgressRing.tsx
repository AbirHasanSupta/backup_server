import React, { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { AppColors, Radius, Shadows, Spacing, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

const RING_SIZE = 226;
const INNER_SIZE = 176;

export type SyncPhase = 'scanning' | 'checking' | 'uploading' | 'idle';

interface Props {
  isActive: boolean;
  progress: number;
  uploaded: number;
  total: number;
  phase?: SyncPhase;
  checked?: number;
  checkTotal?: number;
}

export function SyncProgressRing({
  isActive,
  progress,
  uploaded,
  total,
  phase = 'idle',
  checked = 0,
  checkTotal = 0,
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const pulse = useSharedValue(1);
  const sweep = useSharedValue(0);

  useEffect(() => {
    if (isActive) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.04, { duration: 950, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 950, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
      sweep.value = withRepeat(
        withTiming(360, { duration: 1600, easing: Easing.linear }),
        -1,
        false
      );
    } else {
      pulse.value = withTiming(1, { duration: 300 });
      sweep.value = withTiming(0, { duration: 300 });
    }
  }, [isActive, pulse, sweep]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${sweep.value}deg` }],
    opacity: isActive ? 1 : 0,
  }));

  const progressPct = Math.max(0, Math.min(100, Math.round(progress)));

  const label = (() => {
    if (!isActive) return 'Ready to back up';
    if (phase === 'scanning') return 'Scanning folders';
    if (phase === 'checking') return checkTotal > 0 ? `${checked} of ${checkTotal} checked` : 'Checking server';
    if (phase === 'uploading' && total > 0) return `${uploaded} of ${total} files`;
    return 'Preparing backup';
  })();

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.halo, pulseStyle]} />
      <Animated.View style={[styles.sweep, sweepStyle]} />
      <View style={styles.ring}>
        <View style={styles.inner}>
          <View style={styles.iconWrap}>
            <AppIcon
              androidName={isActive ? 'sync' : 'cloud_done'}
              iosName={isActive ? 'arrow.triangle.2.circlepath' : 'checkmark.icloud'}
              color={isActive ? colors.primary : colors.success}
              size={30}
              fallback={isActive ? 'S' : 'OK'}
            />
          </View>
          {isActive && (phase === 'checking' || phase === 'uploading') ? (
            <View style={styles.percentRow}>
              <Text style={styles.progressNumber}>{progressPct}</Text>
              <Text style={styles.progressSymbol}>%</Text>
            </View>
          ) : (
            <Text style={styles.readyText}>{isActive ? 'Working' : 'All set'}</Text>
          )}
          <Text style={styles.progressLabel} numberOfLines={2}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  container: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    backgroundColor: colors.primaryGlow,
  },
  sweep: {
    position: 'absolute',
    width: RING_SIZE - 10,
    height: RING_SIZE - 10,
    borderRadius: (RING_SIZE - 10) / 2,
    borderWidth: 3,
    borderColor: colors.transparent,
    borderTopColor: colors.primary,
    borderRightColor: colors.primaryLight,
  },
  ring: {
    width: RING_SIZE - 16,
    height: RING_SIZE - 16,
    borderRadius: (RING_SIZE - 16) / 2,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    ...Shadows.soft,
  },
  inner: {
    width: INNER_SIZE,
    height: INNER_SIZE,
    borderRadius: INNER_SIZE / 2,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  iconWrap: {
    width: 54,
    height: 54,
    borderRadius: Radius.full,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.three,
  },
  percentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  progressNumber: {
    fontSize: TextScale.xxl,
    fontWeight: '800',
    color: colors.text,
    lineHeight: 38,
  },
  progressSymbol: {
    fontSize: TextScale.sm,
    fontWeight: '800',
    color: colors.primary,
    marginTop: 4,
  },
  readyText: {
    fontSize: TextScale.lg,
    fontWeight: '800',
    color: colors.text,
  },
  progressLabel: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    marginTop: Spacing.two,
    textAlign: 'center',
    fontWeight: '600',
  },
});
