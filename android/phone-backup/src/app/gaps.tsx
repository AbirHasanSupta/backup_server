import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  StatusBar,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  ScrollView,
  RefreshControl,
  DeviceEventEmitter,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { AnimatedListItem } from '@/components/AnimatedListItem';
import { useAppTheme } from '@/hooks/use-app-theme';
import { runSync, getCurrentSyncState } from '../../backgroundTask';
import {
  formatPendingBytes,
  refreshPendingFileList,
  invalidatePendingPreviewCache,
} from '../../pendingPreview';
import { hapticMedium } from '@/utils/haptics';

type GapStatus = 'new' | 'changed';
type GapCategory = 'all' | 'image' | 'video' | 'audio' | 'other';

export type PendingGapFile = {
  relativePath: string;
  name: string;
  size: number;
  modifiedTime: number;
  status: GapStatus;
};

type PendingFileList = {
  files: PendingGapFile[];
  newCount: number;
  changedCount: number;
  pendingBytes: number;
  scanned?: boolean;
  aborted?: boolean;
  noFolders?: boolean;
};

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v', 'wmv', 'flv', 'ts', 'mts']);
const AUDIO_EXTS = new Set(['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'wma', 'aiff']);

const CATEGORY_CHIPS: { id: GapCategory; label: string; icon: string; iosIcon: string }[] = [
  { id: 'all', label: 'All', icon: 'folder', iosIcon: 'folder' },
  { id: 'image', label: 'Photos', icon: 'image', iosIcon: 'photo' },
  { id: 'video', label: 'Videos', icon: 'videocam', iosIcon: 'video' },
  { id: 'audio', label: 'Audio', icon: 'music_note', iosIcon: 'music.note' },
  { id: 'other', label: 'Other', icon: 'insert_drive_file', iosIcon: 'doc' },
];

function getExt(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase();
}

function getFileCategory(name: string): GapCategory {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'other';
}

function categoryIcon(cat: GapCategory): { icon: string; iosIcon: string } {
  switch (cat) {
    case 'image': return { icon: 'image', iosIcon: 'photo' };
    case 'video': return { icon: 'videocam', iosIcon: 'video' };
    case 'audio': return { icon: 'music_note', iosIcon: 'music.note' };
    default: return { icon: 'insert_drive_file', iosIcon: 'doc' };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function folderLabel(relativePath: string): string {
  const parts = relativePath.split('/');
  if (parts.length <= 1) return relativePath;
  return parts.slice(0, -1).join(' / ');
}

interface GapFileRowProps {
  file: PendingGapFile;
  colors: AppColors;
  styles: ReturnType<typeof createStyles>;
}

function GapFileRow({ file, colors, styles }: GapFileRowProps) {
  const cat = getFileCategory(file.name);
  const icons = categoryIcon(cat);
  const isChanged = file.status === 'changed';

  return (
    <View style={styles.fileRow}>
      <View style={[styles.fileIconWrap, { backgroundColor: colors.surfaceSoft }]}>
        <AppIcon androidName={icons.icon} iosName={icons.iosIcon} color={colors.primary} size={16} />
      </View>
      <View style={styles.fileInfo}>
        <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
        <Text style={styles.fileFolder} numberOfLines={1}>{folderLabel(file.relativePath)}</Text>
        <View style={styles.fileMetaRow}>
          <Text style={styles.fileMeta}>{formatSize(file.size)}</Text>
          <Text style={styles.fileMetaDot}>·</Text>
          <Text style={styles.fileMeta}>{formatDate(file.modifiedTime)}</Text>
        </View>
      </View>
      <View style={[styles.statusBadge, isChanged ? styles.statusChanged : styles.statusNew]}>
        <Text style={[styles.statusText, { color: isChanged ? colors.warning : colors.primary }]}>
          {isChanged ? 'Changed' : 'New'}
        </Text>
      </View>
    </View>
  );
}

export default function GapsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [data, setData] = useState<PendingFileList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<GapCategory>('all');

  const abortRef = useRef(false);
  const genRef = useRef(0);

  const load = useCallback(async (opts: { skipScan?: boolean } = {}) => {
    const gen = ++genRef.current;
    abortRef.current = false;

    const snapshot = await getCurrentSyncState().catch(() => null);
    if (gen !== genRef.current) return;
    if (snapshot?.active) {
      setSyncing(true);
      setLoading(false);
      return;
    }
    setSyncing(false);

    if (!opts.skipScan) setLoading(true);
    try {
      const result = await refreshPendingFileList({
        skipScan: !!opts.skipScan,
        shouldStop: () => abortRef.current || genRef.current !== gen,
      });
      if (gen !== genRef.current || result.aborted) return;
      setData(result);
    } catch {
      // Keep prior data visible on transient errors.
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      abortRef.current = false;
      load();
      return () => {
        abortRef.current = true;
        genRef.current += 1;
      };
    }, [load])
  );

  useEffect(() => {
    const subs = [
      DeviceEventEmitter.addListener('sync-started', () => setSyncing(true)),
      DeviceEventEmitter.addListener('sync-completed', () => {
        setSyncing(false);
        invalidatePendingPreviewCache();
        load();
      }),
      DeviceEventEmitter.addListener('sync-failed', () => {
        setSyncing(false);
        load();
      }),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    invalidatePendingPreviewCache();
    await load();
    setRefreshing(false);
  }, [load]);

  const handleBackUp = useCallback(async () => {
    hapticMedium();
    try {
      await runSync();
    } catch {
      load();
    }
  }, [load]);

  const filteredFiles = useMemo(() => {
    const files = data?.files ?? [];
    const q = searchQuery.trim().toLowerCase();
    return files.filter((file) => {
      if (categoryFilter !== 'all' && getFileCategory(file.name) !== categoryFilter) return false;
      if (!q) return true;
      return file.name.toLowerCase().includes(q) || file.relativePath.toLowerCase().includes(q);
    }).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'new' ? -1 : 1;
      return (b.modifiedTime || 0) - (a.modifiedTime || 0);
    });
  }, [data?.files, searchQuery, categoryFilter]);

  const pendingTotal = (data?.newCount ?? 0) + (data?.changedCount ?? 0);
  const isFiltering = searchQuery.trim().length > 0 || categoryFilter !== 'all';

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="Go back">
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Backup Gaps</Text>
          <Text style={styles.headerSubtitle}>
            {loading && !data
              ? 'Scanning your folders…'
              : data?.noFolders
                ? 'No folders selected'
                : pendingTotal > 0
                  ? `${pendingTotal.toLocaleString()} on device, not backed up`
                  : 'Everything is backed up'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={onRefresh}
          disabled={refreshing || loading}
          accessibilityLabel="Refresh gap list"
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={20} />
          )}
        </TouchableOpacity>
      </View>

      {data?.noFolders ? (
        <View style={styles.emptyContainer}>
          <View style={[styles.emptyIconWrap, { backgroundColor: colors.warningSoft }]}>
            <AppIcon androidName="folder_off" iosName="folder.badge.minus" color={colors.warning} size={36} fallback="!" />
          </View>
          <Text style={styles.emptyTitle}>No folders selected</Text>
          <Text style={styles.emptySubtitle}>
            Open Folders and choose at least one folder to see what still needs backing up.
          </Text>
        </View>
      ) : (
        <>
          {pendingTotal > 0 && (
            <Animated.View entering={FadeInDown.duration(350).delay(80)} style={styles.summaryBanner}>
              <SummaryChip
                value={(data?.newCount ?? 0).toLocaleString()}
                label="new"
                color={colors.primary}
                colors={colors}
              />
              <View style={styles.bannerDivider} />
              <SummaryChip
                value={(data?.changedCount ?? 0).toLocaleString()}
                label="changed"
                color={colors.warning}
                colors={colors}
              />
              <View style={styles.bannerDivider} />
              <SummaryChip
                value={formatPendingBytes(data?.pendingBytes ?? 0) || '0 B'}
                label="waiting"
                color={colors.text}
                colors={colors}
              />
            </Animated.View>
          )}

          <View style={[styles.hintBar, { borderBottomColor: colors.surfaceBorder }]}>
            <AppIcon androidName="info_outline" iosName="info.circle" color={colors.textMuted} size={14} />
            <Text style={[styles.hintText, { color: colors.textMuted }]}>
              Local estimate — sync verifies with your server.
            </Text>
          </View>

          {pendingTotal > 0 && (
            <View style={[styles.filterWrap, { borderBottomColor: colors.surfaceBorder }]}>
              <View style={[styles.searchBox, { backgroundColor: colors.surfaceElevated, borderColor: colors.surfaceBorder }]}>
                <AppIcon androidName="search" iosName="magnifyingglass" color={colors.textMuted} size={16} />
                <TextInput
                  style={[styles.searchInput, { color: colors.text }]}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search by name or folder"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  underlineColorAndroid="transparent"
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <AppIcon androidName="close" iosName="xmark.circle.fill" color={colors.textMuted} size={16} />
                  </TouchableOpacity>
                )}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {CATEGORY_CHIPS.map((chip) => {
                  const active = categoryFilter === chip.id;
                  return (
                    <TouchableOpacity
                      key={chip.id}
                      onPress={() => setCategoryFilter(chip.id)}
                      style={[
                        styles.chip,
                        {
                          borderColor: active ? colors.primary : colors.surfaceBorder,
                          backgroundColor: active ? colors.primarySoft : colors.surface,
                        },
                      ]}
                      activeOpacity={0.75}
                    >
                      <AppIcon
                        androidName={chip.icon}
                        iosName={chip.iosIcon}
                        color={active ? colors.primary : colors.textSecondary}
                        size={14}
                      />
                      <Text style={[styles.chipText, { color: active ? colors.primary : colors.textSecondary }]}>
                        {chip.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              {isFiltering && (
                <Text style={[styles.matchCount, { color: colors.textMuted }]}>
                  {filteredFiles.length.toLocaleString()} of {pendingTotal.toLocaleString()} files
                </Text>
              )}
            </View>
          )}

          {loading && !data ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>Finding files not yet backed up…</Text>
            </View>
          ) : (
            <FlatList
              data={filteredFiles}
              keyExtractor={(item) => item.relativePath}
              renderItem={({ item, index }) => (
                <AnimatedListItem index={index}>
                  <GapFileRow file={item} colors={colors} styles={styles} />
                </AnimatedListItem>
              )}
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: BottomTabInset + Spacing.eight + (pendingTotal > 0 ? 72 : 0) },
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
              ListEmptyComponent={
                pendingTotal === 0 ? (
                  <View style={styles.emptyContainer}>
                    <View style={[styles.emptyIconWrap, { backgroundColor: colors.successSoft }]}>
                      <AppIcon androidName="check_circle" iosName="checkmark.circle.fill" color={colors.success} size={36} />
                    </View>
                    <Text style={[styles.emptyTitle, { color: colors.success }]}>All caught up</Text>
                    <Text style={styles.emptySubtitle}>
                      Every file in your selected folders has been backed up to your server.
                    </Text>
                  </View>
                ) : isFiltering ? (
                  <View style={styles.emptyContainer}>
                    <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
                      <AppIcon androidName="search_off" iosName="magnifyingglass" color={colors.primary} size={36} />
                    </View>
                    <Text style={styles.emptyTitle}>No matching files</Text>
                    <Text style={styles.emptySubtitle}>Try a different search or filter.</Text>
                  </View>
                ) : null
              }
            />
          )}

          {pendingTotal > 0 && !syncing && (
            <AnimatedPressable
              style={[styles.fab, { bottom: insets.bottom + Spacing.four }]}
              onPress={handleBackUp}
              scaleDown={0.94}
              accessibilityLabel="Back up pending files now"
            >
              <AppIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" color={colors.white} size={22} />
              <Text style={styles.fabText}>
                Back Up {pendingTotal.toLocaleString()} {pendingTotal === 1 ? 'File' : 'Files'}
              </Text>
            </AnimatedPressable>
          )}

          {syncing && (
            <View style={[styles.syncBanner, { bottom: insets.bottom + Spacing.four, backgroundColor: colors.surface }]}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.syncBannerText, { color: colors.textSecondary }]}>Backup in progress…</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

function SummaryChip({
  value, label, color, colors,
}: {
  value: string; label: string; color: string; colors: AppColors;
}) {
  return (
    <View style={{ alignItems: 'center', flex: 1, gap: 3 }}>
      <Text style={{ fontSize: TextScale.md, fontWeight: '800', color }}>{value}</Text>
      <Text style={{ fontSize: TextScale.xs, color: colors.textMuted, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceBorder,
    gap: Spacing.two,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text },
  headerSubtitle: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '600', marginTop: 2, textAlign: 'center' },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  summaryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.five,
    marginTop: Spacing.four,
    marginBottom: Spacing.two,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  bannerDivider: {
    width: StyleSheet.hairlineWidth,
    height: 32,
    backgroundColor: colors.surfaceBorder,
  },
  hintBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.five,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hintText: { fontSize: TextScale.xs, fontWeight: '500', flex: 1 },
  filterWrap: {
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
    gap: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  searchInput: {
    flex: 1,
    fontSize: TextScale.sm,
    fontWeight: '500',
    paddingVertical: 0,
  },
  chipRow: { gap: Spacing.two, paddingVertical: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  chipText: { fontSize: TextScale.xs, fontWeight: '700' },
  matchCount: { fontSize: TextScale.xs, fontWeight: '600' },
  listContent: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    flexGrow: 1,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two + 2,
    paddingHorizontal: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceBorder,
  },
  fileIconWrap: {
    width: 32,
    height: 32,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileInfo: { flex: 1, minWidth: 0 },
  fileName: { fontSize: TextScale.sm, color: colors.text, fontWeight: '600' },
  fileFolder: { fontSize: TextScale.xs, color: colors.textMuted, fontWeight: '500', marginTop: 1 },
  fileMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  fileMeta: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '500' },
  fileMetaDot: { fontSize: TextScale.xs, color: colors.textMuted },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  statusNew: { backgroundColor: colors.primarySoft },
  statusChanged: { backgroundColor: colors.warningSoft },
  statusText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.3 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.five },
  loadingText: { marginTop: Spacing.three, fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600' },
  emptyContainer: { alignItems: 'center', padding: Spacing.six, paddingTop: Spacing.eight },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.four,
  },
  emptyTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text, marginBottom: Spacing.two },
  emptySubtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 300,
  },
  fab: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three + 2,
    borderRadius: Radius.full,
    backgroundColor: colors.primary,
    ...Shadows.soft,
  },
  fabText: { fontSize: TextScale.sm, fontWeight: '800', color: colors.white },
  syncBanner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    ...Shadows.soft,
  },
  syncBannerText: { fontSize: TextScale.sm, fontWeight: '600' },
});
