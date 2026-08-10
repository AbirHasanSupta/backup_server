import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
  StatusBar,
  Alert,
  Switch,
} from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  getServerIp,
  setServerIp,
  getServerPort,
  setServerPort,
  getApiKey,
  setApiKey,
  setServerName,
  getSyncInterval,
  setSyncInterval,
  getSyncPaused,
  setSyncPaused,
  clearAllUploads,
  clearScanSnapshot,
  SYNC_INTERVAL_PRESETS,
  setDeviceToken,
  setServerCertFingerprint,
} from '../../settings';
import { registerBackgroundTask, runSync } from '../../backgroundTask';
import { connectToServer } from '../../connectToServer';
import { checkDeviceConnection } from '../../uploader';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { ServerDiscoverySheet } from '@/components/ServerDiscoverySheet';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * Strip protocol prefix (https:// or http://) and trailing slashes from a server address.
 * Users may paste a full URL; we store only the raw hostname/IP.
 */
function normalizeServerAddress(input: string): string {
  let addr = input.trim();
  addr = addr.replace(/^https?:\/\//i, '');
  // Remove trailing slash(es)
  addr = addr.replace(/\/+$/, '');
  // Strip any URL path (e.g., "192.168.1.5:8000/ping" → "192.168.1.5:8000")
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

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark, mode, setMode } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [serverIp, setServerIpState] = useState('');
  const [serverPort, setServerPortState] = useState('8000');
  const [apiKey, setApiKeyState] = useState('');
  const [syncInterval, setSyncIntervalState] = useState(60);
  const [syncPaused, setSyncPausedState] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [discoveryVisible, setDiscoveryVisible] = useState(false);

  // Server status for disabling connection-dependent buttons
  type ServerStatus = 'connected' | 'disconnected' | 'unknown' | 'checking';
  const [serverStatus, setServerStatus] = useState<ServerStatus>('unknown');

  const checkServer = useCallback(async () => {
    const ip = await getServerIp();
    if (!ip) { setServerStatus('unknown'); return; }
    setServerStatus('checking');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const result = await checkDeviceConnection({ signal: controller.signal });
      clearTimeout(timeout);
      setServerStatus(result.connected ? 'connected' : 'disconnected');
    } catch {
      clearTimeout(timeout);
      setServerStatus('disconnected');
    }
  }, []);

  const isOffline = serverStatus === 'disconnected' || serverStatus === 'unknown';

  const loadSettings = useCallback(async () => {
    const [ip, port, key, interval, paused] = await Promise.all([
      getServerIp(),
      getServerPort(),
      getApiKey(),
      getSyncInterval(),
      getSyncPaused(),
    ]);
    setServerIpState(ip);
    setServerPortState(String(port));
    setApiKeyState(key);
    setSyncIntervalState(interval);
    setSyncPausedState(paused);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadSettings();
      checkServer();
    }, [loadSettings, checkServer])
  );

  const handleSaveServer = async () => {
    if (!serverIp.trim()) {
      Alert.alert('Missing IP', 'Please enter the server IP address.');
      return;
    }

    // Normalize: strip https://, http://, trailing slashes
    let cleanIp = normalizeServerAddress(serverIp);
    let portNum = Number.parseInt(serverPort, 10);

    // If the user pasted something like "192.168.1.5:9000" in the IP field,
    // extract the port automatically.
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

    // Update displayed value with normalized address
    setServerIpState(cleanIp);

    setSavingServer(true);
    try {
      const key = apiKey.trim() || 'YOUR_SECRET_KEY';
      await Promise.all([
        setServerIp(cleanIp),
        setServerPort(portNum),
        setApiKey(key),
        setServerName(''),           // Clear name so Home shows the new IP
        setDeviceToken(''),          // New server, need new token
        setServerCertFingerprint(''), // New server, new certificate
      ]);

      Alert.alert('Saved', 'Server settings saved. Connecting…');

      connectToServer(cleanIp, portNum, key)
        .then((result) => {
          if (result.status === 'accepted') {
            setServerStatus('connected');
            Alert.alert('Connected', 'This device was accepted by the server and is ready to back up.');
          } else if (result.status === 'rejected') {
            Alert.alert('Rejected', 'The server rejected this device. Ask the server owner to approve it.');
          } else if (result.status === 'error') {
            Alert.alert('Connection Error', result.reason || 'Could not connect to the server. Check that it is running.');
          }
          checkServer();
        })
        .catch((err: any) => {
          Alert.alert('Connection Failed', err?.message || 'Could not reach the server.');
          checkServer();
        });
    } finally {
      setSavingServer(false);
    }
  };

  const handleServerSelected = async (server: {
    ip: string;
    port: number;
    name: string;
    version: string;
  }) => {
    const cleanIp = normalizeServerAddress(server.ip);
    setServerIpState(cleanIp);
    setServerPortState(String(server.port));
    const key = apiKey.trim() || 'YOUR_SECRET_KEY';
    await Promise.all([
      setServerIp(cleanIp),
      setServerPort(server.port),
      setServerName(server.name),
      setApiKey(key),
      setDeviceToken(''),
    ]);

    Alert.alert(
      'Server found',
      `"${server.name}" (${cleanIp}:${server.port}) was saved. Sending connection request.`
    );

    connectToServer(cleanIp, server.port, key)
      .then((result) => {
        if (result.status === 'accepted') {
          setServerStatus('connected');
          Alert.alert('Connected', `"${server.name}" accepted this device. You are ready to back up.`);
        } else if (result.status === 'rejected') {
          Alert.alert('Rejected', 'The server rejected this device. Check the API key or ask for approval.');
        } else if (result.status === 'error') {
          Alert.alert('Connection Error', result.reason || 'Could not connect to the server.');
        }
        checkServer();
      })
      .catch((err: any) => {
        Alert.alert('Connection Failed', err?.message || 'Could not reach the server.');
        checkServer();
      });
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
              Alert.alert('Error', err?.message || 'Could not refresh backups');
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={styles.header}>
        <Text style={styles.kicker}>Preferences</Text>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Connect the desktop server and tune backup behavior.</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: BottomTabInset + insets.bottom + 34 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <SectionHeader title="Server connection" styles={styles} />
        <SettingsCard styles={styles}>
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
            <TouchableOpacity
              id="discover-servers-button"
              style={styles.outlineBtn}
              onPress={() => setDiscoveryVisible(true)}
              accessibilityLabel="Discover servers on network"
              accessibilityRole="button"
            >
              <AppIcon androidName="search" iosName="magnifyingglass" color={colors.primary} size={18} fallback="S" />
              <Text style={styles.outlineBtnText}>Discover</Text>
            </TouchableOpacity>
            <TouchableOpacity
              id="save-server-button"
              style={[styles.primaryBtn, savingServer && { opacity: 0.65 }]}
              onPress={handleSaveServer}
              disabled={savingServer}
              accessibilityLabel="Save server settings"
              accessibilityRole="button"
            >
              <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={18} fallback="OK" />
              <Text style={styles.primaryBtnText}>{savingServer ? 'Saving' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </SettingsCard>

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
                    <TouchableOpacity
                      key={p.value}
                      style={[styles.presetChip, active && styles.presetChipActive]}
                      onPress={() => handleIntervalChange(p.value)}
                      accessibilityLabel={`Set sync interval to ${p.label}`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: active }}
                    >
                      <Text style={[styles.presetText, active && styles.presetTextActive]}>
                        {p.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={styles.hintText}>
                Android may delay background work to preserve battery, especially when the phone is idle.
              </Text>
            </>
          )}
        </SettingsCard>

        <SectionHeader title="Data management" styles={styles} />
        <SettingsCard styles={styles}>
          <TouchableOpacity
            id="refresh-all-button"
            style={[styles.dangerBtn, isOffline && styles.disabledBtn]}
            onPress={handleRefreshAll}
            disabled={isOffline}
            accessibilityLabel="Refresh all backups"
            accessibilityRole="button"
          >
            <AppIcon androidName="restart_alt" iosName="arrow.clockwise" color={isOffline ? colors.textMuted : colors.error} size={18} fallback="R" />
            <Text style={[styles.dangerBtnText, isOffline && { color: colors.textMuted }]}>Refresh all backups</Text>
          </TouchableOpacity>
          <Text style={styles.hintText}>
            {isOffline
              ? 'Connect to a server first to use this feature.'
              : 'Use this when files are missing on the server. Existing cache entries are cleared, then files upload again.'}
          </Text>
        </SettingsCard>

        <SectionHeader title="About" styles={styles} />
        <SettingsCard styles={styles}>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>App version</Text>
            <Text style={styles.aboutValue}>{Constants.expoConfig?.version ?? '2.4.0'}</Text>
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
      </ScrollView>

      <ServerDiscoverySheet
        visible={discoveryVisible}
        onSelect={handleServerSelected}
        onClose={() => setDiscoveryVisible(false)}
      />
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
});