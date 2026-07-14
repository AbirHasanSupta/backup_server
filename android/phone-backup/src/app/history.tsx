import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  Alert,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { getSyncHistory, clearSyncHistory } from '../../syncHistory';
import type { SyncSession } from '@/components/HistorySessionCard';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { HistorySessionCard } from '@/components/HistorySessionCard';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const totalMins = Math.floor(totalSecs / 60);
  if (totalMins < 60) {
    const s = totalSecs % 60;
    return s > 0 ? `${totalMins}m ${s}s` : `${totalMins}m`;
  }
  const totalHrs = Math.floor(totalMins / 60);
  if (totalHrs < 24) {
    const m = totalMins % 60;
    return m > 0 ? `${totalHrs}h ${m}m` : `${totalHrs}h`;
  }
  const totalDays = Math.floor(totalHrs / 24);
  if (totalDays < 30) {
    const h = totalHrs % 24;
    return h > 0 ? `${totalDays}d ${h}h` : `${totalDays}d`;
  }
  const totalMonths = Math.floor(totalDays / 30);
  if (totalMonths < 12) {
    const d = totalDays % 30;
    return d > 0 ? `${totalMonths}mo ${d}d` : `${totalMonths}mo`;
  }
  const years = Math.floor(totalMonths / 12);
  const mo = totalMonths % 12;
  return mo > 0 ? `${years}y ${mo}mo` : `${years}y`;
}

// ── Sub-components (outside render to satisfy react-hooks/static-components) ──

interface EmptyStateProps {
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
}

function EmptyState({ styles, colors }: EmptyStateProps) {
  return (
    <View style={styles.emptyContainer}>
      <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
        <AppIcon androidName="history" iosName="clock.arrow.circlepath" color={colors.primary} size={36} fallback="⏳" />
      </View>
      <Text style={styles.emptyTitle}>No sync history yet</Text>
      <Text style={styles.emptySubtitle}>
        Each time a sync completes, stops, or fails, a record will appear here
        so you can verify exactly what was backed up.
      </Text>
    </View>
  );
}

interface ListHeaderProps {
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
  insetTop: number;
  sessionCount: number;
  summary: { totalUploaded: number; totalErrors: number; totalDurationMs: number } | null;
  onClear: () => void;
}

function ListHeader({ styles, colors, insetTop, sessionCount, summary, onClear }: ListHeaderProps) {
  return (
    <>
      {/* Page header */}
      <View style={[styles.pageHeader, { paddingTop: insetTop + Spacing.five }]}>
        <View>
          <Text style={styles.pageTitle}>Sync History</Text>
          <Text style={styles.pageSubtitle}>
            {sessionCount > 0
              ? `${sessionCount} session${sessionCount === 1 ? '' : 's'} recorded`
              : 'Your backup audit trail'}
          </Text>
        </View>
        {sessionCount > 0 && (
          <TouchableOpacity
            onPress={onClear}
            style={styles.clearBtn}
            accessibilityLabel="Clear sync history"
          >
            <AppIcon androidName="delete_sweep" iosName="trash" color={colors.error} size={16} fallback="🗑" />
            <Text style={[styles.clearBtnText, { color: colors.error }]}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Summary banner */}
      {summary && (
        <View style={styles.summaryBanner}>
          <SummaryChip
            icon="cloud_done"
            iosIcon="checkmark.icloud"
            value={summary.totalUploaded.toLocaleString()}
            label="total uploaded"
            color={colors.success}
            colors={colors}
          />
          <View style={styles.bannerDivider} />
          <SummaryChip
            icon="schedule"
            iosIcon="clock"
            value={formatDuration(summary.totalDurationMs)}
            label="total time"
            color={colors.primary}
            colors={colors}
          />
          <View style={styles.bannerDivider} />
          <SummaryChip
            icon="error_outline"
            iosIcon="exclamationmark.circle"
            value={summary.totalErrors.toLocaleString()}
            label="errors"
            color={summary.totalErrors > 0 ? colors.error : colors.textMuted}
            colors={colors}
          />
        </View>
      )}

      <View style={styles.listPad} />
    </>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [sessions, setSessions] = useState<SyncSession[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const data = await getSyncHistory();
    setSessions(data);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const handleClear = useCallback(() => {
    Alert.alert(
      'Clear History',
      "This will permanently remove all sync history from this device. The server's records are not affected.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            await clearSyncHistory();
            setSessions([]);
          },
        },
      ],
    );
  }, []);

  const summary = useMemo(() => {
    if (!sessions.length) return null;
    const totalUploaded   = sessions.reduce((s, r) => s + (r.uploaded ?? 0), 0);
    const totalErrors     = sessions.reduce((s, r) => s + (r.errors ?? 0), 0);
    const totalDurationMs = sessions.reduce((s, r) => s + (r.durationMs ?? 0), 0);
    return { totalUploaded, totalErrors, totalDurationMs };
  }, [sessions]);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={colors.bg === '#0B1220' ? 'light-content' : 'dark-content'} />
      <FlatList<SyncSession>
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <HistorySessionCard session={item} />}
        ListHeaderComponent={
          <ListHeader
            styles={styles}
            colors={colors}
            insetTop={insets.top}
            sessionCount={sessions.length}
            summary={summary}
            onClear={handleClear}
          />
        }
        ListEmptyComponent={<EmptyState styles={styles} colors={colors} />}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: BottomTabInset + Spacing.five },
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
      />
    </View>
  );
}

// ── Summary chip ──────────────────────────────────────────────────────────────
function SummaryChip({
  icon, iosIcon, value, label, color, colors,
}: {
  icon: string; iosIcon: string; value: string;
  label: string; color: string; colors: AppColors;
}) {
  return (
    <View style={{ alignItems: 'center', flex: 1, gap: 3 }}>
      <AppIcon androidName={icon} iosName={iosIcon} color={color} size={18} fallback="·" />
      <Text style={{ fontSize: TextScale.md, fontWeight: '800', color }}>{value}</Text>
      <Text style={{ fontSize: TextScale.xs, color: colors.textMuted, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
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
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    marginTop: Spacing.one,
  },
  clearBtnText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
  summaryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.three,
    ...Shadows.card,
  },
  bannerDivider: {
    width: 1,
    height: 40,
    backgroundColor: colors.surfaceBorder,
  },
  listPad: {
    height: Spacing.four,
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
});
