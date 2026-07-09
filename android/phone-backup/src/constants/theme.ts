import { Platform } from 'react-native';

export const Colors = {
  bg: '#F5F7FB',
  bgWarm: '#EFF6F4',
  surface: '#FFFFFF',
  surfaceSoft: '#F9FBFD',
  surfaceElevated: '#FFFFFF',
  surfaceBorder: '#DCE5EE',

  ink: '#102033',
  text: '#102033',
  textSecondary: '#637487',
  textMuted: '#92A0AF',

  primary: '#2563EB',
  primaryDark: '#1D4ED8',
  primaryLight: '#60A5FA',
  primarySoft: '#E8F0FF',
  primaryDim: '#E8F0FF',
  primaryGlow: 'rgba(37, 99, 235, 0.16)',

  success: '#059669',
  successSoft: '#E4F8EF',
  successDim: '#E4F8EF',
  warning: '#D97706',
  warningSoft: '#FFF4DE',
  warningDim: '#FFF4DE',
  error: '#DC2626',
  errorSoft: '#FDECEC',
  errorDim: '#FDECEC',
  info: '#0891B2',
  infoSoft: '#E2F6FA',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  light: {
    text: '#102033',
    background: '#F5F7FB',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#E8F0FF',
    textSecondary: '#637487',
  },
  dark: {
    text: '#F4F7FB',
    background: '#0B1220',
    backgroundElement: '#121C2E',
    backgroundSelected: '#1C2B45',
    textSecondary: '#9AA8B8',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 12,
  four: 16,
  five: 20,
  six: 24,
  seven: 32,
  eight: 48,
  nine: 64,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  full: 9999,
} as const;

export const TextScale = {
  xs: 11,
  sm: 13,
  base: 15,
  md: 17,
  lg: 20,
  xl: 26,
  xxl: 34,
  hero: 44,
} as const;

export const Shadows = {
  card: {
    shadowColor: '#718096',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 3,
  },
  soft: {
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 4,
  },
} as const;

export const BottomTabInset = Platform.select({ ios: 88, android: 82 }) ?? 0;
export const MaxContentWidth = 800;
