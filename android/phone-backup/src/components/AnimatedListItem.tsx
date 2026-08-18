import React, { useEffect, useRef } from 'react';
import { ViewStyle, StyleProp } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withDelay,
  withSpring,
} from 'react-native-reanimated';

interface AnimatedListItemProps {
  children: React.ReactNode;
  index: number;
  style?: StyleProp<ViewStyle>;
}

const MAX_STAGGER_DELAY = 400;
const STAGGER_PER_ITEM = 50;

export function AnimatedListItem({ children, index, style }: AnimatedListItemProps) {
  const translateY = useSharedValue(20);
  const opacity = useSharedValue(0);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (hasAnimated.current) {
      // Re-mounted after a tab switch or list recycle — skip stagger,
      // snap immediately to visible so items never stay at opacity 0.
      translateY.value = 0;
      opacity.value = 1;
      return;
    }
    hasAnimated.current = true;
    const delay = index < 8 ? Math.min(index * STAGGER_PER_ITEM, MAX_STAGGER_DELAY) : 0;
    translateY.value = delay > 0 ? withDelay(delay, withSpring(0, { damping: 18, stiffness: 200 })) : withSpring(0, { damping: 18, stiffness: 200 });
    opacity.value = delay > 0 ? withDelay(delay, withSpring(1, { damping: 18, stiffness: 200 })) : withSpring(1, { damping: 18, stiffness: 200 });
  }, [index, translateY, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[style, animatedStyle]}>
      {children}
    </Animated.View>
  );
}
