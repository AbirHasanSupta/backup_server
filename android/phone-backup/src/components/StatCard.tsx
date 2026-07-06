import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Spacing, Radius, TextScale } from '@/constants/theme';

interface Props {
  icon: string;
  label: string;
  value: string;
  tint?: string;
  dimColor?: string;
}

export function StatCard({ icon, label, value, tint, dimColor }: Props) {
  const accentColor = tint || Colors.primary;
  const bgColor = dimColor || Colors.primaryDim;

  return (
    <View style={styles.card}>
      <View style={[styles.iconWrap, { backgroundColor: bgColor }]}>
        <Text style={styles.icon}>{icon}</Text>
      </View>
      <Text style={[styles.value, { color: accentColor }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.four,
    alignItems: 'center',
    gap: Spacing.two,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 20,
  },
  value: {
    fontSize: TextScale.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  label: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
    textAlign: 'center',
    fontWeight: '500',
  },
});
