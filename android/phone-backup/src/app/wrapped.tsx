import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, StatusBar, ScrollView, Alert, BackHandler } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ViewShot, { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';

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
  const MIN_WRAPPED_YEAR = 2000;
  const [year, setYear] = useState(currentYear);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<WrappedStats | null>(null);
  const [sharing, setSharing] = useState(false);

  const shotRef = React.useRef<React.ElementRef<typeof ViewShot>>(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/memories');
      return true;
    });
    return () => sub.remove();
  }, [router]);

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
    // Year picker / first load.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      } else {
        Alert.alert('Sharing Unavailable', 'Sharing is not available on this device.');
      }
    } catch (err: any) {
      Alert.alert('Share Failed', sanitizeErrorMessage(err, 'Could not export the wrapped card.'));
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.replace('/memories')}>
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
          onPress={() => setYear(y => Math.max(MIN_WRAPPED_YEAR, y - 1))}
          disabled={loading || year <= MIN_WRAPPED_YEAR}
        >
          <AppIcon
            androidName="chevron_left"
            iosName="chevron.left"
            color={year <= MIN_WRAPPED_YEAR ? colors.textMuted : colors.text}
            size={18}
          />
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
          <ViewShot ref={shotRef} options={{ format: 'png', quality: 1 }} style={{ backgroundColor: colors.bg }}>
            {/* collapsable={false} is required for reliable Android screenshot capture */}
            <View collapsable={false} style={styles.card}>
              <Text style={styles.cardYear}>{year}</Text>
              <Text style={styles.cardTagline}>Your Year in Photos</Text>

              <View style={styles.ratioRing}>
                <View style={[styles.ratioRingHalo, { backgroundColor: colors.primaryGlow }]} />
                <View style={[styles.ratioRingOuter, { borderColor: colors.primary }]}>
                  <View style={[styles.ratioRingInner, { backgroundColor: colors.bg }]}>
                    <Text style={styles.ratioRingPct}>{photoPct}%</Text>
                    <Text style={styles.ratioRingLabel}>photos</Text>
                    <Text style={styles.ratioRingSub}>{videoPct}% videos</Text>
                  </View>
                </View>
              </View>

              <Text style={styles.cardTotal}>{stats.total.toLocaleString()}</Text>
              <Text style={styles.cardTotalLabel}>memories captured</Text>

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

              {Object.values(stats.month_counts || {}).some(c => c > 0) && (
                <View style={styles.monthChart}>
                  <Text style={styles.monthChartTitle}>Photos by month</Text>
                  <View style={styles.monthBarsRow}>
                    {MONTH_NAMES.map((name, idx) => {
                      const raw = stats.month_counts?.[String(idx + 1)] ?? stats.month_counts?.[idx + 1] ?? 0;
                      const count = Number(raw) || 0;
                      const maxCount = Math.max(1, ...Object.values(stats.month_counts || {}).map(v => Number(v) || 0));
                      const barHeight = Math.max(count > 0 ? 6 : 2, Math.round((count / maxCount) * 72));
                      const isBusiest = stats.busiest_month === idx + 1;
                      return (
                        <View key={name} style={styles.monthBarCol}>
                          <View
                            style={[
                              styles.monthBar,
                              {
                                height: barHeight,
                                backgroundColor: isBusiest ? colors.primary : colors.primarySoft,
                              },
                            ]}
                          />
                          <Text style={[styles.monthBarLabel, isBusiest && { color: colors.primary, fontWeight: '800' }]}>
                            {name.slice(0, 1)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </View>
              )}
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
    cardTotal: { fontSize: 56, fontWeight: '900', color: colors.text, letterSpacing: -1, marginTop: Spacing.four },
    cardTotalLabel: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600', marginTop: -6, marginBottom: Spacing.four },

    ratioRing: {
      width: 160,
      height: 160,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Spacing.two,
    },
    ratioRingHalo: {
      position: 'absolute',
      width: 160,
      height: 160,
      borderRadius: 80,
      opacity: 0.35,
    },
    ratioRingOuter: {
      width: 148,
      height: 148,
      borderRadius: 74,
      borderWidth: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ratioRingInner: {
      width: 112,
      height: 112,
      borderRadius: 56,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ratioRingPct: { fontSize: TextScale.xl, fontWeight: '900', color: colors.text },
    ratioRingLabel: { fontSize: TextScale.xs, fontWeight: '700', color: colors.textSecondary, marginTop: -2 },
    ratioRingSub: { fontSize: 10, fontWeight: '600', color: colors.success, marginTop: 2 },

    ratioLegendRow: { flexDirection: 'row', gap: Spacing.five, marginBottom: Spacing.six },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '700' },

    statsGrid: { flexDirection: 'row', gap: Spacing.three, width: '100%', marginBottom: Spacing.three },

    monthChart: { width: '100%', marginTop: Spacing.three },
    monthChartTitle: {
      fontSize: TextScale.xs, fontWeight: '700', color: colors.textSecondary,
      marginBottom: Spacing.three, textAlign: 'center',
    },
    monthBarsRow: {
      flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
      height: 88, width: '100%', gap: 4,
    },
    monthBarCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
    monthBar: { width: '100%', borderRadius: 4, minHeight: 2 },
    monthBarLabel: { fontSize: 10, color: colors.textMuted, marginTop: 4, fontWeight: '600' },
  });