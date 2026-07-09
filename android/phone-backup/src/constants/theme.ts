import { Platform } from 'react-native';

const lightColors = {
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
} as const;

export type AppColors = Record<keyof typeof lightColors, string>;

const darkColors: AppColors = {
  bg: '#0B1220',
  bgWarm: '#101827',
  surface: '#121C2E',
  surfaceSoft: '#172338',
  surfaceElevated: '#1B2940',
  surfaceBorder: '#2A3B55',

  ink: '#F4F7FB',
  text: '#F4F7FB',
  textSecondary: '#A9B7C8',
  textMuted: '#71839A',

  primary: '#60A5FA',
  primaryDark: '#3B82F6',
  primaryLight: '#93C5FD',
  primarySoft: '#1C355A',
  primaryDim: '#152844',
  primaryGlow: 'rgba(96, 165, 250, 0.18)',

  success: '#34D399',
  successSoft: '#123A2B',
  successDim: '#123A2B',
  warning: '#FBBF24',
  warningSoft: '#433213',
  warningDim: '#433213',
  error: '#F87171',
  errorSoft: '#451C25',
  errorDim: '#451C25',
  info: '#22D3EE',
  infoSoft: '#123746',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
} as const;

export type ThemeMode = 'light' | 'dark';

export const ColorSchemes = {
  light: lightColors,
  dark: darkColors,
} as const;

export const Colors = {
  ...lightColors,
  light: {
    text: lightColors.text,
    background: lightColors.bg,
    backgroundElement: lightColors.surface,
    backgroundSelected: lightColors.primarySoft,
    textSecondary: lightColors.textSecondary,
  },
  dark: {
    text: darkColors.text,
    background: darkColors.bg,
    backgroundElement: darkColors.surface,
    backgroundSelected: darkColors.primarySoft,
    textSecondary: darkColors.textSecondary,
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
