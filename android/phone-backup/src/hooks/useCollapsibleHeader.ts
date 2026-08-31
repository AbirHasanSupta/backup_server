import { useRef, useCallback, useEffect, useState } from 'react';
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
  StyleProp,
  ViewStyle,
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
 * Uses GPU-accelerated translateY for the header while keeping the scroll container
 * layout frame completely static to prevent layout reflow oscillation / jitter.
 */
export function useCollapsibleHeader({
  headerHeight: estimatedHeight,
  topInset = 0,
}: CollapsibleHeaderConfig) {
  const safeTopInset = Math.max(topInset, 0);
  const initialH = Math.max(estimatedHeight, 1);
  const [measuredHeight, setMeasuredHeight] = useState(initialH);
  const heightSV = useSharedValue(initialH);
  const headerTranslateY = useSharedValue(0);
  const lastScrollY = useRef(0);
  const measuredRef = useRef(initialH);

  useEffect(() => {
    const next = Math.max(estimatedHeight, 1);
    // Prefer live layout measurement; only fall back when estimate changes
    // before the first onLayout (e.g. safe-area insets settle).
    if (Math.abs(measuredRef.current - next) > 8) {
      const wasCollapsed = headerTranslateY.value < -measuredRef.current * 0.5;
      measuredRef.current = next;
      heightSV.value = next;
      setMeasuredHeight(next);
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
      setMeasuredHeight(h);
      if (wasCollapsed) {
        headerTranslateY.value = -h;
      } else if (lastScrollY.current < 4 && headerTranslateY.value < 0) {
        // Layout changed while pinned at the top — keep the header visible.
        headerTranslateY.value = 0;
      }
    },
    [headerTranslateY, heightSV]
  );

  const expandHeader = useCallback((scrollY?: number) => {
    if (scrollY !== undefined) {
      lastScrollY.current = Math.max(0, scrollY);
    }
    headerTranslateY.value = withTiming(0, { duration: 200 });
  }, [headerTranslateY]);

  const syncScrollY = useCallback((scrollY: number) => {
    lastScrollY.current = Math.max(0, scrollY);
  }, []);

  // Tracks the finger 1:1 during the drag.
  // snapHeader settles to fully open/closed once the drag ends.
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const headerHeight = measuredRef.current;
      const currentY = Math.max(0, event.nativeEvent.contentOffset.y);
      const diff = currentY - lastScrollY.current;
      lastScrollY.current = currentY;

      if (currentY <= 0) {
        headerTranslateY.value = withTiming(0, { duration: 150 });
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
    headerTranslateY.value = withTiming(shouldCollapse ? -headerHeight : 0, { duration: 180 });
  }, [headerTranslateY]);

  const headerAnimatedStyle = useAnimatedStyle(() => {
    const headerHeight = Math.max(heightSV.value, 1);
    const collapsed = headerTranslateY.value < -headerHeight * 0.5;
    return {
      position: 'absolute' as const,
      // Keep the header below the system status bar while it is visible and animated.
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

  /** Static flex wrapper — sits below the status bar so scroll content never overlaps it */
  const scrollAreaStyle: StyleProp<ViewStyle> = {
    flex: 1,
    marginTop: safeTopInset,
  };

  /** Fixed fill behind the system status bar */
  const statusBarFillStyle: StyleProp<ViewStyle> = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: safeTopInset,
    zIndex: 20,
  };

  return {
    headerHeight: measuredHeight,
    containerPaddingTop: measuredHeight,
    progressViewOffset: measuredHeight,
    headerTranslateY,
    headerAnimatedStyle,
    scrollAreaStyle,
    statusBarFillStyle,
    contentInsetStyle: scrollAreaStyle,
    onScroll,
    onScrollEndDrag: snapHeader,
    onMomentumScrollEnd: snapHeader,
    onHeaderLayout,
    expandHeader,
    syncScrollY,
  };
}