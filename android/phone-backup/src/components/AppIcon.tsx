import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { SymbolWeight } from 'expo-symbols';
import { useAppTheme } from '@/hooks/use-app-theme';

type AppIconProps = {
  androidName: string;
  iosName?: string;
  size?: number;
  color?: string;
  fallback?: string;
  /** Symbol weight — use 'bold' for active tab icons to simulate a filled look on Android */
  weight?: SymbolWeight;
};

export function AppIcon({
  androidName,
  iosName,
  size = 20,
  color,
  fallback,
  weight,
}: AppIconProps) {
  const { colors } = useAppTheme();
  const iconColor = color ?? colors.text;

  if (Platform.OS === 'web' && fallback) {
    return (
      <View style={[styles.fallbackWrap, { width: size, height: size }]}>
        <Text style={[styles.fallbackText, { color: iconColor, fontSize: Math.max(12, size - 2) }]}>
          {fallback}
        </Text>
      </View>
    );
  }

  return (
    <SymbolView
      name={{
        android: androidName as any,
        web: androidName as any,
        ios: (iosName || androidName) as any,
      }}
      size={size}
      tintColor={iconColor}
      weight={weight}
      fallback={fallback ? <Text style={[styles.fallbackText, { color: iconColor }]}>{fallback}</Text> : null}
    />
  );
}

const styles = StyleSheet.create({
  fallbackWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    fontWeight: '700',
    textAlign: 'center',
  },
});
