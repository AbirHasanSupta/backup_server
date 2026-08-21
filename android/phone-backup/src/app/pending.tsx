import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  FlatList,
  ScrollView,
  Modal,
  Alert,
  RefreshControl,
  DeviceEventEmitter,
} from 'react-native';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { AnimatedListItem } from '@/components/AnimatedListItem';
import { useAppTheme } from '@/hooks/use-app-theme';
import { hapticLight, hapticMedium, hapticSelection, hapticSuccess, hapticError } from '@/utils/haptics';
import { getCurrentSyncState } from '../../backgroundTask';
import {
  computePendingFiles,
  getPendingBackupFiles,
  getPendingBackupSummary,
  uploadPendingFiles,
} from '../../pendingBackup';

type ExpoVideoModule = typeof import('expo-video');
let expoVideoModule: ExpoVideoModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  expoVideoModule = null;
}

type PendingFile = {
  uri: string;
  relativePath: string;
  name: string;
  modifiedTime: number;
  size: number;
};

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', '3gp', 'm4v']);

function getFileCategory(name: string): 'image' | 'video' | 'other' {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}


function formatDate(ts: number): string {
  if (!ts) return 'Unknown date';
  const ms = ts > 1e11 ? ts : ts * 1000;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fileKey(file: PendingFile): string {
  return `${file.relativePath}|${file.modifiedTime}|${file.size || 0}`;
}

function getDisplayName(file: PendingFile): string {
  return file.name || file.relativePath.split('/').pop() || file.relativePath;
}

function getFolderLabel(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts[0] : 'Device';
}

async function copySafToCache(uri: string, name: string): Promise<string | null> {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const cacheUri = `${FileSystem.cacheDirectory}pending_preview_${Date.now()}_${safeName}`;
  try {
    await FileSystem.StorageAccessFramework.copyAsync({ from: uri, to: cacheUri });
    return cacheUri;
  } catch {
    return null;
  }
}

export default function PendingBackupScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [files, setFiles] = useState<PendingFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupProgress, setBackupProgress] = useState({ done: 0, total: 0 });
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [previewFile, setPreviewFile] = useState<PendingFile | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const abortRef = useRef(false);
  const genRef = useRef(0);
  const previewUriRef = useRef<string | null>(null);

  const loadCachedSnapshot = useCallback(async () => {
    const [summary, cached] = await Promise.all([
      getPendingBackupSummary(),
      Promise.resolve(getPendingBackupFiles()),
    ]);
    setFiles(cached);
    setLastScannedAt(summary.scannedAt);
    setHasSnapshot(summary.scannedAt != null);
    setSelected(new Set());
  }, []);

  useFocusEffect(
    useCallback(() => {
      abortRef.current = false;
      loadCachedSnapshot();
      return () => {
        abortRef.current = true;
        genRef.current += 1;
      };
    }, [loadCachedSnapshot])
  );

  const refresh = useCallback(async () => {
    const syncState = await getCurrentSyncState().catch(() => null);
    if (syncState?.active) {
      Alert.alert('Sync in progress', 'Wait for the current backup to finish, then refresh again.');
      return;
    }

    const gen = ++genRef.current;
    abortRef.current = false;
    setScanning(true);
    setScanStatus('Scanning folders…');

    try {
      const result = await computePendingFiles({
        shouldStop: () => abortRef.current || genRef.current !== gen,
        onProgress: (detail: { phase?: string; files?: number; skipped?: number }) => {
          if (gen !== genRef.current) return;
          if (detail?.phase === 'scanning') {
            const found = detail.files || 0;
            const skipped = detail.skipped || 0;
            setScanStatus(
              found > 0
                ? `Scanning… ${found.toLocaleString()} found${skipped ? ` · ${skipped.toLocaleString()} cached` : ''}`
                : 'Scanning folders…'
            );
          }
        },
      });

      if (gen !== genRef.current) return;
      if (!result) return;
      if ('fromCache' in result && result.fromCache) {
        setScanStatus('Sync in progress — showing last scan');
      }
      setFiles(result.pending);
      setLastScannedAt(result.summary.scannedAt);
      setHasSnapshot(true);
      setSelected(new Set());
      if (!('fromCache' in result && result.fromCache)) {
        hapticSuccess();
      }
    } catch {
      hapticError();
      Alert.alert('Scan failed', 'Could not scan folders. Try again.');
    } finally {
      if (gen === genRef.current) {
        setScanning(false);
        setScanStatus('');
      }
    }
  }, []);

  useEffect(() => {
    const onSyncCompleted = () => {
      loadCachedSnapshot();
    };
    const onPendingUpdated = () => {
      loadCachedSnapshot();
    };
    const subs = [
      DeviceEventEmitter.addListener('sync-completed', onSyncCompleted),
      DeviceEventEmitter.addListener('pending-backup-updated', onPendingUpdated),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, [loadCachedSnapshot]);

  const toggleSelect = useCallback((file: PendingFile) => {
    hapticSelection();
    const key = fileKey(file);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    hapticLight();
    setSelected(new Set(files.map(fileKey)));
  }, [files]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  const selectedFiles = useMemo(
    () => files.filter((file) => selected.has(fileKey(file))),
    [files, selected]
  );

  const runBackup = useCallback(async (targets: PendingFile[]) => {
    if (!targets.length) return;

    const syncState = await getCurrentSyncState().catch(() => null);
    if (syncState?.active) {
      Alert.alert('Sync in progress', 'Wait for the current backup to finish before uploading from here.');
      return;
    }

    setBackingUp(true);
    setBackupProgress({ done: 0, total: targets.length });

    try {
      const result = await uploadPendingFiles(targets, {
        onProgress: (done: number, total: number) => setBackupProgress({ done, total }),
      });

      const uploadedKeys = new Set(result.uploaded.map(fileKey));
      setFiles((prev) => prev.filter((file) => !uploadedKeys.has(fileKey(file))));
      setSelected((prev) => {
        const next = new Set(prev);
        uploadedKeys.forEach((key) => next.delete(key));
        return next;
      });

      if (result.uploaded.length > 0) hapticSuccess();
      if (result.errors.length > 0) {
        hapticError();
        Alert.alert(
          'Some uploads failed',
          `${result.uploaded.length} backed up, ${result.errors.length} failed.`
        );
      } else if (result.uploaded.length > 0) {
        Alert.alert('Backup complete', `${result.uploaded.length} file${result.uploaded.length === 1 ? '' : 's'} backed up.`);
      }
    } catch {
      hapticError();
      Alert.alert('Backup failed', 'Could not upload selected files.');
    } finally {
      setBackingUp(false);
      setBackupProgress({ done: 0, total: 0 });
    }
  }, []);

  const handleBackupSelected = useCallback(() => {
    hapticMedium();
    runBackup(selectedFiles);
  }, [runBackup, selectedFiles]);

  const handleBackupAll = useCallback(() => {
    hapticMedium();
    runBackup(files);
  }, [runBackup, files]);

  const openPreview = useCallback(async (file: PendingFile) => {
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

  const previewableFiles = useMemo(
    () => files.filter((file) => getFileCategory(getDisplayName(file)) !== 'other'),
    [files]
  );

  const navigatePreview = useCallback(async (direction: -1 | 1) => {
    if (!previewFile || !previewableFiles.length) return;
    const currentIndex = previewableFiles.findIndex((file) => fileKey(file) === fileKey(previewFile));
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= previewableFiles.length) return;
    await openPreview(previewableFiles[nextIndex]);
  }, [openPreview, previewFile, previewableFiles]);

  const busy = scanning || backingUp;
  const allSelected = files.length > 0 && selected.size === files.length;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="Go back">
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>New Files</Text>
          <Text style={styles.headerSubtitle}>
            {scanning
              ? scanStatus || 'Scanning…'
              : hasSnapshot
                ? `${files.length} not backed up yet`
                : 'Pull down to scan'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => { hapticMedium(); refresh(); }}
          disabled={busy}
          accessibilityLabel="Refresh file list"
        >
          {scanning ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={22} />
          )}
        </TouchableOpacity>
      </View>

      {files.length > 0 && !busy && (
        <View style={styles.toolbar}>
          <TouchableOpacity onPress={allSelected ? clearSelection : selectAll}>
            <Text style={styles.toolbarAction}>{allSelected ? 'Clear' : 'Select all'}</Text>
          </TouchableOpacity>
          <Text style={styles.toolbarMeta}>
            {selected.size > 0 ? `${selected.size} selected` : `${files.length} pending`}
          </Text>
        </View>
      )}

      {!hasSnapshot && !scanning ? (
        <ScrollView
          contentContainerStyle={styles.emptyScrollContent}
          refreshControl={
            <RefreshControl refreshing={scanning} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />
          }
        >
          <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
            <AppIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" color={colors.primary} size={36} />
          </View>
          <Text style={styles.emptyTitle}>Scan for new files</Text>
          <Text style={styles.emptySubtitle}>
            Pull down or tap refresh to scan your backup folders and find files that haven&apos;t been uploaded yet.
          </Text>
          <AnimatedPressable style={[styles.emptyCta, { backgroundColor: colors.primary }]} onPress={refresh} scaleDown={0.96}>
            <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.white} size={18} />
            <Text style={styles.emptyCtaText}>Scan Now</Text>
          </AnimatedPressable>
        </ScrollView>
      ) : scanning && files.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyScrollContent}
          refreshControl={
            <RefreshControl refreshing={scanning} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />
          }
        >
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>{scanStatus || 'Scanning folders…'}</Text>
        </ScrollView>
      ) : files.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyScrollContent}
          refreshControl={
            <RefreshControl refreshing={scanning} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />
          }
        >
          <View style={[styles.emptyIconWrap, { backgroundColor: colors.successSoft }]}>
            <AppIcon androidName="check_circle" iosName="checkmark.circle.fill" color={colors.success} size={36} />
          </View>
          <Text style={styles.emptyTitle}>All caught up</Text>
          <Text style={styles.emptySubtitle}>
            Every file in your backup folders is already backed up. Refresh after adding new files.
          </Text>
          {lastScannedAt ? (
            <Text style={styles.emptyHint}>Last scanned {formatDate(lastScannedAt)}</Text>
          ) : null}
        </ScrollView>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => fileKey(item)}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 96 }]}
          refreshControl={
            <RefreshControl
              refreshing={scanning}
              onRefresh={refresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item, index }) => {
            const key = fileKey(item);
            const isSelected = selected.has(key);
            const category = getFileCategory(getDisplayName(item));
            return (
              <AnimatedListItem index={index}>
                <View style={[styles.row, isSelected && styles.rowSelected]}>
                  <TouchableOpacity style={styles.checkWrap} onPress={() => toggleSelect(item)}>
                    <View style={[styles.checkbox, isSelected && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
                      {isSelected ? <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={14} /> : null}
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.rowBody} onPress={() => toggleSelect(item)}>
                    <Text style={styles.fileName} numberOfLines={1}>{getDisplayName(item)}</Text>
                    <Text style={styles.fileMeta} numberOfLines={1}>
                      {getFolderLabel(item.relativePath)}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.previewBtn}
                    onPress={() => openPreview(item)}
                    disabled={category === 'other'}
                    accessibilityLabel="Preview file"
                  >
                    <AppIcon
                      androidName={category === 'video' ? 'videocam' : category === 'image' ? 'image' : 'description'}
                      iosName={category === 'video' ? 'video.fill' : category === 'image' ? 'photo.fill' : 'doc.fill'}
                      color={category === 'other' ? colors.textMuted : colors.primary}
                      size={20}
                    />
                  </TouchableOpacity>
                </View>
              </AnimatedListItem>
            );
          }}
          showsVerticalScrollIndicator={false}
        />
      )}

      {files.length > 0 && !busy && (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + Spacing.three }]}>
          {selected.size > 0 ? (
            <AnimatedPressable style={[styles.primaryBtn, { backgroundColor: colors.primary }]} onPress={handleBackupSelected} scaleDown={0.98}>
              <AppIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" color={colors.white} size={18} />
              <Text style={styles.primaryBtnText}>Back up {selected.size} file{selected.size === 1 ? '' : 's'}</Text>
            </AnimatedPressable>
          ) : (
            <AnimatedPressable style={[styles.primaryBtn, { backgroundColor: colors.primary }]} onPress={handleBackupAll} scaleDown={0.98}>
              <AppIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" color={colors.white} size={18} />
              <Text style={styles.primaryBtnText}>Back up all {files.length}</Text>
            </AnimatedPressable>
          )}
        </View>
      )}

      {backingUp && (
        <View style={styles.uploadOverlay}>
          <View style={[styles.uploadCard, { backgroundColor: colors.surface }]}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.uploadTitle}>Backing up…</Text>
            <Text style={styles.uploadSubtitle}>
              {backupProgress.done} / {backupProgress.total}
            </Text>
          </View>
        </View>
      )}

      <Modal visible={!!previewFile} transparent animationType="fade" onRequestClose={closePreview}>
        <View style={styles.previewOverlay}>
          <TouchableOpacity style={styles.previewClose} onPress={closePreview}>
            <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
          </TouchableOpacity>

          {previewFile && getFileCategory(getDisplayName(previewFile)) === 'other' ? (
            <View style={styles.previewUnsupported}>
              <AppIcon androidName="description" iosName="doc.fill" color="#fff" size={40} />
              <Text style={styles.previewUnsupportedTitle}>{getDisplayName(previewFile)}</Text>
              <Text style={styles.previewUnsupportedBody}>This file type cannot be previewed.</Text>
            </View>
          ) : previewLoading ? (
            <ActivityIndicator size="large" color="#fff" />
          ) : previewUri && previewFile ? (
            <>
              {getFileCategory(getDisplayName(previewFile)) === 'image' ? (
                <Image source={{ uri: previewUri }} style={styles.previewMedia} contentFit="contain" />
              ) : (
                <PreviewVideo uri={previewUri} />
              )}
              <View style={styles.previewFooter}>
                <TouchableOpacity onPress={() => navigatePreview(-1)} disabled={!previewableFiles.length}>
                  <AppIcon androidName="chevron_left" iosName="chevron.left" color="#fff" size={28} />
                </TouchableOpacity>
                <View style={styles.previewMeta}>
                  <Text style={styles.previewName} numberOfLines={1}>{getDisplayName(previewFile)}</Text>
                  <Text style={styles.previewDetails}>{getFolderLabel(previewFile.relativePath)}</Text>
                </View>
                <TouchableOpacity onPress={() => navigatePreview(1)} disabled={!previewableFiles.length}>
                  <AppIcon androidName="chevron_right" iosName="chevron.right" color="#fff" size={28} />
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <Text style={styles.previewUnsupportedBody}>Could not load preview.</Text>
          )}
        </View>
      </Modal>
    </View>
  );
}

function PreviewVideo({ uri }: { uri: string }) {
  if (!expoVideoModule) {
    return <Text style={stylesShared.previewFallback}>Video preview unavailable</Text>;
  }
  return <NativePendingVideoPreview uri={uri} videoModule={expoVideoModule} />;
}

function NativePendingVideoPreview({
  uri,
  videoModule,
}: {
  uri: string;
  videoModule: ExpoVideoModule;
}) {
  const player = videoModule.useVideoPlayer(uri, (instance) => {
    instance.loop = false;
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
    height: '70%',
  },
  previewFallback: {
    color: '#fff',
    fontSize: TextScale.sm,
    fontWeight: '600',
  },
});

const createStyles = (colors: AppColors) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  headerCenter: { flex: 1 },
  headerTitle: { fontSize: TextScale.lg, fontWeight: '900', color: colors.text },
  headerSubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600', marginTop: 2 },
  refreshBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.five,
    paddingBottom: Spacing.two,
  },
  toolbarAction: { fontSize: TextScale.sm, fontWeight: '800', color: colors.primary },
  toolbarMeta: { fontSize: TextScale.sm, color: colors.textMuted, fontWeight: '600' },
  loadingText: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600' },
  emptyScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.six,
    gap: Spacing.three,
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontSize: TextScale.lg, fontWeight: '900', color: colors.text, textAlign: 'center' },
  emptySubtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyHint: { fontSize: TextScale.xs, color: colors.textMuted, fontWeight: '600' },
  emptyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three,
    borderRadius: Radius.lg,
    marginTop: Spacing.two,
  },
  emptyCtaText: { color: colors.white, fontWeight: '800', fontSize: TextScale.sm },
  listContent: { paddingHorizontal: Spacing.four, paddingTop: Spacing.one },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    paddingVertical: Spacing.three,
    paddingRight: Spacing.two,
    marginBottom: Spacing.two,
  },
  rowSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  checkWrap: { paddingHorizontal: Spacing.three },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, minWidth: 0 },
  fileName: { fontSize: TextScale.sm, fontWeight: '800', color: colors.text },
  fileMeta: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '600', marginTop: 2 },
  previewBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceBorder,
  },
  primaryBtn: {
    minHeight: 52,
    borderRadius: Radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  primaryBtnText: { color: colors.white, fontWeight: '900', fontSize: TextScale.base },
  uploadOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.five,
  },
  uploadCard: {
    width: '100%',
    maxWidth: 280,
    borderRadius: Radius.xl,
    padding: Spacing.five,
    alignItems: 'center',
    gap: Spacing.two,
  },
  uploadTitle: { fontSize: TextScale.base, fontWeight: '800', color: colors.text },
  uploadSubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600' },
  previewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewClose: {
    position: 'absolute',
    top: 52,
    right: Spacing.four,
    zIndex: 2,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewMedia: stylesShared.previewMedia,
  previewFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 40,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  previewMeta: { flex: 1 },
  previewName: { color: '#fff', fontWeight: '800', fontSize: TextScale.sm },
  previewDetails: { color: 'rgba(255,255,255,0.75)', fontSize: TextScale.xs, marginTop: 2, fontWeight: '600' },
  previewUnsupported: { alignItems: 'center', paddingHorizontal: Spacing.six, gap: Spacing.three },
  previewUnsupportedTitle: { color: '#fff', fontWeight: '800', fontSize: TextScale.base, textAlign: 'center' },
  previewUnsupportedBody: { color: 'rgba(255,255,255,0.75)', fontSize: TextScale.sm, textAlign: 'center', fontWeight: '600' },
});