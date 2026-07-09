import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  StatusBar,
  Alert,
} from 'react-native';
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
import { Colors, Spacing, Radius, TextScale, BottomTabInset } from '@/constants/theme';
import { FolderCard, Folder } from '@/components/FolderCard';
import { FileTypeSelector } from '@/components/FileTypeSelector';

export default function FoldersScreen() {
  const insets = useSafeAreaInsets();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(['all']);
  const [refreshing, setRefreshing] = useState<string | null>(null); // folder uri being refreshed

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

  // ── Add folder via SAF picker ─────────────────────────────────────────────
  const handleAddFolder = async () => {
    try {
      const perm =
        await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!perm.granted) return;
      const raw = perm.directoryUri.split('/').pop() as string;
      const name = decodeURIComponent(raw);
      const updated = await addFolder(perm.directoryUri, name);
      setFolders(updated);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not add folder');
    }
  };

  // ── Remove folder ─────────────────────────────────────────────────────────
  const handleRemove = async (uri: string) => {
    const updated = await removeFolder(uri);
    setFolders(updated);
  };

  // ── Refresh folder (force re-backup) ─────────────────────────────────────
  const handleRefresh = async (folder: Folder) => {
    setRefreshing(folder.uri);
    try {
      await clearFolderUploads(folder.name);

      const result = await runSync(null, {
        forceRefreshFolder: folder.name,
        targetFolderUri: folder.uri,
      });

      Alert.alert(
        'Refresh Complete',
        `Finished backing up "${folder.name}". ${result.uploaded} files uploaded.`
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not refresh backup');
    } finally {
      setRefreshing(null);
    }
  };

  // ── File type change ──────────────────────────────────────────────────────
  const handleTypeChange = async (types: string[]) => {
    setSelectedTypes(types);
    await setFileTypes(types);
  };

  // ── Empty state ───────────────────────────────────────────────────────────
  const renderEmpty = () => (
    <View style={styles.emptyState}>
      <Text style={styles.emptyIcon}>📂</Text>
      <Text style={styles.emptyTitle}>No folders added yet</Text>
      <Text style={styles.emptyBody}>
        Tap{' '}
        <Text style={{ color: Colors.primaryLight, fontWeight: '600' }}>
          + Add Folder
        </Text>{' '}
        to choose which folders on your phone should be backed up automatically.
      </Text>
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.bg} />

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Folders</Text>
          <Text style={styles.subtitle}>
            {folders.length > 0
              ? `${folders.length} folder${folders.length !== 1 ? 's' : ''} selected`
              : 'Choose folders to back up'}
          </Text>
        </View>
        <TouchableOpacity
          id="add-folder-button"
          style={styles.addBtn}
          onPress={handleAddFolder}
          accessibilityLabel="Add folder"
          accessibilityRole="button"
        >
          <Text style={styles.addBtnText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {/* ── File type filter ─────────────────────────────────────────────── */}
      <View style={styles.filterSection}>
        <FileTypeSelector selected={selectedTypes} onChange={handleTypeChange} />
      </View>

      {/* ── Folder list ──────────────────────────────────────────────────── */}
      <FlatList
        data={folders}
        keyExtractor={(item) => item.uri}
        contentContainerStyle={[
          styles.listContent,
          folders.length === 0 && styles.listContentEmpty,
          { paddingBottom: BottomTabInset + insets.bottom + 16 },
        ]}
        ListEmptyComponent={renderEmpty}
        renderItem={({ item }) => (
          <View style={item.uri === refreshing ? styles.refreshing : undefined}>
            <FolderCard
              folder={item}
              onRemove={handleRemove}
              onRefresh={handleRefresh}
            />
          </View>
        )}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.six,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.four,
  },
  title: {
    fontSize: TextScale.xl,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
    marginTop: 3,
  },
  addBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two + 2,
  },
  addBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: Colors.white,
  },
  filterSection: {
    paddingHorizontal: Spacing.six,
    paddingBottom: Spacing.four,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
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
    paddingTop: Spacing.nine,
    gap: Spacing.three,
  },
  emptyIcon: {
    fontSize: 64,
  },
  emptyTitle: {
    fontSize: TextScale.lg,
    fontWeight: '700',
    color: Colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: TextScale.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  refreshing: {
    opacity: 0.4,
  },
});
