import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  StatusBar,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  DeviceEventEmitter,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale, Shadows, BottomTabInset } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { runSync, getCurrentSyncState } from '../../backgroundTask';
import {
  refreshStorageSavingsPreview,
  getCachedStorageSavingsPreview,
  invalidateStorageSavingsCache,
  formatStorageBytes,
} from '../../storageSavingsPreview';
import { getServerIp, getServerName } from '../../settings';
import { checkDeviceConnection } from '../../uploader';
import { hapticMedium, hapticLight } from '@/utils/haptics';

export default function StorageInsightScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [serverName, setServerNameState] = useState('');
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<{
    serverTotalBytes: number;
    serverTotalFiles: number;
    deletableCount: number;
    deletableBytes: number;
    localBackedUpCount?: number;
    serverVerified: boolean;
    noFolders?: boolean;
    noServer?: boolean;
  } | null>(null);

  const abortRef = useRef(false);
  const genRef = useRef(0);

  const checkConnection = useCallback(async () => {
    try {
      const ip = await getServerIp();
      const name = await getServerName();
      setServerNameState(name || ip || 'Server');
      if (!ip) {
        setServerOnline(false);
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await checkDeviceConnection({ signal: controller.signal });
      clearTimeout(timeout);
      setServerOnline(res.connected);
    } catch {
      setServerOnline(false);
    }
  }, []);

  const loadData = useCallback(async (force = false) => {
    const gen = ++genRef.current;
    abortRef.current = false;

    if (!force) {
      const cached = await getCachedStorageSavingsPreview();
      if (cached && gen === genRef.current) {
        setPreview(cached);
        setLoading(false);
      }
    }

    try {
      const result = await refreshStorageSavingsPreview({
        force,
        shouldStop: () => abortRef.current || genRef.current !== gen,
      });

      if (gen === genRef.current && result && !result.aborted) {
        setPreview(result);
      }
    } catch {
      // keep prior preview if available
    } finally {
      if (gen === genRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      checkConnection();
      loadData(false);
      getCurrentSyncState().then((s) => setSyncing(!!s?.active)).catch(() => {});

      const onSyncState = (s: any) => setSyncing(!!s?.active);
      const onSyncCompleted = () => {
        invalidateStorageSavingsCache();
        loadData(true);
      };

      const sub1 = DeviceEventEmitter.addListener('sync-state', onSyncState);
      const sub2 = DeviceEventEmitter.addListener('sync-completed', onSyncCompleted);

      return () => {
        abortRef.current = true;
        genRef.current += 1;
        sub1.remove();
        sub2.remove();
      };
    }, [checkConnection, loadData])
  );

  const handleRefresh = useCallback(() => {
    hapticLight();
    setRefreshing(true);
    invalidateStorageSavingsCache();
    checkConnection();
    loadData(true);
  }, [checkConnection, loadData]);

  const handleStartSync = useCallback(async () => {
    hapticMedium();
    try {
      await runSync();
      router.push('/');
    } catch {}
  }, [router]);

  const serverBytesLabel = formatStorageBytes(preview?.serverTotalBytes || 0) || '0 B';
  const deletableBytesLabel = formatStorageBytes(preview?.deletableBytes || 0) || '0 B';
  const serverFilesCount = (preview?.serverTotalFiles || 0).toLocaleString();
  const deletableFilesCount = (preview?.deletableCount || 0).toLocaleString();

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="Go back">
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Storage Insight</Text>
          <Text style={styles.headerSubtitle}>Server totals & reclaimable phone space</Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={handleRefresh}
          disabled={refreshing || loading}
          accessibilityLabel="Refresh storage insight"
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={22} />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: BottomTabInset + insets.bottom + Spacing.six },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        {loading && !preview ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>Analyzing storage & verifying server totals…</Text>
          </View>
        ) : preview?.noFolders ? (
          <View style={styles.emptyCard}>
            <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
              <AppIcon androidName="folder_open" iosName="folder.badge.plus" color={colors.primary} size={32} />
            </View>
            <Text style={styles.emptyTitle}>No folders selected</Text>
            <Text style={styles.emptySubtitle}>Select folders in Settings to start tracking storage insights.</Text>
            <AnimatedPressable
              style={[styles.actionBtn, { backgroundColor: colors.primary, marginTop: Spacing.four }]}
              onPress={() => router.push('/settings')}
              scaleDown={0.96}
            >
              <Text style={styles.actionBtnText}>Choose Folders</Text>
            </AnimatedPressable>
          </View>
        ) : (
          <>
            {/* Server Storage Total Card */}
            <Animated.View entering={FadeInDown.duration(400).delay(100)} style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <View style={[styles.iconWrap, { backgroundColor: colors.primarySoft }]}>
                  <AppIcon androidName="cloud_done" iosName="checkmark.icloud.fill" color={colors.primary} size={22} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardKicker}>On Backup Server</Text>
                  <Text style={styles.cardMainStat}>{serverBytesLabel}</Text>
                </View>
                {preview?.serverVerified ? (
                  <View style={[styles.badge, { backgroundColor: colors.successSoft }]}>
                    <AppIcon androidName="verified" iosName="checkmark.seal.fill" color={colors.success} size={12} />
                    <Text style={[styles.badgeText, { color: colors.success }]}>Verified</Text>
                  </View>
                ) : serverOnline === false ? (
                  <View style={[styles.badge, { backgroundColor: colors.warningSoft }]}>
                    <Text style={[styles.badgeText, { color: colors.warning }]}>Server offline</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.divider} />

              <View style={styles.statGrid}>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Backed Up Files</Text>
                  <Text style={styles.statValue}>{serverFilesCount}</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Target Server</Text>
                  <Text style={styles.statValue} numberOfLines={1}>
                    {serverName || 'Connected PC'}
                  </Text>
                </View>
              </View>
            </Animated.View>

            {/* Reclaimable Storage Card */}
            <Animated.View entering={FadeInDown.duration(400).delay(180)} style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <View style={[styles.iconWrap, { backgroundColor: colors.infoSoft }]}>
                  <AppIcon androidName="delete_sweep" iosName="trash.circle.fill" color={colors.info} size={22} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardKicker}>Space You Can Reclaim</Text>
                  <Text style={styles.cardMainStat}>{deletableBytesLabel}</Text>
                </View>
              </View>

              <Text style={styles.cardDesc}>
                {preview && preview.deletableCount > 0
                  ? `${deletableFilesCount} files are safely backed up on your computer. You can delete these originals from your phone to free up space.`
                  : 'All your current photos and files are either still pending backup or already matched on your server.'}
              </Text>

              <View style={styles.divider} />

              <View style={styles.footnoteRow}>
                <AppIcon androidName="shield" iosName="lock.shield" color={colors.textMuted} size={14} />
                <Text style={styles.footnoteText}>
                  Originals on your computer remain completely safe even if removed locally from your device.
                </Text>
              </View>
            </Animated.View>

            {/* Quick Actions Card */}
            <Animated.View entering={FadeInDown.duration(400).delay(260)} style={styles.actionCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionCardTitle}>Check files waiting for backup</Text>
                <Text style={styles.actionCardSubtitle}>See photos and files on this device that are not yet backed up.</Text>
              </View>
              <AnimatedPressable
                style={[styles.viewGapsBtn, { backgroundColor: colors.surfaceElevated, borderColor: colors.surfaceBorder }]}
                onPress={() => {
                  hapticMedium();
                  router.push('/gaps');
                }}
                scaleDown={0.94}
                accessibilityLabel="View files on this device"
              >
                <Text style={[styles.viewGapsBtnText, { color: colors.primary }]}>View Files</Text>
                <AppIcon androidName="chevron_right" iosName="chevron.right" color={colors.primary} size={16} />
              </AnimatedPressable>
            </Animated.View>

            {serverOnline && !syncing && (
              <Animated.View entering={FadeInDown.duration(400).delay(320)}>
                <AnimatedPressable
                  style={[styles.syncNowCardBtn, { backgroundColor: colors.primary }]}
                  onPress={handleStartSync}
                  scaleDown={0.97}
                  accessibilityLabel="Start backup now"
                >
                  <AppIcon androidName="sync" iosName="arrow.triangle.2.circlepath" color="#fff" size={18} />
                  <Text style={styles.syncNowCardBtnText}>Sync Now</Text>
                </AnimatedPressable>
              </Animated.View>
            )}

            {syncing && (
              <View style={[styles.syncingBanner, { backgroundColor: colors.primarySoft }]}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.syncingBannerText, { color: colors.primary }]}>
                  Backup in progress… totals will update when finished.
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.four,
      paddingBottom: Spacing.three,
    },
    backBtn: {
      width: 40,
      height: 40,
      borderRadius: Radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    refreshBtn: {
      width: 40,
      height: 40,
      borderRadius: Radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerCenter: {
      flex: 1,
      marginHorizontal: Spacing.two,
    },
    headerTitle: {
      fontSize: TextScale.lg,
      fontWeight: '800',
      color: colors.text,
      letterSpacing: -0.3,
    },
    headerSubtitle: {
      fontSize: TextScale.xs,
      color: colors.textSecondary,
      fontWeight: '500',
      marginTop: 2,
    },
    scrollContent: {
      paddingHorizontal: Spacing.four,
      paddingTop: Spacing.two,
      gap: Spacing.four,
    },
    loadingBox: {
      paddingVertical: Spacing.eight,
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.three,
    },
    loadingText: {
      fontSize: TextScale.sm,
      color: colors.textSecondary,
      fontWeight: '500',
      textAlign: 'center',
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: Spacing.five,
      ...Shadows.card,
    },
    cardHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.three,
    },
    iconWrap: {
      width: 46,
      height: 46,
      borderRadius: Radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardKicker: {
      fontSize: TextScale.xs,
      fontWeight: '700',
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    cardMainStat: {
      fontSize: TextScale.xxl,
      fontWeight: '900',
      color: colors.text,
      marginTop: 2,
    },
    cardDesc: {
      fontSize: TextScale.sm,
      color: colors.textSecondary,
      fontWeight: '500',
      lineHeight: 20,
      marginTop: Spacing.three,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.surfaceBorder,
      marginVertical: Spacing.four,
    },
    statGrid: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    statItem: {
      flex: 1,
    },
    statLabel: {
      fontSize: TextScale.xs,
      color: colors.textMuted,
      fontWeight: '600',
    },
    statValue: {
      fontSize: TextScale.md,
      fontWeight: '800',
      color: colors.text,
      marginTop: 2,
    },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: Spacing.two + 2,
      paddingVertical: Spacing.one,
      borderRadius: Radius.full,
    },
    badgeText: {
      fontSize: TextScale.xs,
      fontWeight: '700',
    },
    footnoteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
    },
    footnoteText: {
      flex: 1,
      fontSize: TextScale.xs,
      color: colors.textMuted,
      fontWeight: '500',
      lineHeight: 16,
    },
    actionCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: Spacing.four,
      gap: Spacing.three,
      ...Shadows.card,
    },
    actionCardTitle: {
      fontSize: TextScale.sm,
      fontWeight: '800',
      color: colors.text,
    },
    actionCardSubtitle: {
      fontSize: TextScale.xs,
      color: colors.textSecondary,
      fontWeight: '500',
      marginTop: 2,
    },
    viewGapsBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: Spacing.three,
      paddingVertical: Spacing.two,
      borderRadius: Radius.lg,
      borderWidth: 1,
    },
    viewGapsBtnText: {
      fontSize: TextScale.xs,
      fontWeight: '700',
    },
    emptyCard: {
      backgroundColor: colors.surface,
      borderRadius: Radius.xl,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: Spacing.six,
      alignItems: 'center',
      textAlign: 'center',
      ...Shadows.card,
    },
    emptyIconWrap: {
      width: 60,
      height: 60,
      borderRadius: Radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Spacing.three,
    },
    emptyTitle: {
      fontSize: TextScale.md,
      fontWeight: '800',
      color: colors.text,
      marginBottom: Spacing.one,
    },
    emptySubtitle: {
      fontSize: TextScale.sm,
      color: colors.textSecondary,
      textAlign: 'center',
      fontWeight: '500',
    },
    actionBtn: {
      paddingHorizontal: Spacing.five,
      paddingVertical: Spacing.three,
      borderRadius: Radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionBtnText: {
      color: '#fff',
      fontSize: TextScale.sm,
      fontWeight: '800',
    },
    syncingBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      padding: Spacing.three,
      borderRadius: Radius.lg,
    },
    syncingBannerText: {
      fontSize: TextScale.xs,
      fontWeight: '600',
    },
    syncNowCardBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.two,
      paddingVertical: Spacing.three + 2,
      borderRadius: Radius.lg,
      ...Shadows.card,
    },
    syncNowCardBtnText: {
      fontSize: TextScale.sm,
      fontWeight: '800',
      color: '#fff',
    },
  });
