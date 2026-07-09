import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';

import { AppColors, ColorSchemes, ThemeMode } from '@/constants/theme';
import { getThemeMode, setThemeMode as persistThemeMode } from '../../settings';

type AppThemeContextValue = {
  colors: AppColors;
  isDark: boolean;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => Promise<void>;
  toggleMode: () => Promise<void>;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('light');

  useEffect(() => {
    let mounted = true;
    getThemeMode().then((savedMode: ThemeMode) => {
      if (!mounted) return;
      setModeState(savedMode);
      Appearance.setColorScheme(savedMode);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const setMode = useCallback(async (nextMode: ThemeMode) => {
    setModeState(nextMode);
    Appearance.setColorScheme(nextMode);
    await persistThemeMode(nextMode);
  }, []);

  const toggleMode = useCallback(async () => {
    await setMode(mode === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  const value = useMemo(
    () => ({
      colors: ColorSchemes[mode],
      isDark: mode === 'dark',
      mode,
      setMode,
      toggleMode,
    }),
    [mode, setMode, toggleMode]
  );

  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
}

export function useAppTheme() {
  const value = useContext(AppThemeContext);
  if (!value) {
    throw new Error('useAppTheme must be used inside AppThemeProvider');
  }
  return value;
}
