import React, { useState, useCallback, useMemo } from 'react';
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
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { listServerFiles, downloadFile } from '../../downloader';
import { checkDeviceConnection } from '../../uploader';
import { getServerIp } from '../../settings';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type RemoteFile = {
  path: string;
  size: number;
  modified_time: number;
  sha256: string;
  uploaded_time: number;
};

/** A node in the recursive folder tree */
type TreeNode = {
  /** Segment name, e.g. "WhatsApp" or "photo.jpg" */
  name: string;
  /** Full path segments joined — used as a stable key */
  key: string;
  isFolder: boolean;
  /** Populated only when isFolder=false */
  file?: RemoteFile;
  children: TreeNode[];
  /** Total bytes under this node (recursive) */
  totalSize: number;
  /** Total leaf file count under this node */
  fileCount: number;
  isExpanded: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Android SAF paths are stored as e.g. "primary:Pictures/WhatsApp/photo.jpg".
 * Strip the "volume:" prefix so the path is a valid relative filesystem path
 * that can be safely appended to documentDirectory.
 *
 * Examples:
 *   "primary:Pictures/WhatsApp/photo.jpg" → "Pictures/WhatsApp/photo.jpg"
 *   "secondary:DCIM/Camera/img.jpg"       → "secondary/DCIM/Camera/img.jpg"
 *   "Pictures/Camera/img.jpg"              → "Pictures/Camera/img.jpg"  (unchanged)
 */
function sanitizeRelativePath(raw: string): string {
  // Normalise backslashes first
  const normalised = raw.replace(/\\/g, '/');
  // Match an optional Android volume prefix like "primary:" or "1234-ABCD:"
  const match = normalised.match(/^([^/]+):(.+)$/);
  if (!match) return normalised;
  const [, volume, rest] = match;
  // "primary" volume is the internal storage root — just use the rest
  if (volume.toLowerCase() === 'primary') return rest;
  // Other volumes (SD-card, etc.) — prefix with the volume name as a folder
  return `${volume}/${rest}`;
}

/**
 * Returns true for file extensions that MediaLibrary can save to the gallery.
 * These files are routed through MediaLibrary.saveToLibraryAsync() so they
 * appear in the phone's Photos / Gallery app.
 */
function isMediaExtension(ext: string): boolean {
  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif', 'svg'];
  const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v', 'wmv', 'flv', 'ts', 'mts'];
  const AUDIO_EXTS = ['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'wma', 'aiff'];
  return IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext);
}

/** Insert a file into the nested tree map, creating intermediate folders on the fly */
function insertFileIntoTree(
  node: TreeNode,
  segments: string[],
  file: RemoteFile,
  depth: number,
): void {
  if (depth === segments.length - 1) {
    // leaf — add file node
    node.children.push({
      name: segments[depth],
      key: file.path,
      isFolder: false,
      file,
      children: [],
      totalSize: file.size,
      fileCount: 1,
      isExpanded: false,
    });
    return;
  }
  // intermediate folder
  const segName = segments[depth];
  const folderKey = segments.slice(0, depth + 1).join('/');
  let child = node.children.find(c => c.isFolder && c.name === segName);
  if (!child) {
    child = {
      name: segName,
      key: folderKey,
      isFolder: true,
      children: [],
      totalSize: 0,
      fileCount: 0,
      isExpanded: false,
    };
    node.children.push(child);
  }
  insertFileIntoTree(child, segments, file, depth + 1);
}

/** After building the tree, roll up sizes and counts bottom-up */
function rollupStats(node: TreeNode): void {
  if (!node.isFolder) return;
  for (const child of node.children) rollupStats(child);
  node.totalSize = node.children.reduce((s, c) => s + c.totalSize, 0);
  node.fileCount = node.children.reduce((s, c) => s + c.fileCount, 0);
}

/** Sort children: folders first (alpha), then files (alpha) */
function sortChildren(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) if (child.isFolder) sortChildren(child);
}

/** Build a root-level tree from a flat file list */
function buildTree(files: RemoteFile[]): TreeNode {
  const root: TreeNode = {
    name: '__root__',
    key: '__root__',
    isFolder: true,
    children: [],
    totalSize: 0,
    fileCount: 0,
    isExpanded: true,
  };
  for (const file of files) {
    // Use the sanitized path for display/folder hierarchy, but file.path stays
    // as the server lookup key throughout the tree (file.path is never mutated).
    const displayPath = sanitizeRelativePath(file.path);
    const segments = displayPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    if (segments.length === 1) {
      root.children.push({
        name: segments[0],
        key: file.path,
        isFolder: false,
        file,
        children: [],
        totalSize: file.size,
        fileCount: 1,
        isExpanded: false,
      });
    } else {
      insertFileIntoTree(root, segments, file, 0);
    }
  }
  rollupStats(root);
  sortChildren(root);
  return root;
}

/** Collect every leaf file path under a node (recursively) */
function collectFilePaths(node: TreeNode): string[] {
  if (!node.isFolder) return node.file ? [node.file.path] : [];
  return node.children.flatMap(collectFilePaths);
}

/** Check selection state for a folder node */
function folderSelectionState(
  node: TreeNode,
  selectedPaths: Set<string>,
): 'none' | 'partial' | 'all' {
  const paths = collectFilePaths(node);
  if (paths.length === 0) return 'none';
  const selected = paths.filter(p => selectedPaths.has(p)).length;
  if (selected === 0) return 'none';
  if (selected === paths.length) return 'all';
  return 'partial';
}

// ─────────────────────────────────────────────────────────────────────────────
// Recursive tree renderer — fully self-contained component
// ─────────────────────────────────────────────────────────────────────────────

type TreeNodeViewProps = {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  onToggleNode: (node: TreeNode) => void;
  onToggleExpand: (nodeKey: string) => void;
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
};

const TreeNodeView = React.memo(function TreeNodeView({
  node,
  depth,
  selectedPaths,
  onToggleNode,
  onToggleExpand,
  styles,
  colors,
}: TreeNodeViewProps) {
  const indent = depth * 16;

  if (!node.isFolder) {
    // ── File row ──────────────────────────────────────────────────────────
    const isSelected = selectedPaths.has(node.key);
    return (
      <TouchableOpacity
        style={[styles.fileRow, { paddingLeft: indent + Spacing.four }]}
        onPress={() => onToggleNode(node)}
        activeOpacity={0.7}
      >
        <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
          {isSelected && (
            <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={13} />
          )}
        </View>
        <AppIcon
          androidName="insert_drive_file"
          iosName="doc"
          color={colors.textMuted}
          size={16}
        />
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>
            {node.name}
          </Text>
          <Text style={styles.fileSize}>{formatSize(node.file!.size)}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  // ── Folder row ────────────────────────────────────────────────────────
  const selState = folderSelectionState(node, selectedPaths);
  const isPartial = selState === 'partial';
  const isAllSelected = selState === 'all';
  const checkboxStyle = [
    styles.checkbox,
    (isAllSelected || isPartial) && styles.checkboxSelected,
    isPartial && styles.checkboxPartial,
  ];

  return (
    <View>
      <View style={[styles.folderRow, { paddingLeft: indent + Spacing.four }]}>
        {/* Expand/collapse chevron */}
        <TouchableOpacity
          style={styles.chevronBtn}
          onPress={() => onToggleExpand(node.key)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
        >
          <AppIcon
            androidName={node.isExpanded ? 'expand_more' : 'chevron_right'}
            iosName={node.isExpanded ? 'chevron.down' : 'chevron.right'}
            color={colors.textSecondary}
            size={22}
          />
        </TouchableOpacity>

        {/* Folder checkbox */}
        <TouchableOpacity
          style={checkboxStyle}
          onPress={() => onToggleNode(node)}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
        >
          {isAllSelected && (
            <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={13} />
          )}
          {isPartial && <View style={styles.partialDot} />}
        </TouchableOpacity>

        {/* Folder icon + name (also toggles expand) */}
        <TouchableOpacity
          style={styles.folderLabelBtn}
          onPress={() => onToggleExpand(node.key)}
          activeOpacity={0.7}
        >
          <AppIcon
            androidName="folder"
            iosName="folder.fill"
            color={colors.primary}
            size={18}
          />
          <Text style={styles.folderName} numberOfLines={1}>
            {node.name}
          </Text>
        </TouchableOpacity>

        {/* Stats badge */}
        <View style={styles.folderBadge}>
          <Text style={styles.folderBadgeText}>
            {node.fileCount} {node.fileCount === 1 ? 'file' : 'files'}
          </Text>
          <Text style={styles.folderBadgeSize}>{formatSize(node.totalSize)}</Text>
        </View>
      </View>

      {/* Children */}
      {node.isExpanded &&
        node.children.map(child => (
          <TreeNodeView
            key={child.key}
            node={child}
            depth={depth + 1}
            selectedPaths={selectedPaths}
            onToggleNode={onToggleNode}
            onToggleExpand={onToggleExpand}
            styles={styles}
            colors={colors}
          />
        ))}
    </View>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

export default function RestoreScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isFetching, setIsFetching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    current: number;
    total: number;
    fileName: string;
  } | null>(null);
  const [serverStatus, setServerStatus] = useState<
    'connected' | 'disconnected' | 'unknown' | 'checking'
  >('unknown');

  // ── Server status ──────────────────────────────────────────────────────────
  const checkServer = useCallback(async () => {
    const ip = await getServerIp();
    if (!ip) {
      setServerStatus('unknown');
      return;
    }
    setServerStatus('checking');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const result = await checkDeviceConnection({ signal: controller.signal });
      setServerStatus(result.connected ? 'connected' : 'disconnected');
    } catch {
      setServerStatus('disconnected');
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      checkServer();
    }, [checkServer]),
  );

  const isOffline = serverStatus === 'disconnected' || serverStatus === 'unknown';

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const handleFetch = async () => {
    setIsFetching(true);
    try {
      const serverFiles: RemoteFile[] = await listServerFiles();
      setFiles(serverFiles);
      const newTree = buildTree(serverFiles);
      setTree(newTree);
      setSelectedPaths(new Set());
    } catch (error: any) {
      Alert.alert('Fetch Failed', error.message || 'Could not fetch files');
    } finally {
      setIsFetching(false);
    }
  };

  // ── Expand / collapse ──────────────────────────────────────────────────────
  const handleToggleExpand = useCallback((nodeKey: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setTree(prev => {
      if (!prev) return prev;
      const cloned = deepCloneTree(prev);
      const target = findNodeByKey(cloned, nodeKey);
      if (target) target.isExpanded = !target.isExpanded;
      return cloned;
    });
  }, []);

  // ── Selection ──────────────────────────────────────────────────────────────
  const handleToggleNode = useCallback(
    (node: TreeNode) => {
      const paths = collectFilePaths(node);
      setSelectedPaths(prev => {
        const next = new Set(prev);
        const allSelected = paths.every(p => next.has(p));
        if (allSelected) {
          paths.forEach(p => next.delete(p));
        } else {
          paths.forEach(p => next.add(p));
        }
        return next;
      });
    },
    [],
  );

  const selectAll = () => {
    if (selectedPaths.size === files.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(files.map(f => f.path)));
    }
  };

  // ── Download ───────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    if (selectedPaths.size === 0) return;
    setIsDownloading(true);

    // Request media library permission once up-front (needed for images/videos/audio)
    const { status } = await MediaLibrary.requestPermissionsAsync();
    const canSaveToGallery = status === 'granted';

    let index = 0;
    let saved = 0;
    let skipped = 0;
    let failed = 0;

    for (const path of selectedPaths) {
      const fileInfo = files.find(f => f.path === path);
      if (!fileInfo) continue;

      index++;
      const displayName = path.split(/[/\\]/).pop() ?? path;
      setDownloadProgress({ current: index, total: selectedPaths.size, fileName: displayName });

      try {
        if (!FileSystem.cacheDirectory) {
          console.warn('cacheDirectory is null, skipping:', path);
          failed++;
          continue;
        }

        const localPath = sanitizeRelativePath(path);
        const ext = localPath.split('.').pop()?.toLowerCase() ?? '';
        const isMedia = isMediaExtension(ext);

        // ── Strategy A: media file → save via MediaLibrary so it appears in Gallery ──
        if (isMedia && canSaveToGallery) {
          // Download to a temp cache file first
          const tmpUri = FileSystem.cacheDirectory + 'restore_tmp_' + Date.now() + '_' + displayName;

          // Skip if already in the library with the same size? We can't easily check,
          // so we always re-download media files (user can deduplicate later).
          await downloadFile(path, tmpUri);

          try {
            await MediaLibrary.saveToLibraryAsync(tmpUri);
            saved++;
          } finally {
            // Clean up temp file regardless of whether saveToLibrary succeeded
            await FileSystem.deleteAsync(tmpUri, { idempotent: true });
          }
          continue;
        }

        // ── Strategy B: non-media (docs, APKs, etc.) → documentDirectory ────────────
        if (!FileSystem.documentDirectory) {
          console.warn('documentDirectory is null, skipping:', path);
          failed++;
          continue;
        }

        const destUri = FileSystem.documentDirectory + localPath;
        const folderUri = destUri.substring(0, destUri.lastIndexOf('/'));
        const folderInfo = await FileSystem.getInfoAsync(folderUri);
        if (!folderInfo.exists) {
          await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });
        }

        const existingInfo = await FileSystem.getInfoAsync(destUri);
        if (existingInfo.exists && (existingInfo as any).size === fileInfo.size) {
          skipped++;
          continue;
        }

        await downloadFile(path, destUri);
        saved++;
      } catch (e) {
        console.warn(`Failed to restore ${path}:`, e);
        failed++;
      }
    }

    setIsDownloading(false);
    setDownloadProgress(null);

    const parts: string[] = [];
    if (saved > 0) parts.push(`${saved} saved to gallery / storage`);
    if (skipped > 0) parts.push(`${skipped} already present`);
    if (failed > 0) parts.push(`${failed} failed`);
    Alert.alert(
      'Restore Complete',
      parts.join('\n') || 'Nothing was downloaded.',
    );
    setSelectedPaths(new Set());
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const rootChildren = tree?.children ?? [];

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={colors.bg === '#0B1220' ? 'light-content' : 'dark-content'} />

      {/* Download progress banner */}
      {isDownloading && downloadProgress && (
        <View style={[styles.progressContainer, { paddingTop: insets.top + Spacing.two }]}>
          <Text style={styles.progressText}>
            Downloading {downloadProgress.current} / {downloadProgress.total}
          </Text>
          <Text style={styles.progressSubtext} numberOfLines={1}>
            {downloadProgress.fileName}
          </Text>
          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFill,
                {
                  width: `${(downloadProgress.current / downloadProgress.total) * 100}%`,
                },
              ]}
            />
          </View>
        </View>
      )}

      {/* Page header */}
      <View
        style={[
          styles.pageHeader,
          { paddingTop: !isDownloading ? insets.top + Spacing.five : Spacing.four },
        ]}
      >
        <View>
          <Text style={styles.pageTitle}>Restore Files</Text>
          <Text style={styles.pageSubtitle}>Download files from server</Text>
        </View>

        <View style={styles.headerButtons}>
          <TouchableOpacity
            onPress={handleFetch}
            style={[styles.actionBtn, isOffline && styles.disabledBtn]}
            disabled={isFetching || isDownloading || isOffline}
          >
            {isFetching ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <>
                <AppIcon
                  androidName="sync"
                  iosName="arrow.triangle.2.circlepath"
                  color={colors.primary}
                  size={16}
                />
                <Text style={[styles.actionBtnText, { color: colors.primary }]}>Fetch</Text>
              </>
            )}
          </TouchableOpacity>

          {files.length > 0 && (
            <TouchableOpacity
              onPress={selectAll}
              style={[styles.actionBtn, isOffline && styles.disabledBtn]}
              disabled={isDownloading || isOffline}
            >
              <Text style={[styles.actionBtnText, { color: colors.primary }]}>
                {selectedPaths.size === files.length ? 'Deselect All' : 'Select All'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Selection info bar */}
      {selectedPaths.size > 0 && !isDownloading && (
        <View style={[styles.selectionBar, { borderColor: colors.surfaceBorder }]}>
          <AppIcon androidName="check_circle" iosName="checkmark.circle" color={colors.primary} size={16} />
          <Text style={[styles.selectionBarText, { color: colors.primary }]}>
            {selectedPaths.size} {selectedPaths.size === 1 ? 'file' : 'files'} selected
          </Text>
          <TouchableOpacity onPress={() => setSelectedPaths(new Set())} style={styles.clearSelBtn}>
            <Text style={[styles.clearSelText, { color: colors.textSecondary }]}>Clear</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* File tree */}
      <FlatList
        data={rootChildren}
        keyExtractor={item => item.key}
        renderItem={({ item }) => (
          <TreeNodeView
            node={item}
            depth={0}
            selectedPaths={selectedPaths}
            onToggleNode={handleToggleNode}
            onToggleExpand={handleToggleExpand}
            styles={styles}
            colors={colors}
          />
        )}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: BottomTabInset + Spacing.eight },
        ]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          !isFetching ? (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
                <AppIcon
                  androidName="cloud_download"
                  iosName="icloud.and.arrow.down"
                  color={colors.primary}
                  size={36}
                  fallback="⬇️"
                />
              </View>
              <Text style={styles.emptyTitle}>No files fetched</Text>
              <Text style={styles.emptySubtitle}>
                Tap Fetch to see files available on the server.
              </Text>
            </View>
          ) : null
        }
      />

      {/* Download FAB */}
      {selectedPaths.size > 0 && !isDownloading && (
        <TouchableOpacity
          style={[
            styles.fab,
            { bottom: BottomTabInset + Spacing.four },
            isOffline && styles.disabledBtn,
          ]}
          onPress={handleDownload}
          disabled={isOffline}
        >
          <AppIcon androidName="download" iosName="arrow.down.circle" color={colors.white} size={22} />
          <Text style={styles.fabText}>Restore {selectedPaths.size} Files</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree mutation helpers (immutable clones for React state)
// ─────────────────────────────────────────────────────────────────────────────

function deepCloneTree(node: TreeNode): TreeNode {
  return { ...node, children: node.children.map(deepCloneTree) };
}

function findNodeByKey(node: TreeNode, key: string): TreeNode | null {
  if (node.key === key) return node;
  for (const child of node.children) {
    const found = findNodeByKey(child, key);
    if (found) return found;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: Spacing.four,
      paddingTop: Spacing.two,
      flexGrow: 1,
    },
    pageHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.five,
      paddingBottom: Spacing.three,
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

    // Selection bar
    selectionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.five,
      paddingVertical: Spacing.two,
      borderBottomWidth: 1,
      gap: Spacing.two,
    },
    selectionBarText: {
      fontSize: TextScale.sm,
      fontWeight: '600',
      flex: 1,
    },
    clearSelBtn: {
      paddingHorizontal: Spacing.two,
      paddingVertical: Spacing.one,
    },
    clearSelText: {
      fontSize: TextScale.sm,
      fontWeight: '500',
    },

    // Folder rows
    folderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingRight: Spacing.three,
      paddingVertical: Spacing.two,
      gap: Spacing.two,
    },
    chevronBtn: {
      width: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderLabelBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      flex: 1,
    },
    folderName: {
      fontSize: TextScale.base,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    folderBadge: {
      alignItems: 'flex-end',
    },
    folderBadgeText: {
      fontSize: TextScale.xs,
      color: colors.textSecondary,
    },
    folderBadgeSize: {
      fontSize: TextScale.xs,
      color: colors.textMuted,
    },

    // File rows
    fileRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingRight: Spacing.three,
      paddingVertical: Spacing.two,
      gap: Spacing.two,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.surfaceBorder,
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
      marginTop: 1,
    },

    // Checkboxes
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 5,
      borderWidth: 2,
      borderColor: colors.textSecondary,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    checkboxSelected: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    checkboxPartial: {
      backgroundColor: colors.primarySoft,
      borderColor: colors.primary,
    },
    partialDot: {
      width: 8,
      height: 8,
      borderRadius: 2,
      backgroundColor: colors.primary,
    },

    // FAB
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
    disabledBtn: {
      opacity: 0.4,
    },

    // Empty state
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

    // Progress banner
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
