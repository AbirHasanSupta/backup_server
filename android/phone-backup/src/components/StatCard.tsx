import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';

interface Props {
  icon: string;
  iosIcon?: string;
  label: string;
  value: string;
  tint?: string;
  dimColor?: string;
}

export function StatCard({ icon, iosIcon, label, value, tint, dimColor }: Props) {
  const accentColor = tint || Colors.primary;
  const bgColor = dimColor || Colors.primarySoft;

  return (
    <View style={styles.card}>
      <View style={[styles.iconWrap, { backgroundColor: bgColor }]}>
        <AppIcon androidName={icon} iosName={iosIcon} color={accentColor} size={21} fallback="*" />
      </View>
      <Text style={[styles.value, { color: Colors.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 126,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
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
    color: Colors.textSecondary,
    fontWeight: '600',
  },
});
