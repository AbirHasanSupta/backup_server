import { useRef, useCallback } from 'react';
import {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

interface CollapsibleHeaderConfig {
  headerHeight: number;
  scrollThreshold?: number;
  snapThreshold?: number;
}

export function useCollapsibleHeader({
  headerHeight,
  scrollThreshold = 10,
  snapThreshold = 0.5,
}: CollapsibleHeaderConfig) {
  const scrollY = useSharedValue(0);
  const headerTranslateY = useSharedValue(0);
  const lastScrollY = useRef(0);
  const isHeaderVisible = useRef(true);

  /* eslint-disable react-hooks/immutability -- Reanimated shared values are designed to be mutated */
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const currentY = event.nativeEvent.contentOffset.y;
      const diff = currentY - lastScrollY.current;

      if (currentY <= 0) {
        headerTranslateY.value = withTiming(0, { duration: 250 });
        isHeaderVisible.current = true;
      } else if (diff > scrollThreshold && currentY > headerHeight) {
        headerTranslateY.value = withTiming(-headerHeight, { duration: 300 });
        isHeaderVisible.current = false;
      } else if (diff < -scrollThreshold) {
        headerTranslateY.value = withTiming(0, { duration: 250 });
        isHeaderVisible.current = true;
      }

      lastScrollY.current = currentY;
      scrollY.value = currentY;
    },
    [headerHeight, scrollThreshold, headerTranslateY, scrollY]
  );
  /* eslint-enable react-hooks/immutability */

  const headerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: headerTranslateY.value }],
  }));

  const tabBarAnimatedStyle = useAnimatedStyle(() => {
    const progress = interpolate(
      headerTranslateY.value,
      [-headerHeight, 0],
      [1, 0],
      Extrapolation.CLAMP
    );
    return {
      transform: [
        {
          translateY: interpolate(
            progress,
            [0, 1],
            [0, 100],
            Extrapolation.CLAMP
          ),
        },
      ],
    };
  });

  return {
    scrollY,
    headerTranslateY,
    headerAnimatedStyle,
    tabBarAnimatedStyle,
    onScroll,
  };
}
