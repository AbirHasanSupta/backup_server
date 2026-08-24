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
} from 'react-native';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { hapticLight, hapticMedium, hapticSuccess } from '@/utils/haptics';
import {
  computeCleanupCandidates,
  getCleanupCandidateFiles,
  invalidateCleanupCache,
  reportDeletedFiles,
  markAsCleanedLocally,
  formatFreeUpBytes,
} from '../../freeUpStorage';

// ─── File type helpers ────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', '3gp', 'm4v']);

function getFileCategory(name: string): 'image' | 'video' | 'other' {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

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
  // uri is always unique (SAF URI includes the full path).
  // We use it as the primary key so there are no collisions even when
  // modifiedTime/size are 0 (noMetadata scan mode in freeUpStorage).
  return file.uri || `${file.relativePath}|${file.modifiedTime || 0}|${file.size || 0}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CandidateFile = {
  uri: string;
  relativePath: string;
  name: string;
  modifiedTime: number;
  size: number;
};

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
        size={28}
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
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [confirmVisible, setConfirmVisible] = useState(false);
  const shouldStopRef = useRef(false);

  // ─── Scan ────────────────────────────────────────────────────────────────

  const scan = useCallback(async (isRefresh = false) => {
    // Guard: don't start a new scan if one is already running or a delete is in progress
    if (scanning || deleting) return;
    shouldStopRef.current = false;
    if (isRefresh) setRefreshing(true);
    else setScanning(true);
    setStatusMsg('Scanning backed-up files…');

    try {
      // Try in-memory cache first for instant load
      const cached = getCleanupCandidateFiles();
      if (cached.length > 0 && !isRefresh) {
        setFiles(cached);
        setSelected(new Set(cached.map(fileKey)));
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

      setFiles(result.files);
      setSelected(new Set(result.files.map(fileKey)));
      setStatusMsg('');
    } catch (err: any) {
      setStatusMsg(err?.message || 'Scan failed');
    } finally {
      setScanning(false);
      setRefreshing(false);
    }
  }, [scanning, deleting]);

  useFocusEffect(useCallback(() => {
    scan(false);
    return () => { shouldStopRef.current = true; };
  }, [scan]));

  const onRefresh = useCallback(() => {
    invalidateCleanupCache();
    scan(true);
  }, [scan]);

  // ─── Selection ───────────────────────────────────────────────────────────

  const allSelected = files.length > 0 && selected.size === files.length;

  const toggleSelectAll = useCallback(() => {
    hapticLight();
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map(fileKey)));
    }
  }, [allSelected, files]);

  const toggleFile = useCallback((file: CandidateFile) => {
    hapticLight();
    setSelected((prev) => {
      const next = new Set(prev);
      const k = fileKey(file);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

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
    setDeleting(true);
    setStatusMsg(`Deleting ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}…`);

    const succeeded: CandidateFile[] = [];
    const failed: string[] = [];

    for (const file of selectedFiles) {
      try {
        await FileSystem.deleteAsync(file.uri, { idempotent: true });
        succeeded.push(file);
      } catch {
        failed.push(getDisplayName(file));
      }
    }

    // Update local state immediately
    if (succeeded.length > 0) {
      const deletedKeys = new Set(succeeded.map(fileKey));
      const remaining = files.filter((f) => !deletedKeys.has(fileKey(f)));
      setFiles(remaining);
      setSelected(new Set(remaining.map(fileKey)));

      // Persist cleaned paths + update cache
      await markAsCleanedLocally(succeeded.map((f) => f.relativePath));

      // Report to server — pass only the fields the endpoint needs (best-effort)
      reportDeletedFiles(
        succeeded.map((f) => ({ relativePath: f.relativePath, size: f.size || 0 }))
      ).catch(() => {});
    }

    const freedBytes = succeeded.reduce((s, f) => s + (f.size || 0), 0);
    setDeleting(false);
    setStatusMsg('');

    // Determine result and fire appropriate haptic
    if (succeeded.length === 0) {
      // All failed — nothing was freed
      hapticMedium();
      Alert.alert(
        'Could not delete files',
        `${failed.length} file${failed.length === 1 ? '' : 's'} could not be deleted. They may have already been removed or require extra permissions.`,
        [{ text: 'OK' }]
      );
    } else if (failed.length > 0) {
      // Partial success
      hapticMedium();
      Alert.alert(
        'Partially freed',
        `Freed ${formatFreeUpBytes(freedBytes)} from ${succeeded.length} file${succeeded.length === 1 ? '' : 's'}. ${failed.length} file${failed.length === 1 ? '' : 's'} could not be deleted.`,
        [{ text: 'OK' }]
      );
    } else {
      // Full success
      hapticSuccess();
      Alert.alert(
        'Storage freed',
        `Freed ${formatFreeUpBytes(freedBytes)} from ${succeeded.length} file${succeeded.length === 1 ? '' : 's'}.`,
        [{ text: 'OK' }]
      );
    }
  }, [selectedFiles, files]);

  // ─── Render item ──────────────────────────────────────────────────────────

  const renderItem = useCallback(({ item, index }: { item: CandidateFile; index: number }) => {
    const key = fileKey(item);
    const isSelected = selected.has(key);
    const name = getDisplayName(item);
    const folder = getFolderLabel(item.relativePath);
    const dateStr = formatDate(item.modifiedTime);

    return (
      <Animated.View entering={FadeInDown.duration(250).delay(Math.min(index * 30, 300))}>
        <TouchableOpacity
          style={[styles.fileRow, isSelected && styles.fileRowSelected]}
          onPress={() => toggleFile(item)}
          activeOpacity={0.7}
        >
          <FileThumbnail file={item} colors={colors} styles={styles} />
          <View style={styles.fileMeta}>
            <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
            <Text style={styles.fileDetail}>{folder} · {formatFreeUpBytes(item.size || 0)}{dateStr ? ` · ${dateStr}` : ''}</Text>
          </View>
          <View style={[styles.checkbox, isSelected && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
            {isSelected && (
              <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={12} fallback="✓" />
            )}
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  }, [selected, toggleFile, colors, styles]);

  // ─── Empty state ─────────────────────────────────────────────────────────

  const renderEmpty = () => {
    if (scanning) return null;
    return (
      <View style={styles.emptyState}>
        <View style={[styles.emptyIcon, { backgroundColor: colors.successSoft }]}>
          <AppIcon androidName="check_circle" iosName="checkmark.circle.fill" color={colors.success} size={40} fallback="✓" />
        </View>
        <Text style={styles.emptyTitle}>Nothing to clean up</Text>
        <Text style={styles.emptyBody}>
          All your backed-up files have already been cleaned, or no files have been backed up yet.
        </Text>
        <AnimatedPressable style={[styles.rescanBtn, { backgroundColor: colors.primarySoft }]} onPress={onRefresh} scaleDown={0.96}>
          <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={16} fallback="↺" />
          <Text style={[styles.rescanBtnText, { color: colors.primary }]}>Re-scan</Text>
        </AnimatedPressable>
      </View>
    );
  };

  // ─── Summary bar ─────────────────────────────────────────────────────────

  const totalCandidateBytes = useMemo(
    () => files.reduce((s, f) => s + (f.size || 0), 0),
    [files]
  );

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
          {files.length > 0 && !scanning && (
            <Text style={styles.headerSubtitle}>
              {files.length} file{files.length === 1 ? '' : 's'} · {formatFreeUpBytes(totalCandidateBytes)} recoverable
            </Text>
          )}
        </View>
        {files.length > 0 && !scanning && (
          <TouchableOpacity onPress={toggleSelectAll} style={styles.selectAllBtn}>
            <Text style={[styles.selectAllText, { color: colors.primary }]}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Scanning spinner */}
      {scanning && (
        <View style={styles.scanningRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.scanningText}>{statusMsg || 'Scanning…'}</Text>
        </View>
      )}

      {/* Info banner */}
      {!scanning && files.length > 0 && (
        <View style={[styles.infoBanner, { backgroundColor: colors.primarySoft, borderColor: colors.primary + '33' }]}>
          <AppIcon androidName="info" iosName="info.circle.fill" color={colors.primary} size={16} fallback="i" />
          <Text style={[styles.infoBannerText, { color: colors.primary }]}>
            These files are safely backed up on your server. Deleting them frees phone storage — your backups are unaffected.
          </Text>
        </View>
      )}

      {/* File list */}
      <FlatList
        data={files}
        keyExtractor={fileKey}
        renderItem={renderItem}
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: BottomTabInset + insets.bottom + 100 },
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

      {/* Bottom CTA */}
      {selectedFiles.length > 0 && !scanning && (
        <View style={[styles.ctaBar, { paddingBottom: insets.bottom + Spacing.three }]}>
          {statusMsg && deleting ? (
            <View style={styles.deletingRow}>
              <ActivityIndicator size="small" color={colors.white} />
              <Text style={styles.deletingText}>{statusMsg}</Text>
            </View>
          ) : (
            <AnimatedPressable
              style={[styles.deleteBtn, deleting && { opacity: 0.7 }]}
              onPress={handleDeletePress}
              disabled={deleting}
              scaleDown={0.97}
            >
              <AppIcon androidName="delete" iosName="trash.fill" color={colors.white} size={18} fallback="🗑" />
              <Text style={styles.deleteBtnText}>
                Delete {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'} · free {formatFreeUpBytes(selectedBytes)}
              </Text>
            </AnimatedPressable>
          )}
        </View>
      )}

      {/* Confirm dialog */}
      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
            <View style={[styles.modalIconWrap, { backgroundColor: colors.errorSoft }]}>
              <AppIcon androidName="delete_forever" iosName="trash.fill" color={colors.error} size={28} fallback="🗑" />
            </View>
            <Text style={styles.modalTitle}>Delete {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'}?</Text>
            <Text style={styles.modalBody}>
              This will permanently delete {selectedFiles.length === 1 ? 'this file' : `these ${selectedFiles.length} files`} from your phone, freeing {formatFreeUpBytes(selectedBytes)}.
              {'\n\n'}Your server backup copies are safe and won&apos;t be affected.
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
                <Text style={[styles.modalBtnText, { color: colors.white }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

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
  selectAllBtn: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  selectAllText: { fontSize: TextScale.sm, fontWeight: '700' },
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
  infoBanner: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginHorizontal: Spacing.four,
    marginTop: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'flex-start',
  },
  infoBannerText: {
    flex: 1,
    fontSize: TextScale.xs,
    fontWeight: '600',
    lineHeight: 18,
  },
  listContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: 2,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.two,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  fileRowSelected: {
    borderColor: colors.primary + '66',
    backgroundColor: colors.primarySoft,
  },
  thumbnail: {
    width: 52,
    height: 52,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileMeta: { flex: 1, gap: 2 },
  fileName: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: colors.text,
  },
  fileDetail: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    fontWeight: '500',
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
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
    marginTop: Spacing.two,
  },
  rescanBtnText: { fontSize: TextScale.sm, fontWeight: '700' },
  ctaBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.surfaceBorder,
    ...Shadows.soft,
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    backgroundColor: colors.error,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.four,
    ...Shadows.soft,
  },
  deleteBtnText: {
    fontSize: TextScale.md,
    fontWeight: '800',
    color: '#fff',
  },
  deletingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    backgroundColor: colors.error,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.four,
  },
  deletingText: { fontSize: TextScale.sm, fontWeight: '700', color: colors.white },
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
});
