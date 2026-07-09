import React, { useState, useCallback } from 'react';
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
import { Colors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { ServerDiscoverySheet } from '@/components/ServerDiscoverySheet';
import { AppIcon } from '@/components/AppIcon';

const INTERVAL_PRESETS = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hr', value: 60 },
  { label: '2 hr', value: 120 },
  { label: '6 hr', value: 360 },
  { label: '12 hr', value: 720 },
  { label: '24 hr', value: 1440 },
];

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return <View style={styles.settingsCard}>{children}</View>;
}

function FieldLabel({ text }: { text: string }) {
  return <Text style={styles.fieldLabel}>{text}</Text>;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();

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
    const portNum = parseInt(serverPort);
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
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />

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
        <SectionHeader title="Server connection" />
        <SettingsCard>
          <FieldLabel text="Server IP address" />
          <TextInput
            id="server-ip-input"
            style={styles.textInput}
            value={serverIp}
            onChangeText={setServerIpState}
            placeholder="192.168.1.100"
            placeholderTextColor={Colors.textMuted}
            keyboardType="numeric"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />

          <FieldLabel text="Port" />
          <TextInput
            id="server-port-input"
            style={styles.textInput}
            value={serverPort}
            onChangeText={setServerPortState}
            placeholder="8000"
            placeholderTextColor={Colors.textMuted}
            keyboardType="numeric"
            returnKeyType="next"
          />

          <FieldLabel text="API key" />
          <TextInput
            id="api-key-input"
            style={styles.textInput}
            value={apiKey}
            onChangeText={setApiKeyState}
            placeholder="Your secret key"
            placeholderTextColor={Colors.textMuted}
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
              <AppIcon androidName="search" iosName="magnifyingglass" color={Colors.primary} size={18} fallback="S" />
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
              <AppIcon androidName="check" iosName="checkmark" color={Colors.white} size={18} fallback="OK" />
              <Text style={styles.primaryBtnText}>{savingServer ? 'Saving' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </SettingsCard>

        <SectionHeader title="Sync schedule" />
        <SettingsCard>
          <View style={styles.toggleRow}>
            <View style={styles.toggleIcon}>
              <AppIcon
                androidName={syncPaused ? 'pause' : 'sync'}
                iosName={syncPaused ? 'pause.fill' : 'arrow.triangle.2.circlepath'}
                color={syncPaused ? Colors.warning : Colors.primary}
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
              trackColor={{ false: Colors.surfaceBorder, true: Colors.primarySoft }}
              thumbColor={!syncPaused ? Colors.primary : Colors.textMuted}
              accessibilityLabel="Toggle auto sync"
            />
          </View>

          {!syncPaused && (
            <>
              <View style={styles.divider} />
              <FieldLabel text="Sync every" />
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

        <SectionHeader title="Data management" />
        <SettingsCard>
          <TouchableOpacity
            id="refresh-all-button"
            style={styles.dangerBtn}
            onPress={handleRefreshAll}
            accessibilityLabel="Refresh all backups"
            accessibilityRole="button"
          >
            <AppIcon androidName="restart_alt" iosName="arrow.clockwise" color={Colors.error} size={18} fallback="R" />
            <Text style={styles.dangerBtnText}>Refresh all backups</Text>
          </TouchableOpacity>
          <Text style={styles.hintText}>
            Use this when files are missing on the server. Existing cache entries are cleared, then files upload again.
          </Text>
        </SettingsCard>

        <SectionHeader title="About" />
        <SettingsCard>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>App version</Text>
            <Text style={styles.aboutValue}>1.0.0</Text>
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

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    paddingHorizontal: Spacing.six,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.one,
  },
  kicker: {
    color: Colors.primary,
    fontSize: TextScale.xs,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: TextScale.xl,
    fontWeight: '900',
    color: Colors.text,
  },
  subtitle: {
    fontSize: TextScale.sm,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: Spacing.six,
    gap: Spacing.three,
  },
  sectionHeader: {
    fontSize: TextScale.xs,
    fontWeight: '900',
    color: Colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  settingsCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.four,
    gap: Spacing.three,
    ...Shadows.card,
  },
  fieldLabel: {
    fontSize: TextScale.xs,
    fontWeight: '800',
    color: Colors.textSecondary,
    marginBottom: -Spacing.two,
  },
  textInput: {
    minHeight: 46,
    backgroundColor: Colors.surfaceSoft,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    fontSize: TextScale.base,
    color: Colors.text,
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
    borderColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    backgroundColor: Colors.primarySoft,
  },
  outlineBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '900',
    color: Colors.primary,
  },
  primaryBtn: {
    flex: 1,
    minHeight: 46,
    backgroundColor: Colors.primary,
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
    color: Colors.white,
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
    backgroundColor: Colors.primarySoft,
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
    color: Colors.text,
  },
  toggleSub: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  divider: {
    height: 1,
    backgroundColor: Colors.surfaceBorder,
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
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.surfaceSoft,
    justifyContent: 'center',
  },
  presetChipActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  presetText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  presetTextActive: {
    color: Colors.primary,
    fontWeight: '900',
  },
  hintText: {
    fontSize: TextScale.xs,
    color: Colors.textMuted,
    lineHeight: 17,
    fontWeight: '600',
  },
  dangerBtn: {
    minHeight: 46,
    backgroundColor: Colors.errorSoft,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: '#F4B4B4',
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  dangerBtnText: {
    fontSize: TextScale.base,
    fontWeight: '900',
    color: Colors.error,
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
    color: Colors.textSecondary,
    fontWeight: '700',
  },
  aboutValue: {
    fontSize: TextScale.sm,
    color: Colors.text,
    fontWeight: '800',
    textAlign: 'right',
  },
});
