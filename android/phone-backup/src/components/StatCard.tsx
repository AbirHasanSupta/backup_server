import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

interface Props {
  icon: string;
  iosIcon?: string;
  label: string;
  value: string;
  tint?: string;
  dimColor?: string;
}

export function StatCard({ icon, iosIcon, label, value, tint, dimColor }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const accentColor = tint || colors.primary;
  const bgColor = dimColor || colors.primarySoft;

  return (
    <View style={styles.card}>
      <View style={[styles.iconWrap, { backgroundColor: bgColor }]}>
        <AppIcon androidName={icon} iosName={iosIcon} color={accentColor} size={21} fallback="*" />
      </View>
      <Text style={[styles.value, { color: colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 126,
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    padding: Spacing.four,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    ...Shadows.card,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontSize: TextScale.lg,
    fontWeight: '800',
    marginTop: Spacing.three,
  },
  label: {
    fontSize: TextScale.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
});
