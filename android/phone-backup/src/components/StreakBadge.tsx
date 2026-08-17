import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AppColors, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';

type Props = {
  colors: AppColors;
  streak: number;
  atRisk: boolean;
};

export function StreakBadge({ colors, streak, atRisk }: Props) {
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (streak <= 0) return null;

  const tint = atRisk ? colors.error : colors.warning;
  const bg = atRisk ? colors.errorSoft : colors.warningSoft;

  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <AppIcon androidName="local_fire_department" iosName="flame.fill" color={tint} size={16} fallback="*" />
      <Text style={[styles.text, { color: tint }]}>{streak}</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: Radius.full,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  text: {
    fontSize: TextScale.sm,
    fontWeight: '800',
  },
});
