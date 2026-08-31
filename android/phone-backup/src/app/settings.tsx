import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  StatusBar,
  Alert,
  Switch,
  TouchableOpacity,
  RefreshControl,
  Platform,
} from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import Animated, {
  FadeInDown,
} from 'react-native-reanimated';
import {
  getServerIp,
  setServerIp,
  getServerPort,
  setServerPort,
  getApiKey,
  setApiKey,
  getServerName,
  setServerName,
  getUsername,
  setUsername,
  getSyncInterval,
  setSyncInterval,
  getSyncPaused,
  setSyncPaused,
  clearAllUploads,
  clearScanSnapshot,
  SYNC_INTERVAL_PRESETS,
  setDeviceToken,
  setServerCertFingerprint,
  getSavedServers,
  saveServerProfile,
  removeSavedServer,
  resolveReachableServer,
  switchToSavedServer,
} from '../../settings';
import { hapticMedium, hapticLight } from '@/utils/haptics';
import { registerBackgroundTask, runSync, getCurrentSyncState } from '../../backgroundTask';
import { connectToServer } from '../../connectToServer';
import { checkDeviceConnection } from '../../uploader';
import { updateUsernameOnServer } from '../../downloader';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { ServerDiscoverySheet } from '@/components/ServerDiscoverySheet';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useCollapsibleHeader } from '@/hooks/useCollapsibleHeader';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { clearAllDiskCache } from '@/utils/previewCacheManager';
import { sanitizeErrorMessage } from '@/utils/errorUtils';

function normalizeServerAddress(input: string): string {
  let addr = input.trim();
  addr = addr.replace(/^https?:\/\//i, '');
  addr = addr.replace(/\/+$/, '');
  const slashIdx = addr.indexOf('/');
  if (slashIdx > 0) {
    addr = addr.slice(0, slashIdx);
  }
  return addr;
}

function SectionHeader({ title, styles }: { title: string; styles: ReturnType<typeof createStyles> }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function SettingsCard({ children, styles }: { children: React.ReactNode; styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.settingsCard}>{children}</View>;
}

function FieldLabel({ text, styles }: { text: string; styles: ReturnType<typeof createStyles> }) {
  return <Text style={styles.fieldLabel}>{text}</Text>;
}

const HEADER_HEIGHT = 100;

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { keyboardHeight } = useKeyboardHeight();
  const { colors, isDark, mode, setMode } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  const [serverIp, setServerIpState] = useState('');
  const [serverPort, setServerPortState] = useState('8000');
  const [serverName, setServerNameState] = useState('');
  const [username, setUsernameState] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);
  const [apiKey, setApiKeyState] = useState('');
  const [syncInterval, setSyncIntervalState] = useState(60);
  const [syncPaused, setSyncPausedState] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [discoveryVisible, setDiscoveryVisible] = useState(false);
  const [savedServers, setSavedServers] = useState<any[]>([]);
  const [pullRefreshing, setPullRefreshing] = useState(false);

  type ServerStatus = 'connected' | 'disconnected' | 'unknown' | 'checking';
  const [serverStatus, setServerStatus] = useState<ServerStatus>('unknown');

  const {
    onScroll,
    onScrollEndDrag,
    onMomentumScrollEnd,
    headerAnimatedStyle,
    contentInsetStyle,
    statusBarFillStyle,
    onHeaderLayout,
    containerPaddingTop,
    expandHeader,
  } = useCollapsibleHeader({
    headerHeight: HEADER_HEIGHT,
    topInset: insets.top,
  });

  const checkServer = useCallback(async () => {
    const ip = await getServerIp();
    if (!ip) { setServerStatus('unknown'); return; }

    const snapshot = await getCurrentSyncState().catch(() => null);
    if (snapshot?.active) {
      setServerStatus('connected');
      return;
    }

    setServerStatus(prev => (prev === 'connected' ? prev : 'checking'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const result = await checkDeviceConnection({ signal: controller.signal });
      clearTimeout(timeout);
      setServerStatus(result.connected ? 'connected' : 'disconnected');
    } catch {
      clearTimeout(timeout);
      // Attempt mesh failover re-discovery before marking offline
      const resolved = await resolveReachableServer().catch(() => ({ ok: false }));
      if (resolved.ok && resolved.reconnected) {
        setServerIpState(resolved.ip);
        try {
          const result = await checkDeviceConnection();
          setServerStatus(result.connected ? 'connected' : 'disconnected');
          return;
        } catch {}
      }
      setServerStatus('disconnected');
    }
  }, []);

  const isOffline = serverStatus === 'disconnected' || serverStatus === 'unknown';

  const loadSettings = useCallback(async () => {
    const [ip, port, key, interval, paused, saved, name, savedUsername] = await Promise.all([
      getServerIp(),
      getServerPort(),
      getApiKey(),
      getSyncInterval(),
      getSyncPaused(),
      getSavedServers(),
      getServerName(),
      getUsername(),
    ]);
    setServerIpState(ip);
    setServerPortState(String(port));
    setApiKeyState(key);
    setSyncIntervalState(interval);
    setSyncPausedState(paused);
    setSavedServers(saved);
    setServerNameState(name || '');
    setUsernameState(savedUsername || '');

    // If server name is not set or equals the IP, attempt to resolve friendly name from server
    if (ip && (!name || name === ip)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`http://${ip}:${port || 8000}/ping`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (data?.name) {
            await setServerName(data.name);
            setServerNameState(data.name);
            const updated = await saveServerProfile({
              ip,
              port: Number(port) || 8000,
              name: data.name,
            });
            setSavedServers(updated);
          }
        }
      } catch {}
    }
  }, []);

  const handlePullRefresh = useCallback(async () => {
    expandHeader(0);
    setPullRefreshing(true);
    try {
      await Promise.all([loadSettings(), checkServer()]);
    } finally {
      setPullRefreshing(false);
    }
  }, [loadSettings, checkServer, expandHeader]);

  useFocusEffect(
    useCallback(() => {
      loadSettings();
      checkServer();
    }, [loadSettings, checkServer])
  );

  const handleSaveUsername = async () => {
    setSavingUsername(true);
    try {
      const trimmed = username.trim();
      await setUsername(trimmed);
      setUsernameState(trimmed);
      try {
        await updateUsernameOnServer(trimmed);
      } catch {}
    } finally {
      setSavingUsername(false);
    }
  };

  const handleSaveServer = async () => {
    if (!serverIp.trim()) {
      Alert.alert('Missing IP', 'Please enter the server IP address.');
      return;
    }

    let cleanIp = normalizeServerAddress(serverIp);
    let portNum = Number.parseInt(serverPort, 10);

    const colonIdx = cleanIp.lastIndexOf(':');
    if (colonIdx > 0) {
      const maybPort = cleanIp.slice(colonIdx + 1);
      if (/^\d+$/.test(maybPort)) {
        portNum = Number.parseInt(maybPort, 10);
        cleanIp = cleanIp.slice(0, colonIdx);
        setServerPortState(String(portNum));
      }
    }

    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      Alert.alert('Invalid port', 'Port must be a number between 1 and 65535.');
      return;
    }

    setServerIpState(cleanIp);

    setSavingServer(true);
    try {
      const key = apiKey.trim() || 'YOUR_SECRET_KEY';
      let discoveredName = '';
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`http://${cleanIp}:${portNum}/ping`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          discoveredName = data?.name || '';
        }
      } catch {}

      await Promise.all([
        setServerIp(cleanIp),
        setServerPort(portNum),
        setApiKey(key),
        setServerName(discoveredName || cleanIp),
        setDeviceToken(''),
        setServerCertFingerprint(''),
        saveServerProfile({
          ip: cleanIp,
          port: portNum,
          name: discoveredName || cleanIp,
          apiKey: key,
        }),
      ]);

      setServerNameState(discoveredName || cleanIp);
      const updatedSaved = await getSavedServers();
      setSavedServers(updatedSaved);

      Alert.alert('Saved', 'Server settings saved. Connecting…');

      connectToServer(cleanIp, portNum, key)
        .then(async (result) => {
          if (result.status === 'accepted') {
            setServerStatus('connected');
            Alert.alert('Connected', 'This device was accepted by the server and is ready to back up.');
          } else if (result.status === 'rejected') {
            Alert.alert('Rejected', 'The server rejected this device. Ask the server owner to approve it.');
          } else if (result.status === 'error') {
            Alert.alert('Connection Error', result.reason || 'Could not connect to the server. Check that it is running.');
          }
          setSavedServers(await getSavedServers());
          checkServer();
        })
        .catch((err: any) => {
          Alert.alert('Connection Failed', sanitizeErrorMessage(err, 'Could not reach the desktop server. Check Wi-Fi and server status.'));
          checkServer();
        });
    } finally {
      setSavingServer(false);
    }
  };

  const handleServerSelected = async (server: {
    serverId?: string;
    ip: string;
    port: number;
    name: string;
    version: string;
    all_ips?: string[];
    candidateIps?: string[];
    hostname?: string;
  }) => {
    const cleanIp = normalizeServerAddress(server.ip);
    setServerIpState(cleanIp);
    setServerPortState(String(server.port));
    setServerNameState(server.name || cleanIp);
    const key = apiKey.trim() || 'YOUR_SECRET_KEY';
    await Promise.all([
      setServerIp(cleanIp),
      setServerPort(server.port),
      setServerName(server.name),
      setApiKey(key),
      setDeviceToken(''),
      saveServerProfile({
        serverId: server.serverId || '',
        ip: cleanIp,
        port: server.port,
        name: server.name || cleanIp,
        apiKey: key,
        all_ips: server.all_ips || [cleanIp],
        candidateIps: server.candidateIps || server.all_ips || [cleanIp],
        hostname: server.hostname || '',
      }),
    ]);

    setSavedServers(await getSavedServers());

    Alert.alert(
      'Server found',
      `"${server.name}" (${cleanIp}:${server.port}) was saved. Sending connection request.`
    );

    connectToServer(cleanIp, server.port, key)
      .then(async (result) => {
        if (result.status === 'accepted') {
          setServerStatus('connected');
          Alert.alert('Connected', `"${server.name}" accepted this device. You are ready to back up.`);
        } else if (result.status === 'rejected') {
          Alert.alert('Rejected', 'The server rejected this device. Check the API key or ask for approval.');
        } else if (result.status === 'error') {
          Alert.alert('Connection Error', result.reason || 'Could not connect to the server.');
        }
        setSavedServers(await getSavedServers());
        checkServer();
      })
      .catch((err: any) => {
        Alert.alert('Connection Failed', sanitizeErrorMessage(err, 'Could not reach the desktop server. Check Wi-Fi and server status.'));
        checkServer();
      });
  };

  const handleSwitchServer = async (item: any) => {
    hapticMedium();
    const switched = await switchToSavedServer(item.id);
    if (switched) {
      setServerIpState(switched.ip);
      setServerPortState(String(switched.port));
      setServerNameState(switched.name || switched.ip);
      setApiKeyState(switched.apiKey || '');
      setSavedServers(await getSavedServers());
      checkServer();
      Alert.alert('Switched Server', `Now using "${switched.name || switched.ip}" (${switched.ip}:${switched.port})`);
    }
  };

  const handleRemoveSaved = (item: any) => {
    Alert.alert('Remove Server', `Remove "${item.name || item.ip}" from saved servers?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          hapticLight();
          const updated = await removeSavedServer(item.id);
          setSavedServers(updated);
        },
      },
    ]);
  };

  const handleIntervalChange = async (minutes: number) => {
    setSyncIntervalState(minutes);
    await setSyncInterval(minutes);
    await registerBackgroundTask(minutes);
  };

  const handlePauseToggle = async (val: boolean) => {
    setSyncPausedState(val);
    await setSyncPaused(val);
  };

  const handleCleanCache = async () => {
    try {
      await clearAllDiskCache();
      Alert.alert('Cache Cleared', 'All temporary preview files and image caches have been cleared from disk.');
    } catch (err: any) {
      Alert.alert('Error', sanitizeErrorMessage(err, 'Could not clear disk cache.'));
    }
  };

  const handleRefreshAll = () => {
    Alert.alert(
      'Refresh all backups',
      'This clears the sync cache and re-checks every file against the server. Files missing on the server will be re-uploaded. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Refresh all',
          style: 'destructive',
          onPress: async () => {
            try {
              const count = await clearAllUploads();
              await clearScanSnapshot();
              const result = await runSync(null, { forceRefreshAll: true });
              Alert.alert(
                'Refresh complete',
                `Cleared ${count} cached entries. ${result?.uploaded ?? 0} files uploaded.`
              );
            } catch (err: any) {
              Alert.alert('Error', sanitizeErrorMessage(err, 'Could not refresh backups. Check server status.'));
            }
          },
        },
      ]
    );
  };

  return (
    <View style={styles.screen}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
      <View style={[statusBarFillStyle, { backgroundColor: colors.bg }]} />

      <Animated.View
        onLayout={onHeaderLayout}
        style={[styles.header, headerAnimatedStyle, { backgroundColor: colors.bg }]}
      >
        <Text style={styles.kicker}>Preferences</Text>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Connect the desktop server and tune backup behavior.</Text>
      </Animated.View>

      <Animated.View style={contentInsetStyle}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: containerPaddingTop + Spacing.two,
            paddingBottom: BottomTabInset + insets.bottom + 34 + (Platform.OS === 'android' ? keyboardHeight : 0),
          },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets={true}
        onScroll={onScroll}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={handlePullRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressViewOffset={containerPaddingTop}
          />
        }
      >
        <Animated.View entering={FadeInDown.duration(300).delay(100)}>
          <SectionHeader title="Server connection" styles={styles} />
          <SettingsCard styles={styles}>
            {savedServers.length > 0 && (
              <>
                <FieldLabel text="Saved servers" styles={styles} />
                <View style={styles.savedServersList}>
                  {savedServers.map((srv) => {
                    const isActive = srv.ip === serverIp && String(srv.port) === String(serverPort);
                    const displayName = (isActive && serverName) ? serverName : (srv.name || srv.ip);
                    return (
                      <View
                        key={srv.id || `${srv.ip}:${srv.port}`}
                        style={[styles.savedServerRow, isActive && styles.savedServerRowActive]}
                      >
                        <View
                          style={[
                            styles.savedServerIcon,
                            { backgroundColor: isActive ? colors.successSoft : colors.primarySoft },
                          ]}
                        >
                          <AppIcon
                            androidName="desktop_windows"
                            iosName="desktopcomputer"
                            color={isActive ? colors.success : colors.primary}
                            size={18}
                            fallback="PC"
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.savedServerName} numberOfLines={1}>
                            {displayName}
                          </Text>
                          <Text style={styles.savedServerMeta} numberOfLines={1}>
                            {srv.ip}:{srv.port}
                          </Text>
                        </View>
                        {isActive ? (
                          <View style={[styles.activeBadge, { backgroundColor: colors.successSoft }]}>
                            <AppIcon androidName="check" iosName="checkmark" color={colors.success} size={12} />
                            <Text style={[styles.activeBadgeText, { color: colors.success }]}>Active</Text>
                          </View>
                        ) : (
                          <TouchableOpacity
                            style={[styles.switchBtn, { backgroundColor: colors.primarySoft }]}
                            onPress={() => handleSwitchServer(srv)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel={`Switch to ${displayName}`}
                          >
                            <Text style={[styles.switchBtnText, { color: colors.primary }]}>Switch</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          style={styles.removeSavedBtn}
                          onPress={() => handleRemoveSaved(srv)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityLabel={`Remove ${displayName}`}
                        >
                          <AppIcon androidName="close" iosName="xmark" color={colors.textMuted} size={16} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
                <View style={styles.divider} />
              </>
            )}

            <FieldLabel text="Server IP address" styles={styles} />
            <TextInput
              id="server-ip-input"
              style={styles.textInput}
              value={serverIp}
              onChangeText={setServerIpState}
              placeholder="192.168.1.100 or http://myserver"
              placeholderTextColor={colors.textMuted}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />

            <FieldLabel text="Port" styles={styles} />
            <TextInput
              id="server-port-input"
              style={styles.textInput}
              value={serverPort}
              onChangeText={setServerPortState}
              placeholder="8000"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              returnKeyType="next"
            />

            <FieldLabel text="API key" styles={styles} />
            <TextInput
              id="api-key-input"
              style={styles.textInput}
              value={apiKey}
              onChangeText={setApiKeyState}
              placeholder="Your secret key"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />

            <View style={styles.buttonRow}>
              <AnimatedPressable
                id="discover-servers-button"
                style={styles.outlineBtn}
                onPress={() => setDiscoveryVisible(true)}
                scaleDown={0.95}
                accessibilityLabel="Discover servers on network"
              >
                <AppIcon androidName="search" iosName="magnifyingglass" color={colors.primary} size={18} fallback="S" />
                <Text style={styles.outlineBtnText}>Discover</Text>
              </AnimatedPressable>
              <AnimatedPressable
                id="save-server-button"
                style={styles.primaryBtn}
                onPress={handleSaveServer}
                disabled={savingServer}
                scaleDown={0.95}
                accessibilityLabel="Save server settings"
              >
                <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={18} fallback="OK" />
                <Text style={styles.primaryBtnText}>{savingServer ? 'Saving' : 'Save'}</Text>
              </AnimatedPressable>
            </View>
          </SettingsCard>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(300).delay(150)}>
          <SectionHeader title="Sync schedule" styles={styles} />
          <SettingsCard styles={styles}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleIcon}>
                <AppIcon
                  androidName={syncPaused ? 'pause' : 'sync'}
                  iosName={syncPaused ? 'pause.fill' : 'arrow.triangle.2.circlepath'}
                  color={syncPaused ? colors.warning : colors.primary}
                  size={20}
                  fallback={syncPaused ? 'P' : 'S'}
                />
              </View>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>Auto sync</Text>
                <Text style={styles.toggleSub}>
                  {syncPaused ? 'Paused. Manual Sync Now still works.' : 'Runs automatically in the background.'}
                </Text>
              </View>
              <Switch
                value={!syncPaused}
                onValueChange={(val) => handlePauseToggle(!val)}
                trackColor={{ false: colors.surfaceBorder, true: colors.primarySoft }}
                thumbColor={!syncPaused ? colors.primary : colors.textMuted}
                accessibilityLabel="Toggle auto sync"
              />
            </View>

            {!syncPaused && (
              <>
                <View style={styles.divider} />
                <FieldLabel text="Sync every" styles={styles} />
                <View style={styles.presetGrid}>
                  {SYNC_INTERVAL_PRESETS.map((p) => {
                    const active = syncInterval === p.value;
                    return (
                      <AnimatedPressable
                        key={p.value}
                        style={[styles.presetChip, active && styles.presetChipActive]}
                        onPress={() => handleIntervalChange(p.value)}
                        scaleDown={0.9}
                        accessibilityLabel={`Set sync interval to ${p.label}`}
                      >
                        <Text style={[styles.presetText, active && styles.presetTextActive]}>
                          {p.label}
                        </Text>
                      </AnimatedPressable>
                    );
                  })}
                </View>
                <Text style={styles.hintText}>
                  Android may delay background work to preserve battery, especially when the phone is idle.
                </Text>
              </>
            )}
          </SettingsCard>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(300).delay(175)}>
          <SectionHeader title="Manage" styles={styles} />
          <SettingsCard styles={styles}>
            <AnimatedPressable
              style={styles.navRow}
              onPress={() => router.push('/folders')}
              scaleDown={0.98}
              accessibilityLabel="Backup Folders"
            >
              <View style={styles.toggleIcon}>
                <AppIcon androidName="folder" iosName="folder" color={colors.primary} size={20} fallback="F" />
              </View>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>Backup Folders</Text>
                <Text style={styles.toggleSub}>Choose which folders sync</Text>
              </View>
              <AppIcon androidName="chevron_right" iosName="chevron.right" color={colors.textMuted} size={18} fallback=">" />
            </AnimatedPressable>
            <View style={styles.divider} />
            <AnimatedPressable
              style={styles.navRow}
              onPress={() => router.push('/history')}
              scaleDown={0.98}
              accessibilityLabel="Sync History"
            >
              <View style={styles.toggleIcon}>
                <AppIcon androidName="history" iosName="clock.arrow.circlepath" color={colors.primary} size={20} fallback="H" />
              </View>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>Sync History</Text>
                <Text style={styles.toggleSub}>View past backup sessions</Text>
              </View>
              <AppIcon androidName="chevron_right" iosName="chevron.right" color={colors.textMuted} size={18} fallback=">" />
            </AnimatedPressable>
          </SettingsCard>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(300).delay(200)}>
          <SectionHeader title="Your profile" styles={styles} />
          <SettingsCard styles={styles}>
            <FieldLabel text="Your name" styles={styles} />
            <TextInput
              id="username-input"
              style={styles.textInput}
              value={username}
              onChangeText={setUsernameState}
              placeholder="e.g. Alex"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSaveUsername}
            />
            <AnimatedPressable
              id="save-username-button"
              style={styles.primaryBtn}
              onPress={handleSaveUsername}
              disabled={savingUsername}
              scaleDown={0.95}
              accessibilityLabel="Save your name"
            >
              <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={18} fallback="OK" />
              <Text style={styles.primaryBtnText}>{savingUsername ? 'Saving…' : 'Save'}</Text>
            </AnimatedPressable>
          </SettingsCard>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(300).delay(300)}>
          <SectionHeader title="Data management" styles={styles} />
          <SettingsCard styles={styles}>
            <AnimatedPressable
              id="clean-cache-button"
              style={styles.outlineBtn}
              onPress={handleCleanCache}
              scaleDown={0.95}
              accessibilityLabel="Clean disk cache"
            >
              <AppIcon androidName="delete_sweep" iosName="trash" color={colors.primary} size={18} fallback="C" />
              <Text style={styles.outlineBtnText}>Clean disk cache</Text>
            </AnimatedPressable>
            <Text style={styles.hintText}>
              Removes temporary preview images and disk cache files to free up storage space.
            </Text>

            <View style={styles.divider} />

            <AnimatedPressable
              id="refresh-all-button"
              style={[styles.dangerBtn, isOffline && styles.disabledBtn]}
              onPress={handleRefreshAll}
              disabled={isOffline}
              scaleDown={0.95}
              accessibilityLabel="Refresh all backups"
            >
              <AppIcon androidName="restart_alt" iosName="arrow.clockwise" color={isOffline ? colors.textMuted : colors.error} size={18} fallback="R" />
              <Text style={[styles.dangerBtnText, isOffline && { color: colors.textMuted }]}>Refresh all backups</Text>
            </AnimatedPressable>
            <Text style={styles.hintText}>
              {isOffline
                ? 'Connect to a server first to use this feature.'
                : 'Use this when files are missing on the server. Existing cache entries are cleared, then files upload again.'}
            </Text>
          </SettingsCard>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(300).delay(400)}>
          <SectionHeader title="Appearance" styles={styles} />
          <SettingsCard styles={styles}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleIcon}>
                <AppIcon
                  androidName={isDark ? 'dark_mode' : 'light_mode'}
                  iosName={isDark ? 'moon.fill' : 'sun.max.fill'}
                  color={isDark ? colors.primaryLight : colors.warning}
                  size={20}
                  fallback={isDark ? 'D' : 'L'}
                />
              </View>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleLabel}>Dark mode</Text>
                <Text style={styles.toggleSub}>
                  {isDark ? 'Using the darker app theme.' : 'Using the light app theme.'}
                </Text>
              </View>
              <Switch
                value={mode === 'dark'}
                onValueChange={(val) => setMode(val ? 'dark' : 'light')}
                trackColor={{ false: colors.surfaceBorder, true: colors.primarySoft }}
                thumbColor={isDark ? colors.primary : colors.textMuted}
                accessibilityLabel="Toggle dark mode"
              />
            </View>
          </SettingsCard>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(300).delay(500)}>
          <SectionHeader title="About" styles={styles} />
          <SettingsCard styles={styles}>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>App version</Text>
              <Text style={styles.aboutValue}>{Constants.expoConfig?.version ?? '4.1.2'}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>Server stack</Text>
              <Text style={styles.aboutValue}>Python + FastAPI</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>Framework</Text>
              <Text style={styles.aboutValue}>Expo SDK 57</Text>
            </View>
          </SettingsCard>
        </Animated.View>
      </ScrollView>
      </Animated.View>

      {discoveryVisible ? (
        <ServerDiscoverySheet
          visible
          onSelect={handleServerSelected}
          onClose={() => setDiscoveryVisible(false)}
        />
      ) : null}
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
    paddingBottom: Spacing.four,
    gap: Spacing.one,
  },
  kicker: {
    color: colors.primary,
    fontSize: TextScale.xs,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: TextScale.xl,
    fontWeight: '900',
    color: colors.text,
  },
  subtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: Spacing.six,
    gap: Spacing.three,
  },
  sectionHeader: {
    fontSize: TextScale.xs,
    fontWeight: '900',
    color: colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  settingsCard: {
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    padding: Spacing.four,
    gap: Spacing.three,
    ...Shadows.card,
  },
  fieldLabel: {
    fontSize: TextScale.xs,
    fontWeight: '800',
    color: colors.textSecondary,
    marginBottom: -Spacing.two,
  },
  textInput: {
    minHeight: 46,
    backgroundColor: colors.surfaceSoft,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    fontSize: TextScale.base,
    color: colors.text,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.three,
    marginTop: Spacing.two,
  },
  outlineBtn: {
    flex: 1,
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    backgroundColor: colors.primarySoft,
  },
  outlineBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '900',
    color: colors.primary,
  },
  primaryBtn: {
    flex: 1,
    minHeight: 46,
    backgroundColor: colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  primaryBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '900',
    color: colors.white,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  toggleIcon: {
    width: 42,
    height: 42,
    borderRadius: Radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleInfo: {
    flex: 1,
    gap: 3,
  },
  toggleLabel: {
    fontSize: TextScale.base,
    fontWeight: '900',
    color: colors.text,
  },
  toggleSub: {
    fontSize: TextScale.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: colors.surfaceBorder,
    marginVertical: Spacing.one,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  presetChip: {
    minHeight: 36,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    backgroundColor: colors.surfaceSoft,
    justifyContent: 'center',
  },
  presetChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  presetText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  presetTextActive: {
    color: colors.primary,
    fontWeight: '900',
  },
  hintText: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    lineHeight: 17,
    fontWeight: '600',
  },
  dangerBtn: {
    minHeight: 46,
    backgroundColor: colors.errorSoft,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  dangerBtnText: {
    fontSize: TextScale.base,
    fontWeight: '900',
    color: colors.error,
  },
  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.one,
  },
  aboutLabel: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  aboutValue: {
    fontSize: TextScale.sm,
    color: colors.text,
    fontWeight: '800',
    textAlign: 'right',
  },
  disabledBtn: {
    opacity: 0.4,
  },
  savedServersList: {
    gap: Spacing.two,
    marginTop: Spacing.two,
    marginBottom: Spacing.two,
  },
  savedServerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSoft,
    borderRadius: Radius.lg,
    padding: Spacing.three,
    gap: Spacing.three,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  savedServerRowActive: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceElevated,
  },
  savedServerIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedServerName: {
    fontSize: TextScale.sm,
    fontWeight: '800',
    color: colors.text,
  },
  savedServerMeta: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    fontWeight: '600',
    marginTop: 1,
  },
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radius.full,
  },
  activeBadgeText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  switchBtn: {
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
    borderRadius: Radius.md,
  },
  switchBtnText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  removeSavedBtn: {
    padding: 6,
  },
});