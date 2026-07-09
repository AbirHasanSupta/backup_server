import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, StatusBar, Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  getFolders,
  addFolder,
  removeFolder,
  getFileTypes,
  setFileTypes,
  clearFolderUploads,
} from '../../settings';
import { runSync } from '../../backgroundTask';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { FolderCard, Folder } from '@/components/FolderCard';
import { FileTypeSelector } from '@/components/FileTypeSelector';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

export default function FoldersScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(['all']);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const [f, t] = await Promise.all([getFolders(), getFileTypes()]);
    setFolders(f);
    setSelectedTypes(t);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const handleAddFolder = async () => {
    try {
      const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!perm.granted) return;
      const raw = perm.directoryUri.split('/').pop() as string;
      const name = decodeURIComponent(raw);
      const updated = await addFolder(perm.directoryUri, name);
      setFolders(updated);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not add folder');
    }
  };

  const handleRemove = async (uri: string) => {
    const updated = await removeFolder(uri);
    setFolders(updated);
  };

  const handleRefresh = async (folder: Folder) => {
    setRefreshing(folder.uri);
    try {
      await clearFolderUploads(folder.name);

      const result = await runSync(null, {
        forceRefreshFolder: folder.name,
        targetFolderUri: folder.uri,
      });

      Alert.alert(
        'Refresh complete',
        `Finished backing up "${folder.name}". ${result.uploaded} files uploaded.`
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not refresh backup');
    } finally {
      setRefreshing(null);
    }
  };

  const handleTypeChange = async (types: string[]) => {
    setSelectedTypes(types);
    await setFileTypes(types);
  };

  const renderEmpty = () => (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <AppIcon androidName="folder_open" iosName="folder" color={colors.primary} size={34} fallback="F" />
      </View>
      <Text style={styles.emptyTitle}>Choose what gets backed up</Text>
      <Text style={styles.emptyBody}>
        Add a folder once and Phone Backup will keep it protected automatically.
      </Text>
      <TouchableOpacity style={styles.emptyButton} onPress={handleAddFolder} accessibilityRole="button">
        <AppIcon androidName="add" iosName="plus" color={colors.white} size={18} fallback="+" />
        <Text style={styles.emptyButtonText}>Add folder</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.kicker}>Backup sources</Text>
          <Text style={styles.title}>Folders</Text>
          <Text style={styles.subtitle}>
            {folders.length > 0
              ? `${folders.length} folder${folders.length !== 1 ? 's' : ''} selected`
              : 'Pick folders to protect'}
          </Text>
        </View>
        <TouchableOpacity
          id="add-folder-button"
          style={styles.addBtn}
          onPress={handleAddFolder}
          accessibilityLabel="Add folder"
          accessibilityRole="button"
        >
          <AppIcon androidName="add" iosName="plus" color={colors.white} size={18} fallback="+" />
          <Text style={styles.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.filterSection}>
        <FileTypeSelector selected={selectedTypes} onChange={handleTypeChange} />
      </View>

      <FlatList
        data={folders}
        keyExtractor={(item) => item.uri}
        contentContainerStyle={[
          styles.listContent,
          folders.length === 0 && styles.listContentEmpty,
          { paddingBottom: BottomTabInset + insets.bottom + 24 },
        ]}
        ListEmptyComponent={renderEmpty}
        renderItem={({ item }) => (
          <View style={item.uri === refreshing ? styles.refreshing : undefined}>
            <FolderCard folder={item} onRemove={handleRemove} onRefresh={handleRefresh} />
          </View>
        )}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: Spacing.four,
    paddingHorizontal: Spacing.six,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.four,
  },
  titleBlock: {
    flex: 1,
    gap: Spacing.one,
  },
  kicker: {
    color: colors.primary,
    fontSize: TextScale.xs,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: TextScale.xl,
    fontWeight: '900',
    color: colors.text,
  },
  subtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  addBtn: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: colors.primary,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    ...Shadows.soft,
  },
  addBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '900',
    color: colors.white,
  },
  filterSection: {
    marginHorizontal: Spacing.six,
    padding: Spacing.four,
    borderRadius: Radius.lg,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  listContent: {
    paddingHorizontal: Spacing.six,
    paddingTop: Spacing.four,
  },
  listContentEmpty: {
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.seven,
    paddingTop: Spacing.eight,
    gap: Spacing.three,
  },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: Radius.full,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.one,
  },
  emptyTitle: {
    fontSize: TextScale.lg,
    fontWeight: '900',
    color: colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: TextScale.base,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    fontWeight: '600',
  },
  emptyButton: {
    marginTop: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 48,
    paddingHorizontal: Spacing.five,
    borderRadius: Radius.full,
    backgroundColor: colors.primary,
  },
  emptyButtonText: {
    color: colors.white,
    fontSize: TextScale.base,
    fontWeight: '900',
  },
  refreshing: {
    opacity: 0.45,
  },
});
