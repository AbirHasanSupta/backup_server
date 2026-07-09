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
} from '../../settings';
import { registerBackgroundTask } from '../../backgroundTask';
import { connectToServer } from '../../connectToServer';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { ServerDiscoverySheet } from '@/components/ServerDiscoverySheet';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

const INTERVAL_PRESETS = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hr', value: 60 },
  { label: '2 hr', value: 120 },
  { label: '6 hr', value: 360 },
  { label: '12 hr', value: 720 },
  { label: '24 hr', value: 1440 },
];

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
  const [syncInterval, setSyncIntervalState] = useState(15);
  const [syncPaused, setSyncPausedState] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [discoveryVisible, setDiscoveryVisible] = useState(false);

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
    }, [loadSettings])
  );

  const handleSaveServer = async () => {
    if (!serverIp.trim()) {
      Alert.alert('Missing IP', 'Please enter the server IP address.');
      return;
    }
    const portNum = Number.parseInt(serverPort, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      Alert.alert('Invalid port', 'Port must be a number between 1 and 65535.');
      return;
    }
    setSavingServer(true);
    try {
      const key = apiKey.trim() || 'YOUR_SECRET_KEY';
      await Promise.all([setServerIp(serverIp.trim()), setServerPort(portNum), setApiKey(key)]);

      Alert.alert('Saved', 'Server settings saved.');

      connectToServer(serverIp.trim(), portNum, key).then((result) => {
        if (result.status === 'accepted') {
          Alert.alert('Connected', 'This device was accepted by the server and is ready to back up.');
        } else if (result.status === 'rejected') {
          Alert.alert('Rejected', 'The server rejected this device. Ask the server owner to approve it.');
        }
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
    setServerIpState(server.ip);
    setServerPortState(String(server.port));
    const key = apiKey.trim() || 'YOUR_SECRET_KEY';
    await Promise.all([
      setServerIp(server.ip),
      setServerPort(server.port),
      setServerName(server.name),
      setApiKey(key),
    ]);

    Alert.alert(
      'Server found',
      `"${server.name}" (${server.ip}:${server.port}) was saved. Sending connection request.`
    );

    connectToServer(server.ip, server.port, key).then((result) => {
      if (result.status === 'accepted') {
        Alert.alert('Connected', `"${server.name}" accepted this device. You are ready to back up.`);
      } else if (result.status === 'rejected') {
        Alert.alert('Rejected', 'The server rejected this device. Check the API key or ask for approval.');
      }
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
      'This clears the sync cache and re-uploads every file on the next sync. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Refresh all',
          style: 'destructive',
          onPress: async () => {
            const count = await clearAllUploads();
            Alert.alert('Done', `Cleared ${count} cached entries. Files will re-upload on the next sync.`);
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
            placeholder="192.168.1.100"
            placeholderTextColor={colors.textMuted}
            keyboardType="numeric"
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
                {INTERVAL_PRESETS.map((p) => {
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
            style={styles.dangerBtn}
            onPress={handleRefreshAll}
            accessibilityLabel="Refresh all backups"
            accessibilityRole="button"
          >
            <AppIcon androidName="restart_alt" iosName="arrow.clockwise" color={colors.error} size={18} fallback="R" />
            <Text style={styles.dangerBtnText}>Refresh all backups</Text>
          </TouchableOpacity>
          <Text style={styles.hintText}>
            Use this when files are missing on the server. Existing cache entries are cleared, then files upload again.
          </Text>
        </SettingsCard>

        <SectionHeader title="About" styles={styles} />
        <SettingsCard styles={styles}>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>App version</Text>
            <Text style={styles.aboutValue}>1.1.0</Text>
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
});
