import React, { useState, useCallback, useEffect } from 'react';
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
  setLastSyncTime,
  setTotalSynced,
  getSyncInterval,
  getSyncPaused,
} from '../../settings';
import {
  showSyncProgressNotification,
  showSyncCompleteNotification,
  showSyncErrorNotification,
} from '../../notificationService';
import { Colors, Spacing, Radius, TextScale, BottomTabInset } from '@/constants/theme';
import { SyncProgressRing } from '@/components/SyncProgressRing';
import { StatCard } from '@/components/StatCard';

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

type ServerStatus = 'connected' | 'disconnected' | 'unknown' | 'checking';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();

  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  const [lastSyncTime, setLastSyncTimeState] = useState<number | null>(null);
  const [totalSynced, setTotalSyncedState] = useState(0);
  const [syncInterval, setSyncIntervalState] = useState(15);
  const [syncPaused, setSyncPausedState] = useState(false);

  const [serverStatus, setServerStatus] = useState<ServerStatus>('unknown');
  const [serverLabel, setServerLabel] = useState('No Server');

  // ── Load stats & server status whenever tab comes into focus ─────────────
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
    setServerLabel(name || ip || 'No Server');

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

  // ── Listen for background sync completion ────────────────────────────────
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('sync-completed', (data) => {
      if (data.lastSyncTime) setLastSyncTimeState(data.lastSyncTime);
      if (data.totalSynced) setTotalSyncedState(data.totalSynced);
    });
    return () => sub.remove();
  }, []);

  // ── Sync handler ─────────────────────────────────────────────────────────
  const handleSync = async () => {
    if (syncing) return;

    const ip = await getServerIp();
    if (!ip) {
      Alert.alert(
        'No Server Configured',
        'Go to Settings to enter your server IP address, or tap Discover to find it on your network.',
        [{ text: 'OK' }]
      );
      return;
    }

    setSyncing(true);
    setProgress(0);
    setUploaded(0);
    setTotal(0);
    setStatusMessage('Scanning your folders…');

    await showSyncProgressNotification(0, 0);

    try {
      const result = await runSync(async (current: number, tot: number, detail?: any) => {
        if (detail?.phase === 'scanning') {
          setStatusMessage(
            detail.files
              ? `Scanning files... ${detail.files.toLocaleString()} found`
              : 'Scanning your folders...'
          );
          setUploaded(0);
          setTotal(0);
          setProgress(0);
          await showSyncProgressNotification(0, 0, detail);
          return;
        }

        if (detail?.phase === 'checking') {
          const checked = detail.checked || 0;
          const count = detail.total || 0;
          setStatusMessage(
            count > 0
              ? `Checking server... ${checked.toLocaleString()} / ${count.toLocaleString()}`
              : 'Checking server...'
          );
          setUploaded(0);
          setTotal(0);
          setProgress(0);
          await showSyncProgressNotification(0, 0, detail);
          return;
        }

        setUploaded(current);
        setTotal(tot);
        setProgress(tot > 0 ? Math.round((current / tot) * 100) : 0);
        if (detail?.currentFile && current < tot) {
          const name = detail.currentFile.split('/').pop() || detail.currentFile;
          setStatusMessage(`Uploading ${name}`);
        }
        await showSyncProgressNotification(current, tot, detail);
      });

      const now = Date.now();
      await setLastSyncTime(now);
      setLastSyncTimeState(now);

      // Use server-provided total if available
      const verifiedSynced = result.deviceTotalFiles > 0 ? result.deviceTotalFiles : (result.uploaded + result.skipped);
      if (verifiedSynced > 0) {
        await setTotalSynced(verifiedSynced);
        setTotalSyncedState(verifiedSynced);
      }

      await showSyncCompleteNotification(result.uploaded, result.skipped);

      setProgress(result.total > 0 ? 100 : 0);
      if (result.errors > 0) {
        setStatusMessage(
          result.uploaded > 0
            ? `${result.uploaded} backed up, ${result.errors} failed`
            : `${result.errors} file${result.errors !== 1 ? 's' : ''} need attention; ${result.skipped} already backed up`
        );
      } else {
        setStatusMessage(
        result.uploaded > 0
          ? `✅  ${result.uploaded} file${result.uploaded !== 1 ? 's' : ''} backed up`
          : '✓  Everything is already up to date'
        );
      }
    } catch (err: any) {
      await showSyncErrorNotification(err?.message);
      setStatusMessage(`❌  ${err?.message || 'Backup failed — check your connection'}`);
    } finally {
      setSyncing(false);
    }
  };

  // ── Derived display values ───────────────────────────────────────────────
  const statusColors: Record<ServerStatus, string> = {
    connected: Colors.success,
    disconnected: Colors.error,
    checking: Colors.warning,
    unknown: Colors.textMuted,
  };

  const statusLabels: Record<ServerStatus, string> = {
    connected: `● ${serverLabel}`,
    disconnected: '● Offline',
    checking: '● Checking…',
    unknown: '● No Server',
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
      <StatusBar barStyle="light-content" backgroundColor={Colors.bg} />

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.appTitle}>Phone Backup</Text>
          <Text style={styles.appSubtitle}>Automatic · Secure · Private</Text>
        </View>
        <View style={[styles.serverPill, { borderColor: serverColor }]}>
          <Text style={[styles.serverPillText, { color: serverColor }]}>
            {statusLabels[serverStatus]}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: BottomTabInset + insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Sync Ring ────────────────────────────────────────────────── */}
        <View style={styles.ringSection}>
          <SyncProgressRing
            isActive={syncing}
            progress={progress}
            uploaded={uploaded}
            total={total}
          />
          {statusMessage ? (
            <Text style={styles.statusMsg}>{statusMessage}</Text>
          ) : null}
          {syncPaused && !syncing && (
            <View style={styles.pausedBadge}>
              <Text style={styles.pausedText}>⏸  Auto Sync Paused</Text>
            </View>
          )}
        </View>

        {/* ── Stat cards ───────────────────────────────────────────────── */}
        <View style={styles.statsRow}>
          <StatCard
            icon="📦"
            label="Files Synced"
            value={totalSynced > 0 ? totalSynced.toLocaleString() : '—'}
            tint={Colors.primary}
            dimColor={Colors.primaryDim}
          />
          <StatCard
            icon="🕐"
            label="Last Sync"
            value={formatRelativeTime(lastSyncTime)}
            tint={Colors.success}
            dimColor={Colors.successDim}
          />
          <StatCard
            icon="⏱️"
            label="Interval"
            value={syncPaused ? 'Paused' : intervalLabel}
            tint={syncPaused ? Colors.textMuted : Colors.warning}
            dimColor={Colors.warningDim}
          />
        </View>

        {/* ── Sync Now button ──────────────────────────────────────────── */}
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
              <ActivityIndicator color={Colors.white} size="small" />
              <Text style={styles.syncBtnText}>Syncing…</Text>
            </View>
          ) : (
            <Text style={styles.syncBtnText}>↑  Sync Now</Text>
          )}
        </TouchableOpacity>

        {/* ── No-server warning card ───────────────────────────────────── */}
        {serverStatus === 'unknown' && (
          <View style={styles.warningCard}>
            <Text style={styles.warningTitle}>⚠️  No Server Connected</Text>
            <Text style={styles.warningBody}>
              Open{' '}
              <Text style={{ color: Colors.primaryLight, fontWeight: '600' }}>
                Settings
              </Text>{' '}
              to enter your backup server IP, or tap{' '}
              <Text style={{ color: Colors.primaryLight, fontWeight: '600' }}>
                Discover
              </Text>{' '}
              to find it automatically on your local network.
            </Text>
          </View>
        )}

        {serverStatus === 'disconnected' && (
          <View style={[styles.warningCard, styles.errorCard]}>
            <Text style={[styles.warningTitle, { color: Colors.error }]}>
              ❌  Server Unreachable
            </Text>
            <Text style={styles.warningBody}>
              Make sure the backup server is running on your PC and that both
              devices are on the same Wi-Fi network.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.six,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.five,
  },
  appTitle: {
    fontSize: TextScale.xl,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  appSubtitle: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
    marginTop: 3,
  },
  serverPill: {
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: Colors.surface,
    maxWidth: 160,
  },
  serverPillText: {
    fontSize: 11,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: Spacing.six,
    gap: Spacing.six,
  },
  ringSection: {
    alignItems: 'center',
    gap: Spacing.four,
    paddingVertical: Spacing.four,
  },
  statusMsg: {
    fontSize: TextScale.base,
    color: Colors.textSecondary,
    textAlign: 'center',
    fontWeight: '500',
  },
  pausedBadge: {
    backgroundColor: Colors.warningDim,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.four,
    paddingVertical: 5,
  },
  pausedText: {
    fontSize: TextScale.xs,
    color: Colors.warning,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  syncBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.xl,
    paddingVertical: Spacing.five,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
  },
  syncBtnBusy: {
    opacity: 0.75,
    elevation: 2,
    shadowOpacity: 0.1,
  },
  syncBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  syncBtnText: {
    fontSize: TextScale.md,
    fontWeight: '700',
    color: Colors.white,
    letterSpacing: 0.4,
  },
  warningCard: {
    backgroundColor: Colors.warningDim,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.warning,
    padding: Spacing.five,
    gap: Spacing.two,
  },
  errorCard: {
    backgroundColor: Colors.errorDim,
    borderColor: Colors.error,
  },
  warningTitle: {
    fontSize: TextScale.base,
    fontWeight: '700',
    color: Colors.warning,
  },
  warningBody: {
    fontSize: TextScale.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
});
