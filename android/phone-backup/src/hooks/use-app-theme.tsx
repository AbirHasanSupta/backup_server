import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { AppColors, ColorSchemes, ThemeMode } from '@/constants/theme';
import { getThemeMode, setThemeMode as persistThemeMode } from '../../settings';

SplashScreen.preventAutoHideAsync().catch(() => {});

type AppThemeContextValue = {
  colors: AppColors;
  isDark: boolean;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => Promise<void>;
  toggleMode: () => Promise<void>;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode | null>(null);

  useEffect(() => {
    let mounted = true;
    getThemeMode()
      .then((savedMode: ThemeMode) => {
        if (!mounted) return;
        setModeState(savedMode);
        Appearance.setColorScheme(savedMode);
      })
      .catch(() => {
        if (!mounted) return;
        setModeState('light');
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!mode) return;
    SplashScreen.hideAsync().catch(() => {});
  }, [mode]);

  const setMode = useCallback(async (nextMode: ThemeMode) => {
    setModeState(nextMode);
    Appearance.setColorScheme(nextMode);
    await persistThemeMode(nextMode);
  }, []);

  const toggleMode = useCallback(async () => {
    if (!mode) return;
    await setMode(mode === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  const value = useMemo(
    () =>
      mode
        ? {
            colors: ColorSchemes[mode],
            isDark: mode === 'dark',
            mode,
            setMode,
            toggleMode,
          }
        : null,
    [mode, setMode, toggleMode]
  );

  // Keep splash visible until persisted theme is applied — avoids light→dark flash.
  if (!value) {
    return null;
  }

  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

export function useAppTheme() {
  const value = useContext(AppThemeContext);
  if (!value) {
    throw new Error('useAppTheme must be used inside AppThemeProvider');
  }
  return value;
}
