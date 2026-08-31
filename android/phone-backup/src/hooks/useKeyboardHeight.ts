import { useState, useEffect } from 'react';
import { Keyboard, Platform, KeyboardEvent, LayoutAnimation } from 'react-native';

/**
 * Tracks keyboard height for main-screen (non-modal) use.
 * Works alongside windowSoftInputMode="adjustResize" on Android.
 */
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

/**
 * Tracks keyboard height for use inside React Native Modal components.
 *
 * On Android, Modals are rendered inside their own separate PhoneWindow and
 * are NOT affected by windowSoftInputMode="adjustResize" set on MainActivity.
 * This means the keyboard will overlap the modal content unless we manually
 * shift it up by the keyboard height.
 */
export function useModalKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = (e: KeyboardEvent) => {
      setKeyboardHeight(e.endCoordinates.height);
      setIsKeyboardVisible(true);
    };

    const onHide = () => {
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
