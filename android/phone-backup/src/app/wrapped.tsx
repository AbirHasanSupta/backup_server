import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, StatusBar, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ViewShot, { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

import { AppColors, Spacing, Radius, TextScale, BottomTabInset } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { StatCard } from '@/components/StatCard';
import { useAppTheme } from '@/hooks/use-app-theme';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import { getYearWrapped } from '../../downloader';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface WrappedStats {
  year: number;
  total: number;
  photos: number;
  videos: number;
  total_size: number;
  busiest_month: number | null;
  busiest_month_count: number;
  month_counts: Record<string, number>;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function WrappedScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<WrappedStats | null>(null);
  const [sharing, setSharing] = useState(false);

  const shotRef = React.useRef<ViewShot>(null);

  const fetchWrapped = useCallback(async (targetYear: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getYearWrapped(targetYear);
      setStats(res);
    } catch (err: any) {
      setError(sanitizeErrorMessage(err, 'Could not load your year in review.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWrapped(year);
  }, [year, fetchWrapped]);

  const photoPct = stats && stats.total > 0 ? Math.round((stats.photos / stats.total) * 100) : 0;
  const videoPct = stats && stats.total > 0 ? 100 - photoPct : 0;

  const handleShare = async () => {
    if (!shotRef.current || sharing) return;
    setSharing(true);
    try {
      const uri = await captureRef(shotRef, { format: 'png', quality: 1 });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: `My ${year} Wrapped` });
      }
    } catch (err) {
      // Sharing is a nice-to-have — swallow silently if the platform can't do it.
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Year Wrapped</Text>
        <TouchableOpacity style={styles.shareBtn} onPress={handleShare} disabled={sharing || loading || !stats}>
          {sharing ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <AppIcon androidName="share" iosName="square.and.arrow.up" color={colors.primary} size={20} />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.yearPickerRow}>
        <TouchableOpacity
          style={styles.yearArrowBtn}
          onPress={() => setYear(y => y - 1)}
          disabled={loading}
        >
          <AppIcon androidName="chevron_left" iosName="chevron.left" color={colors.text} size={18} />
        </TouchableOpacity>
        <Text style={styles.yearLabel}>{year}</Text>
        <TouchableOpacity
          style={styles.yearArrowBtn}
          onPress={() => setYear(y => y + 1)}
          disabled={loading || year >= currentYear}
        >
          <AppIcon
            androidName="chevron_right"
            iosName="chevron.right"
            color={year >= currentYear ? colors.textMuted : colors.text}
            size={18}
          />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Crunching your {year}…</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <AppIcon androidName="cloud_off" iosName="wifi.slash" color={colors.error} size={48} />
          <Text style={styles.errorText}>Server Unreachable</Text>
          <Text style={styles.errorSubtext}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => fetchWrapped(year)}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !stats || stats.total === 0 ? (
        <View style={styles.centered}>
          <View style={styles.emptyIconBg}>
            <AppIcon androidName="insights" iosName="chart.bar.fill" color={colors.primary} size={40} />
          </View>
          <Text style={styles.emptyTitle}>Nothing Backed Up in {year}</Text>
          <Text style={styles.emptySubtitle}>Once you back up photos or videos from {year}, your wrapped card will show up here.</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <ViewShot ref={shotRef} options={{ format: 'png', quality: 1 }}>
            <View style={styles.card}>
              <Text style={styles.cardYear}>{year}</Text>
              <Text style={styles.cardTagline}>Your Year in Photos</Text>

              <Text style={styles.cardTotal}>{stats.total.toLocaleString()}</Text>
              <Text style={styles.cardTotalLabel}>memories captured</Text>

              <View style={styles.ratioBar}>
                <View style={[styles.ratioSegmentPhoto, { flex: Math.max(photoPct, 2) }]} />
                <View style={[styles.ratioSegmentVideo, { flex: Math.max(videoPct, 2) }]} />
              </View>
              <View style={styles.ratioLegendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
                  <Text style={styles.legendText}>{photoPct}% Photos</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: colors.success }]} />
                  <Text style={styles.legendText}>{videoPct}% Videos</Text>
                </View>
              </View>

              <View style={styles.statsGrid}>
                <StatCard
                  icon="photo_camera"
                  iosIcon="camera.fill"
                  label="Photos"
                  value={stats.photos.toLocaleString()}
                />
                <StatCard
                  icon="videocam"
                  iosIcon="video.fill"
                  label="Videos"
                  value={stats.videos.toLocaleString()}
                />
              </View>
              <View style={styles.statsGrid}>
                <StatCard
                  icon="calendar_month"
                  iosIcon="calendar"
                  label="Busiest Month"
                  value={stats.busiest_month ? MONTH_NAMES[stats.busiest_month - 1] : '—'}
                />
                <StatCard
                  icon="sd_storage"
                  iosIcon="externaldrive.fill"
                  label="Total Size"
                  value={formatBytes(stats.total_size)}
                />
              </View>
            </View>
          </ViewShot>
        </ScrollView>
      )}
    </View>
  );
}

const createStyles = (colors: AppColors, insets: any) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: Math.max(insets.top, 12),
      paddingBottom: Spacing.three,
      paddingHorizontal: Spacing.four,
      backgroundColor: colors.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.surfaceBorder,
    },
    backBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.surface,
    },
    headerTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text },
    shareBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },

    yearPickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.five,
      paddingVertical: Spacing.three,
    },
    yearArrowBtn: {
      width: 32, height: 32, borderRadius: 16,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
    },
    yearLabel: { fontSize: TextScale.xl, fontWeight: '900', color: colors.text, minWidth: 80, textAlign: 'center' },

    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.five },
    loadingText: { marginTop: Spacing.three, fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600' },
    errorText: { fontSize: TextScale.lg, fontWeight: '800', color: colors.error, marginTop: Spacing.two },
    errorSubtext: { fontSize: TextScale.xs, color: colors.textSecondary, textAlign: 'center', marginTop: 4 },
    retryBtn: {
      marginTop: Spacing.four,
      paddingHorizontal: Spacing.five,
      paddingVertical: Spacing.two,
      backgroundColor: colors.primary,
      borderRadius: Radius.md,
    },
    retryBtnText: { color: '#fff', fontWeight: '700', fontSize: TextScale.sm },

    emptyIconBg: {
      width: 80, height: 80, borderRadius: 40,
      backgroundColor: colors.primarySoft,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: Spacing.three,
    },
    emptyTitle: { fontSize: TextScale.xl, fontWeight: '800', color: colors.text },
    emptySubtitle: {
      fontSize: TextScale.sm, color: colors.textSecondary, textAlign: 'center',
      marginTop: Spacing.two, maxWidth: 280, lineHeight: 20,
    },

    scrollContent: { padding: Spacing.five, paddingBottom: BottomTabInset + insets.bottom + Spacing.eight },

    card: {
      borderRadius: Radius.xxl,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: Spacing.six,
      alignItems: 'center',
    },
    cardYear: { fontSize: TextScale.hero, fontWeight: '900', color: colors.primary, letterSpacing: -1 },
    cardTagline: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '700', marginTop: -4, marginBottom: Spacing.five },
    cardTotal: { fontSize: 56, fontWeight: '900', color: colors.text, letterSpacing: -1 },
    cardTotalLabel: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600', marginTop: -6, marginBottom: Spacing.five },

    ratioBar: {
      flexDirection: 'row',
      width: '100%',
      height: 14,
      borderRadius: Radius.full,
      overflow: 'hidden',
      backgroundColor: colors.surfaceBorder,
    },
    ratioSegmentPhoto: { backgroundColor: colors.primary },
    ratioSegmentVideo: { backgroundColor: colors.success },
    ratioLegendRow: { flexDirection: 'row', gap: Spacing.five, marginTop: Spacing.three, marginBottom: Spacing.six },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '700' },

    statsGrid: { flexDirection: 'row', gap: Spacing.three, width: '100%', marginBottom: Spacing.three },
  });
