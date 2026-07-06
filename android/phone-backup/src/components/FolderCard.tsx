import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { Colors, Spacing, Radius, TextScale } from '@/constants/theme';

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
      'Remove Folder',
      `Stop backing up "${folder.name}"? Previously backed-up files remain on the server.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => onRemove(folder.uri),
        },
      ]
    );
  };

  const handleRefresh = () => {
    Alert.alert(
      'Refresh Backup',
      `Re-upload all files in "${folder.name}"? This will re-sync even files already on the server.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Refresh',
          onPress: () => onRefresh(folder),
        },
      ]
    );
  };

  return (
    <View style={styles.card}>
      {/* Left icon */}
      <View style={styles.iconContainer}>
        <Text style={styles.icon}>📁</Text>
      </View>

      {/* Folder info */}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {folder.name}
        </Text>
        {folder.addedAt ? (
          <Text style={styles.meta}>
            Added {new Date(folder.addedAt).toLocaleDateString()}
          </Text>
        ) : null}
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.refreshBtn]}
          onPress={handleRefresh}
          accessibilityLabel={`Refresh backup for ${folder.name}`}
        >
          <Text style={styles.refreshBtnText}>↺</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.removeBtn]}
          onPress={handleRemove}
          accessibilityLabel={`Remove ${folder.name}`}
        >
          <Text style={styles.removeBtnText}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.four,
    marginBottom: Spacing.three,
    gap: Spacing.three,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 22,
  },
  info: {
    flex: 1,
    gap: 3,
  },
  name: {
    fontSize: TextScale.base,
    fontWeight: '600',
    color: Colors.text,
  },
  meta: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshBtn: {
    backgroundColor: Colors.primaryDim,
  },
  refreshBtnText: {
    fontSize: 18,
    color: Colors.primaryLight,
    fontWeight: '700',
  },
  removeBtn: {
    backgroundColor: Colors.errorDim,
  },
  removeBtnText: {
    fontSize: 14,
    color: Colors.error,
    fontWeight: '700',
  },
});
