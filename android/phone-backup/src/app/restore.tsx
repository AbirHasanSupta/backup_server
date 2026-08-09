import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
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
  Modal,
  ScrollView,
  Dimensions,
  Pressable,
  PanResponder,
  Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  listServerFiles,
  downloadFile,
  getFilePreviewUrl,
  listSharedSources,
  listSharedFiles,
  downloadSharedFile,
  getSharedFilePreviewUrl,
} from '../../downloader';
import { checkDeviceConnection } from '../../uploader';
import { getServerIp } from '../../settings';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SourceMode = 'phone' | 'shared';

type SharedSource = { id: string; label: string };

type RemoteFile = {
  path: string;
  size: number;
  modified_time: number;
  sha256?: string;
  uploaded_time?: number;
};

/** A node in the recursive folder tree */
type TreeNode = {
  name: string;
  key: string;
  isFolder: boolean;
  file?: RemoteFile;
  children: TreeNode[];
  totalSize: number;
  fileCount: number;
  isExpanded: boolean;
};

type SortField = 'name' | 'date' | 'type' | 'size';
type SortDir   = 'asc' | 'desc';

type FileCategory = 'image' | 'video' | 'audio' | 'other';

// ─────────────────────────────────────────────────────────────────────────────
// File-type helpers
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v', 'wmv', 'flv', 'ts', 'mts']);
const AUDIO_EXTS = new Set(['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'wma', 'aiff']);

function getExt(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase();
}

function getFileCategory(name: string): FileCategory {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'other';
}

function isMediaExtension(ext: string): boolean {
  return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

/** Returns a color/icon for a file category to use in the metadata card */
function categoryMeta(cat: FileCategory): { icon: string; iosIcon: string; label: string } {
  switch (cat) {
    case 'image': return { icon: 'image', iosIcon: 'photo', label: 'Image' };
    case 'video': return { icon: 'videocam', iosIcon: 'video', label: 'Video' };
    case 'audio': return { icon: 'music_note', iosIcon: 'music.note', label: 'Audio' };
    default:      return { icon: 'insert_drive_file', iosIcon: 'doc', label: 'File' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function sanitizeRelativePath(raw: string): string {
  const normalised = raw.replace(/\\/g, '/');
  const match = normalised.match(/^([^/]+):(.+)$/);
  if (!match) return normalised;
  const [, volume, rest] = match;
  if (volume.toLowerCase() === 'primary') return rest;
  return `${volume}/${rest}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree construction & helpers
// ─────────────────────────────────────────────────────────────────────────────

function insertFileIntoTree(node: TreeNode, segments: string[], file: RemoteFile, depth: number): void {
  if (depth === segments.length - 1) {
    node.children.push({
      name: segments[depth], key: file.path, isFolder: false,
      file, children: [], totalSize: file.size, fileCount: 1, isExpanded: false,
    });
    return;
  }
  const segName = segments[depth];
  const folderKey = segments.slice(0, depth + 1).join('/');
  let child = node.children.find(c => c.isFolder && c.name === segName);
  if (!child) {
    child = { name: segName, key: folderKey, isFolder: true, children: [], totalSize: 0, fileCount: 0, isExpanded: false };
    node.children.push(child);
  }
  insertFileIntoTree(child, segments, file, depth + 1);
}

function rollupStats(node: TreeNode): void {
  if (!node.isFolder) return;
  for (const child of node.children) rollupStats(child);
  node.totalSize = node.children.reduce((s, c) => s + c.totalSize, 0);
  node.fileCount = node.children.reduce((s, c) => s + c.fileCount, 0);
}

function buildTree(files: RemoteFile[]): TreeNode {
  const root: TreeNode = { name: '__root__', key: '__root__', isFolder: true, children: [], totalSize: 0, fileCount: 0, isExpanded: true };
  for (const file of files) {
    const displayPath = sanitizeRelativePath(file.path);
    const segments = displayPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    if (segments.length === 1) {
      root.children.push({ name: segments[0], key: file.path, isFolder: false, file, children: [], totalSize: file.size, fileCount: 1, isExpanded: false });
    } else {
      insertFileIntoTree(root, segments, file, 0);
    }
  }
  rollupStats(root);
  return root;
}

function collectFilePaths(node: TreeNode): string[] {
  if (!node.isFolder) return node.file ? [node.file.path] : [];
  return node.children.flatMap(collectFilePaths);
}

function folderSelectionState(node: TreeNode, selectedPaths: Set<string>): 'none' | 'partial' | 'all' {
  const paths = collectFilePaths(node);
  if (paths.length === 0) return 'none';
  const selected = paths.filter(p => selectedPaths.has(p)).length;
  if (selected === 0) return 'none';
  if (selected === paths.length) return 'all';
  return 'partial';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort helpers
// ─────────────────────────────────────────────────────────────────────────────

function sortTreeChildren(node: TreeNode, field: SortField, dir: SortDir): TreeNode {
  if (!node.isFolder) return node;
  const sorted = [...node.children].sort((a, b) => {
    // Folders always float to the top regardless of sort
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;

    let cmp = 0;
    if (field === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (field === 'size') {
      cmp = a.totalSize - b.totalSize;
    } else if (field === 'date') {
      const ta = a.file?.uploaded_time ?? a.file?.modified_time ?? 0;
      const tb = b.file?.uploaded_time ?? b.file?.modified_time ?? 0;
      cmp = ta - tb;
    } else if (field === 'type') {
      const ea = getExt(a.name);
      const eb = getExt(b.name);
      cmp = ea.localeCompare(eb);
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return { ...node, children: sorted.map(c => sortTreeChildren(c, field, dir)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Selector
// ─────────────────────────────────────────────────────────────────────────────

type SourceSelectorProps = {
  mode: SourceMode;
  sharedSources: SharedSource[];
  selectedSourceId: string | null;
  isLoadingSources: boolean;
  onModeChange: (mode: SourceMode) => void;
  onSourceSelect: (source: SharedSource) => void;
  colors: AppColors;
};

function SourceSelector({
  mode, sharedSources, selectedSourceId, isLoadingSources,
  onModeChange, onSourceSelect, colors,
}: SourceSelectorProps) {
  const [showSourceMenu, setShowSourceMenu] = useState(false);
  const selectedSource = sharedSources.find(s => s.id === selectedSourceId);

  return (
    <View style={[srcStyles.container, { backgroundColor: colors.surface, borderBottomColor: colors.surfaceBorder }]}>
      {/* Pill tabs */}
      <View style={srcStyles.pillRow}>
        <TouchableOpacity
          onPress={() => onModeChange('phone')}
          style={[
            srcStyles.pill,
            { borderColor: mode === 'phone' ? colors.primary : colors.surfaceBorder,
              backgroundColor: mode === 'phone' ? colors.primarySoft : 'transparent' },
          ]}
          activeOpacity={0.75}
        >
          <AppIcon androidName="smartphone" iosName="iphone" color={mode === 'phone' ? colors.primary : colors.textSecondary} size={14} />
          <Text style={[srcStyles.pillText, { color: mode === 'phone' ? colors.primary : colors.textSecondary }]}>
            Phone Backups
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => onModeChange('shared')}
          style={[
            srcStyles.pill,
            { borderColor: mode === 'shared' ? colors.primary : colors.surfaceBorder,
              backgroundColor: mode === 'shared' ? colors.primarySoft : 'transparent' },
          ]}
          activeOpacity={0.75}
        >
          <AppIcon androidName="folder_open" iosName="folder" color={mode === 'shared' ? colors.primary : colors.textSecondary} size={14} />
          <Text style={[srcStyles.pillText, { color: mode === 'shared' ? colors.primary : colors.textSecondary }]}>
            Shared Folders
          </Text>
        </TouchableOpacity>
      </View>

      {/* Source dropdown row — only when in shared mode */}
      {mode === 'shared' && (
        <View style={srcStyles.sourceRow}>
          {isLoadingSources ? (
            <View style={srcStyles.sourceLoadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[srcStyles.sourceLoadingText, { color: colors.textSecondary }]}>
                Loading shared sources…
              </Text>
            </View>
          ) : sharedSources.length === 0 ? (
            <Text style={[srcStyles.noSourceText, { color: colors.textMuted }]}>
              No shared folders configured. Add folders in the Desktop app → Settings.
            </Text>
          ) : (
            <>
              <TouchableOpacity
                style={[srcStyles.sourcePicker, { backgroundColor: colors.surfaceElevated, borderColor: colors.surfaceBorder }]}
                onPress={() => setShowSourceMenu(v => !v)}
                activeOpacity={0.8}
              >
                <AppIcon androidName="folder" iosName="folder.fill" color={colors.primary} size={16} />
                <Text style={[srcStyles.sourcePickerText, { color: colors.text }]} numberOfLines={1}>
                  {selectedSource ? selectedSource.label : 'Select a folder…'}
                </Text>
                <AppIcon androidName={showSourceMenu ? 'expand_less' : 'expand_more'} iosName={showSourceMenu ? 'chevron.up' : 'chevron.down'} color={colors.textSecondary} size={18} />
              </TouchableOpacity>

              {showSourceMenu && (
                <View style={[srcStyles.sourceMenu, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}>
                  {sharedSources.map(src => (
                    <TouchableOpacity
                      key={src.id}
                      style={[
                        srcStyles.sourceMenuItem,
                        src.id === selectedSourceId && { backgroundColor: colors.primarySoft },
                      ]}
                      onPress={() => {
                        onSourceSelect(src);
                        setShowSourceMenu(false);
                      }}
                      activeOpacity={0.75}
                    >
                      <AppIcon androidName="folder" iosName="folder.fill" color={src.id === selectedSourceId ? colors.primary : colors.textSecondary} size={16} />
                      <Text style={[srcStyles.sourceMenuItemText, { color: src.id === selectedSourceId ? colors.primary : colors.text }]}>
                        {src.label}
                      </Text>
                      {src.id === selectedSourceId && (
                        <AppIcon androidName="check" iosName="checkmark" color={colors.primary} size={14} />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const srcStyles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: Spacing.two,
  },
  pillRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.three,
    paddingVertical: 7,
    borderRadius: Radius.full,
    borderWidth: 1.5,
  },
  pillText: { fontSize: TextScale.xs, fontWeight: '700' },

  sourceRow: { paddingHorizontal: Spacing.four, paddingTop: Spacing.two },
  sourceLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  sourceLoadingText: { fontSize: TextScale.xs },
  noSourceText: { fontSize: TextScale.xs, lineHeight: 18 },

  sourcePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  sourcePickerText: { flex: 1, fontSize: TextScale.sm, fontWeight: '500' },

  sourceMenu: {
    marginTop: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  sourceMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  sourceMenuItemText: { flex: 1, fontSize: TextScale.sm, fontWeight: '500' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview Modal
// ─────────────────────────────────────────────────────────────────────────────

type PreviewState =
  | { phase: 'loading' }
  | { phase: 'ready'; localUri: string }
  | { phase: 'error'; message: string };

type PreviewModalProps = {
  file: RemoteFile | null;
  fileList: RemoteFile[];      // ordered flat list of all previewable files
  currentIndex: number;        // index of `file` in fileList
  onClose: () => void;
  onNavigate: (index: number) => void;  // called when user swipes to a neighbour
  onDownload: (file: RemoteFile) => void;
  previewUrl: string | null;
  previewCache: React.MutableRefObject<Map<string, string>>; // path -> localUri cache
  colors: AppColors;
};

const PreviewModal = React.memo(function PreviewModal({
  file, fileList, currentIndex, onClose, onNavigate, onDownload, previewUrl, previewCache, colors,
}: PreviewModalProps) {
  const insets = useSafeAreaInsets();

  const category = file ? getFileCategory(file.path) : 'other';
  const fileName = file ? (file.path.split(/[/\\]/).pop() ?? file.path) : '';

  const [state, setState] = useState<PreviewState>(() => {
    if (!file || category === 'other') return { phase: 'ready', localUri: '' };
    return { phase: 'loading' };
  });

  // Reset state when file changes
  const [prevPath, setPrevPath] = useState<string | undefined>(file?.path);
  if (file?.path !== prevPath) {
    setPrevPath(file?.path);
    if (!file || category === 'other') {
      setState({ phase: 'ready', localUri: '' });
    } else {
      setState({ phase: 'loading' });
    }
  }

  // Unified effect: checks cache or downloads asynchronously
  React.useEffect(() => {
    if (!file || !previewUrl || category === 'other') return;

    let cancelled = false;

    (async () => {
      // Check cache first
      const cachedUri = previewCache.current.get(file.path);
      if (cachedUri) {
        if (!cancelled) setState({ phase: 'ready', localUri: cachedUri });
        return;
      }

      // Cache miss: download
      const safeKey = file.path.replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmpUri = (FileSystem.cacheDirectory ?? '') + `preview_${safeKey}`;

      try {
        const result = await FileSystem.downloadAsync(previewUrl, tmpUri);
        if (!cancelled) {
          previewCache.current.set(file.path, result.uri);
          setState({ phase: 'ready', localUri: result.uri });
        }
      } catch (e: any) {
        if (!cancelled) {
          setState({ phase: 'error', message: e?.message ?? 'Failed to load preview' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, previewUrl, category, previewCache]);

  // ── Swipe navigation via PanResponder ──────────────────────────────────────
  const [slideAnim] = useState(() => new Animated.Value(0));
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < fileList.length - 1;

  const navigateTo = useCallback((idx: number) => {
    const dir = idx > currentIndex ? -1 : 1;
    // Slide-out, then switch file, then snap back
    Animated.timing(slideAnim, {
      toValue: dir * SCREEN_W * 0.25,
      duration: 100,
      useNativeDriver: true,
    }).start(() => {
      onNavigate(idx);
      slideAnim.setValue(-dir * SCREEN_W * 0.15);
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        speed: 30,
        bounciness: 0,
      }).start();
    });
  }, [currentIndex, onNavigate, slideAnim]);

  // Use ref updated in useEffect so PanResponder callbacks access latest values without ref access during render
  const latestRef = useRef<{
    hasNext: boolean;
    hasPrev: boolean;
    navigateTo: (idx: number) => void;
    currentIndex: number;
  }>({ hasNext, hasPrev, navigateTo, currentIndex });

  useEffect(() => {
    latestRef.current = { hasNext, hasPrev, navigateTo, currentIndex };
  }, [hasNext, hasPrev, navigateTo, currentIndex]);

  const [panResponder, setPanResponder] = useState<ReturnType<typeof PanResponder.create> | null>(null);

  useEffect(() => {
    setPanResponder(
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gs) =>
          Math.abs(gs.dx) > 12 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5,
        onPanResponderGrant: () => {
          slideAnim.setValue(0);
        },
        onPanResponderMove: (_, gs) => {
          slideAnim.setValue(gs.dx * 0.25);
        },
        onPanResponderRelease: (_, gs) => {
          const cur = latestRef.current;
          if (gs.dx < -60 && cur.hasNext) {
            cur.navigateTo(cur.currentIndex + 1);
          } else if (gs.dx > 60 && cur.hasPrev) {
            cur.navigateTo(cur.currentIndex - 1);
          } else {
            // Snap back
            Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, speed: 20, bounciness: 4 }).start();
          }
        },
      })
    );
  }, [slideAnim]);

  if (!file) return null;

  const cat = categoryMeta(category);
  const uploadedDate = formatDate(file.uploaded_time ?? file.modified_time);
  const modDate = formatDate(file.modified_time);

  const renderContent = () => {
    if (state.phase === 'loading') {
      return (
        <View style={pvStyles.centeredBox}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[pvStyles.loadingText, { color: colors.textSecondary }]}>Loading preview…</Text>
        </View>
      );
    }

    if (state.phase === 'error') {
      return (
        <View style={pvStyles.centeredBox}>
          <AppIcon androidName="error_outline" iosName="exclamationmark.circle" color={colors.error} size={40} />
          <Text style={[pvStyles.errorText, { color: colors.error }]}>Preview failed</Text>
          <Text style={[pvStyles.errorSub, { color: colors.textSecondary }]}>{state.message}</Text>
        </View>
      );
    }

    // ready
    if (category === 'image') {
      return (
        <Image
          source={{ uri: state.localUri }}
          style={pvStyles.imageFull}
          contentFit="contain"
          transition={200}
        />
      );
    }

    if (category === 'video') {
      return (
        <VideoPreviewPlayer uri={state.localUri} />
      );
    }

    if (category === 'audio') {
      return (
        <AudioPlayer uri={state.localUri} colors={colors} fileName={fileName} />
      );
    }

    // other — metadata card
    return (
      <View style={pvStyles.metaCard}>
        <View style={[pvStyles.metaIconWrap, { backgroundColor: colors.primarySoft }]}>
          <AppIcon androidName={cat.icon} iosName={cat.iosIcon} color={colors.primary} size={48} />
        </View>
        <Text style={[pvStyles.metaFileName, { color: colors.text }]}>{fileName}</Text>
        <View style={[pvStyles.metaTable, { borderColor: colors.surfaceBorder }]}>
          <MetaRow label="Size" value={formatSize(file.size)} colors={colors} />
          <MetaRow label="Uploaded" value={uploadedDate} colors={colors} />
          <MetaRow label="Modified" value={modDate} colors={colors} />
          <MetaRow label="Type" value={getExt(fileName).toUpperCase() || '—'} colors={colors} last />
        </View>
        <Text style={[pvStyles.metaNote, { color: colors.textMuted }]}>
          This file type cannot be previewed. Download it to open on your device.
        </Text>
      </View>
    );
  };

  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <View style={[pvStyles.root, { backgroundColor: '#000' }]}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />

        {/* Top bar */}
        <View style={[pvStyles.topBar, { paddingTop: insets.top + Spacing.two, backgroundColor: 'rgba(0,0,0,0.85)' }]}>
          <TouchableOpacity onPress={onClose} style={pvStyles.topBarBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <AppIcon androidName="close" iosName="xmark" color="#fff" size={22} />
          </TouchableOpacity>
          <View style={pvStyles.topBarCenter}>
            <Text style={pvStyles.topBarTitle} numberOfLines={1}>{fileName}</Text>
            {fileList.length > 1 && (
              <Text style={pvStyles.topBarCounter}>
                {currentIndex + 1} / {fileList.length}
              </Text>
            )}
          </View>
          <TouchableOpacity
            onPress={() => onDownload(file)}
            style={[pvStyles.topBarBtn, pvStyles.downloadBtn]}
          >
            <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={20} />
            <Text style={pvStyles.downloadBtnText}>Save</Text>
          </TouchableOpacity>
        </View>

        {/* Content area with swipe gesture */}
        <Animated.View
          style={[pvStyles.contentArea, { transform: [{ translateX: slideAnim }] }]}
          {...(panResponder?.panHandlers ?? {})}
        >
          {renderContent()}
        </Animated.View>

        {/* Left / Right nav arrows — only when neighbours exist */}
        {hasPrev && (
          <TouchableOpacity
            style={pvStyles.navArrowLeft}
            onPress={() => navigateTo(currentIndex - 1)}
            hitSlop={{ top: 20, bottom: 20, left: 10, right: 10 }}
          >
            <AppIcon androidName="chevron_left" iosName="chevron.left" color="rgba(255,255,255,0.85)" size={28} />
          </TouchableOpacity>
        )}
        {hasNext && (
          <TouchableOpacity
            style={pvStyles.navArrowRight}
            onPress={() => navigateTo(currentIndex + 1)}
            hitSlop={{ top: 20, bottom: 20, left: 10, right: 10 }}
          >
            <AppIcon androidName="chevron_right" iosName="chevron.right" color="rgba(255,255,255,0.85)" size={28} />
          </TouchableOpacity>
        )}

        {/* Bottom info strip */}
        <View style={[pvStyles.bottomBar, { paddingBottom: insets.bottom + Spacing.two, backgroundColor: 'rgba(0,0,0,0.8)' }]}>
          <Text style={pvStyles.bottomSize}>{formatSize(file.size)}</Text>
          <Text style={pvStyles.bottomDot}>·</Text>
          <Text style={pvStyles.bottomDate}>{uploadedDate}</Text>
        </View>
      </View>
    </Modal>
  );
});

// ── Tiny metadata row ─────────────────────────────────────────────────────────
function MetaRow({ label, value, colors, last }: { label: string; value: string; colors: AppColors; last?: boolean }) {
  return (
    <View style={[pvStyles.metaRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surfaceBorder }]}>
      <Text style={[pvStyles.metaLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[pvStyles.metaValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

// ── Video preview player ──────────────────────────────────────────────────────
function VideoPreviewPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, p => {
    p.pause();
  });

  return (
    <View style={pvStyles.videoContainer}>
      <VideoView
        player={player}
        style={pvStyles.videoFull}
        contentFit="contain"
        nativeControls
      />
    </View>
  );
}

// ── Simple audio player ───────────────────────────────────────────────────────
function AudioPlayer({ uri, colors, fileName }: { uri: string; colors: AppColors; fileName: string }) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);

  // Clean up player on unmount
  useEffect(() => {
    return () => { player.remove(); };
  }, [player]);

  const togglePlay = () => {
    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  };

  const formatSec = (sec: number) => {
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  const positionSec = status.currentTime ?? 0;
  const durationSec = status.duration ?? 0;
  const progress = durationSec > 0 ? positionSec / durationSec : 0;

  return (
    <View style={pvStyles.audioPlayer}>
      <View style={[pvStyles.audioIconWrap, { backgroundColor: colors.primarySoft }]}>
        <AppIcon androidName="music_note" iosName="music.note" color={colors.primary} size={52} />
      </View>
      <Text style={pvStyles.audioFileName} numberOfLines={2}>{fileName}</Text>

      {/* Progress bar */}
      <View style={pvStyles.audioProgressBg}>
        <View style={[pvStyles.audioProgressFill, { width: `${progress * 100}%`, backgroundColor: colors.primary }]} />
      </View>
      <View style={pvStyles.audioTimings}>
        <Text style={pvStyles.audioTime}>{formatSec(positionSec)}</Text>
        <Text style={pvStyles.audioTime}>{formatSec(durationSec)}</Text>
      </View>

      {/* Play/Pause */}
      <TouchableOpacity onPress={togglePlay} style={[pvStyles.audioPlayBtn, { backgroundColor: colors.primary }]}>
        <AppIcon
          androidName={status.playing ? 'pause' : 'play_arrow'}
          iosName={status.playing ? 'pause.fill' : 'play.fill'}
          color="#fff"
          size={28}
        />
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort Bar
// ─────────────────────────────────────────────────────────────────────────────

const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'date', label: 'Date' },
  { field: 'type', label: 'Type' },
  { field: 'size', label: 'Size' },
];

type SortBarProps = {
  field: SortField;
  dir: SortDir;
  onChange: (field: SortField, dir: SortDir) => void;
  colors: AppColors;
};

function SortBar({ field, dir, onChange, colors }: SortBarProps) {
  const handlePress = (f: SortField) => {
    if (f === field) {
      onChange(f, dir === 'asc' ? 'desc' : 'asc');
    } else {
      onChange(f, 'asc');
    }
  };

  return (
    <View style={[sortStyles.wrapper, { backgroundColor: colors.surface, borderBottomColor: colors.surfaceBorder }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={sortStyles.row}
        style={{ flexGrow: 0 }}
      >
        {SORT_OPTIONS.map(opt => {
          const active = opt.field === field;
          return (
            <TouchableOpacity
              key={opt.field}
              onPress={() => handlePress(opt.field)}
              style={[
                sortStyles.chip,
                { borderColor: active ? colors.primary : colors.surfaceBorder,
                  backgroundColor: active ? colors.primarySoft : 'transparent' },
              ]}
              activeOpacity={0.7}
            >
              <Text style={[sortStyles.chipLabel, { color: active ? colors.primary : colors.textSecondary }]}>
                {opt.label}
              </Text>
              {active && (
                <Text style={[sortStyles.chipArrow, { color: colors.primary }]}>
                  {dir === 'asc' ? '↑' : '↓'}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const sortStyles = StyleSheet.create({
  wrapper: {
    // Ensure the sort bar always has a consistent height and doesn't stretch
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    gap: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.full,
    borderWidth: 1.5,
    height: 30,
  },
  chipLabel: { fontSize: TextScale.xs, fontWeight: '600', lineHeight: 16 },
  chipArrow: { fontSize: 12, fontWeight: '700', lineHeight: 16 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Tree node renderer
// ─────────────────────────────────────────────────────────────────────────────

type TreeNodeViewProps = {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  selectionMode: boolean;
  onToggleNode: (node: TreeNode) => void;
  onToggleExpand: (nodeKey: string) => void;
  onPreview: (file: RemoteFile) => void;
  onEnterSelectionMode: (node: TreeNode) => void;
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
};

const TreeNodeView = React.memo(function TreeNodeView({
  node, depth, selectedPaths, selectionMode, onToggleNode, onToggleExpand, onPreview, onEnterSelectionMode, styles, colors,
}: TreeNodeViewProps) {
  const indent = depth * 16;

  if (!node.isFolder) {
    const isSelected = selectedPaths.has(node.key);
    const category = getFileCategory(node.name);
    const catMeta = categoryMeta(category);

    const handlePress = () => {
      if (selectionMode) {
        // In selection mode: tap anywhere (including file row) selects/deselects
        onToggleNode(node);
      } else {
        node.file && onPreview(node.file);
      }
    };

    const handleLongPress = () => {
      if (selectionMode) {
        // In selection mode: long press previews the file
        node.file && onPreview(node.file);
      } else {
        // Outside selection mode: long press enters selection mode
        onEnterSelectionMode(node);
      }
    };

    const handleCheckboxPress = () => {
      if (selectionMode) {
        // Already in selection mode — just toggle
        onToggleNode(node);
      } else {
        // Enter selection mode AND select this item
        onEnterSelectionMode(node);
      }
    };

    return (
      <Pressable
        style={[styles.fileRow, { paddingLeft: indent + Spacing.four }]}
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={350}
        android_ripple={{ color: colors.primarySoft }}
      >
        {/* Checkbox — tapping it always toggles selection */}
        <TouchableOpacity
          onPress={handleCheckboxPress}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
          activeOpacity={0.7}
        >
          <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
            {isSelected ? (
              <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={13} />
            ) : null}
          </View>
        </TouchableOpacity>

        <AppIcon androidName={catMeta.icon} iosName={catMeta.iosIcon} color={colors.textMuted} size={16} />

        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>{node.name}</Text>
          <View style={styles.fileMetaRow}>
            <Text style={styles.fileSize}>{formatSize(node.file!.size)}</Text>
            <Text style={styles.fileDot}>·</Text>
            <Text style={styles.fileDate}>{formatDate(node.file!.uploaded_time ?? node.file!.modified_time)}</Text>
          </View>
        </View>

        {/* Show preview hint only when NOT in selection mode */}
        {!selectionMode && (
          <AppIcon androidName="chevron_right" iosName="chevron.right" color={colors.textMuted} size={14} />
        )}
      </Pressable>
    );
  }

  // ── Folder row ─────────────────────────────────────────────────────────
  const selState = folderSelectionState(node, selectedPaths);
  const isPartial = selState === 'partial';
  const isAllSelected = selState === 'all';
  const checkboxStyle = [styles.checkbox, (isAllSelected || isPartial) && styles.checkboxSelected, isPartial && styles.checkboxPartial];

  return (
    <View>
      <View style={[styles.folderRow, { paddingLeft: indent + Spacing.four }]}>
        <TouchableOpacity style={styles.chevronBtn} onPress={() => onToggleExpand(node.key)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}>
          <AppIcon androidName={node.isExpanded ? 'expand_more' : 'chevron_right'} iosName={node.isExpanded ? 'chevron.down' : 'chevron.right'} color={colors.textSecondary} size={22} />
        </TouchableOpacity>
        <TouchableOpacity
          style={checkboxStyle}
          onPress={() => {
            if (selectionMode) {
              // Already in selection mode: just toggle this folder
              onToggleNode(node);
            } else {
              // First tap: enter selection mode and toggle (onEnterSelectionMode handles both)
              onEnterSelectionMode(node);
            }
          }}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
        >
          {isAllSelected && <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={13} />}
          {isPartial && <View style={styles.partialDot} />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.folderLabelBtn} onPress={() => onToggleExpand(node.key)} activeOpacity={0.7}>
          <AppIcon androidName="folder" iosName="folder.fill" color={colors.primary} size={18} />
          <Text style={styles.folderName} numberOfLines={1}>{node.name}</Text>
        </TouchableOpacity>
        <View style={styles.folderBadge}>
          <Text style={styles.folderBadgeText}>{node.fileCount} {node.fileCount === 1 ? 'file' : 'files'}</Text>
          <Text style={styles.folderBadgeSize}>{formatSize(node.totalSize)}</Text>
        </View>
      </View>
      {node.isExpanded && node.children.map(child => (
        <TreeNodeView
          key={child.key} node={child} depth={depth + 1}
          selectedPaths={selectedPaths} selectionMode={selectionMode}
          onToggleNode={onToggleNode} onEnterSelectionMode={onEnterSelectionMode}
          onToggleExpand={onToggleExpand} onPreview={onPreview}
          styles={styles} colors={colors}
        />
      ))}
    </View>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Tree mutation helpers
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
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

export default function RestoreScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // ── Source mode state ──────────────────────────────────────────────────────
  const [sourceMode, setSourceMode] = useState<SourceMode>('phone');
  const [sharedSources, setSharedSources] = useState<SharedSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [isLoadingSources, setIsLoadingSources] = useState(false);

  // ── File list / tree state ─────────────────────────────────────────────────
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isFetching, setIsFetching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ current: number; total: number; fileName: string } | null>(null);
  const [serverStatus, setServerStatus] = useState<'connected' | 'disconnected' | 'unknown' | 'checking'>('unknown');

  // Sort state
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Selection mode state
  const [selectionMode, setSelectionMode] = useState(false);

  // Preview state
  const [previewFile, setPreviewFile] = useState<RemoteFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number>(0);

  // Preview file cache: path -> local file URI. Persists across modal open/close.
  const previewCacheRef = useRef<Map<string, string>>(new Map());

  // Clear cache helper (deletes all cached preview files from disk)
  const clearPreviewCache = useCallback(async () => {
    const entries = Array.from(previewCacheRef.current.entries());
    previewCacheRef.current.clear();
    for (const [, uri] of entries) {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }, []);


  // ── Server status ──────────────────────────────────────────────────────────
  const checkServer = useCallback(async () => {
    const ip = await getServerIp();
    if (!ip) { setServerStatus('unknown'); return; }
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

  useFocusEffect(useCallback(() => { checkServer(); }, [checkServer]));

  const isOffline = serverStatus === 'disconnected' || serverStatus === 'unknown';

  // ── Load shared sources when switching to shared mode ──────────────────────
  const loadSharedSources = useCallback(async () => {
    setIsLoadingSources(true);
    try {
      const sources: SharedSource[] = await listSharedSources();
      setSharedSources(sources);
      // Auto-select first source if none selected
      if (sources.length > 0 && !selectedSourceId) {
        setSelectedSourceId(sources[0].id);
      }
    } catch (e: any) {
      Alert.alert('Shared Folders', `Could not load shared sources: ${e?.message ?? 'Unknown error'}`);
    } finally {
      setIsLoadingSources(false);
    }
  }, [selectedSourceId]);

  const handleModeChange = useCallback((mode: SourceMode) => {
    setSourceMode(mode);
    // Clear file list when switching modes
    setFiles([]);
    setTree(null);
    setSelectedPaths(new Set());
    if (mode === 'shared') {
      loadSharedSources();
    }
  }, [loadSharedSources]);

  const handleSourceSelect = useCallback((source: SharedSource) => {
    setSelectedSourceId(source.id);
    // Clear file list so user explicitly re-fetches
    setFiles([]);
    setTree(null);
    setSelectedPaths(new Set());
  }, []);

  // ── Sorted tree ────────────────────────────────────────────────────────────
  const sortedTree = useMemo(() => {
    if (!tree) return null;
    return sortTreeChildren(tree, sortField, sortDir);
  }, [tree, sortField, sortDir]);

  // Flat ordered list of all files (for swipe navigation). Refreshed whenever sortedTree changes.
  const previewableFiles = useMemo<RemoteFile[]>(() => {
    const result: RemoteFile[] = [];
    function collect(node: TreeNode) {
      if (!node.isFolder && node.file) {
        result.push(node.file);
      } else {
        node.children.forEach(collect);
      }
    }
    if (sortedTree) sortedTree.children.forEach(collect);
    return result;
  }, [sortedTree]);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const handleFetch = async () => {
    // Guard early before showing the spinner
    if (sourceMode === 'shared' && !selectedSourceId) {
      Alert.alert('No Source', 'Please select a shared folder first.');
      return;
    }
    // Clear preview cache when re-fetching so stale previews don’t persist
    await clearPreviewCache();
    setIsFetching(true);
    try {
      let serverFiles: RemoteFile[];
      if (sourceMode === 'shared') {
        serverFiles = await listSharedFiles(selectedSourceId!);
      } else {
        serverFiles = await listServerFiles();
      }
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

  // ── Sort ───────────────────────────────────────────────────────────────────
  const handleSortChange = useCallback((field: SortField, dir: SortDir) => {
    setSortField(field);
    setSortDir(dir);
  }, []);

  // ── Preview ────────────────────────────────────────────────────────────────
  const openPreview = useCallback(async (file: RemoteFile, index?: number) => {
    let url: string;
    if (sourceMode === 'shared' && selectedSourceId) {
      url = await getSharedFilePreviewUrl(selectedSourceId, file.path);
    } else {
      url = await getFilePreviewUrl(file.path);
    }
    const idx = index !== undefined ? index : previewableFiles.findIndex(f => f.path === file.path);
    setPreviewIndex(idx >= 0 ? idx : 0);
    setPreviewUrl(url);
    setPreviewFile(file);
  }, [sourceMode, selectedSourceId, previewableFiles]);

  const handlePreview = useCallback((file: RemoteFile) => {
    openPreview(file);
  }, [openPreview]);

  // Navigate to prev/next file in preview
  const handlePreviewNavigate = useCallback(async (newIndex: number) => {
    if (newIndex < 0 || newIndex >= previewableFiles.length) return;
    const nextFile = previewableFiles[newIndex];
    openPreview(nextFile, newIndex);
  }, [previewableFiles, openPreview]);

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewUrl(null);
  }, []);

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

  // ── Selection mode ─────────────────────────────────────────────────────────
  // Enter selection mode and immediately toggle the given node
  const handleEnterSelectionMode = useCallback((node: TreeNode) => {
    setSelectionMode(true);
    const paths = collectFilePaths(node);
    setSelectedPaths(prev => {
      const next = new Set(prev);
      const allSelected = paths.every(p => next.has(p));
      if (allSelected) paths.forEach(p => next.delete(p));
      else paths.forEach(p => next.add(p));
      return next;
    });
  }, []);

  const handleToggleNode = useCallback((node: TreeNode) => {
    const paths = collectFilePaths(node);
    setSelectedPaths(prev => {
      const next = new Set(prev);
      const allSelected = paths.every(p => next.has(p));
      if (allSelected) paths.forEach(p => next.delete(p));
      else paths.forEach(p => next.add(p));
      return next;
    });
  }, []);

  const selectAll = () => {
    if (selectedPaths.size === files.length) {
      setSelectedPaths(new Set());
      setSelectionMode(false);
    } else {
      setSelectionMode(true);
      setSelectedPaths(new Set(files.map(f => f.path)));
    }
  };

  // ── Download (selected) ────────────────────────────────────────────────────
  const handleDownloadFiles = useCallback(async (pathSet: Set<string>) => {
    if (pathSet.size === 0) return;
    setIsDownloading(true);

    const { status } = await MediaLibrary.requestPermissionsAsync();
    const canSaveToGallery = status === 'granted';

    let index = 0, saved = 0, skipped = 0, failed = 0;

    for (const path of pathSet) {
      const fileInfo = files.find(f => f.path === path);
      if (!fileInfo) continue;

      index++;
      const displayName = path.split(/[/\\]/).pop() ?? path;
      setDownloadProgress({ current: index, total: pathSet.size, fileName: displayName });

      try {
        if (!FileSystem.cacheDirectory) { failed++; continue; }

        const localPath = sanitizeRelativePath(path);
        const ext = localPath.split('.').pop()?.toLowerCase() ?? '';
        const isMedia = isMediaExtension(ext);

        if (isMedia && canSaveToGallery) {
          const tmpUri = FileSystem.cacheDirectory + 'restore_tmp_' + Date.now() + '_' + displayName;
          if (sourceMode === 'shared' && selectedSourceId) {
            await downloadSharedFile(selectedSourceId, path, tmpUri);
          } else {
            await downloadFile(path, tmpUri);
          }
          try {
            await MediaLibrary.saveToLibraryAsync(tmpUri);
            saved++;
          } finally {
            await FileSystem.deleteAsync(tmpUri, { idempotent: true });
          }
          continue;
        }

        if (!FileSystem.documentDirectory) { failed++; continue; }
        const destUri = FileSystem.documentDirectory + localPath;
        const folderUri = destUri.substring(0, destUri.lastIndexOf('/'));
        const folderInfo = await FileSystem.getInfoAsync(folderUri);
        if (!folderInfo.exists) await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });

        const existingInfo = await FileSystem.getInfoAsync(destUri);
        if (existingInfo.exists && (existingInfo as any).size === fileInfo.size) { skipped++; continue; }

        if (sourceMode === 'shared' && selectedSourceId) {
          await downloadSharedFile(selectedSourceId, path, destUri);
        } else {
          await downloadFile(path, destUri);
        }
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
    Alert.alert('Restore Complete', parts.join('\n') || 'Nothing was downloaded.');
    setSelectedPaths(new Set());
  }, [files, sourceMode, selectedSourceId]);


  // ── Download a single file triggered from the preview modal ───────────────
  const handleDownloadSingle = useCallback(async (file: RemoteFile) => {
    closePreview();
    // Small delay so the modal animation completes before download begins
    setTimeout(() => handleDownloadFiles(new Set([file.path])), 300);
  }, [closePreview, handleDownloadFiles]);

  const handleDownload = useCallback(
    () => handleDownloadFiles(selectedPaths),
    [handleDownloadFiles, selectedPaths],
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  const rootChildren = sortedTree?.children ?? [];

  // Determine fetch button disabled state
  const fetchDisabled = isFetching || isDownloading || isOffline ||
    (sourceMode === 'shared' && !selectedSourceId);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={colors.bg === '#0B1220' ? 'light-content' : 'dark-content'} />

      {/* Download progress banner */}
      {isDownloading && downloadProgress && (
        <View style={[styles.progressContainer, { paddingTop: insets.top + Spacing.two }]}>
          <Text style={styles.progressText}>Downloading {downloadProgress.current} / {downloadProgress.total}</Text>
          <Text style={styles.progressSubtext} numberOfLines={1}>{downloadProgress.fileName}</Text>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${(downloadProgress.current / downloadProgress.total) * 100}%` }]} />
          </View>
        </View>
      )}

      {/* Page header */}
      <View style={[styles.pageHeader, { paddingTop: !isDownloading ? insets.top + Spacing.five : Spacing.four }]}>
        <View>
          <Text style={styles.pageTitle}>Restore Files</Text>
          <Text style={styles.pageSubtitle}>
            {files.length > 0 ? `${files.length} files on server` : 'Download files from server'}
          </Text>
        </View>
        <View style={styles.headerButtons}>
          <TouchableOpacity
            onPress={handleFetch}
            style={[styles.actionBtn, fetchDisabled && styles.disabledBtn]}
            disabled={fetchDisabled}
          >
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
            <TouchableOpacity onPress={selectAll} style={[styles.actionBtn, isOffline && styles.disabledBtn]} disabled={isDownloading || isOffline}>
              <Text style={[styles.actionBtnText, { color: colors.primary }]}>
                {selectedPaths.size === files.length ? 'Deselect All' : 'Select All'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Source selector (always visible) */}
      {!isDownloading && (
        <SourceSelector
          mode={sourceMode}
          sharedSources={sharedSources}
          selectedSourceId={selectedSourceId}
          isLoadingSources={isLoadingSources}
          onModeChange={handleModeChange}
          onSourceSelect={handleSourceSelect}
          colors={colors}
        />
      )}

      {/* Sort bar (only when files are loaded) */}
      {files.length > 0 && !isDownloading && (
        <SortBar field={sortField} dir={sortDir} onChange={handleSortChange} colors={colors} />
      )}

      {/* Tap hint — changes based on selection mode */}
      {files.length > 0 && selectedPaths.size === 0 && (
        <View style={[styles.hintBar, { borderColor: colors.surfaceBorder }]}>
          <AppIcon androidName="touch_app" iosName="hand.tap" color={colors.textMuted} size={13} />
          <Text style={[styles.hintText, { color: colors.textMuted }]}>
            {selectionMode ? 'Tap to select · Long press for preview' : 'Tap to preview · Hold to select'}
          </Text>
        </View>
      )}

      {/* Selection info bar */}
      {selectedPaths.size > 0 && !isDownloading && (
        <View style={[styles.selectionBar, { borderColor: colors.surfaceBorder }]}>
          <AppIcon androidName="check_circle" iosName="checkmark.circle" color={colors.primary} size={16} />
          <Text style={[styles.selectionBarText, { color: colors.primary }]}>
            {selectedPaths.size} {selectedPaths.size === 1 ? 'file' : 'files'} selected
          </Text>
          <TouchableOpacity
            onPress={() => { setSelectedPaths(new Set()); setSelectionMode(false); }}
            style={styles.clearSelBtn}
          >
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
            node={item} depth={0}
            selectedPaths={selectedPaths}
            selectionMode={selectionMode}
            onToggleNode={handleToggleNode}
            onEnterSelectionMode={handleEnterSelectionMode}
            onToggleExpand={handleToggleExpand}
            onPreview={handlePreview}
            styles={styles} colors={colors}
          />
        )}
        contentContainerStyle={[styles.listContent, { paddingBottom: BottomTabInset + Spacing.eight }]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          !isFetching ? (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
                <AppIcon androidName="cloud_download" iosName="icloud.and.arrow.down" color={colors.primary} size={36} fallback="⬇️" />
              </View>
              <Text style={styles.emptyTitle}>No files fetched</Text>
              <Text style={styles.emptySubtitle}>
                {sourceMode === 'shared' && !selectedSourceId
                  ? 'Select a shared folder above, then tap Fetch.'
                  : 'Tap Fetch to see files available on the server.'}
              </Text>
            </View>
          ) : null
        }
      />

      {/* Download FAB */}
      {selectedPaths.size > 0 && !isDownloading && (
        <TouchableOpacity
          style={[styles.fab, { bottom: BottomTabInset + Spacing.four }, isOffline && styles.disabledBtn]}
          onPress={handleDownload}
          disabled={isOffline}
        >
          <AppIcon androidName="download" iosName="arrow.down.circle" color={colors.white} size={22} />
          <Text style={styles.fabText}>Download {selectedPaths.size} {selectedPaths.size === 1 ? 'File' : 'Files'}</Text>
        </TouchableOpacity>
      )}

      {/* Preview modal — stays mounted across navigation; state resets via unified effect */}
      {previewFile && (
        <PreviewModal
          file={previewFile}
          fileList={previewableFiles}
          currentIndex={previewIndex}
          onClose={closePreview}
          onNavigate={handlePreviewNavigate}
          onDownload={handleDownloadSingle}
          previewUrl={previewUrl}
          previewCache={previewCacheRef}
          colors={colors}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    listContent: { paddingHorizontal: Spacing.four, paddingTop: Spacing.two, flexGrow: 1 },
    pageHeader: {
      flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
      paddingHorizontal: Spacing.five, paddingBottom: Spacing.three,
    },
    pageTitle: { fontSize: TextScale.xl, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
    pageSubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '500', marginTop: 2 },
    headerButtons: { alignItems: 'flex-end', gap: Spacing.two },
    actionBtn: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.one,
      paddingHorizontal: Spacing.three, paddingVertical: Spacing.two,
      borderRadius: Radius.md, backgroundColor: colors.primarySoft,
    },
    actionBtnText: { fontSize: TextScale.xs, fontWeight: '700' },

    // Hint bar
    hintBar: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingHorizontal: Spacing.five, paddingVertical: 5,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    hintText: { fontSize: TextScale.xs },

    // Selection bar
    selectionBar: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: Spacing.five, paddingVertical: Spacing.two,
      borderBottomWidth: 1, gap: Spacing.two,
    },
    selectionBarText: { fontSize: TextScale.sm, fontWeight: '600', flex: 1 },
    clearSelBtn: { paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
    clearSelText: { fontSize: TextScale.sm, fontWeight: '500' },

    // Folder rows
    folderRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingRight: Spacing.three, paddingVertical: Spacing.two, gap: Spacing.two,
    },
    chevronBtn: { width: 28, alignItems: 'center', justifyContent: 'center' },
    folderLabelBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flex: 1 },
    folderName: { fontSize: TextScale.base, fontWeight: '600', color: colors.text, flex: 1 },
    folderBadge: { alignItems: 'flex-end' },
    folderBadgeText: { fontSize: TextScale.xs, color: colors.textSecondary },
    folderBadgeSize: { fontSize: TextScale.xs, color: colors.textMuted },

    // File rows
    fileRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingRight: Spacing.three, paddingVertical: Spacing.two + 2, gap: Spacing.two,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.surfaceBorder,
    },
    fileInfo: { flex: 1 },
    fileName: { fontSize: TextScale.sm, color: colors.text, fontWeight: '500' },
    fileMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    fileSize: { fontSize: TextScale.xs, color: colors.textMuted },
    fileDot: { fontSize: TextScale.xs, color: colors.textMuted },
    fileDate: { fontSize: TextScale.xs, color: colors.textMuted },

    // Checkboxes
    checkbox: {
      width: 20, height: 20, borderRadius: 5, borderWidth: 2,
      borderColor: colors.textSecondary, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    checkboxSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
    checkboxPartial: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
    partialDot: { width: 8, height: 8, borderRadius: 2, backgroundColor: colors.primary },

    // FAB
    fab: {
      position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center',
      backgroundColor: colors.primary, paddingVertical: Spacing.three, paddingHorizontal: Spacing.six,
      borderRadius: Radius.full, gap: Spacing.two, ...Shadows.soft,
    },
    fabText: { color: colors.white, fontWeight: '700', fontSize: TextScale.md },
    disabledBtn: { opacity: 0.4 },

    // Empty state
    emptyContainer: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: Spacing.seven, paddingTop: Spacing.nine, gap: Spacing.four,
    },
    emptyIconWrap: { width: 88, height: 88, borderRadius: Radius.xxl, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: { fontSize: TextScale.md, fontWeight: '800', color: colors.text, textAlign: 'center' },
    emptySubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, fontWeight: '500' },

    // Progress banner
    progressContainer: {
      backgroundColor: colors.surface, paddingHorizontal: Spacing.five,
      paddingBottom: Spacing.three, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder,
    },
    progressText: { fontSize: TextScale.sm, fontWeight: '700', color: colors.text, marginBottom: Spacing.one },
    progressSubtext: { fontSize: TextScale.xs, color: colors.textSecondary, marginBottom: Spacing.two },
    progressBarBg: { height: 6, backgroundColor: colors.surfaceBorder, borderRadius: Radius.full, overflow: 'hidden' },
    progressBarFill: { height: '100%', backgroundColor: colors.primary },
  });

// ─────────────────────────────────────────────────────────────────────────────
// Preview modal styles (dark-only, always on black bg)
// ─────────────────────────────────────────────────────────────────────────────

const pvStyles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
    paddingHorizontal: Spacing.four, paddingBottom: Spacing.three, zIndex: 10,
  },
  topBarCenter: { flex: 1, alignItems: 'center' },
  topBarTitle: {
    color: '#fff', fontSize: TextScale.sm, fontWeight: '600',
    textAlign: 'center',
  },
  topBarCounter: {
    color: 'rgba(255,255,255,0.5)', fontSize: TextScale.xs, textAlign: 'center', marginTop: 1,
  },
  topBarBtn: {
    padding: Spacing.two, borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  downloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: Spacing.three },
  downloadBtnText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '600' },

  contentArea: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Navigation arrows
  navArrowLeft: {
    position: 'absolute',
    left: 8,
    top: '50%',
    marginTop: -24,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  navArrowRight: {
    position: 'absolute',
    right: 8,
    top: '50%',
    marginTop: -24,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },

  bottomBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: Spacing.five, paddingTop: Spacing.two, gap: 6,
  },
  bottomSize: { color: 'rgba(255,255,255,0.7)', fontSize: TextScale.xs },
  bottomDot: { color: 'rgba(255,255,255,0.4)', fontSize: TextScale.xs },
  bottomDate: { color: 'rgba(255,255,255,0.7)', fontSize: TextScale.xs },

  centeredBox: { alignItems: 'center', gap: Spacing.three, padding: Spacing.six },
  loadingText: { fontSize: TextScale.sm, marginTop: Spacing.two },
  errorText: { fontSize: TextScale.base, fontWeight: '700' },
  errorSub: { fontSize: TextScale.sm, textAlign: 'center' },

  imageFull: { width: SCREEN_W, height: SCREEN_H * 0.72 },

  videoContainer: { width: SCREEN_W, height: SCREEN_H * 0.65 },
  videoFull: { width: '100%', height: '100%' },

  // Audio player
  audioPlayer: { alignItems: 'center', padding: Spacing.six, gap: Spacing.four, width: SCREEN_W },
  audioIconWrap: { width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center' },
  audioFileName: { color: '#fff', fontSize: TextScale.base, fontWeight: '600', textAlign: 'center', paddingHorizontal: Spacing.six },
  audioProgressBg: { width: SCREEN_W * 0.8, height: 4, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: Radius.full, overflow: 'hidden' },
  audioProgressFill: { height: '100%', borderRadius: Radius.full },
  audioTimings: { flexDirection: 'row', justifyContent: 'space-between', width: SCREEN_W * 0.8 },
  audioTime: { color: 'rgba(255,255,255,0.6)', fontSize: TextScale.xs },
  audioPlayBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.two },

  // Metadata card (other files)
  metaCard: { alignItems: 'center', padding: Spacing.six, gap: Spacing.four, width: SCREEN_W * 0.9 },
  metaIconWrap: { width: 96, height: 96, borderRadius: Radius.xxl, alignItems: 'center', justifyContent: 'center' },
  metaFileName: { fontSize: TextScale.base, fontWeight: '700', textAlign: 'center', color: '#fff' },
  metaTable: { width: '100%', borderRadius: Radius.lg, borderWidth: 1, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.07)' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.four, paddingVertical: Spacing.three },
  metaLabel: { fontSize: TextScale.sm, color: 'rgba(255,255,255,0.5)' },
  metaValue: { fontSize: TextScale.sm, fontWeight: '600', color: '#fff' },
  metaNote: { fontSize: TextScale.xs, textAlign: 'center', color: 'rgba(255,255,255,0.45)', lineHeight: 18 },
});
