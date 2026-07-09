import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
  Alert,
  DeviceEventEmitter,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { runSync } from '../../backgroundTask';
import {
  getServerIp,
  getServerPort,
  getServerName,
  getLastSyncTime,
  getTotalSynced,
  getSyncInterval,
  getSyncPaused,
  getFolders,
} from '../../settings';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { SyncProgressRing, SyncPhase } from '@/components/SyncProgressRing';
import { StatCard } from '@/components/StatCard';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

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
  if (detail?.phase === 'scanning') {
    setters.setPhase('scanning');
    setters.setProgress(0);
    setters.setUploaded(0);
    setters.setTotal(0);
    setters.setStatusMessage(
      detail.files
        ? `Scanning files: ${detail.files.toLocaleString()} found`
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

type ServerStatus = 'connected' | 'disconnected' | 'unknown' | 'checking';

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
  const [, setRelativeTimeTick] = useState(0);

  const [serverStatus, setServerStatus] = useState<ServerStatus>('unknown');
  const [serverLabel, setServerLabel] = useState('No server');

  const loadAll = useCallback(async () => {
    const [lt, ts, si, paused, ip, name, port] = await Promise.all([
      getLastSyncTime(),
      getTotalSynced(),
      getSyncInterval(),
      getSyncPaused(),
      getServerIp(),
      getServerName(),
      getServerPort(),
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

    setServerStatus('checking');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`http://${ip}:${port}/ping`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      setServerStatus(res.ok ? 'connected' : 'disconnected');
    } catch {
      clearTimeout(timeout);
      setServerStatus('disconnected');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [loadAll])
  );

  useEffect(() => {
    const id = setInterval(() => setRelativeTimeTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onStarted = () => {
      setSyncing(true);
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
    }) => {
      setSyncing(false);
      setPhase('idle');
      if (data.lastSyncTime) setLastSyncTimeState(data.lastSyncTime);
      if (data.totalSynced) setTotalSyncedState(data.totalSynced);

      const uploadedCount = data.uploaded ?? 0;
      const errorCount = data.errors ?? 0;
      const skippedCount = data.skipped ?? 0;

      if (errorCount > 0) {
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
      setPhase('idle');
      setStatusMessage(message || 'Backup failed. Check your connection.');
    };

    const subs = [
      DeviceEventEmitter.addListener('sync-started', onStarted),
      DeviceEventEmitter.addListener('sync-progress', onProgress),
      DeviceEventEmitter.addListener('sync-completed', onCompleted),
      DeviceEventEmitter.addListener('sync-failed', onFailed),
    ];

    return () => subs.forEach((sub) => sub.remove());
  }, []);

  const handleSync = async () => {
    if (syncing) return;

    const ip = await getServerIp();
    if (!ip) {
      Alert.alert(
        'No server configured',
        'Open Settings to enter your server IP address, or use Discover to find it on your network.',
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

  const statusColors: Record<ServerStatus, string> = {
    connected: colors.success,
    disconnected: colors.error,
    checking: colors.warning,
    unknown: colors.textMuted,
  };

  const statusLabels: Record<ServerStatus, string> = {
    connected: serverLabel,
    disconnected: 'Offline',
    checking: 'Checking',
    unknown: 'No server',
  };

  const intervalLabel =
    syncInterval < 60
      ? `${syncInterval}m`
      : syncInterval === 60
      ? '1 hr'
      : `${Math.floor(syncInterval / 60)}h`;

  const serverColor = statusColors[serverStatus];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.kicker}>Private phone backup</Text>
          <Text style={styles.appTitle}>Everything safe, quietly.</Text>
          <Text style={styles.appSubtitle}>Your folders sync to your own computer.</Text>
        </View>
        <View style={[styles.serverPill, { borderColor: serverColor }]}>
          <View style={[styles.statusDot, { backgroundColor: serverColor }]} />
          <Text style={[styles.serverPillText, { color: serverColor }]} numberOfLines={1}>
            {statusLabels[serverStatus]}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: BottomTabInset + insets.bottom + 34 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroPanel}>
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
        </View>

        <View style={styles.statsRow}>
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
        </View>

        <TouchableOpacity
          id="sync-now-button"
          style={[styles.syncBtn, syncing && styles.syncBtnBusy]}
          onPress={handleSync}
          disabled={syncing}
          accessibilityLabel="Sync now"
          accessibilityRole="button"
        >
          {syncing ? (
            <View style={styles.syncBtnInner}>
              <ActivityIndicator color={colors.white} size="small" />
              <Text style={styles.syncBtnText}>Syncing</Text>
            </View>
          ) : (
            <View style={styles.syncBtnInner}>
              <AppIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" color={colors.white} size={20} fallback="UP" />
              <Text style={styles.syncBtnText}>Sync now</Text>
            </View>
          )}
        </TouchableOpacity>

        {serverStatus === 'unknown' && (
          <View style={styles.noticeCard}>
            <View style={styles.noticeIcon}>
              <AppIcon androidName="wifi_off" iosName="wifi.slash" color={colors.warning} size={20} fallback="!" />
            </View>
            <View style={styles.noticeCopy}>
              <Text style={styles.noticeTitle}>Connect a server</Text>
              <Text style={styles.noticeBody}>
                Open Settings to enter your server IP, or use Discover to find it automatically.
              </Text>
            </View>
          </View>
        )}

        {serverStatus === 'disconnected' && (
          <View style={[styles.noticeCard, styles.errorCard]}>
            <View style={[styles.noticeIcon, styles.errorIcon]}>
              <AppIcon androidName="error" iosName="exclamationmark.triangle" color={colors.error} size={20} fallback="!" />
            </View>
            <View style={styles.noticeCopy}>
              <Text style={[styles.noticeTitle, { color: colors.error }]}>Server unreachable</Text>
              <Text style={styles.noticeBody}>
                Make sure the desktop app is running and both devices are on the same Wi-Fi network.
              </Text>
            </View>
          </View>
        )}
      </ScrollView>
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
    opacity: 0.72,
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
