import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  FlatList,
  Alert,
  RefreshControl,
  Modal,
  TextInput,
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { AnimatedListItem } from '@/components/AnimatedListItem';
import { useAppTheme } from '@/hooks/use-app-theme';
import { hapticLight, hapticMedium, hapticSuccess, hapticError, hapticSelection } from '@/utils/haptics';
import {
  computeCleanupCandidates,
  getCleanupCandidateFiles,
  invalidateCleanupCache,
  reportDeletedFiles,
  markAsCleanedLocally,
  formatFreeUpBytes,
  getFileCategory,
} from '../../freeUpStorage';

// ─── Video preview module ─────────────────────────────────────────────────────

type ExpoVideoModule = typeof import('expo-video');
let expoVideoModule: ExpoVideoModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  expoVideoModule = null;
}

// ─── Types & Helpers ──────────────────────────────────────────────────────────

type CandidateFile = {
  uri: string;
  relativePath: string;
  name: string;
  modifiedTime: number;
  size: number;
  file_id?: number | null;
};

type FilterTab = 'all' | 'image' | 'video' | 'large' | 'older';
type SortOption = 'largest' | 'newest' | 'oldest' | 'smallest';

const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50 MB
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

function formatDate(ts: number): string {
  if (!ts) return '';
  const ms = ts > 1e11 ? ts : ts * 1000;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getDisplayName(file: CandidateFile): string {
  return file.name || file.relativePath.split('/').pop() || file.relativePath;
}

function getFolderLabel(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts[0] : 'Device';
}

function fileKey(file: CandidateFile): string {
  return file.uri || `${file.relativePath}|${file.modifiedTime || 0}|${file.size || 0}`;
}

async function copySafToCache(uri: string, name: string): Promise<string | null> {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const cacheUri = `${FileSystem.cacheDirectory}freeup_preview_${Date.now()}_${safeName}`;
  try {
    await FileSystem.StorageAccessFramework.copyAsync({ from: uri, to: cacheUri });
    return cacheUri;
  } catch {
    return null;
  }
}

// ─── Thumbnail component ──────────────────────────────────────────────────────

const FileThumbnail = React.memo(function FileThumbnail({
  file,
  colors,
  styles,
}: {
  file: CandidateFile;
  colors: AppColors;
  styles: ReturnType<typeof createStyles>;
}) {
  const category = getFileCategory(getDisplayName(file));
  if (category === 'image') {
    return (
      <Image
        source={{ uri: file.uri }}
        style={styles.thumbnail}
        contentFit="cover"
        cachePolicy="memory"
        transition={150}
      />
    );
  }
  return (
    <View style={[styles.thumbnail, styles.thumbnailPlaceholder, { backgroundColor: colors.surfaceSoft }]}>
      <AppIcon
        androidName={category === 'video' ? 'play_circle' : 'insert_drive_file'}
        iosName={category === 'video' ? 'play.circle.fill' : 'doc.fill'}
        color={category === 'video' ? colors.primary : colors.textMuted}
        size={26}
        fallback={category === 'video' ? '▶' : '📄'}
      />
    </View>
  );
});

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function FreeUpScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [files, setFiles] = useState<CandidateFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [sortOption, setSortOption] = useState<SortOption>('largest');
  const [searchQuery, setSearchQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState({ done: 0, total: 0, freedBytes: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [referenceTime, setReferenceTime] = useState(() => Date.now());
  const [statusMsg, setStatusMsg] = useState('');
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);

  // Preview state
  const [previewFile, setPreviewFile] = useState<CandidateFile | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const shouldStopRef = useRef(false);
  const scanningRef = useRef(false);
  const deletingRef = useRef(false);
  const previewUriRef = useRef<string | null>(null);

  // ─── Scan ────────────────────────────────────────────────────────────────

  const scan = useCallback(async (isRefresh = false) => {
    if (scanningRef.current || deletingRef.current) return;
    shouldStopRef.current = false;
    scanningRef.current = true;
    if (isRefresh) setRefreshing(true);
    else setScanning(true);
    setStatusMsg('Scanning backed-up files…');

    try {
      const cached = getCleanupCandidateFiles() as CandidateFile[];
      if (cached.length > 0 && !isRefresh) {
        setFiles(cached);
        setSelected(new Set(cached.map(fileKey)));
        setHasScanned(true);
        setStatusMsg('');
        return;
      }

      const result = await computeCleanupCandidates({
        onProgress: (detail: any) => {
          if (detail?.phase === 'scanning') {
            const n = (detail.files || 0) + (detail.skipped || 0);
            setStatusMsg(n ? `Scanning… ${n.toLocaleString()} files found` : 'Scanning backed-up files…');
          }
        },
        shouldStop: () => shouldStopRef.current,
      });

      if (!result) {
        setStatusMsg('Scan was interrupted.');
        return;
      }

      const resultFiles = result.files as CandidateFile[];
      setFiles(resultFiles);
      setSelected(new Set(resultFiles.map(fileKey)));
      setHasScanned(true);
      setReferenceTime(Date.now());
      setStatusMsg('');
      if (!isRefresh && resultFiles.length > 0) {
        hapticSuccess();
      }
    } catch (err: any) {
      setStatusMsg(err?.message || 'Scan failed');
    } finally {
      scanningRef.current = false;
      setScanning(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    const cached = getCleanupCandidateFiles() as CandidateFile[];
    if (cached.length > 0) {
      setFiles(cached);
      setSelected(new Set(cached.map(fileKey)));
      setHasScanned(true);
    }
    return () => {
      shouldStopRef.current = true;
      if (previewUriRef.current) {
        FileSystem.deleteAsync(previewUriRef.current, { idempotent: true }).catch(() => {});
        previewUriRef.current = null;
      }
    };
  }, []));

  const onRefresh = useCallback(() => {
    invalidateCleanupCache();
    scan(true);
  }, [scan]);

  // ─── Filter & Sort Calculations ──────────────────────────────────────────

  const countsAndSizes = useMemo(() => {
    let totalBytes = 0;
    let photoBytes = 0;
    let photoCount = 0;
    let videoBytes = 0;
    let videoCount = 0;
    let largeBytes = 0;
    let largeCount = 0;
    let olderBytes = 0;
    let olderCount = 0;

    const nowSec = referenceTime / 1000;
    const thresholdSec = nowSec - THIRTY_DAYS_SEC;

    for (const f of files) {
      const sz = f.size || 0;
      const mtimeSec = f.modifiedTime > 1e11 ? f.modifiedTime / 1000 : f.modifiedTime;
      totalBytes += sz;
      const cat = getFileCategory(getDisplayName(f));
      if (cat === 'image') {
        photoBytes += sz;
        photoCount += 1;
      } else if (cat === 'video') {
        videoBytes += sz;
        videoCount += 1;
      }

      if (sz >= LARGE_FILE_THRESHOLD) {
        largeBytes += sz;
        largeCount += 1;
      }

      if (mtimeSec > 0 && mtimeSec <= thresholdSec) {
        olderBytes += sz;
        olderCount += 1;
      }
    }

    return {
      totalCount: files.length,
      totalBytes,
      photoCount,
      photoBytes,
      videoCount,
      videoBytes,
      largeCount,
      largeBytes,
      olderCount,
      olderBytes,
    };
  }, [files, referenceTime]);

  const filteredAndSortedFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const nowSec = referenceTime / 1000;
    const thresholdSec = nowSec - THIRTY_DAYS_SEC;

    let list = files.filter((f) => {
      if (query) {
        const name = getDisplayName(f).toLowerCase();
        const path = f.relativePath.toLowerCase();
        if (!name.includes(query) && !path.includes(query)) return false;
      }

      if (activeTab === 'image') {
        return getFileCategory(getDisplayName(f)) === 'image';
      }
      if (activeTab === 'video') {
        return getFileCategory(getDisplayName(f)) === 'video';
      }
      if (activeTab === 'large') {
        return (f.size || 0) >= LARGE_FILE_THRESHOLD;
      }
      if (activeTab === 'older') {
        const mtimeSec = f.modifiedTime > 1e11 ? f.modifiedTime / 1000 : f.modifiedTime;
        return mtimeSec > 0 && mtimeSec <= thresholdSec;
      }
      return true;
    });

    list.sort((a, b) => {
      if (sortOption === 'largest') return (b.size || 0) - (a.size || 0);
      if (sortOption === 'smallest') return (a.size || 0) - (b.size || 0);
      if (sortOption === 'newest') return (b.modifiedTime || 0) - (a.modifiedTime || 0);
      if (sortOption === 'oldest') return (a.modifiedTime || 0) - (b.modifiedTime || 0);
      return 0;
    });

    return list;
  }, [files, activeTab, sortOption, searchQuery, referenceTime]);

  // ─── Selection ───────────────────────────────────────────────────────────

  const visibleKeys = useMemo(() => new Set(filteredAndSortedFiles.map(fileKey)), [filteredAndSortedFiles]);
  const visibleSelectedCount = useMemo(() => {
    let c = 0;
    for (const k of visibleKeys) {
      if (selected.has(k)) c++;
    }
    return c;
  }, [visibleKeys, selected]);

  const allVisibleSelected = filteredAndSortedFiles.length > 0 && visibleSelectedCount === filteredAndSortedFiles.length;

  const toggleSelectAllVisible = useCallback(() => {
    hapticLight();
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const k of visibleKeys) next.delete(k);
      } else {
        for (const k of visibleKeys) next.add(k);
      }
      return next;
    });
  }, [allVisibleSelected, visibleKeys]);

  const toggleFile = useCallback((file: CandidateFile) => {
    hapticSelection();
    setSelected((prev) => {
      const next = new Set(prev);
      const k = fileKey(file);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  // ─── Preview Modal ───────────────────────────────────────────────────────

  const openPreview = useCallback(async (file: CandidateFile) => {
    hapticLight();
    if (previewUriRef.current) {
      FileSystem.deleteAsync(previewUriRef.current, { idempotent: true }).catch(() => {});
      previewUriRef.current = null;
    }
    setPreviewFile(file);
    setPreviewUri(null);
    setPreviewLoading(true);

    const category = getFileCategory(getDisplayName(file));
    if (category === 'other') {
      setPreviewLoading(false);
      return;
    }

    const cacheUri = await copySafToCache(file.uri, getDisplayName(file));
    previewUriRef.current = cacheUri;
    setPreviewUri(cacheUri);
    setPreviewLoading(false);
  }, []);

  const closePreview = useCallback(() => {
    if (previewUriRef.current) {
      FileSystem.deleteAsync(previewUriRef.current, { idempotent: true }).catch(() => {});
      previewUriRef.current = null;
    }
    setPreviewFile(null);
    setPreviewUri(null);
    setPreviewLoading(false);
  }, []);

  const navigatePreview = useCallback(async (direction: -1 | 1) => {
    if (!previewFile || !filteredAndSortedFiles.length) return;
    const currentIndex = filteredAndSortedFiles.findIndex((f) => fileKey(f) === fileKey(previewFile));
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= filteredAndSortedFiles.length) return;
    await openPreview(filteredAndSortedFiles[nextIndex]);
  }, [filteredAndSortedFiles, openPreview, previewFile]);

  const handleDeleteSingleFile = useCallback((file: CandidateFile) => {
    hapticMedium();
    const name = getDisplayName(file);
    const sizeStr = formatFreeUpBytes(file.size || 0);

    Alert.alert(
      'Delete from phone?',
      `Remove "${name}" (${sizeStr}) from your device?\n\n✓ Safe to delete: Your backup copy on the server remains 100% intact.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await FileSystem.deleteAsync(file.uri, { idempotent: true });
              hapticSuccess();

              const k = fileKey(file);
              setFiles((prev) => prev.filter((f) => fileKey(f) !== k));
              setSelected((prev) => {
                const next = new Set(prev);
                next.delete(k);
                return next;
              });

              markAsCleanedLocally([file.relativePath]).catch(() => {});
              reportDeletedFiles([{
                relativePath: file.relativePath,
                size: file.size || 0,
                file_id: file.file_id ?? undefined,
              }]).catch(() => {});

              const currentIndex = filteredAndSortedFiles.findIndex((f) => fileKey(f) === k);
              const remaining = filteredAndSortedFiles.filter((f) => fileKey(f) !== k);
              if (remaining.length > 0) {
                const nextIdx = Math.min(currentIndex, remaining.length - 1);
                openPreview(remaining[nextIdx]);
              } else {
                closePreview();
              }
            } catch {
              hapticError();
              Alert.alert('Could not delete', 'The file could not be deleted. Check folder permissions.');
            }
          },
        },
      ]
    );
  }, [filteredAndSortedFiles, openPreview, closePreview]);

  // ─── Delete ──────────────────────────────────────────────────────────────

  const selectedFiles = useMemo(
    () => files.filter((f) => selected.has(fileKey(f))),
    [files, selected]
  );

  const selectedBytes = useMemo(
    () => selectedFiles.reduce((s, f) => s + (f.size || 0), 0),
    [selectedFiles]
  );

  const handleDeletePress = useCallback(() => {
    if (selectedFiles.length === 0) return;
    hapticMedium();
    setConfirmVisible(true);
  }, [selectedFiles]);

  const handleConfirmDelete = useCallback(async () => {
    setConfirmVisible(false);
    if (selectedFiles.length === 0) return;

    deletingRef.current = true;
    setDeleting(true);
    setDeleteProgress({ done: 0, total: selectedFiles.length, freedBytes: 0 });

    const succeeded: CandidateFile[] = [];
    const failed: string[] = [];
    let freedAccumulator = 0;

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        try {
          await FileSystem.deleteAsync(file.uri, { idempotent: true });
          succeeded.push(file);
          freedAccumulator += file.size || 0;
        } catch {
          failed.push(getDisplayName(file));
        }

        setDeleteProgress({
          done: i + 1,
          total: selectedFiles.length,
          freedBytes: freedAccumulator,
        });
      }

      // Update state
      if (succeeded.length > 0) {
        const deletedKeys = new Set(succeeded.map(fileKey));
        const remaining = files.filter((f) => !deletedKeys.has(fileKey(f)));
        setFiles(remaining);
        setSelected((prev) => {
          const next = new Set(prev);
          deletedKeys.forEach((k) => next.delete(k));
          return next;
        });

        // Persist cleaned paths locally
        await markAsCleanedLocally(succeeded.map((f) => f.relativePath)).catch(() => {});

        // Queue / report deletion to server
        reportDeletedFiles(
          succeeded.map((f) => ({
            relativePath: f.relativePath,
            size: f.size || 0,
            file_id: f.file_id ?? undefined,
          }))
        ).catch(() => {});
      }
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      closePreview();
    }

    if (succeeded.length === 0) {
      hapticError();
      Alert.alert(
        'Could not delete files',
        `${failed.length} file${failed.length === 1 ? '' : 's'} could not be removed. Check folder permissions.`,
        [{ text: 'OK' }]
      );
    } else if (failed.length > 0) {
      hapticMedium();
      Alert.alert(
        'Partially freed',
        `Freed ${formatFreeUpBytes(freedAccumulator)} from ${succeeded.length} file${succeeded.length === 1 ? '' : 's'}. ${failed.length} file${failed.length === 1 ? '' : 's'} could not be deleted.`,
        [{ text: 'OK' }]
      );
    } else {
      hapticSuccess();
      Alert.alert(
        'Storage freed! 🎉',
        `Successfully removed ${succeeded.length} file${succeeded.length === 1 ? '' : 's'} and reclaimed ${formatFreeUpBytes(freedAccumulator)} of phone storage. Your backups remain safe on the server.`,
        [{ text: 'Great' }]
      );
    }
  }, [closePreview, files, selectedFiles]);

  // ─── Render Item ──────────────────────────────────────────────────────────

  const renderItem = useCallback(({ item, index }: { item: CandidateFile; index: number }) => {
    const key = fileKey(item);
    const isSelected = selected.has(key);
    const name = getDisplayName(item);
    const folder = getFolderLabel(item.relativePath);
    const dateStr = formatDate(item.modifiedTime);
    const category = getFileCategory(name);

    return (
      <AnimatedListItem index={index}>
        <View style={[styles.fileRow, isSelected && styles.fileRowSelected]}>
          <TouchableOpacity
            style={styles.thumbnailTouch}
            onPress={() => openPreview(item)}
            accessibilityLabel="Preview media"
          >
            <FileThumbnail file={item} colors={colors} styles={styles} />
            {category === 'video' && (
              <View style={styles.videoBadge}>
                <AppIcon androidName="play_arrow" iosName="play.fill" color={colors.white} size={10} fallback="▶" />
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.fileMeta}
            onPress={() => toggleFile(item)}
            activeOpacity={0.7}
          >
            <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
            <View style={styles.fileDetailRow}>
              <Text style={[styles.folderBadge, { backgroundColor: colors.surfaceSoft, color: colors.textSecondary }]}>
                {folder}
              </Text>
              <Text style={styles.fileDetailDot}>·</Text>
              <Text style={[styles.fileSizeText, { color: colors.primary }]}>{formatFreeUpBytes(item.size || 0)}</Text>
              {dateStr ? (
                <>
                  <Text style={styles.fileDetailDot}>·</Text>
                  <Text style={styles.fileDateText}>{dateStr}</Text>
                </>
              ) : null}
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.checkWrap}
            onPress={() => toggleFile(item)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <View style={[styles.checkbox, isSelected && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
              {isSelected && (
                <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={13} fallback="✓" />
              )}
            </View>
          </TouchableOpacity>
        </View>
      </AnimatedListItem>
    );
  }, [selected, toggleFile, openPreview, colors, styles]);

  // ─── Header & Filter Section ──────────────────────────────────────────────

  const renderHeaderComponent = () => {
    if (!hasScanned || files.length === 0) return null;

    return (
      <View style={styles.headerSection}>
        {/* Storage Reclaim Card */}
        <Animated.View entering={FadeInDown.duration(350)} style={[styles.reclaimCard, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}>
          <View style={styles.reclaimCardTop}>
            <View style={[styles.reclaimIconWrap, { backgroundColor: colors.successSoft }]}>
              <AppIcon androidName="delete_sweep" iosName="trash.circle.fill" color={colors.success} size={24} fallback="🧹" />
            </View>
            <View style={styles.reclaimTitles}>
              <Text style={styles.reclaimBigText}>{formatFreeUpBytes(countsAndSizes.totalBytes)}</Text>
              <Text style={styles.reclaimSubText}>
                {countsAndSizes.totalCount} backed-up file{countsAndSizes.totalCount === 1 ? '' : 's'} ready to safely clean
              </Text>
            </View>
          </View>

          {/* Breakdown Pills */}
          <View style={styles.breakdownRow}>
            {countsAndSizes.photoCount > 0 && (
              <View style={[styles.breakdownPill, { backgroundColor: colors.surfaceSoft }]}>
                <AppIcon androidName="photo" iosName="photo.fill" color={colors.primary} size={14} fallback="📷" />
                <Text style={styles.breakdownPillText}>
                  {countsAndSizes.photoCount} photos · {formatFreeUpBytes(countsAndSizes.photoBytes)}
                </Text>
              </View>
            )}
            {countsAndSizes.videoCount > 0 && (
              <View style={[styles.breakdownPill, { backgroundColor: colors.surfaceSoft }]}>
                <AppIcon androidName="videocam" iosName="video.fill" color={colors.primary} size={14} fallback="🎬" />
                <Text style={styles.breakdownPillText}>
                  {countsAndSizes.videoCount} videos · {formatFreeUpBytes(countsAndSizes.videoBytes)}
                </Text>
              </View>
            )}
          </View>

          <View style={[styles.reassuranceBanner, { backgroundColor: colors.primarySoft }]}>
            <AppIcon androidName="shield" iosName="checkmark.shield.fill" color={colors.primary} size={14} fallback="🛡" />
            <Text style={[styles.reassuranceText, { color: colors.primary }]}>
              Your backup copies on the server stay 100% safe and intact.
            </Text>
          </View>
        </Animated.View>

        {/* Search Bar */}
        <View style={[styles.searchBar, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}>
          <AppIcon androidName="search" iosName="magnifyingglass" color={colors.textMuted} size={18} fallback="🔍" />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search by file or folder name…"
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon androidName="close" iosName="xmark.circle.fill" color={colors.textMuted} size={16} fallback="✕" />
            </TouchableOpacity>
          )}
        </View>

        {/* Filter Chips Scroll */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterTabsContent}>
          <TouchableOpacity
            style={[styles.filterChip, activeTab === 'all' && [styles.filterChipActive, { backgroundColor: colors.primary }]]}
            onPress={() => { hapticSelection(); setActiveTab('all'); }}
          >
            <Text style={[styles.filterChipText, activeTab === 'all' && styles.filterChipTextActive]}>
              All ({countsAndSizes.totalCount})
            </Text>
          </TouchableOpacity>

          {countsAndSizes.photoCount > 0 && (
            <TouchableOpacity
              style={[styles.filterChip, activeTab === 'image' && [styles.filterChipActive, { backgroundColor: colors.primary }]]}
              onPress={() => { hapticSelection(); setActiveTab('image'); }}
            >
              <Text style={[styles.filterChipText, activeTab === 'image' && styles.filterChipTextActive]}>
                Photos ({countsAndSizes.photoCount})
              </Text>
            </TouchableOpacity>
          )}

          {countsAndSizes.videoCount > 0 && (
            <TouchableOpacity
              style={[styles.filterChip, activeTab === 'video' && [styles.filterChipActive, { backgroundColor: colors.primary }]]}
              onPress={() => { hapticSelection(); setActiveTab('video'); }}
            >
              <Text style={[styles.filterChipText, activeTab === 'video' && styles.filterChipTextActive]}>
                Videos ({countsAndSizes.videoCount})
              </Text>
            </TouchableOpacity>
          )}

          {countsAndSizes.largeCount > 0 && (
            <TouchableOpacity
              style={[styles.filterChip, activeTab === 'large' && [styles.filterChipActive, { backgroundColor: colors.primary }]]}
              onPress={() => { hapticSelection(); setActiveTab('large'); }}
            >
              <Text style={[styles.filterChipText, activeTab === 'large' && styles.filterChipTextActive]}>
                Large &gt;50MB ({countsAndSizes.largeCount})
              </Text>
            </TouchableOpacity>
          )}

          {countsAndSizes.olderCount > 0 && (
            <TouchableOpacity
              style={[styles.filterChip, activeTab === 'older' && [styles.filterChipActive, { backgroundColor: colors.primary }]]}
              onPress={() => { hapticSelection(); setActiveTab('older'); }}
            >
              <Text style={[styles.filterChipText, activeTab === 'older' && styles.filterChipTextActive]}>
                Older &gt;30d ({countsAndSizes.olderCount})
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {/* Toolbar: Selection & Sorting */}
        <View style={styles.listToolbar}>
          <TouchableOpacity onPress={toggleSelectAllVisible} style={styles.toolbarSelectBtn}>
            <Text style={[styles.toolbarSelectText, { color: colors.primary }]}>
              {allVisibleSelected ? 'Deselect all' : `Select all (${filteredAndSortedFiles.length})`}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.sortBtn, { backgroundColor: colors.surfaceSoft }]}
            onPress={() => { hapticLight(); setSortModalVisible(true); }}
          >
            <AppIcon androidName="sort" iosName="arrow.up.arrow.down" color={colors.textSecondary} size={14} fallback="⇅" />
            <Text style={[styles.sortBtnText, { color: colors.textSecondary }]}>
              {sortOption === 'largest'
                ? 'Largest'
                : sortOption === 'smallest'
                  ? 'Smallest'
                  : sortOption === 'newest'
                    ? 'Newest'
                    : 'Oldest'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Empty state ─────────────────────────────────────────────────────────

  const renderEmpty = () => {
    if (scanning) return null;

    if (!hasScanned) {
      return (
        <View style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.primarySoft }]}>
            <AppIcon androidName="cleaning_services" iosName="sparkles" color={colors.primary} size={38} fallback="🧹" />
          </View>
          <Text style={styles.emptyTitle}>Free up phone storage</Text>
          <Text style={styles.emptyBody}>
            Scan for photos and videos that are already safely backed up on your server. You can remove them from your phone to reclaim storage without affecting your backups.
          </Text>
          <AnimatedPressable
            style={[styles.rescanBtn, { backgroundColor: colors.primary }]}
            onPress={() => { hapticMedium(); scan(false); }}
            scaleDown={0.96}
          >
            <AppIcon androidName="search" iosName="magnifyingglass" color={colors.white} size={16} fallback="⌕" />
            <Text style={[styles.rescanBtnText, { color: colors.white }]}>Scan now</Text>
          </AnimatedPressable>
        </View>
      );
    }

    if (files.length === 0) {
      return (
        <View style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.successSoft }]}>
            <AppIcon androidName="check_circle" iosName="checkmark.circle.fill" color={colors.success} size={40} fallback="✓" />
          </View>
          <Text style={styles.emptyTitle}>All clean! 🎉</Text>
          <Text style={styles.emptyBody}>
            No backed-up files are currently taking up space on your phone, or all eligible files have already been cleaned.
          </Text>
          <AnimatedPressable style={[styles.rescanBtn, { backgroundColor: colors.primarySoft }]} onPress={onRefresh} scaleDown={0.96}>
            <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={16} fallback="↺" />
            <Text style={[styles.rescanBtnText, { color: colors.primary }]}>Re-scan folders</Text>
          </AnimatedPressable>
        </View>
      );
    }

    // Filter or Search returned 0 results
    return (
      <View style={styles.emptyState}>
        <View style={[styles.emptyIcon, { backgroundColor: colors.surfaceSoft }]}>
          <AppIcon androidName="filter_alt_off" iosName="line.3.horizontal.decrease.circle" color={colors.textMuted} size={36} fallback="⊘" />
        </View>
        <Text style={styles.emptyTitle}>No matching files</Text>
        <Text style={styles.emptyBody}>
          No files match your search query &quot;{searchQuery}&quot; or the active filter.
        </Text>
        <AnimatedPressable
          style={[styles.rescanBtn, { backgroundColor: colors.surfaceSoft }]}
          onPress={() => { setSearchQuery(''); setActiveTab('all'); }}
          scaleDown={0.96}
        >
          <Text style={[styles.rescanBtnText, { color: colors.primary }]}>Clear filters</Text>
        </AnimatedPressable>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
        <AnimatedPressable onPress={() => router.back()} style={styles.backBtn} scaleDown={0.9}>
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} fallback="←" />
        </AnimatedPressable>
        <View style={styles.headerTitles}>
          <Text style={styles.headerTitle}>Free up storage</Text>
          <Text style={styles.headerSubtitle}>
            {scanning
              ? statusMsg || 'Scanning folders…'
              : hasScanned
                ? `${files.length} backed-up file${files.length === 1 ? '' : 's'} · ${formatFreeUpBytes(countsAndSizes.totalBytes)}`
                : 'Reclaim device storage'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.refreshHeaderBtn}
          onPress={() => { hapticMedium(); onRefresh(); }}
          disabled={scanning || deleting}
        >
          {scanning ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={20} fallback="↺" />
          )}
        </TouchableOpacity>
      </View>

      {/* Scanning status banner */}
      {scanning && (
        <View style={styles.scanningRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.scanningText}>{statusMsg || 'Scanning…'}</Text>
        </View>
      )}

      {/* File list */}
      <FlatList
        data={filteredAndSortedFiles}
        keyExtractor={fileKey}
        renderItem={renderItem}
        ListHeaderComponent={renderHeaderComponent}
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + 120 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
        maxToRenderPerBatch={20}
        windowSize={10}
      />

      {/* Bottom Floating CTA Bar */}
      {selectedFiles.length > 0 && !scanning && !deleting && (
        <Animated.View entering={FadeInDown.duration(200)} style={[styles.ctaBar, { paddingBottom: insets.bottom + Spacing.three }]}>
          <TouchableOpacity
            style={[styles.clearBtn, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}
            onPress={() => { hapticLight(); setSelected(new Set()); }}
            accessibilityLabel="Clear selection"
          >
            <Text style={[styles.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
          </TouchableOpacity>
          <AnimatedPressable
            style={[styles.deleteBtn, { backgroundColor: colors.error }]}
            onPress={handleDeletePress}
            scaleDown={0.98}
          >
            <AppIcon androidName="delete_sweep" iosName="trash.fill" color={colors.white} size={18} fallback="🗑" />
            <Text style={styles.deleteBtnText} numberOfLines={1}>
              Delete {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'} · Free {formatFreeUpBytes(selectedBytes)}
            </Text>
          </AnimatedPressable>
        </Animated.View>
      )}

      {/* Deleting in Progress Overlay */}
      {deleting && (
        <View style={styles.deletingOverlay}>
          <View style={[styles.deletingCard, { backgroundColor: colors.surface }]}>
            <ActivityIndicator size="large" color={colors.error} />
            <Text style={styles.deletingCardTitle}>Freeing storage…</Text>
            <Text style={styles.deletingCardSubtitle}>
              {deleteProgress.done} of {deleteProgress.total} files deleted
            </Text>
            {/* Progress Bar */}
            <View style={[styles.progressBarTrack, { backgroundColor: colors.surfaceSoft }]}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    backgroundColor: colors.error,
                    width: `${Math.min(100, Math.round((deleteProgress.done / (deleteProgress.total || 1)) * 100))}%`,
                  },
                ]}
              />
            </View>
            <Text style={[styles.deletingFreedText, { color: colors.success }]}>
              {formatFreeUpBytes(deleteProgress.freedBytes)} reclaimed so far
            </Text>
          </View>
        </View>
      )}

      {/* Confirmation Dialog Modal */}
      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
            <View style={[styles.modalIconWrap, { backgroundColor: colors.errorSoft }]}>
              <AppIcon androidName="delete_forever" iosName="trash.fill" color={colors.error} size={28} fallback="🗑" />
            </View>
            <Text style={styles.modalTitle}>
              Delete {selectedFiles.length} backed-up file{selectedFiles.length === 1 ? '' : 's'}?
            </Text>
            <Text style={styles.modalBody}>
              This will permanently remove {selectedFiles.length === 1 ? 'this file' : `these ${selectedFiles.length} files`} from your phone to free{' '}
              <Text style={{ fontWeight: '800', color: colors.text }}>{formatFreeUpBytes(selectedBytes)}</Text>.
              {'\n\n'}
              <Text style={{ color: colors.success, fontWeight: '700' }}>✓ Safe to delete:</Text> Your backup copies on your server remain 100% intact and unaffected.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnCancel, { borderColor: colors.surfaceBorder }]}
                onPress={() => { hapticLight(); setConfirmVisible(false); }}
              >
                <Text style={[styles.modalBtnText, { color: colors.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnDelete, { backgroundColor: colors.error }]}
                onPress={handleConfirmDelete}
              >
                <Text style={[styles.modalBtnText, { color: colors.white }]}>
                  Free up {formatFreeUpBytes(selectedBytes)}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Sort Option Modal */}
      <Modal visible={sortModalVisible} transparent animationType="fade" onRequestClose={() => setSortModalVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setSortModalVisible(false)}>
          <View style={[styles.sortCard, { backgroundColor: colors.surface }]}>
            <Text style={styles.sortTitle}>Sort files by</Text>
            {(
              [
                { id: 'largest', label: 'Largest size first', icon: 'swap_vert' },
                { id: 'smallest', label: 'Smallest size first', icon: 'swap_vert' },
                { id: 'newest', label: 'Newest date first', icon: 'event' },
                { id: 'oldest', label: 'Oldest date first', icon: 'history' },
              ] as const
            ).map((opt) => (
              <TouchableOpacity
                key={opt.id}
                style={[styles.sortOptionRow, sortOption === opt.id && { backgroundColor: colors.primarySoft }]}
                onPress={() => {
                  hapticLight();
                  setSortOption(opt.id);
                  setSortModalVisible(false);
                }}
              >
                <Text style={[styles.sortOptionLabel, sortOption === opt.id && { color: colors.primary, fontWeight: '800' }]}>
                  {opt.label}
                </Text>
                {sortOption === opt.id && (
                  <AppIcon androidName="check" iosName="checkmark" color={colors.primary} size={18} fallback="✓" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Full-Screen Media Preview Modal */}
      <Modal visible={!!previewFile} transparent animationType="fade" onRequestClose={closePreview}>
        <View style={styles.previewOverlay}>
          <View style={[styles.previewHeader, { paddingTop: insets.top + Spacing.two }]}>
            <TouchableOpacity style={styles.previewClose} onPress={closePreview} accessibilityLabel="Close preview">
              <AppIcon androidName="close" iosName="xmark" color="#fff" size={22} fallback="✕" />
            </TouchableOpacity>
            <View style={styles.previewHeaderMeta}>
              <Text style={styles.previewName} numberOfLines={1}>
                {previewFile ? getDisplayName(previewFile) : ''}
              </Text>
              <Text style={styles.previewDetails}>
                {previewFile ? `${getFolderLabel(previewFile.relativePath)} · ${formatFreeUpBytes(previewFile.size || 0)} · Backed Up` : ''}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.previewDeleteBtn}
              onPress={() => previewFile && handleDeleteSingleFile(previewFile)}
              accessibilityLabel="Delete this file"
            >
              <AppIcon androidName="delete" iosName="trash.fill" color="#fff" size={20} fallback="🗑" />
            </TouchableOpacity>
          </View>

          <View style={styles.previewBody}>
            {previewFile && getFileCategory(getDisplayName(previewFile)) === 'other' ? (
              <View style={styles.previewUnsupported}>
                <AppIcon androidName="description" iosName="doc.fill" color="#fff" size={48} fallback="📄" />
                <Text style={styles.previewUnsupportedTitle}>{getDisplayName(previewFile)}</Text>
                <Text style={styles.previewUnsupportedBody}>This file type cannot be visually previewed.</Text>
              </View>
            ) : previewLoading ? (
              <ActivityIndicator size="large" color="#fff" />
            ) : previewUri && previewFile ? (
              getFileCategory(getDisplayName(previewFile)) === 'image' ? (
                <Image source={{ uri: previewUri }} style={styles.previewMedia} contentFit="contain" />
              ) : (
                <PreviewVideo uri={previewUri} />
              )
            ) : (
              <Text style={styles.previewUnsupportedBody}>Could not load media preview.</Text>
            )}
          </View>

          {/* Preview Footer Controls */}
          {previewFile && (
            <View style={[styles.previewFooter, { paddingBottom: insets.bottom + Spacing.four }]}>
              <TouchableOpacity
                style={styles.previewNavBtn}
                onPress={() => navigatePreview(-1)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <AppIcon androidName="chevron_left" iosName="chevron.left" color="#fff" size={30} fallback="‹" />
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.previewSelectToggle,
                  selected.has(fileKey(previewFile)) && { backgroundColor: colors.primary },
                ]}
                onPress={() => toggleFile(previewFile)}
              >
                <AppIcon
                  androidName={selected.has(fileKey(previewFile)) ? 'check' : 'add'}
                  iosName={selected.has(fileKey(previewFile)) ? 'checkmark' : 'plus'}
                  color="#fff"
                  size={16}
                  fallback="✓"
                />
                <Text style={styles.previewSelectToggleText}>
                  {selected.has(fileKey(previewFile)) ? 'Selected for cleanup' : 'Select to clean'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.previewNavBtn}
                onPress={() => navigatePreview(1)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <AppIcon androidName="chevron_right" iosName="chevron.right" color="#fff" size={30} fallback="›" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

// ─── Video player subcomponent ────────────────────────────────────────────────

function PreviewVideo({ uri }: { uri: string }) {
  if (!expoVideoModule) {
    return <Text style={stylesShared.previewFallback}>Video playback unavailable</Text>;
  }
  return <NativeFreeUpVideoPreview uri={uri} videoModule={expoVideoModule} />;
}

function NativeFreeUpVideoPreview({
  uri,
  videoModule,
}: {
  uri: string;
  videoModule: ExpoVideoModule;
}) {
  const player = videoModule.useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.play();
  });

  return (
    <videoModule.VideoView
      style={stylesShared.previewMedia}
      player={player}
      nativeControls
      contentFit="contain"
      surfaceType="textureView"
    />
  );
}

const stylesShared = StyleSheet.create({
  previewMedia: {
    width: '100%',
    height: '75%',
  },
  previewFallback: {
    color: '#fff',
    fontSize: TextScale.sm,
    fontWeight: '600',
  },
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const createStyles = (colors: AppColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    backgroundColor: colors.bg,
    gap: Spacing.two,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceBorder,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  headerTitles: { flex: 1 },
  headerTitle: {
    fontSize: TextScale.md,
    fontWeight: '800',
    color: colors.text,
  },
  headerSubtitle: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    fontWeight: '600',
    marginTop: 1,
  },
  refreshHeaderBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.full,
  },
  scanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    backgroundColor: colors.primarySoft,
  },
  scanningText: {
    fontSize: TextScale.sm,
    color: colors.primary,
    fontWeight: '600',
  },
  headerSection: {
    paddingBottom: Spacing.two,
    gap: Spacing.three,
  },
  reclaimCard: {
    borderRadius: Radius.xl,
    padding: Spacing.four,
    borderWidth: 1,
    gap: Spacing.three,
    ...Shadows.card,
  },
  reclaimCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  reclaimIconWrap: {
    width: 46,
    height: 46,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reclaimTitles: { flex: 1 },
  reclaimBigText: {
    fontSize: TextScale.xl,
    fontWeight: '900',
    color: colors.text,
    letterSpacing: -0.5,
  },
  reclaimSubText: {
    fontSize: TextScale.xs,
    fontWeight: '600',
    color: colors.textMuted,
    marginTop: 1,
  },
  breakdownRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  breakdownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.three,
    paddingVertical: 5,
    borderRadius: Radius.full,
  },
  breakdownPillText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    color: colors.text,
  },
  reassuranceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
  },
  reassuranceText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    flex: 1,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.lg,
    borderWidth: 1,
    gap: Spacing.two,
  },
  searchInput: {
    flex: 1,
    fontSize: TextScale.sm,
    padding: 0,
  },
  filterTabsContent: {
    gap: Spacing.two,
    paddingVertical: 2,
  },
  filterChip: {
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceSoft,
  },
  filterChipActive: {},
  filterChipText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  filterChipTextActive: {
    color: colors.white,
  },
  listToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Spacing.one,
  },
  toolbarSelectBtn: {
    paddingVertical: Spacing.one,
  },
  toolbarSelectText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.three,
    paddingVertical: 5,
    borderRadius: Radius.full,
  },
  sortBtnText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
  listContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.two,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  fileRowSelected: {
    borderColor: colors.primary + '66',
    backgroundColor: colors.primarySoft,
  },
  thumbnailTouch: {
    position: 'relative',
  },
  thumbnail: {
    width: 52,
    height: 52,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoBadge: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: Radius.full,
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileMeta: { flex: 1, gap: 3 },
  fileName: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: colors.text,
  },
  fileDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  folderBadge: {
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: Radius.sm,
    textTransform: 'uppercase',
  },
  fileDetailDot: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
  },
  fileSizeText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  fileDateText: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    fontWeight: '500',
  },
  checkWrap: {
    padding: Spacing.two,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    borderWidth: 2,
    borderColor: colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: Spacing.eight,
    paddingHorizontal: Spacing.seven,
    gap: Spacing.three,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.two,
  },
  emptyTitle: {
    fontSize: TextScale.md,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 20,
  },
  rescanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
    marginTop: Spacing.two,
  },
  rescanBtnText: { fontSize: TextScale.sm, fontWeight: '800' },
  ctaBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceBorder,
    ...Shadows.card,
  },
  clearBtn: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    borderRadius: Radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
  },
  deleteBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.four,
    ...Shadows.soft,
  },
  deleteBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '800',
    color: '#fff',
  },
  deletingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
    zIndex: 1000,
  },
  deletingCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: Radius.xl,
    padding: Spacing.six,
    alignItems: 'center',
    gap: Spacing.two,
    ...Shadows.card,
  },
  deletingCardTitle: {
    fontSize: TextScale.md,
    fontWeight: '800',
    color: colors.text,
    marginTop: Spacing.two,
  },
  deletingCardSubtitle: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    fontWeight: '600',
  },
  progressBarTrack: {
    width: '100%',
    height: 8,
    borderRadius: Radius.full,
    overflow: 'hidden',
    marginTop: Spacing.two,
  },
  progressBarFill: {
    height: '100%',
    borderRadius: Radius.full,
  },
  deletingFreedText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
    marginTop: Spacing.one,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  modalCard: {
    width: '100%',
    maxWidth: 340,
    borderRadius: Radius.xl,
    padding: Spacing.five,
    alignItems: 'center',
    ...Shadows.card,
  },
  modalIconWrap: {
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.three,
  },
  modalTitle: {
    fontSize: TextScale.md,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  modalBody: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.five,
  },
  modalActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    width: '100%',
  },
  modalBtn: {
    flex: 1,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
  },
  modalBtnCancel: {
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  modalBtnDelete: {},
  modalBtnText: { fontSize: TextScale.sm, fontWeight: '800' },
  sortCard: {
    width: '100%',
    maxWidth: 300,
    borderRadius: Radius.xl,
    padding: Spacing.four,
    gap: Spacing.one,
    ...Shadows.card,
  },
  sortTitle: {
    fontSize: TextScale.sm,
    fontWeight: '800',
    color: colors.text,
    marginBottom: Spacing.two,
  },
  sortOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: Radius.md,
  },
  sortOptionLabel: {
    fontSize: TextScale.sm,
    fontWeight: '600',
    color: colors.text,
  },
  previewOverlay: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'space-between',
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
    gap: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  previewClose: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewDeleteBtn: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(239,68,68,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewHeaderMeta: { flex: 1 },
  previewName: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: '#fff',
  },
  previewDetails: {
    fontSize: TextScale.xs,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '500',
    marginTop: 2,
  },
  previewBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewMedia: {
    width: '100%',
    height: '100%',
  },
  previewUnsupported: {
    alignItems: 'center',
    padding: Spacing.six,
    gap: Spacing.two,
  },
  previewUnsupportedTitle: {
    fontSize: TextScale.md,
    fontWeight: '800',
    color: '#fff',
    textAlign: 'center',
  },
  previewUnsupportedBody: {
    fontSize: TextScale.sm,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
  },
  previewFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  previewNavBtn: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewSelectToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
  },
  previewSelectToggleText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
    color: '#fff',
  },
});