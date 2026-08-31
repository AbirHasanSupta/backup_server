import { useState, useEffect } from 'react';
import { Keyboard, Platform, KeyboardEvent, LayoutAnimation } from 'react-native';

export function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = (e: KeyboardEvent) => {
      if (Platform.OS === 'android') {
        try {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        } catch {}
      }
      setKeyboardHeight(e.endCoordinates.height);
      setIsKeyboardVisible(true);
    };

    const onHide = () => {
      if (Platform.OS === 'android') {
        try {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        } catch {}
      }
      setKeyboardHeight(0);
      setIsKeyboardVisible(false);
    };

    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);

    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  return { keyboardHeight, isKeyboardVisible };
}
