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
  Modal,
  ScrollView,
  Dimensions,
  Pressable,
  PanResponder,
  Animated,
  Easing,
} from 'react-native';
import ReAnimated from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useEvent } from 'expo';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useCollapsibleHeader } from '@/hooks/useCollapsibleHeader';
import {
  listServerFiles,
  downloadFile,
  listSharedSources,
  listSharedFiles,
  downloadSharedFile,
  getConfig,
  buildPreviewUrl,
  buildVideoPreviewUrl,
  warmVideoPreviews,
} from '../../downloader';
import { checkDeviceConnection } from '../../uploader';
import { getServerIp } from '../../settings';
import { prunePreviewCache } from '@/utils/previewCacheManager';
import { sanitizeErrorMessage } from '@/utils/errorUtils';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const getCurrentTimestamp = (): number => Date.now();

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

type ServerConfig = { ip: string; port: string; key: string; deviceId: string } | null;

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

type PreviewModalProps = {
  file: RemoteFile | null;
  fileList: RemoteFile[];      // ordered flat list of all previewable files
  currentIndex: number;        // index of `file` in fileList
  sourceMode: SourceMode;
  selectedSourceId: string | null;
  serverConfig: ServerConfig;
  onClose: () => void;
  onNavigate: (index: number) => void;  // called when user navigates
  onDownload: (file: RemoteFile) => void;
  colors: AppColors;
};

type TransitionState = {
  toIndex: number;
};

const PreviewModal = React.memo(function PreviewModal({
  file, fileList, currentIndex, sourceMode, selectedSourceId, serverConfig,
  onClose, onNavigate, onDownload, colors,
}: PreviewModalProps) {
  const insets = useSafeAreaInsets();

  // Keep a local override only while this modal is driving navigation.
  const [internalActiveIdx, setInternalActiveIdx] = useState<number | null>(null);
  const activeIdx = internalActiveIdx ?? currentIndex;

  const currentFile = fileList[activeIdx] ?? file;
  const category = currentFile ? getFileCategory(currentFile.path) : 'other';
  const fileName = currentFile ? (currentFile.path.split(/[/\\]/).pop() ?? currentFile.path) : '';

  // Synchronous preview URL generator
  const getUrlForFile = useCallback((f: RemoteFile | null): string => {
    if (!f || !serverConfig) return '';
    return buildPreviewUrl(serverConfig, f.path, sourceMode, selectedSourceId);
  }, [serverConfig, sourceMode, selectedSourceId]);

  const getVideoPreviewUrlForFile = useCallback((f: RemoteFile | null): string => {
    if (!f || !serverConfig) return '';
    return buildVideoPreviewUrl(serverConfig, f.path, sourceMode, selectedSourceId);
  }, [serverConfig, sourceMode, selectedSourceId]);

  const previewUrl = useMemo(() => getUrlForFile(currentFile), [getUrlForFile, currentFile]);
  const prevFile = fileList[activeIdx - 1] ?? null;
  const nextFile = fileList[activeIdx + 1] ?? null;
  const prevVideoPreviewUrl = useMemo(() => getVideoPreviewUrlForFile(prevFile), [getVideoPreviewUrlForFile, prevFile]);
  const nextVideoPreviewUrl = useMemo(() => getVideoPreviewUrlForFile(nextFile), [getVideoPreviewUrlForFile, nextFile]);

  // Loading state for images
  const [imgLoading, setImgLoading] = useState(category === 'image');
  const [transition, setTransition] = useState<TransitionState | null>(null);

  // Session-level de-dupe so we don't repeatedly warm the same video.
  const warmedPreviewPathsRef = useRef<Set<string>>(new Set());

  // Warm current/adjacent videos when the user navigates via swipe.
  useEffect(() => {
    if (sourceMode === 'shared' && !selectedSourceId) return;

    const candidates = [
      fileList[activeIdx],
      fileList[activeIdx - 1],
      fileList[activeIdx + 1],
    ].filter(Boolean) as RemoteFile[];

    const newlyWarm = candidates
      .filter(f => getFileCategory(f.path) === 'video')
      .filter(f => !warmedPreviewPathsRef.current.has(f.path))
      .slice(0, 3);

    if (newlyWarm.length === 0) return;

    newlyWarm.forEach(f => warmedPreviewPathsRef.current.add(f.path));
    void warmVideoPreviews(
      newlyWarm.map(f => f.path),
      sourceMode,
      sourceMode === 'shared' ? selectedSourceId : null,
    ).catch(() => undefined);
  }, [activeIdx, fileList, sourceMode, selectedSourceId]);

  // ── Swipe navigation animation ──────────────────────────────────────────────
  const [slideAnim] = useState(() => new Animated.Value(0));
  const [incomingSlideAnim] = useState(() => new Animated.Value(0));
  const [isAnimating, setIsAnimating] = useState(false);

  // Automatically prune disk cache to last 10 preview items
  useEffect(() => {
    prunePreviewCache(10);
  }, [activeIdx]);

  // Prefetch adjacent image files to make preview swiping instantaneous
  useEffect(() => {
    const nextFile = fileList[activeIdx + 1];
    const prevFile = fileList[activeIdx - 1];
    [nextFile, prevFile].forEach(f => {
      if (f && (getFileCategory(f.path) === 'image')) {
        const url = getUrlForFile(f);
        if (url) {
          Image.prefetch(url);
        }
      }
    });
  }, [activeIdx, fileList, getUrlForFile]);

  const hasPrev = activeIdx > 0;
  const hasNext = activeIdx < fileList.length - 1;
  const canZoom = category === 'image' || category === 'video';

  // Zoom parameters
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 5;
  const DOUBLE_TAP_ZOOM = 2.5;

  const [scaleAnim] = useState(() => new Animated.Value(1));
  const [translateXAnim] = useState(() => new Animated.Value(0));
  const [translateYAnim] = useState(() => new Animated.Value(0));

  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null);
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaleDisplayRafRef = useRef<number | null>(null);

  const [currentScaleDisplay, setCurrentScaleDisplay] = useState(1);

  useEffect(() => {
    return () => {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      if (scaleDisplayRafRef.current != null) {
        cancelAnimationFrame(scaleDisplayRafRef.current);
        scaleDisplayRafRef.current = null;
      }
    };
  }, []);

  const scheduleScaleDisplay = useCallback((nextScale: number) => {
    if (scaleDisplayRafRef.current != null) return;
    scaleDisplayRafRef.current = requestAnimationFrame(() => {
      scaleDisplayRafRef.current = null;
      setCurrentScaleDisplay(nextScale);
    });
  }, []);

  const resetZoom = useCallback((animated: boolean) => {
    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
    setCurrentScaleDisplay(1);
    if (animated) {
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 0 }),
        Animated.spring(translateXAnim, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 0 }),
        Animated.spring(translateYAnim, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 0 }),
      ]).start();
    } else {
      scaleAnim.setValue(1);
      translateXAnim.setValue(0);
      translateYAnim.setValue(0);
    }
  }, [scaleAnim, translateXAnim, translateYAnim]);

  // Fullscreen mode state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chromeAnim] = useState(() => new Animated.Value(0));

  // Reset zoom and fullscreen when file changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsFullscreen(false);
    scaleAnim.setValue(1);
    translateXAnim.setValue(0);
    translateYAnim.setValue(0);
    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
  }, [currentFile?.path, scaleAnim, translateXAnim, translateYAnim]);

  const setZoomTo = useCallback((targetScale: number) => {
    const nextScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetScale));
    scaleRef.current = nextScale;
    setCurrentScaleDisplay(nextScale);
    if (nextScale === 1) {
      translateRef.current = { x: 0, y: 0 };
    }
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: nextScale, useNativeDriver: true, speed: 22, bounciness: 0 }),
      Animated.spring(translateXAnim, { toValue: translateRef.current.x, useNativeDriver: true, speed: 22, bounciness: 0 }),
      Animated.spring(translateYAnim, { toValue: translateRef.current.y, useNativeDriver: true, speed: 22, bounciness: 0 }),
    ]).start();
  }, [scaleAnim, translateXAnim, translateYAnim]);

  const zoomIn = useCallback(() => {
    setZoomTo(scaleRef.current + 0.5);
  }, [setZoomTo]);

  const zoomOut = useCallback(() => {
    setZoomTo(scaleRef.current - 0.5);
  }, [setZoomTo]);

  // Smooth slide navigation helper
  const animateToFile = useCallback((targetIndex: number, startDx?: number) => {
    if (isAnimating || targetIndex < 0 || targetIndex >= fileList.length || targetIndex === activeIdx) return;
    setIsAnimating(true);

    const isNext = targetIndex > activeIdx;
    const direction: 1 | -1 = isNext ? 1 : -1;
    const slideOutVal = direction === 1 ? -SCREEN_W : SCREEN_W;
    const slideInStartVal = direction === 1 ? SCREEN_W : -SCREEN_W;

    const fromVal = startDx !== undefined ? startDx : 0;
    slideAnim.setValue(fromVal);
    incomingSlideAnim.setValue(slideInStartVal + fromVal);
    setTransition({ toIndex: targetIndex });

    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: slideOutVal,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(incomingSlideAnim, {
        toValue: 0,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      setInternalActiveIdx(targetIndex);
      onNavigate(targetIndex);
      setTransition(null);
      setIsAnimating(false);
      slideAnim.setValue(0);
      incomingSlideAnim.setValue(0);
      scaleAnim.setValue(1);
      translateXAnim.setValue(0);
      translateYAnim.setValue(0);
      scaleRef.current = 1;
      translateRef.current = { x: 0, y: 0 };
    });
  }, [isAnimating, fileList.length, activeIdx, slideAnim, incomingSlideAnim, onNavigate, scaleAnim, translateXAnim, translateYAnim]);

  // ── Fullscreen mode (tap content to hide/show chrome) ──────────────────────
  useEffect(() => {
    Animated.timing(chromeAnim, {
      toValue: isFullscreen ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [isFullscreen, chromeAnim]);

  const latestRef = useRef({ activeIdx, category, fileListLen: fileList.length, animateToFile, hasNext, hasPrev, canZoom, resetZoom, setZoomTo, slideAnim, scaleAnim, translateXAnim, translateYAnim, isAnimating });
  useEffect(() => {
    latestRef.current = { activeIdx, category, fileListLen: fileList.length, animateToFile, hasNext, hasPrev, canZoom, resetZoom, setZoomTo, slideAnim, scaleAnim, translateXAnim, translateYAnim, isAnimating };
  }, [activeIdx, category, fileList.length, animateToFile, hasNext, hasPrev, canZoom, resetZoom, setZoomTo, slideAnim, scaleAnim, translateXAnim, translateYAnim, isAnimating]);

  const getTouchDistance = (touches: { pageX: number; pageY: number }[]) => {
    const [a, b] = touches;
    return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
  };

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  // ── Memoized PanResponder ──────────────────
  const panResponder = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: (evt) => {
        const cur = latestRef.current;
        if (cur.category === 'video' && scaleRef.current <= 1.02) {
          return false;
        }
        return true;
      },
      onMoveShouldSetPanResponder: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        if (cur.canZoom && touches.length === 2) return true;
        if (cur.canZoom && scaleRef.current > 1.02) return true;
        return Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.2;
      },
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        if (cur.canZoom && touches.length === 2) {
          pinchStartRef.current = { distance: getTouchDistance(touches), scale: scaleRef.current };
        } else {
          panStartRef.current = { ...translateRef.current };
          if (scaleRef.current <= 1.02) {
            cur.slideAnim.setValue(0);
          }
        }
      },
      onPanResponderMove: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        if (cur.canZoom && touches.length === 2 && pinchStartRef.current) {
          const dist = getTouchDistance(touches);
          // Elastic pinch scaling (0.8x to 5.5x during active pinch gesture)
          const rawScale = pinchStartRef.current.scale * (dist / pinchStartRef.current.distance);
          const newScale = clamp(rawScale, 0.8, 5.5);
          scaleRef.current = newScale;
          scheduleScaleDisplay(newScale);
          cur.scaleAnim.setValue(newScale);
        } else if (cur.canZoom && scaleRef.current > 1.02) {
          const maxX = (SCREEN_W * (scaleRef.current - 1)) / 2;
          const maxY = (SCREEN_H * (scaleRef.current - 1)) / 2;
          const nx = clamp(panStartRef.current.x + gs.dx, -maxX, maxX);
          const ny = clamp(panStartRef.current.y + gs.dy, -maxY, maxY);
          translateRef.current = { x: nx, y: ny };
          cur.translateXAnim.setValue(nx);
          cur.translateYAnim.setValue(ny);
        } else {
          if (!cur.isAnimating) {
            cur.slideAnim.setValue(gs.dx);
          }
        }
      },
      onPanResponderRelease: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        if (cur.canZoom && (pinchStartRef.current || scaleRef.current > 1.02)) {
          pinchStartRef.current = null;
          if (touches.length === 0) {
            if (scaleRef.current < 1.05) {
              cur.resetZoom(true);
            } else if (scaleRef.current > ZOOM_MAX) {
              cur.setZoomTo(ZOOM_MAX);
            } else {
              panStartRef.current = { ...translateRef.current };
            }
          }
          return;
        }

        // Tap handling (single vs double tap) using reliable timestamp helper
        if (Math.abs(gs.dx) < 8 && Math.abs(gs.dy) < 8) {
          const now = getCurrentTimestamp();
          if (now - lastTapRef.current < 280) {
            if (tapTimerRef.current) {
              clearTimeout(tapTimerRef.current);
              tapTimerRef.current = null;
            }
            lastTapRef.current = 0;
            if (cur.canZoom) {
              cur.setZoomTo(scaleRef.current > 1.02 ? 1 : DOUBLE_TAP_ZOOM);
            }
          } else {
            lastTapRef.current = now;
            tapTimerRef.current = setTimeout(() => {
              setIsFullscreen(f => !f);
              lastTapRef.current = 0;
            }, 260);
          }
          return;
        }

        // Swipe navigation release
        const flung = Math.abs(gs.vx) > 0.4;
        if ((gs.dx < -50 || (flung && gs.vx < 0)) && cur.hasNext) {
          cur.animateToFile(cur.activeIdx + 1, gs.dx);
        } else if ((gs.dx > 50 || (flung && gs.vx > 0)) && cur.hasPrev) {
          cur.animateToFile(cur.activeIdx - 1, gs.dx);
        } else {
          Animated.spring(cur.slideAnim, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 4 }).start();
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!currentFile) return null;

  const uploadedDate = formatDate(currentFile.uploaded_time ?? currentFile.modified_time);

  const renderContentForFile = (targetFile: RemoteFile | null, targetUrl: string, keyPrefix: string) => {
    if (!targetFile) return null;

    const targetCategory = getFileCategory(targetFile.path);
    const targetFileName = targetFile.path.split(/[/\\]/).pop() ?? targetFile.path;
    const targetCat = categoryMeta(targetCategory);
    const targetUploadedDate = formatDate(targetFile.uploaded_time ?? targetFile.modified_time);
    const targetModDate = formatDate(targetFile.modified_time);

    if (!targetUrl) {
      return (
        <View key={`${keyPrefix}-loading`} style={pvStyles.centeredBox}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[pvStyles.loadingText, { color: colors.textSecondary }]}>Loading server preview…</Text>
        </View>
      );
    }

    if (targetCategory === 'image') {
      return (
        <Animated.View
          key={`${keyPrefix}-image`}
          style={[
            pvStyles.zoomWrap,
            { transform: [{ scale: scaleAnim }, { translateX: translateXAnim }, { translateY: translateYAnim }] },
          ]}
        >
          <Image
            source={{ uri: targetUrl }}
            style={pvStyles.imageFull}
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={150}
            onLoadStart={() => setImgLoading(true)}
            onLoad={() => setImgLoading(false)}
            onError={() => setImgLoading(false)}
          />
          {imgLoading && (
            <View style={pvStyles.imgLoadingOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#fff" />
            </View>
          )}
        </Animated.View>
      );
    }

    if (targetCategory === 'video') {
      return (
        <Animated.View
          key={`${keyPrefix}-video`}
          style={[
            pvStyles.zoomWrap,
            { transform: [{ scale: scaleAnim }, { translateX: translateXAnim }, { translateY: translateYAnim }] },
          ]}
        >
          <VideoPreviewPlayer
            previewUri={getVideoPreviewUrlForFile(targetFile)}
            originalUri={targetUrl}
            fileSize={targetFile.size}
            isActive={!transition}
          />
        </Animated.View>
      );
    }

    if (targetCategory === 'audio') {
      return (
        <AudioPlayer uri={targetUrl} colors={colors} fileName={targetFileName} />
      );
    }

    // Other — Metadata card
    return (
      <View key={`${keyPrefix}-meta`} style={pvStyles.metaCard}>
        <View style={[pvStyles.metaIconWrap, { backgroundColor: colors.primarySoft }]}>
          <AppIcon androidName={targetCat.icon} iosName={targetCat.iosIcon} color={colors.primary} size={48} />
        </View>
        <Text style={[pvStyles.metaFileName, { color: colors.text }]}>{targetFileName}</Text>
        <View style={[pvStyles.metaTable, { borderColor: colors.surfaceBorder }]}>
          <MetaRow label="Size" value={formatSize(targetFile.size)} colors={colors} />
          <MetaRow label="Uploaded" value={targetUploadedDate} colors={colors} />
          <MetaRow label="Modified" value={targetModDate} colors={colors} />
          <MetaRow label="Type" value={getExt(targetFileName).toUpperCase() || '—'} colors={colors} last />
        </View>
        <Text style={[pvStyles.metaNote, { color: colors.textMuted }]}>
          This file type cannot be previewed. Download it to open on your device.
        </Text>
      </View>
    );
  };

  const transitionTargetFile = transition ? fileList[transition.toIndex] ?? null : null;
  const transitionTargetUrl = transitionTargetFile ? getUrlForFile(transitionTargetFile) : '';

  const chromeOpacity = chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const topBarTranslate = chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -70] });
  const bottomBarTranslate = chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 70] });

  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <View style={[pvStyles.root, { backgroundColor: '#000' }]}>
        <StatusBar barStyle="light-content" backgroundColor="#000" hidden={isFullscreen} />

        {/* Floating Zoom level indicator / reset pill */}
        {canZoom && currentScaleDisplay > 1.02 && (
          <TouchableOpacity
            style={pvStyles.zoomPill}
            onPress={() => resetZoom(true)}
            activeOpacity={0.8}
          >
            <Text style={pvStyles.zoomPillText}>Zoom {currentScaleDisplay.toFixed(1)}x · Tap to Reset</Text>
          </TouchableOpacity>
        )}

        {/* Main Content Area with gestures */}
        <View style={pvStyles.contentArea} {...panResponder.panHandlers}>
          {transition ? (
            <>
              <Animated.View
                style={[pvStyles.transitionLayer, { transform: [{ translateX: slideAnim }] }]}
                pointerEvents="none"
              >
                {renderContentForFile(currentFile, previewUrl, 'current')}
              </Animated.View>
              <Animated.View
                style={[pvStyles.transitionLayer, { transform: [{ translateX: incomingSlideAnim }] }]}
                pointerEvents="none"
              >
                {renderContentForFile(transitionTargetFile, transitionTargetUrl, 'incoming')}
              </Animated.View>
            </>
          ) : (
            <Animated.View style={{ transform: [{ translateX: slideAnim }] }}>
              {renderContentForFile(currentFile, previewUrl, 'active')}
            </Animated.View>
          )}
        </View>

        <VideoPreviewPreloader uri={prevFile && getFileCategory(prevFile.path) === 'video' ? prevVideoPreviewUrl : ''} />
        <VideoPreviewPreloader uri={nextFile && getFileCategory(nextFile.path) === 'video' ? nextVideoPreviewUrl : ''} />

        {/* Top Header Bar */}
        <Animated.View
          style={[
            pvStyles.topBar,
            { paddingTop: insets.top + Spacing.two, backgroundColor: 'rgba(0,0,0,0.85)' },
            { opacity: chromeOpacity, transform: [{ translateY: topBarTranslate }] },
          ]}
          pointerEvents={isFullscreen ? 'none' : 'auto'}
        >
          <TouchableOpacity onPress={onClose} style={pvStyles.topBarBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <AppIcon androidName="close" iosName="xmark" color="#fff" size={22} />
          </TouchableOpacity>
          <View style={pvStyles.topBarCenter}>
            <Text style={pvStyles.topBarTitle} numberOfLines={1}>{fileName}</Text>
            {fileList.length > 1 && (
              <Text style={pvStyles.topBarCounter}>
                {activeIdx + 1} / {fileList.length}
              </Text>
            )}
          </View>
          <View style={pvStyles.topBarRightActions}>
            {/* Zoom Out */}
            {canZoom && (
              <TouchableOpacity onPress={zoomOut} style={pvStyles.topBarBtn}>
                <AppIcon androidName="zoom_out" iosName="minus.magnifyingglass" color="#fff" size={18} />
              </TouchableOpacity>
            )}
            {/* Zoom In */}
            {canZoom && (
              <TouchableOpacity onPress={zoomIn} style={pvStyles.topBarBtn}>
                <AppIcon androidName="zoom_in" iosName="plus.magnifyingglass" color="#fff" size={18} />
              </TouchableOpacity>
            )}
            {/* Fullscreen Toggle */}
            <TouchableOpacity onPress={() => setIsFullscreen(v => !v)} style={pvStyles.topBarBtn}>
              <AppIcon
                androidName={isFullscreen ? 'fullscreen_exit' : 'fullscreen'}
                iosName={isFullscreen ? 'arrow.down.right.and.arrow.up.left' : 'arrow.up.left.and.arrow.down.right'}
                color="#fff"
                size={20}
              />
            </TouchableOpacity>
            {/* Save Button */}
            <TouchableOpacity
              onPress={() => onDownload(currentFile)}
              style={[pvStyles.topBarBtn, pvStyles.downloadBtn]}
            >
              <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={20} />
              <Text style={pvStyles.downloadBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Left / Right Nav Arrows */}
        {hasPrev && (
          <Animated.View style={[pvStyles.navArrowLeft, { opacity: chromeOpacity }]} pointerEvents={isFullscreen ? 'none' : 'auto'}>
            <TouchableOpacity
              style={pvStyles.navArrowBtnInner}
              onPress={() => animateToFile(activeIdx - 1)}
              hitSlop={{ top: 20, bottom: 20, left: 10, right: 10 }}
            >
              <AppIcon androidName="chevron_left" iosName="chevron.left" color="rgba(255,255,255,0.85)" size={28} />
            </TouchableOpacity>
          </Animated.View>
        )}
        {hasNext && (
          <Animated.View style={[pvStyles.navArrowRight, { opacity: chromeOpacity }]} pointerEvents={isFullscreen ? 'none' : 'auto'}>
            <TouchableOpacity
              style={pvStyles.navArrowBtnInner}
              onPress={() => animateToFile(activeIdx + 1)}
              hitSlop={{ top: 20, bottom: 20, left: 10, right: 10 }}
            >
              <AppIcon androidName="chevron_right" iosName="chevron.right" color="rgba(255,255,255,0.85)" size={28} />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Bottom Info Strip */}
        <Animated.View
          style={[
            pvStyles.bottomBar,
            { paddingBottom: insets.bottom + Spacing.two, backgroundColor: 'rgba(0,0,0,0.8)' },
            { opacity: chromeOpacity, transform: [{ translateY: bottomBarTranslate }] },
          ]}
          pointerEvents="none"
        >
          <Text style={pvStyles.bottomSize}>{formatSize(currentFile.size)}</Text>
          <Text style={pvStyles.bottomDot}>·</Text>
          <Text style={pvStyles.bottomDate}>{uploadedDate}</Text>
        </Animated.View>
      </View>
    </Modal>
  );
});

// ── MetaRow ──────────────────────────────────────────────────────────────────
function MetaRow({ label, value, colors, last }: { label: string; value: string; colors: AppColors; last?: boolean }) {
  return (
    <View style={[pvStyles.metaRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surfaceBorder }]}>
      <Text style={[pvStyles.metaLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[pvStyles.metaValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

// ── Video Preview Player ──────────────────────────────────────────────────────
function VideoPreviewPlayer({
  previewUri,
  originalUri,
  fileSize,
  isActive = true,
}: {
  previewUri: string;
  originalUri: string;
  fileSize: number;
  isActive?: boolean;
}) {
  const PREVIEW_TRANSCODE_MIN_BYTES = 40 * 1024 * 1024;
  const shouldUpgrade = previewUri !== originalUri && fileSize >= PREVIEW_TRANSCODE_MIN_BYTES;
  const upgradedRef = useRef(false);
  const upgradeScheduledRef = useRef(false);
  const upgradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const source = useMemo<VideoSource>(() => ({
    uri: previewUri,
    useCaching: true,
    contentType: 'progressive',
  }), [previewUri]);

  const player = useVideoPlayer(source, p => {
    p.loop = true;
    p.bufferOptions = {
      preferredForwardBufferDuration: 1.5,
      minBufferForPlayback: 0.15,
      prioritizeTimeOverSizeThreshold: true,
    };
    if (isActive) {
      p.play();
    }
  });

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const isBuffering = status !== 'readyToPlay' && status !== 'error';

  useEffect(() => {
    upgradedRef.current = false;
    upgradeScheduledRef.current = false;
    if (upgradeTimerRef.current) {
      clearTimeout(upgradeTimerRef.current);
      upgradeTimerRef.current = null;
    }
  }, [previewUri, originalUri]);

  useEffect(() => {
    if (isActive) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, player]);

  useEffect(() => {
    if (
      !shouldUpgrade ||
      upgradedRef.current ||
      upgradeScheduledRef.current ||
      status !== 'readyToPlay' ||
      !isActive
    ) {
      return;
    }

    let cancelled = false;
    upgradeScheduledRef.current = true;
    const timer = setTimeout(async () => {
      if (cancelled || upgradedRef.current) return;
      const position = player.currentTime;
      const wasPlaying = player.playing;
      try {
        await player.replaceAsync({
          uri: originalUri,
          useCaching: true,
          contentType: 'progressive',
        });
        if (cancelled) return;
        upgradedRef.current = true;
        player.currentTime = position;
        if (wasPlaying) {
          player.play();
        }
      } catch {
        // Allow another attempt later.
        upgradedRef.current = false;
        upgradeScheduledRef.current = false;
      }
    }, 1500);
    upgradeTimerRef.current = timer;

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (upgradeTimerRef.current === timer) {
        upgradeTimerRef.current = null;
      }
      if (!upgradedRef.current) {
        upgradeScheduledRef.current = false;
      }
    };
  }, [shouldUpgrade, status, isActive, originalUri, player]);

  useEffect(() => {
    return () => {
      player.pause();
    };
  }, [player]);

  return (
    <View style={pvStyles.videoContainer}>
      <VideoView
        player={player}
        style={pvStyles.videoFull}
        contentFit="contain"
        nativeControls={true}
        surfaceType="textureView"
      />
      {isBuffering && (
        <View style={pvStyles.imgLoadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={pvStyles.videoLoadingText}>Buffering video…</Text>
        </View>
      )}
    </View>
  );
}

function VideoPreviewPreloader({ uri }: { uri: string }) {
  const source = useMemo<VideoSource | null>(() => (
    uri ? { uri, useCaching: true, contentType: 'progressive' } : null
  ), [uri]);

  useVideoPlayer(source, player => {
    player.loop = true;
    player.bufferOptions = {
      preferredForwardBufferDuration: 1.5,
      minBufferForPlayback: 0.15,
      prioritizeTimeOverSizeThreshold: true,
    };
  });

  return null;
}

// ── Audio Player ─────────────────────────────────────────────────────────────
function AudioPlayer({ uri, colors, fileName }: { uri: string; colors: AppColors; fileName: string }) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);

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

      <View style={pvStyles.audioProgressBg}>
        <View style={[pvStyles.audioProgressFill, { width: `${progress * 100}%`, backgroundColor: colors.primary }]} />
      </View>
      <View style={pvStyles.audioTimings}>
        <Text style={pvStyles.audioTime}>{formatSec(positionSec)}</Text>
        <Text style={pvStyles.audioTime}>{formatSec(durationSec)}</Text>
      </View>

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
// Tree Node Renderer
// ─────────────────────────────────────────────────────────────────────────────

type TreeNodeViewProps = {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  selectionMode: boolean;
  onToggleNode: (node: TreeNode) => void;
  onToggleExpand: (nodeKey: string) => void;
  onPreview: (file: RemoteFile) => void;
  onWarmPreview: (file: RemoteFile) => void;
  onEnterSelectionMode: (node: TreeNode) => void;
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
};

const TreeNodeView = React.memo(function TreeNodeView({
  node, depth, selectedPaths, selectionMode, onToggleNode, onToggleExpand, onPreview, onWarmPreview, onEnterSelectionMode, styles, colors,
}: TreeNodeViewProps) {
  const indent = depth * 16;

  if (!node.isFolder) {
    const isSelected = selectedPaths.has(node.key);
    const category = getFileCategory(node.name);
    const catMeta = categoryMeta(category);

    // Modern interaction model (matches Google Photos / Files):
    //  - Tap always opens preview (or toggles selection if in selection mode)
    //  - Long-press always starts/toggles selection
    //  - Checkbox always toggles selection directly
    const handlePress = () => {
      if (selectionMode) {
        onToggleNode(node);
      } else {
        node.file && onPreview(node.file);
      }
    };

    const handleLongPress = () => {
      if (selectionMode) {
        onToggleNode(node);
      } else {
        onEnterSelectionMode(node);
      }
    };

    const handleCheckboxPress = () => {
      if (selectionMode) {
        onToggleNode(node);
      } else {
        onEnterSelectionMode(node);
      }
    };

    return (
      <Pressable
        style={[styles.fileRow, { paddingLeft: indent + Spacing.four }, isSelected && styles.fileRowSelected]}
        onPress={handlePress}
        onPressIn={() => {
          if (node.file) {
            onWarmPreview(node.file);
          }
        }}
        onLongPress={handleLongPress}
        delayLongPress={400}
        android_ripple={{ color: colors.primarySoft }}
      >
        {selectionMode ? (
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
        ) : (
          <View style={styles.fileIconWrap}>
            <AppIcon androidName={catMeta.icon} iosName={catMeta.iosIcon} color={colors.primary} size={18} />
          </View>
        )}

        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>{node.name}</Text>
          <View style={styles.fileMetaRow}>
            <Text style={styles.fileSize}>{formatSize(node.file!.size)}</Text>
            <Text style={styles.fileDot}>·</Text>
            <Text style={styles.fileDate}>{formatDate(node.file!.uploaded_time ?? node.file!.modified_time)}</Text>
          </View>
        </View>

        <AppIcon
          androidName={selectionMode ? (isSelected ? 'check_circle' : 'radio_button_unchecked') : 'chevron_right'}
          iosName={selectionMode ? (isSelected ? 'checkmark.circle.fill' : 'circle') : 'chevron.right'}
          color={selectionMode ? (isSelected ? colors.primary : colors.textMuted) : colors.textMuted}
          size={selectionMode ? 20 : 14}
        />
      </Pressable>
    );
  }

  // Folder row
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
              onToggleNode(node);
            } else {
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
          onToggleExpand={onToggleExpand} onPreview={onPreview} onWarmPreview={onWarmPreview}
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
// Main Restore Screen Component
// ─────────────────────────────────────────────────────────────────────────────

export default function RestoreScreen() {
  const { colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  // Source mode state
  const [sourceMode, setSourceMode] = useState<SourceMode>('phone');
  const [sharedSources, setSharedSources] = useState<SharedSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [isLoadingSources, setIsLoadingSources] = useState(false);

  // Server Config cache
  const [serverConfig, setServerConfig] = useState<ServerConfig>(null);

  const loadServerConfig = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setServerConfig(cfg);
    } catch {
      setServerConfig(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getConfig()
      .then(cfg => { if (active) setServerConfig(cfg); })
      .catch(() => { if (active) setServerConfig(null); });
    return () => { active = false; };
  }, []);

  // File list & tree state
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
  const [previewIndex, setPreviewIndex] = useState<number>(0);
  const [warmPreviewFile, setWarmPreviewFile] = useState<RemoteFile | null>(null);

  const headerHeight = insets.top + Spacing.five + 88;
  const {
    onScroll: onListScroll,
    headerAnimatedStyle,
    contentInsetStyle,
    onHeaderLayout,
    expandHeader,
  } = useCollapsibleHeader({
    headerHeight,
  });

  useEffect(() => {
    if (isDownloading) {
      expandHeader();
    }
  }, [isDownloading, expandHeader]);

  // Server connection check
  const checkServer = useCallback(async (alive?: () => boolean) => {
    const stillAlive = alive ?? (() => true);
    const ip = await getServerIp();
    if (!stillAlive()) return;
    if (!ip) { setServerStatus('unknown'); return; }
    setServerStatus('checking');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const result = await checkDeviceConnection({ signal: controller.signal });
      if (!stillAlive()) return;
      setServerStatus(result.connected ? 'connected' : 'disconnected');
      loadServerConfig();
    } catch {
      if (!stillAlive()) return;
      setServerStatus('disconnected');
    } finally {
      clearTimeout(timeout);
    }
  }, [loadServerConfig]);

  useFocusEffect(useCallback(() => {
    let alive = true;
    checkServer(() => alive);
    return () => { alive = false; };
  }, [checkServer]));

  const isOffline = serverStatus === 'disconnected' || serverStatus === 'unknown';

  // Load shared sources
  const loadSharedSources = useCallback(async () => {
    setIsLoadingSources(true);
    try {
      const sources: SharedSource[] = await listSharedSources();
      setSharedSources(sources);
      if (sources.length > 0 && !selectedSourceId) {
        setSelectedSourceId(sources[0].id);
      }
    } catch (e: any) {
      Alert.alert('Shared Folders', sanitizeErrorMessage(e, 'Server unreachable — check that the desktop server is running.'));
    } finally {
      setIsLoadingSources(false);
    }
  }, [selectedSourceId]);

  const handleModeChange = useCallback((mode: SourceMode) => {
    setSourceMode(mode);
    setFiles([]);
    setTree(null);
    setSelectedPaths(new Set());
    if (mode === 'shared') {
      loadSharedSources();
    }
  }, [loadSharedSources]);

  const handleSourceSelect = useCallback((source: SharedSource) => {
    setSelectedSourceId(source.id);
    setFiles([]);
    setTree(null);
    setSelectedPaths(new Set());
  }, []);

  // Sorted tree
  const sortedTree = useMemo(() => {
    if (!tree) return null;
    return sortTreeChildren(tree, sortField, sortDir);
  }, [tree, sortField, sortDir]);

  // Flat ordered list of previewable files
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

  // Fetch files from server
  const handleFetch = async () => {
    if (sourceMode === 'shared' && !selectedSourceId) {
      Alert.alert('No Source', 'Please select a shared folder first.');
      return;
    }
    setIsFetching(true);
    try {
      await loadServerConfig();
      let serverFiles: RemoteFile[];
      if (sourceMode === 'shared') {
        serverFiles = await listSharedFiles(selectedSourceId!);
      } else {
        serverFiles = await listServerFiles();
      }
      setFiles(serverFiles);

      // After a successful fetch, warm a few of the largest video previews in the background.
      // This reduces the first-open wait time dramatically for big files.
      const warmCandidates = serverFiles
        .filter(f => getFileCategory(f.path) === 'video')
        .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
        .slice(0, 6)
        .map(f => f.path);
      void warmVideoPreviews(
        warmCandidates,
        sourceMode,
        sourceMode === 'shared' ? selectedSourceId : null,
      ).catch(() => undefined);

      const newTree = buildTree(serverFiles);
      setTree(newTree);
      setSelectedPaths(new Set());
    } catch (error: any) {
      Alert.alert('Fetch Failed', sanitizeErrorMessage(error, 'Could not fetch files from server.'));
    } finally {
      setIsFetching(false);
    }
  };

  // Sort handler
  const handleSortChange = useCallback((field: SortField, dir: SortDir) => {
    setSortField(field);
    setSortDir(dir);
  }, []);

  // Preview handlers
  const openPreview = useCallback((file: RemoteFile, index?: number) => {
    const idx = index !== undefined ? index : previewableFiles.findIndex(f => f.path === file.path);
    setPreviewIndex(idx >= 0 ? idx : 0);
    setPreviewFile(file);
  }, [previewableFiles]);

  const handlePreview = useCallback((file: RemoteFile) => {
    setWarmPreviewFile(file);
    openPreview(file);
  }, [openPreview]);

  const handleWarmPreview = useCallback((file: RemoteFile) => {
    if (getFileCategory(file.path) === 'video') {
      setWarmPreviewFile(file);
    }
  }, []);

  const handlePreviewNavigate = useCallback((newIndex: number) => {
    if (newIndex < 0 || newIndex >= previewableFiles.length) return;
    setPreviewIndex(newIndex);
    setPreviewFile(previewableFiles[newIndex]);
  }, [previewableFiles]);

  const closePreview = useCallback(() => {
    setPreviewFile(null);
  }, []);

  // Expand / collapse folder nodes
  const handleToggleExpand = useCallback((nodeKey: string) => {
    setTree(prev => {
      if (!prev) return prev;
      const cloned = deepCloneTree(prev);
      const target = findNodeByKey(cloned, nodeKey);
      if (target) target.isExpanded = !target.isExpanded;
      return cloned;
    });
  }, []);

  // Selection mode handlers
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
      if (next.size === 0) setSelectionMode(false);
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

  // Download files
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

  const handleDownloadSingle = useCallback(async (file: RemoteFile) => {
    closePreview();
    setTimeout(() => handleDownloadFiles(new Set([file.path])), 300);
  }, [closePreview, handleDownloadFiles]);

  const handleDownload = useCallback(
    () => handleDownloadFiles(selectedPaths),
    [handleDownloadFiles, selectedPaths],
  );

  const rootChildren = sortedTree?.children ?? [];
  const warmPreviewUrl = useMemo(() => {
    if (!warmPreviewFile || !serverConfig || getFileCategory(warmPreviewFile.path) !== 'video') {
      return '';
    }
    return buildVideoPreviewUrl(serverConfig, warmPreviewFile.path, sourceMode, selectedSourceId);
  }, [warmPreviewFile, serverConfig, sourceMode, selectedSourceId]);

  const fetchDisabled = isFetching || isDownloading || isOffline ||
    (sourceMode === 'shared' && !selectedSourceId);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

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

      {/* Page Header — absolute+collapsible when browsing; in-flow under banner while downloading */}
      <ReAnimated.View
        onLayout={isDownloading ? undefined : onHeaderLayout}
        style={[
          styles.pageHeader,
          {
            paddingTop: isDownloading ? Spacing.four : insets.top + Spacing.five,
            backgroundColor: colors.bg,
          },
          !isDownloading && headerAnimatedStyle,
        ]}
      >
        <View>
          <Text style={styles.pageTitle}>Restore Files</Text>
          <Text style={styles.pageSubtitle}>
            {files.length > 0 ? `${files.length} files on server` : 'Download files from server'}
          </Text>
        </View>
        <View style={styles.headerButtons}>
          <AnimatedPressable
            onPress={handleFetch}
            style={[styles.actionBtn, fetchDisabled && styles.disabledBtn]}
            disabled={fetchDisabled}
            scaleDown={0.92}
          >
            {isFetching ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <>
                <AppIcon androidName="sync" iosName="arrow.triangle.2.circlepath" color={colors.primary} size={16} />
                <Text style={[styles.actionBtnText, { color: colors.primary }]}>Fetch</Text>
              </>
            )}
          </AnimatedPressable>
          {files.length > 0 && (
            <AnimatedPressable onPress={selectAll} style={[styles.actionBtn, isOffline && styles.disabledBtn]} disabled={isDownloading || isOffline} scaleDown={0.92}>
              <AppIcon androidName="select_all" iosName="checkmark.circle" color={colors.primary} size={16} />
              <Text style={[styles.actionBtnText, { color: colors.primary }]}>
                {selectedPaths.size === files.length ? 'Deselect All' : 'Select All'}
              </Text>
            </AnimatedPressable>
          )}
        </View>
      </ReAnimated.View>

      <ReAnimated.View style={isDownloading ? { flex: 1 } : contentInsetStyle}>
      {/* Source Selector */}
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

      {/* Sort Bar */}
      {files.length > 0 && !isDownloading && (
        <SortBar field={sortField} dir={sortDir} onChange={handleSortChange} colors={colors} />
      )}

      {/* Hint Bar */}
      {files.length > 0 && selectedPaths.size === 0 && !selectionMode && (
        <View style={[styles.hintBar, { borderColor: colors.surfaceBorder }]}>
          <AppIcon androidName="touch_app" iosName="hand.tap" color={colors.textMuted} size={13} />
          <Text style={[styles.hintText, { color: colors.textMuted }]}>
            Tap to preview · long press to select
          </Text>
        </View>
      )}

      {/* Selection Info Bar */}
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

      {/* File Tree List */}
      <FlatList
        style={{ flex: 1 }}
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
            onWarmPreview={handleWarmPreview}
            styles={styles} colors={colors}
          />
        )}
        contentContainerStyle={[styles.listContent, { paddingBottom: BottomTabInset + Spacing.eight }]}
        showsVerticalScrollIndicator={false}
        onScroll={onListScroll}
        scrollEventThrottle={16}
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
      </ReAnimated.View>

      {/* Download FAB */}
      {selectedPaths.size > 0 && !isDownloading && (
        <AnimatedPressable
          style={[styles.fab, { bottom: BottomTabInset + Spacing.four }, isOffline && styles.disabledBtn]}
          onPress={handleDownload}
          disabled={isOffline}
          scaleDown={0.94}
        >
          <AppIcon androidName="download" iosName="arrow.down.circle" color={colors.white} size={22} />
          <Text style={styles.fabText}>Download {selectedPaths.size} {selectedPaths.size === 1 ? 'File' : 'Files'}</Text>
        </AnimatedPressable>
      )}

      {/* Preview Modal */}
      <VideoPreviewPreloader uri={warmPreviewUrl} />
      {previewFile && (
        <PreviewModal
          file={previewFile}
          fileList={previewableFiles}
          currentIndex={previewIndex}
          sourceMode={sourceMode}
          selectedSourceId={selectedSourceId}
          serverConfig={serverConfig}
          onClose={closePreview}
          onNavigate={handlePreviewNavigate}
          onDownload={handleDownloadSingle}
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

    hintBar: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingHorizontal: Spacing.five, paddingVertical: 5,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    hintText: { fontSize: TextScale.xs },

    selectionBar: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: Spacing.five, paddingVertical: Spacing.two,
      borderBottomWidth: 1, gap: Spacing.two,
    },
    selectionBarText: { fontSize: TextScale.sm, fontWeight: '600', flex: 1 },
    clearSelBtn: { paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
    clearSelText: { fontSize: TextScale.sm, fontWeight: '500' },

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

    fileRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingRight: Spacing.three, paddingVertical: Spacing.two + 2, gap: Spacing.two,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.surfaceBorder,
      borderRadius: Radius.sm,
    },
    fileRowSelected: {
      backgroundColor: colors.primarySoft,
    },
    fileIconWrap: {
      width: 32, height: 32, borderRadius: Radius.md,
      backgroundColor: colors.surfaceSoft,
      alignItems: 'center', justifyContent: 'center',
    },
    fileInfo: { flex: 1 },
    fileName: { fontSize: TextScale.sm, color: colors.text, fontWeight: '500' },
    fileMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    fileSize: { fontSize: TextScale.xs, color: colors.textMuted },
    fileDot: { fontSize: TextScale.xs, color: colors.textMuted },
    fileDate: { fontSize: TextScale.xs, color: colors.textMuted },

    checkbox: {
      width: 20, height: 20, borderRadius: 5, borderWidth: 2,
      borderColor: colors.textSecondary, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    checkboxSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
    checkboxPartial: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
    partialDot: { width: 8, height: 8, borderRadius: 2, backgroundColor: colors.primary },

    fab: {
      position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center',
      backgroundColor: colors.primary, paddingVertical: Spacing.three, paddingHorizontal: Spacing.six,
      borderRadius: Radius.full, gap: Spacing.two, ...Shadows.soft,
    },
    fabText: { color: colors.white, fontWeight: '700', fontSize: TextScale.md },
    disabledBtn: { opacity: 0.4 },

    emptyContainer: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: Spacing.seven, paddingTop: Spacing.nine, gap: Spacing.four,
    },
    emptyIconWrap: { width: 88, height: 88, borderRadius: Radius.xxl, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: { fontSize: TextScale.md, fontWeight: '800', color: colors.text, textAlign: 'center' },
    emptySubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, fontWeight: '500' },

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
// Preview Modal Styles
// ─────────────────────────────────────────────────────────────────────────────

const pvStyles = StyleSheet.create({
  root: { flex: 1, position: 'relative' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
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
  topBarRightActions: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.one,
  },
  topBarBtn: {
    padding: Spacing.two, borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  downloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: Spacing.three },
  downloadBtnText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '600' },

  zoomPill: {
    position: 'absolute', top: 90, alignSelf: 'center', zIndex: 15,
    backgroundColor: 'rgba(0,0,0,0.75)', paddingHorizontal: Spacing.four, paddingVertical: Spacing.two,
    borderRadius: Radius.full, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  zoomPillText: { color: '#fff', fontSize: TextScale.xs, fontWeight: '600' },

  contentArea: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center',
  },
  transitionLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomWrap: { justifyContent: 'center', alignItems: 'center' },
  imgLoadingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center',
    gap: Spacing.three,
  },

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
  navArrowBtnInner: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },

  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
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

  imageFull: { width: SCREEN_W, height: SCREEN_H },

  videoContainer: { width: SCREEN_W, height: SCREEN_H },
  videoFull: { width: '100%', height: '100%' },
  videoLoadingText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '600' },

  audioPlayer: { alignItems: 'center', padding: Spacing.six, gap: Spacing.four, width: SCREEN_W },
  audioIconWrap: { width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center' },
  audioFileName: { color: '#fff', fontSize: TextScale.base, fontWeight: '600', textAlign: 'center', paddingHorizontal: Spacing.six },
  audioProgressBg: { width: SCREEN_W * 0.8, height: 4, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: Radius.full, overflow: 'hidden' },
  audioProgressFill: { height: '100%', borderRadius: Radius.full },
  audioTimings: { flexDirection: 'row', justifyContent: 'space-between', width: SCREEN_W * 0.8 },
  audioTime: { color: 'rgba(255,255,255,0.6)', fontSize: TextScale.xs },
  audioPlayBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.two },

  metaCard: { alignItems: 'center', padding: Spacing.six, gap: Spacing.four, width: SCREEN_W * 0.9 },
  metaIconWrap: { width: 96, height: 96, borderRadius: Radius.xxl, alignItems: 'center', justifyContent: 'center' },
  metaFileName: { fontSize: TextScale.base, fontWeight: '700', textAlign: 'center', color: '#fff' },
  metaTable: { width: '100%', borderRadius: Radius.lg, borderWidth: 1, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.07)' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.four, paddingVertical: Spacing.three },
  metaLabel: { fontSize: TextScale.sm, color: 'rgba(255,255,255,0.5)' },
  metaValue: { fontSize: TextScale.sm, fontWeight: '600', color: '#fff' },
  metaNote: { fontSize: TextScale.xs, textAlign: 'center', color: 'rgba(255,255,255,0.45)', lineHeight: 18 },
});
