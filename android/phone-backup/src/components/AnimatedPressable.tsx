import React, { useCallback, useMemo } from 'react';
import { ViewStyle, StyleProp } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolate,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

interface AnimatedPressableProps {
  children?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  scaleDown?: number;
  disabled?: boolean;
  hitSlop?: number;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link' | 'checkbox' | 'radio';
  delayLongPress?: number;
  id?: string;
}

const SPRING_CONFIG = { damping: 15, stiffness: 400, mass: 0.5 };

export function AnimatedPressable({
  children,
  onPress,
  onLongPress,
  style,
  scaleDown = 0.97,
  disabled = false,
  hitSlop = 0,
  accessibilityLabel,
  delayLongPress = 350,
}: AnimatedPressableProps) {
  const pressed = useSharedValue(0);

  const invokePress = useCallback(() => {
    onPress?.();
  }, [onPress]);

  const invokeLongPress = useCallback(() => {
    onLongPress?.();
  }, [onLongPress]);

  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .enabled(!disabled)
      .hitSlop(hitSlop)
      .onBegin(() => {
        pressed.value = withSpring(1, SPRING_CONFIG);
      })
      .onEnd(() => {
        runOnJS(invokePress)();
      })
      .onFinalize(() => {
        pressed.value = withSpring(0, SPRING_CONFIG);
      });

    if (!onLongPress) {
      return tap;
    }

    const longPress = Gesture.LongPress()
      .enabled(!disabled)
      .hitSlop(hitSlop)
      .minDuration(delayLongPress)
      .onStart(() => {
        pressed.value = withSpring(1, SPRING_CONFIG);
        runOnJS(invokeLongPress)();
      })
      .onFinalize(() => {
        pressed.value = withSpring(0, SPRING_CONFIG);
      });

    return Gesture.Race(longPress, tap);
  }, [disabled, delayLongPress, hitSlop, invokePress, invokeLongPress, onLongPress, pressed]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: interpolate(pressed.value, [0, 1], [1, scaleDown]) },
    ],
    opacity: interpolate(pressed.value, [0, 1], [1, 0.85]),
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[style, animatedStyle, disabled && { opacity: 0.45 }]}
        accessible
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
