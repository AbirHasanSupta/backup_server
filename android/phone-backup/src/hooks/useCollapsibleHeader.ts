import { useRef, useCallback, useEffect } from 'react';
import {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';

/* eslint-disable react-hooks/immutability -- Reanimated shared values are designed to be mutated */
interface CollapsibleHeaderConfig {
  /** Estimated header height used until onLayout measures the real one. */
  headerHeight: number;
  /** Height of the system status-bar inset that must remain unobstructed. */
  topInset?: number;
}

/**
 * Collapses the page header on scroll down and restores it on scroll up.
 * Uses translateY for the header and a matching content inset so the blank
 * header slot is reclaimed (transform alone leaves empty layout space).
 */
export function useCollapsibleHeader({
  headerHeight: estimatedHeight,
  topInset = 0,
}: CollapsibleHeaderConfig) {
  const safeTopInset = Math.max(topInset, 0);
  const heightSV = useSharedValue(Math.max(estimatedHeight, 1));
  const headerTranslateY = useSharedValue(0);
  const lastScrollY = useRef(0);
  const measuredRef = useRef(Math.max(estimatedHeight, 1));

  useEffect(() => {
    const next = Math.max(estimatedHeight, 1);
    // Prefer live layout measurement; only fall back when estimate changes
    // before the first onLayout (e.g. safe-area insets settle).
    if (Math.abs(measuredRef.current - next) > 8) {
      const wasCollapsed = headerTranslateY.value < -measuredRef.current * 0.5;
      measuredRef.current = next;
      heightSV.value = next;
      if (wasCollapsed) {
        headerTranslateY.value = -next;
      }
    }
  }, [estimatedHeight, heightSV, headerTranslateY]);

  const onHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const h = Math.round(event.nativeEvent.layout.height);
      if (h <= 0 || Math.abs(h - measuredRef.current) < 2) return;
      const wasCollapsed = headerTranslateY.value < -measuredRef.current * 0.5;
      measuredRef.current = h;
      heightSV.value = h;
      if (wasCollapsed) {
        headerTranslateY.value = -h;
      }
    },
    [headerTranslateY, heightSV]
  );

  const expandHeader = useCallback(() => {
    headerTranslateY.value = withTiming(0, { duration: 200 });
  }, [headerTranslateY]);

  // Tracks the finger 1:1 during the drag (no withTiming mid-gesture, so
  // there is never more than one animation competing for the shared value).
  // snapHeader settles to fully open/closed once the drag ends.
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const headerHeight = measuredRef.current;
      const currentY = Math.max(0, event.nativeEvent.contentOffset.y);
      const diff = currentY - lastScrollY.current;
      lastScrollY.current = currentY;

      if (currentY <= 0) {
        headerTranslateY.value = withTiming(0, { duration: 200 });
        return;
      }
      if (Math.abs(diff) < 0.5) return;

      const next = Math.min(0, Math.max(-headerHeight, headerTranslateY.value - diff));
      headerTranslateY.value = next;
    },
    [headerTranslateY]
  );

  const snapHeader = useCallback(() => {
    const headerHeight = measuredRef.current;
    const shouldCollapse = headerTranslateY.value < -headerHeight * 0.5;
    headerTranslateY.value = withTiming(shouldCollapse ? -headerHeight : 0, { duration: 200 });
  }, [headerTranslateY]);

  const headerAnimatedStyle = useAnimatedStyle(() => {
    const headerHeight = Math.max(heightSV.value, 1);
    const collapsed = headerTranslateY.value < -headerHeight * 0.5;
    return {
      position: 'absolute' as const,
      // These pages run edge-to-edge on Android. Keep the header below the
      // system status bar while it is visible and while it is animated.
      top: safeTopInset,
      left: 0,
      right: 0,
      zIndex: 10,
      transform: [{ translateY: headerTranslateY.value }],
      opacity: interpolate(
        headerTranslateY.value,
        [-headerHeight, -headerHeight * 0.6, 0],
        [0, 0.4, 1],
        Extrapolation.CLAMP
      ),
      pointerEvents: collapsed ? ('none' as const) : ('auto' as const),
    };
  });

  /** Apply to a flex wrapper around the scrollable content. */
  const contentInsetStyle = useAnimatedStyle(() => {
    const headerHeight = Math.max(heightSV.value, 1);
    return {
      flex: 1,
      paddingTop: interpolate(
        headerTranslateY.value,
        [-headerHeight, 0],
        [safeTopInset, safeTopInset + headerHeight],
        Extrapolation.CLAMP
      ),
    };
  });

  return {
    headerTranslateY,
    headerAnimatedStyle,
    contentInsetStyle,
    onScroll,
    onScrollEndDrag: snapHeader,
    onMomentumScrollEnd: snapHeader,
    onHeaderLayout,
    expandHeader,
  };
}