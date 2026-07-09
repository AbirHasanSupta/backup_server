import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Colors, Radius, Shadows, Spacing, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';

export interface Folder {
  uri: string;
  name: string;
  addedAt?: number;
}

interface Props {
  folder: Folder;
  onRemove: (uri: string) => void;
  onRefresh: (folder: Folder) => void;
}

export function FolderCard({ folder, onRemove, onRefresh }: Props) {
  const handleRemove = () => {
    Alert.alert(
      'Remove folder',
      `Stop backing up "${folder.name}"? Files already backed up will stay on the server.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => onRemove(folder.uri) },
      ]
    );
  };

  const handleRefresh = () => {
    Alert.alert(
      'Refresh backup',
      `Re-upload all files in "${folder.name}"? This is useful when something looks missing on the server.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Refresh', onPress: () => onRefresh(folder) },
      ]
    );
  };

  return (
    <View style={styles.card}>
      <View style={styles.iconContainer}>
        <AppIcon androidName="folder" iosName="folder" color={Colors.primary} size={24} fallback="F" />
      </View>

      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {folder.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {folder.addedAt
            ? `Added ${new Date(folder.addedAt).toLocaleDateString()}`
            : 'Ready for automatic backup'}
        </Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.refreshBtn]}
          onPress={handleRefresh}
          accessibilityLabel={`Refresh backup for ${folder.name}`}
          accessibilityRole="button"
        >
          <AppIcon androidName="sync" iosName="arrow.triangle.2.circlepath" color={Colors.primary} size={18} fallback="R" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.removeBtn]}
          onPress={handleRemove}
          accessibilityLabel={`Remove ${folder.name}`}
          accessibilityRole="button"
        >
          <AppIcon androidName="close" iosName="xmark" color={Colors.error} size={18} fallback="X" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.four,
    marginBottom: Spacing.three,
    gap: Spacing.three,
    ...Shadows.card,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    gap: 4,
  },
  name: {
    fontSize: TextScale.base,
    fontWeight: '800',
    color: Colors.text,
  },
  meta: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionBtn: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshBtn: {
    backgroundColor: Colors.primarySoft,
  },
  removeBtn: {
    backgroundColor: Colors.errorSoft,
  },
});
