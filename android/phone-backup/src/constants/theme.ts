import { Platform } from 'react-native';

// ─── Dark-first color palette ─────────────────────────────────────────────────
// Background layers: deep navy → surface → elevated surface
// Accent: electric indigo with glow, success emerald, warning amber, error red
export const Colors = {
  // Background hierarchy
  bg: '#090D1A',
  surface: '#0F1729',
  surfaceElevated: '#162033',
  surfaceBorder: '#1E2D45',

  // Primary accent — electric indigo
  primary: '#6366F1',
  primaryLight: '#818CF8',
  primaryDim: 'rgba(99, 102, 241, 0.15)',
  primaryGlow: 'rgba(99, 102, 241, 0.35)',

  // States
  success: '#10B981',
  successDim: 'rgba(16, 185, 129, 0.15)',
  warning: '#F59E0B',
  warningDim: 'rgba(245, 158, 11, 0.15)',
  error: '#EF4444',
  errorDim: 'rgba(239, 68, 68, 0.15)',

  // Text
  text: '#F1F5F9',
  textSecondary: '#94A3B8',
  textMuted: '#475569',

  // Extras
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  // Legacy themed support (maps to dark as default)
  light: {
    text: '#0F172A',
    background: '#F8FAFC',
    backgroundElement: '#E2E8F0',
    backgroundSelected: '#CBD5E1',
    textSecondary: '#64748B',
  },
  dark: {
    text: '#F1F5F9',
    background: '#090D1A',
    backgroundElement: '#162033',
    backgroundSelected: '#1E2D45',
    textSecondary: '#94A3B8',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

// ─── Typography ───────────────────────────────────────────────────────────────
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

// ─── Spacing scale ────────────────────────────────────────────────────────────
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

// ─── Border radius ────────────────────────────────────────────────────────────
export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  full: 9999,
} as const;

// ─── Typography scale ─────────────────────────────────────────────────────────
export const TextScale = {
  xs: 11,
  sm: 13,
  base: 15,
  md: 17,
  lg: 20,
  xl: 24,
  xxl: 32,
  hero: 42,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
