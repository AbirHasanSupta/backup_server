import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  StatusBar,
  Alert,
  DeviceEventEmitter,
  RefreshControl,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  getCurrentSyncState,
  stopCurrentSync,
  forceStopCurrentSync,
  runSync,
} from '../../backgroundTask';
import { checkDeviceConnection } from '../../uploader';
import {
  getServerIp,
  getServerName,
  getLastSyncTime,
  getTotalSynced,
  getSyncInterval,
  getSyncPaused,
  getFolders,
  formatSyncIntervalLabel,
} from '../../settings';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { SyncProgressRing, SyncPhase } from '@/components/SyncProgressRing';
import { StatCard } from '@/components/StatCard';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useCollapsibleHeader } from '@/hooks/useCollapsibleHeader';

function formatRelativeTime(ts: number | null): string {
  if (!ts) return 'Never';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function applyProgressUpdate(
  current: number,
  total: number,
  detail: any,
  setters: {
    setPhase: (p: SyncPhase) => void;
    setProgress: (n: number) => void;
    setUploaded: (n: number) => void;
    setTotal: (n: number) => void;
    setChecked: (n: number) => void;
    setCheckTotal: (n: number) => void;
    setStatusMessage: (s: string) => void;
  }
) {
  if (detail?.stopping) {
    setters.setPhase('stopping');
    setters.setUploaded(current || 0);
    setters.setTotal(total || 0);
    setters.setProgress(total > 0 ? Math.round((current / total) * 100) : 0);
    const fileName = detail?.currentFile ? (detail.currentFile.split('/').pop() || detail.currentFile) : '';
    setters.setStatusMessage(fileName ? `Finishing ${fileName}` : 'Stopping backup');
    return;
  }

  if (detail?.phase === 'scanning') {
    const scannedFiles = detail.files || 0;
    setters.setPhase('scanning');
    setters.setProgress(0);
    setters.setUploaded(0);
    setters.setTotal(0);
    setters.setStatusMessage(
      scannedFiles
        ? `Scanning files: ${scannedFiles.toLocaleString()} found`
        : 'Scanning your selected folders'
    );
    return;
  }

  if (detail?.phase === 'checking') {
    const checked = detail.checked || 0;
    const count = detail.total || 0;
    setters.setPhase('checking');
    setters.setChecked(checked);
    setters.setCheckTotal(count);
    setters.setProgress(count > 0 ? Math.round((checked / count) * 100) : 0);
    setters.setUploaded(0);
    setters.setTotal(0);
    setters.setStatusMessage(
      count > 0
        ? `Checking server: ${checked.toLocaleString()} / ${count.toLocaleString()}`
        : 'Checking server'
    );
    return;
  }

  setters.setPhase('uploading');
  setters.setUploaded(current);
  setters.setTotal(total);
  setters.setProgress(total > 0 ? Math.round((current / total) * 100) : 0);
  if (detail?.currentFile && current < total) {
    const name = detail.currentFile.split('/').pop() || detail.currentFile;
    setters.setStatusMessage(`Uploading ${name}`);
  } else if (total > 0) {
    const remaining = Math.max(total - current, 0);
    setters.setStatusMessage(`${current}/${total} uploaded - ${remaining} remaining`);
  }
}

type ServerStatus = 'connected' | 'disconnected' | 'removed' | 'unknown' | 'checking';

const HEADER_HEIGHT = 140;

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [syncing, setSyncing] = useState(false);
  const [phase, setPhase] = useState<SyncPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [checked, setChecked] = useState(0);
  const [checkTotal, setCheckTotal] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  const [lastSyncTime, setLastSyncTimeState] = useState<number | null>(null);
  const [totalSynced, setTotalSyncedState] = useState(0);
  const [syncInterval, setSyncIntervalState] = useState(15);
  const [syncPaused, setSyncPausedState] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [forceStopPressedAt, setForceStopPressedAt] = useState<number | null>(null);
  const [, setRelativeTimeTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const DOUBLE_TAP_WINDOW_MS = 1200;

  const [serverStatus, setServerStatus] = useState<ServerStatus>('unknown');
  const [serverLabel, setServerLabel] = useState('No server');

  const { onScroll, headerAnimatedStyle, contentInsetStyle, onHeaderLayout } = useCollapsibleHeader({
    headerHeight: HEADER_HEIGHT,
    topInset: insets.top,
  });

  const loadAll = useCallback(async () => {
    const [lt, ts, si, paused, ip, name] = await Promise.all([
      getLastSyncTime(),
      getTotalSynced(),
      getSyncInterval(),
      getSyncPaused(),
      getServerIp(),
      getServerName(),
    ]);

    setLastSyncTimeState(lt);
    setTotalSyncedState(ts);
    setSyncIntervalState(si);
    setSyncPausedState(paused);
    setServerLabel(name || ip || 'No server');

    if (!ip) {
      setServerStatus('unknown');
      return;
    }

    // Keep connected status visible while re-probing to avoid Sync Now flicker.
    setServerStatus(prev => (prev === 'connected' ? prev : 'checking'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const result = await checkDeviceConnection({ signal: controller.signal });
      clearTimeout(timeout);
      setServerStatus(result.connected ? 'connected' : 'removed');
    } catch {
      clearTimeout(timeout);
      setServerStatus('disconnected');
    }
  }, []);

  const applySyncSnapshot = useCallback((snapshot: any) => {
    if (!snapshot?.active) {
      setSyncing(false);
      setStopRequested(false);
      setForceStopPressedAt(null);
      setPhase('idle');
      return;
    }

    setSyncing(true);
    setStopRequested((prev) => prev || !!snapshot.stopping);

    const detail = {
      ...(snapshot.detail || {}),
      phase: snapshot.phase || snapshot.detail?.phase || 'uploading',
      stopping: !!snapshot.stopping,
    };

    applyProgressUpdate(snapshot.current || 0, snapshot.total || 0, detail, {
      setPhase,
      setProgress,
      setUploaded,
      setTotal,
      setChecked,
      setCheckTotal,
      setStatusMessage,
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadAll();
      getCurrentSyncState().then(applySyncSnapshot).catch(() => {});
    }, [applySyncSnapshot, loadAll])
  );

  useEffect(() => {
    const id = setInterval(() => setRelativeTimeTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      loadAll();
    }, 15000);
    return () => clearInterval(id);
  }, [loadAll]);

  useEffect(() => {
    const id = setInterval(() => {
      getCurrentSyncState().then(applySyncSnapshot).catch(() => {});
    }, syncing ? 1000 : 2500);
    return () => clearInterval(id);
  }, [applySyncSnapshot, syncing]);

  useEffect(() => {
    const onStarted = () => {
      setSyncing(true);
      setStopRequested(false);
      setForceStopPressedAt(null);
      setPhase('scanning');
      setProgress(0);
      setUploaded(0);
      setTotal(0);
      setChecked(0);
      setCheckTotal(0);
      setStatusMessage('Starting backup');
    };

    const onProgress = ({
      current,
      total: tot,
      detail,
    }: {
      current: number;
      total: number;
      detail?: any;
    }) => {
      setSyncing(true);
      if (detail?.stopping) setStopRequested(true);
      applyProgressUpdate(current, tot, detail, {
        setPhase,
        setProgress,
        setUploaded,
        setTotal,
        setChecked,
        setCheckTotal,
        setStatusMessage,
      });
    };

    const onCompleted = (data: {
      lastSyncTime?: number;
      totalSynced?: number;
      uploaded?: number;
      skipped?: number;
      errors?: number;
      stopped?: boolean;
    }) => {
      setSyncing(false);
      setStopRequested(false);
      setForceStopPressedAt(null);
      setPhase('idle');
      if (data.lastSyncTime) setLastSyncTimeState(data.lastSyncTime);
      if (data.totalSynced) setTotalSyncedState(data.totalSynced);

      const uploadedCount = data.uploaded ?? 0;
      const errorCount = data.errors ?? 0;
      const skippedCount = data.skipped ?? 0;

      if (data.stopped) {
        setStatusMessage(`Stopped - ${uploadedCount} file${uploadedCount !== 1 ? 's' : ''} backed up`);
      } else if (errorCount > 0) {
        setStatusMessage(
          uploadedCount > 0
            ? `${uploadedCount} backed up, ${errorCount} failed`
            : `${errorCount} file${errorCount !== 1 ? 's' : ''} need attention; ${skippedCount} already backed up`
        );
      } else {
        setStatusMessage(
          uploadedCount > 0
            ? `${uploadedCount} file${uploadedCount !== 1 ? 's' : ''} backed up`
            : 'Everything is already up to date'
        );
      }
    };

    const onFailed = ({ message }: { message?: string }) => {
      setSyncing(false);
      setStopRequested(false);
      setForceStopPressedAt(null);
      setPhase('idle');
      setStatusMessage(message || 'Backup failed. Check your connection.');
    };

    const subs = [
      DeviceEventEmitter.addListener('sync-started', onStarted),
      DeviceEventEmitter.addListener('sync-progress', onProgress),
      DeviceEventEmitter.addListener('sync-state', applySyncSnapshot),
      DeviceEventEmitter.addListener('sync-completed', onCompleted),
      DeviceEventEmitter.addListener('sync-failed', onFailed),
      DeviceEventEmitter.addListener('settings-updated', loadAll),
    ];

    return () => subs.forEach((sub) => sub.remove());
  }, [applySyncSnapshot, loadAll]);

  const handleSync = async () => {
    const snapshot = await getCurrentSyncState().catch(() => null);

    if (syncing || snapshot?.active) {
      if (snapshot?.active) applySyncSnapshot(snapshot);

      if (stopRequested || snapshot?.stopping) {
        const now = Date.now();
        const isDoubleTap = forceStopPressedAt !== null && (now - forceStopPressedAt) < DOUBLE_TAP_WINDOW_MS;

        if (isDoubleTap) {
          setForceStopPressedAt(null);
          setStopRequested(false);
          setSyncing(false);
          setPhase('idle');
          setStatusMessage('Backup force-stopped');
          await forceStopCurrentSync();
        } else {
          setForceStopPressedAt(now);
        }
        return;
      }

      const changed = await stopCurrentSync();
      if (changed) {
        setStopRequested(true);
        setForceStopPressedAt(null);
        setPhase('stopping');
        setStatusMessage('Finishing current file, then stopping…');
      } else {
        const latest = await getCurrentSyncState().catch(() => null);
        if (latest?.stopping || latest?.stopRequested) {
          setStopRequested(true);
          setPhase('stopping');
          setStatusMessage('Finishing current file, then stopping…');
        }
      }
      return;
    }

    // New syncs require connectivity; allow stop/force-stop while an active sync runs.
    if (
      serverStatus === 'disconnected' ||
      serverStatus === 'unknown' ||
      serverStatus === 'removed'
    ) {
      return;
    }

    const ip = await getServerIp();
    if (!ip) {
      Alert.alert(
        'No server configured',
        'Open Settings to enter your server IP address, or use Discover to find it on your network.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      const status = await checkDeviceConnection();
      if (!status.connected) {
        setServerStatus('removed');
        Alert.alert(
          'Device disconnected',
          'This phone was removed from the desktop app. Open Settings to connect again.',
          [{ text: 'OK' }]
        );
        return;
      }
      setServerStatus('connected');
    } catch {
      setServerStatus('disconnected');
      Alert.alert(
        'Server unreachable',
        'Make sure the desktop app is running and both devices are on the same Wi-Fi network.',
        [{ text: 'OK' }]
      );
      return;
    }

    const folders = await getFolders();
    if (folders.length === 0) {
      Alert.alert(
        'No folders selected',
        'Open Folders and add at least one folder before starting a backup.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      await runSync();
    } catch {}
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const statusColors: Record<ServerStatus, string> = {
    connected: colors.success,
    disconnected: colors.error,
    removed: colors.error,
    checking: colors.warning,
    unknown: colors.textMuted,
  };

  const statusLabels: Record<ServerStatus, string> = {
    connected: serverLabel,
    disconnected: 'Offline',
    removed: 'Disconnected',
    checking: 'Checking',
    unknown: 'No server',
  };

  const intervalLabel = formatSyncIntervalLabel(syncInterval);

  const serverColor = statusColors[serverStatus];

  const isOffline = serverStatus === 'disconnected' || serverStatus === 'unknown' || serverStatus === 'removed';

  return (
    <View style={styles.screen}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <Animated.View
        onLayout={onHeaderLayout}
        style={[styles.header, headerAnimatedStyle, { backgroundColor: colors.bg }]}
      >
        <View style={styles.titleBlock}>
          <Text style={styles.kicker}>Private phone backup</Text>
          <Text style={styles.appTitle}>Everything safe, quietly.</Text>
          <Text style={styles.appSubtitle}>Your folders sync to your own computer.</Text>
        </View>
        <AnimatedPressable style={[styles.serverPill, { borderColor: serverColor }]} onPress={loadAll}>
          <View style={[styles.statusDot, { backgroundColor: serverColor }]} />
          <Text style={[styles.serverPillText, { color: serverColor }]} numberOfLines={1}>
            {statusLabels[serverStatus]}
          </Text>
        </AnimatedPressable>
      </Animated.View>

      <Animated.View style={contentInsetStyle}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: BottomTabInset + insets.bottom + 34 },
        ]}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        <Animated.View entering={FadeInDown.duration(400).delay(100)} style={styles.heroPanel}>
          <SyncProgressRing
            isActive={syncing}
            progress={progress}
            uploaded={uploaded}
            total={total}
            phase={syncing ? phase : 'idle'}
            checked={checked}
            checkTotal={checkTotal}
          />
          {statusMessage ? <Text style={styles.statusMsg}>{statusMessage}</Text> : null}
          {syncPaused && !syncing && (
            <View style={styles.pausedBadge}>
              <AppIcon androidName="pause" iosName="pause.fill" color={colors.warning} size={14} fallback="P" />
              <Text style={styles.pausedText}>Auto sync paused</Text>
            </View>
          )}
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(200)} style={styles.statsRow}>
          <StatCard
            icon="inventory_2"
            iosIcon="archivebox"
            label="Files synced"
            value={totalSynced > 0 ? totalSynced.toLocaleString() : '-'}
            tint={colors.primary}
            dimColor={colors.primarySoft}
          />
          <StatCard
            icon="history"
            iosIcon="clock.arrow.circlepath"
            label="Last sync"
            value={formatRelativeTime(lastSyncTime)}
            tint={colors.success}
            dimColor={colors.successSoft}
          />
          <StatCard
            icon="schedule"
            iosIcon="timer"
            label="Interval"
            value={syncPaused ? 'Paused' : intervalLabel}
            tint={syncPaused ? colors.textMuted : colors.warning}
            dimColor={colors.warningSoft}
          />
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(300)}>
          <AnimatedPressable
            id="sync-now-button"
            style={[
              styles.syncBtn,
              syncing && !stopRequested && styles.syncBtnStop,
              stopRequested && !forceStopPressedAt && styles.syncBtnStopping,
              stopRequested && !!forceStopPressedAt && styles.syncBtnForceHint,
              isOffline && !syncing && styles.disabledBtn,
            ]}
            onPress={handleSync}
            disabled={isOffline && !syncing}
            scaleDown={0.96}
            accessibilityLabel={
              syncing
                ? stopRequested
                  ? forceStopPressedAt
                    ? 'Tap again to force stop'
                    : 'Stopping sync — tap again to force stop'
                  : 'Stop sync'
                : isOffline
                  ? 'Sync unavailable while offline'
                  : 'Sync now'
            }
          >
            {syncing ? (
              stopRequested ? (
                <View style={styles.syncBtnInner}>
                  <AppIcon
                    androidName={forceStopPressedAt ? 'warning' : 'hourglass_top'}
                    iosName={forceStopPressedAt ? 'exclamationmark.triangle.fill' : 'hourglass'}
                    color={colors.white}
                    size={20}
                    fallback="!"
                  />
                  <View>
                    <Text style={styles.syncBtnText}>
                      {forceStopPressedAt ? 'Tap again to force stop' : 'Stopping…'}
                    </Text>
                    {!forceStopPressedAt && (
                      <Text style={styles.syncBtnHint}>Double-tap to force stop</Text>
                    )}
                  </View>
                </View>
              ) : (
                <View style={styles.syncBtnInner}>
                  <AppIcon
                    androidName="stop"
                    iosName="stop.fill"
                    color={colors.white}
                    size={20}
                    fallback="S"
                  />
                  <Text style={styles.syncBtnText}>Stop Sync</Text>
                </View>
              )
            ) : (
              <View style={styles.syncBtnInner}>
                <AppIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" color={colors.white} size={20} fallback="UP" />
                <Text style={styles.syncBtnText}>Sync Now</Text>
              </View>
            )}
          </AnimatedPressable>
        </Animated.View>

        {serverStatus === 'unknown' && (
          <Animated.View entering={FadeIn.duration(300)} style={styles.noticeCard}>
            <View style={styles.noticeIcon}>
              <AppIcon androidName="wifi_off" iosName="wifi.slash" color={colors.warning} size={20} fallback="!" />
            </View>
            <View style={styles.noticeCopy}>
              <Text style={styles.noticeTitle}>Connect a server</Text>
              <Text style={styles.noticeBody}>
                Open Settings to enter your server IP, or use Discover to find it automatically.
              </Text>
            </View>
          </Animated.View>
        )}

        {serverStatus === 'disconnected' && (
          <Animated.View entering={FadeIn.duration(300)} style={[styles.noticeCard, styles.errorCard]}>
            <View style={[styles.noticeIcon, styles.errorIcon]}>
              <AppIcon androidName="error" iosName="exclamationmark.triangle" color={colors.error} size={20} fallback="!" />
            </View>
            <View style={styles.noticeCopy}>
              <Text style={[styles.noticeTitle, { color: colors.error }]}>Server unreachable</Text>
              <Text style={styles.noticeBody}>
                Make sure the desktop app is running and both devices are on the same Wi-Fi network.
              </Text>
            </View>
          </Animated.View>
        )}

        {serverStatus === 'removed' && (
          <Animated.View entering={FadeIn.duration(300)} style={[styles.noticeCard, styles.errorCard]}>
            <View style={[styles.noticeIcon, styles.errorIcon]}>
              <AppIcon androidName="link_off" iosName="link.badge.minus" color={colors.error} size={20} fallback="!" />
            </View>
            <View style={styles.noticeCopy}>
              <Text style={[styles.noticeTitle, { color: colors.error }]}>Device disconnected</Text>
              <Text style={styles.noticeBody}>
                This phone was removed from the desktop app. Open Settings to connect again.
              </Text>
            </View>
          </Animated.View>
        )}
      </ScrollView>
      </Animated.View>
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: Spacing.six,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.four,
    backgroundColor: colors.bg,
  },
  titleBlock: {
    gap: Spacing.one,
  },
  kicker: {
    color: colors.primary,
    fontSize: TextScale.xs,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  appTitle: {
    fontSize: TextScale.xl,
    fontWeight: '900',
    color: colors.text,
  },
  appSubtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  serverPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: colors.surface,
    maxWidth: '100%',
    gap: 7,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: Radius.full,
  },
  serverPillText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  scrollContent: {
    paddingHorizontal: Spacing.six,
    gap: Spacing.six,
  },
  heroPanel: {
    alignItems: 'center',
    gap: Spacing.four,
    paddingVertical: Spacing.six,
    borderRadius: Radius.xxl,
    backgroundColor: colors.surfaceSoft,
  },
  statusMsg: {
    fontSize: TextScale.base,
    color: colors.textSecondary,
    textAlign: 'center',
    fontWeight: '700',
    paddingHorizontal: Spacing.five,
  },
  pausedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: colors.warningSoft,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.four,
    paddingVertical: 7,
  },
  pausedText: {
    fontSize: TextScale.xs,
    color: colors.warning,
    fontWeight: '800',
  },
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  syncBtn: {
    minHeight: 56,
    backgroundColor: colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.soft,
  },
  syncBtnBusy: {
    opacity: 0.92,
  },
  disabledBtn: {
    opacity: 0.45,
  },
  syncBtnStop: {
    backgroundColor: colors.error,
  },
  syncBtnStopping: {
    backgroundColor: colors.warning,
    opacity: 1,
  },
  syncBtnForceHint: {
    backgroundColor: '#C2410C',
    opacity: 1,
  },
  syncBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  syncBtnText: {
    fontSize: TextScale.md,
    fontWeight: '900',
    color: colors.white,
  },
  syncBtnHint: {
    fontSize: TextScale.xs,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.75)',
    textAlign: 'center',
    marginTop: 2,
  },
  noticeCard: {
    flexDirection: 'row',
    gap: Spacing.three,
    backgroundColor: colors.warningSoft,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    padding: Spacing.four,
  },
  errorCard: {
    backgroundColor: colors.errorSoft,
    borderColor: colors.errorBorder,
  },
  noticeIcon: {
    width: 38,
    height: 38,
    borderRadius: Radius.full,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorIcon: {
    backgroundColor: colors.surface,
  },
  noticeCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  noticeTitle: {
    fontSize: TextScale.base,
    fontWeight: '900',
    color: colors.warning,
  },
  noticeBody: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    lineHeight: 20,
    fontWeight: '600',
  },
});
