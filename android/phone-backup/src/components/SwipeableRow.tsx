import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { AppIcon } from '@/components/AppIcon';

const ACTION_WIDTH = 80;
const SNAP_THRESHOLD = ACTION_WIDTH * 0.6;
const SPRING_CONFIG = { damping: 20, stiffness: 300, mass: 0.8 };

interface SwipeableRowProps {
  children: React.ReactNode;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  leftIcon?: string;
  leftIosIcon?: string;
  leftColor?: string;
  leftLabel?: string;
  rightIcon?: string;
  rightIosIcon?: string;
  rightColor?: string;
  rightLabel?: string;
  enabled?: boolean;
}

export function SwipeableRow({
  children,
  onSwipeLeft,
  onSwipeRight,
  leftIcon = 'sync',
  leftIosIcon = 'arrow.triangle.2.circlepath',
  leftColor = '#2563EB',
  leftLabel = 'Refresh',
  rightIcon = 'delete',
  rightIosIcon = 'trash',
  rightColor = '#DC2626',
  rightLabel = 'Remove',
  enabled = true,
}: SwipeableRowProps) {
  const translateX = useSharedValue(0);
  const contextX = useSharedValue(0);

  const pan = Gesture.Pan()
    .enabled(enabled && (!!onSwipeLeft || !!onSwipeRight))
    .activeOffsetX([-15, 15])
    .failOffsetY([-10, 10])
    .onBegin(() => {
      contextX.value = translateX.value;
    })
    .onUpdate((e) => {
      let nextX = contextX.value + e.translationX;
      if (!onSwipeRight) nextX = Math.min(nextX, 0);
      if (!onSwipeLeft) nextX = Math.max(nextX, 0);
      const max = ACTION_WIDTH + 20;
      if (nextX > max) nextX = max + (nextX - max) * 0.2;
      if (nextX < -max) nextX = -max + (nextX + max) * 0.2;
      translateX.value = nextX;
    })
    .onEnd((e) => {
      if (translateX.value < -SNAP_THRESHOLD && onSwipeLeft) {
        translateX.value = withTiming(-ACTION_WIDTH, { duration: 200 });
        runOnJS(onSwipeLeft)();
        translateX.value = withSpring(0, SPRING_CONFIG);
      } else if (translateX.value > SNAP_THRESHOLD && onSwipeRight) {
        translateX.value = withTiming(ACTION_WIDTH, { duration: 200 });
        runOnJS(onSwipeRight)();
        translateX.value = withSpring(0, SPRING_CONFIG);
      } else {
        translateX.value = withSpring(0, SPRING_CONFIG);
      }
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const leftActionStyle = useAnimatedStyle(() => {
    const progress = interpolate(translateX.value, [0, ACTION_WIDTH], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: progress,
      transform: [{ scale: interpolate(progress, [0, 1], [0.5, 1], Extrapolation.CLAMP) }],
    };
  });

  const rightActionStyle = useAnimatedStyle(() => {
    const progress = interpolate(translateX.value, [-ACTION_WIDTH, 0], [1, 0], Extrapolation.CLAMP);
    return {
      opacity: progress,
      transform: [{ scale: interpolate(progress, [0, 1], [0.5, 1], Extrapolation.CLAMP) }],
    };
  });

  return (
    <View style={styles.container}>
      {onSwipeRight && (
        <Animated.View style={[styles.leftAction, { backgroundColor: leftColor }, leftActionStyle]}>
          <AppIcon androidName={leftIcon} iosName={leftIosIcon} color="#fff" size={22} />
          <Text style={styles.actionLabel}>{leftLabel}</Text>
        </Animated.View>
      )}
      {onSwipeLeft && (
        <Animated.View style={[styles.rightAction, { backgroundColor: rightColor }, rightActionStyle]}>
          <AppIcon androidName={rightIcon} iosName={rightIosIcon} color="#fff" size={22} />
          <Text style={styles.actionLabel}>{rightLabel}</Text>
        </Animated.View>
      )}
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 16,
    marginBottom: 12,
  },
  leftAction: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: ACTION_WIDTH,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  rightAction: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: ACTION_WIDTH,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
