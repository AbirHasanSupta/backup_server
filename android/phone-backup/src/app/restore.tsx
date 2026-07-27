import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Alert,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  LayoutAnimation,
  UIManager,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { listServerFiles, downloadFile } from '../../downloader';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

type RemoteFile = {
  path: string;
  size: number;
  modified_time: number;
  sha256: string;
  uploaded_time: number;
};

type GroupedFiles = {
  folder: string;
  files: RemoteFile[];
  totalSize: number;
  isExpanded: boolean;
};

export default function RestoreScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [groups, setGroups] = useState<GroupedFiles[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isFetching, setIsFetching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ current: number, total: number, fileName: string } | null>(null);



  const handleFetch = async () => {
    setIsFetching(true);
    try {
      const serverFiles = await listServerFiles();
      setFiles(serverFiles);
      
      const grouped = serverFiles.reduce((acc: Record<string, RemoteFile[]>, file: RemoteFile) => {
        const parts = file.path.split(/[/\\]/);
        const folder = parts.length > 1 ? parts[0] : 'Root';
        if (!acc[folder]) acc[folder] = [];
        acc[folder].push(file);
        return acc;
      }, {});

      const sortedGroups = Object.keys(grouped).map(folder => {
        const folderFiles = grouped[folder];
        const totalSize = folderFiles.reduce((sum, f) => sum + f.size, 0);
        return { folder, files: folderFiles, totalSize, isExpanded: false };
      }).sort((a, b) => a.folder.localeCompare(b.folder));

      setGroups(sortedGroups);
      setSelectedPaths(new Set());
    } catch (error: any) {
      Alert.alert('Fetch Failed', error.message || 'Could not fetch files');
    } finally {
      setIsFetching(false);
    }
  };

  const toggleGroup = (folder: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setGroups(groups.map(g => g.folder === folder ? { ...g, isExpanded: !g.isExpanded } : g));
  };

  const toggleSelection = (path: string) => {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelectedPaths(next);
  };

  const selectAll = () => {
    if (selectedPaths.size === files.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(files.map(f => f.path)));
    }
  };

  const handleDownload = async () => {
    if (selectedPaths.size === 0) return;
    setIsDownloading(true);
    let downloaded = 0;
    
    for (const path of selectedPaths) {
      const fileInfo = files.find(f => f.path === path);
      if (!fileInfo) continue;
      
      downloaded++;
      setDownloadProgress({ current: downloaded, total: selectedPaths.size, fileName: path });
      
      try {
        if (!FileSystem.documentDirectory) {
          console.warn('documentDirectory is null, skipping:', path);
          continue;
        }
        const destUri = FileSystem.documentDirectory + path.replace(/\\/g, '/');
        
        // Ensure folder exists
        const folderUri = destUri.substring(0, destUri.lastIndexOf('/'));
        const folderInfo = await FileSystem.getInfoAsync(folderUri);
        if (!folderInfo.exists) {
          await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });
        }
        
        // Check if exists and same size
        const existingInfo = await FileSystem.getInfoAsync(destUri);
        if (existingInfo.exists && existingInfo.size === fileInfo.size) {
          continue; // Skip
        }
        
        await downloadFile(path, destUri);
      } catch (e) {
        console.warn(`Failed to download ${path}:`, e);
      }
    }
    
    setIsDownloading(false);
    setDownloadProgress(null);
    Alert.alert('Download Complete', `Finished processing ${selectedPaths.size} files.`);
    setSelectedPaths(new Set());
  };

  const renderGroup = ({ item }: { item: GroupedFiles }) => (
    <View style={styles.groupContainer}>
      <TouchableOpacity style={styles.groupHeader} onPress={() => toggleGroup(item.folder)}>
        <View style={styles.groupHeaderLeft}>
          <AppIcon
            androidName={item.isExpanded ? 'expand_more' : 'chevron_right'}
            iosName={item.isExpanded ? 'chevron.down' : 'chevron.right'}
            color={colors.textSecondary}
            size={24}
          />
          <AppIcon androidName="folder" iosName="folder" color={colors.primary} size={20} />
          <Text style={styles.groupTitle} numberOfLines={1}>{item.folder}</Text>
        </View>
        <View style={styles.groupHeaderRight}>
          <Text style={styles.groupInfo}>{item.files.length} files</Text>
          <Text style={styles.groupInfo}>{formatSize(item.totalSize)}</Text>
        </View>
      </TouchableOpacity>
      
      {item.isExpanded && (
        <View style={styles.groupContent}>
          {item.files.map(file => {
            const isSelected = selectedPaths.has(file.path);
            const fileName = file.path.split(/[/\\]/).pop() || file.path;
            return (
              <TouchableOpacity
                key={file.path}
                style={styles.fileRow}
                onPress={() => toggleSelection(file.path)}
              >
                <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                  {isSelected && <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={14} />}
                </View>
                <View style={styles.fileInfo}>
                  <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
                  <Text style={styles.fileSize}>{formatSize(file.size)}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={colors.bg === '#0B1220' ? 'light-content' : 'dark-content'} />
      
      {isDownloading && downloadProgress && (
        <View style={[styles.progressContainer, { paddingTop: insets.top + Spacing.two }]}>
          <Text style={styles.progressText}>
            Downloading {downloadProgress.current} / {downloadProgress.total}
          </Text>
          <Text style={styles.progressSubtext} numberOfLines={1}>{downloadProgress.fileName}</Text>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${(downloadProgress.current / downloadProgress.total) * 100}%` }]} />
          </View>
        </View>
      )}
      
      <View style={[styles.pageHeader, { paddingTop: !isDownloading ? insets.top + Spacing.five : Spacing.four }]}>
        <View>
          <Text style={styles.pageTitle}>Restore Files</Text>
          <Text style={styles.pageSubtitle}>Download files from server</Text>
        </View>
        
        <View style={styles.headerButtons}>
          <TouchableOpacity onPress={handleFetch} style={styles.actionBtn} disabled={isFetching || isDownloading}>
            {isFetching ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <>
                <AppIcon androidName="sync" iosName="arrow.triangle.2.circlepath" color={colors.primary} size={16} />
                <Text style={[styles.actionBtnText, { color: colors.primary }]}>Fetch</Text>
              </>
            )}
          </TouchableOpacity>
          {files.length > 0 && (
            <TouchableOpacity onPress={selectAll} style={styles.actionBtn} disabled={isDownloading}>
              <Text style={[styles.actionBtnText, { color: colors.primary }]}>
                {selectedPaths.size === files.length ? 'Deselect All' : 'Select All'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={groups}
        keyExtractor={item => item.folder}
        renderItem={renderGroup}
        contentContainerStyle={[styles.listContent, { paddingBottom: BottomTabInset + Spacing.eight }]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          !isFetching ? (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
                <AppIcon androidName="cloud_download" iosName="icloud.and.arrow.down" color={colors.primary} size={36} fallback="⬇️" />
              </View>
              <Text style={styles.emptyTitle}>No files fetched</Text>
              <Text style={styles.emptySubtitle}>Tap Fetch to see files available on the server.</Text>
            </View>
          ) : null
        }
      />

      {selectedPaths.size > 0 && !isDownloading && (
        <TouchableOpacity style={[styles.fab, { bottom: BottomTabInset + Spacing.four }]} onPress={handleDownload}>
          <AppIcon androidName="download" iosName="arrow.down.circle" color={colors.white} size={24} />
          <Text style={styles.fabText}>Restore {selectedPaths.size} Files</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  root: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: Spacing.five,
    flexGrow: 1,
  },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.five,
    paddingBottom: Spacing.four,
  },
  pageTitle: {
    fontSize: TextScale.xl,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -0.5,
  },
  pageSubtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '500',
    marginTop: 2,
  },
  headerButtons: {
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    backgroundColor: colors.primarySoft,
  },
  actionBtnText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
  groupContainer: {
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    marginBottom: Spacing.three,
    overflow: 'hidden',
    ...Shadows.card,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.four,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceBorder,
  },
  groupHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flex: 1,
  },
  groupTitle: {
    fontSize: TextScale.md,
    fontWeight: '600',
    color: colors.text,
    flex: 1,
  },
  groupHeaderRight: {
    alignItems: 'flex-end',
  },
  groupInfo: {
    fontSize: TextScale.xs,
    color: colors.textSecondary,
  },
  groupContent: {
    paddingHorizontal: Spacing.four,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceBorder,
    gap: Spacing.three,
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: TextScale.sm,
    color: colors.text,
    fontWeight: '500',
  },
  fileSize: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.textSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  fab: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.six,
    borderRadius: Radius.full,
    gap: Spacing.two,
    ...Shadows.soft,
  },
  fabText: {
    color: colors.white,
    fontWeight: '700',
    fontSize: TextScale.md,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.seven,
    paddingTop: Spacing.nine,
    gap: Spacing.four,
  },
  emptyIconWrap: {
    width: 88,
    height: 88,
    borderRadius: Radius.xxl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: TextScale.md,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    fontWeight: '500',
  },
  progressContainer: {
    backgroundColor: colors.surface,
    paddingHorizontal: Spacing.five,
    paddingBottom: Spacing.three,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceBorder,
  },
  progressText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: colors.text,
    marginBottom: Spacing.one,
  },
  progressSubtext: {
    fontSize: TextScale.xs,
    color: colors.textSecondary,
    marginBottom: Spacing.two,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: colors.surfaceBorder,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
});
