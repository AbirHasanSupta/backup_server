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
import { Colors, Spacing, Radius, TextScale, BottomTabInset } from '@/constants/theme';
import { ServerDiscoverySheet } from '@/components/ServerDiscoverySheet';

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

function SettingsRow({ children }: { children: React.ReactNode }) {
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

  // ── Save server settings ──────────────────────────────────────────────────
  const handleSaveServer = async () => {
    if (!serverIp.trim()) {
      Alert.alert('Missing IP', 'Please enter the server IP address.');
      return;
    }
    const portNum = parseInt(serverPort);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      Alert.alert('Invalid Port', 'Port must be a number between 1 and 65535.');
      return;
    }
    setSavingServer(true);
    try {
      const key = apiKey.trim() || 'YOUR_SECRET_KEY';
      await Promise.all([
        setServerIp(serverIp.trim()),
        setServerPort(portNum),
        setApiKey(key),
      ]);

      // Confirm save immediately — connect happens in background
      Alert.alert('Saved', 'Server settings saved.');

      // Fire-and-forget connection request — server may show accept/reject dialog
      connectToServer(serverIp.trim(), portNum, key).then((result) => {
        if (result.status === 'accepted') {
          Alert.alert('✅ Connected', 'This device has been accepted by the server and is ready to back up.');
        } else if (result.status === 'rejected') {
          Alert.alert('❌ Rejected', 'The server rejected this device. Ask the server owner to accept your connection request.');
        }
        // 'error' = server offline / wrong key — silently ignore
      });
    } finally {
      setSavingServer(false);
    }
  };

  // ── Handle server discovered from sheet ───────────────────────────────────
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
      '🖥️ Server Found',
      `"${server.name}" (${server.ip}:${server.port}) saved. Sending connection request…`
    );

    // Register device with the newly discovered server
    connectToServer(server.ip, server.port, key).then((result) => {
      if (result.status === 'accepted') {
        Alert.alert('✅ Connected', `"${server.name}" accepted this device. You are ready to back up!`);
      } else if (result.status === 'rejected') {
        Alert.alert('❌ Rejected', 'The server rejected this device. Check the API key or ask the server owner to accept.');
      }
    });
  };

  // ── Change sync interval ──────────────────────────────────────────────────
  const handleIntervalChange = async (minutes: number) => {
    setSyncIntervalState(minutes);
    await setSyncInterval(minutes);
    await registerBackgroundTask(minutes);
  };

  // ── Toggle pause ──────────────────────────────────────────────────────────
  const handlePauseToggle = async (val: boolean) => {
    setSyncPausedState(val);
    await setSyncPaused(val);
  };

  // ── Refresh all backups ───────────────────────────────────────────────────
  const handleRefreshAll = () => {
    Alert.alert(
      'Refresh All Backups',
      'This will clear the sync cache and re-upload every file on the next sync. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Refresh All',
          style: 'destructive',
          onPress: async () => {
            const count = await clearAllUploads();
            Alert.alert(
              'Done',
              `Cleared ${count} cached entries. All files will be re-uploaded on the next sync.`
            );
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.bg} />

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Configure your backup preferences</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: BottomTabInset + insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Server Configuration ─────────────────────────────────────── */}
        <SectionHeader title="Server Connection" />
        <SettingsRow>
          <FieldLabel text="Server IP Address" />
          <TextInput
            id="server-ip-input"
            style={styles.textInput}
            value={serverIp}
            onChangeText={setServerIpState}
            placeholder="e.g. 192.168.1.100"
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

          <FieldLabel text="API Key" />
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

          {/* Discover / Save buttons */}
          <View style={styles.buttonRow}>
            <TouchableOpacity
              id="discover-servers-button"
              style={styles.outlineBtn}
              onPress={() => setDiscoveryVisible(true)}
              accessibilityLabel="Discover servers on network"
            >
              <Text style={styles.outlineBtnText}>🔍  Discover</Text>
            </TouchableOpacity>
            <TouchableOpacity
              id="save-server-button"
              style={[styles.primaryBtn, savingServer && { opacity: 0.6 }]}
              onPress={handleSaveServer}
              disabled={savingServer}
              accessibilityLabel="Save server settings"
            >
              <Text style={styles.primaryBtnText}>
                {savingServer ? 'Saving…' : '✓  Save'}
              </Text>
            </TouchableOpacity>
          </View>
        </SettingsRow>

        {/* ── Sync Schedule ────────────────────────────────────────────── */}
        <SectionHeader title="Sync Schedule" />
        <SettingsRow>
          {/* Pause toggle */}
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleLabel}>Auto Sync</Text>
              <Text style={styles.toggleSub}>
                {syncPaused
                  ? 'Paused — only Sync Now works'
                  : 'Running automatically in background'}
              </Text>
            </View>
            <Switch
              value={!syncPaused}
              onValueChange={(val) => handlePauseToggle(!val)}
              trackColor={{ false: Colors.surfaceBorder, true: Colors.primaryDim }}
              thumbColor={!syncPaused ? Colors.primary : Colors.textMuted}
              accessibilityLabel="Toggle auto sync"
            />
          </View>

          {/* Interval presets */}
          {!syncPaused && (
            <>
              <View style={styles.divider} />
              <FieldLabel text="Sync Every" />
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
                      <Text
                        style={[styles.presetText, active && styles.presetTextActive]}
                      >
                        {p.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={styles.hintText}>
                Actual frequency may vary — Android may delay background tasks to preserve battery.
              </Text>
            </>
          )}
        </SettingsRow>

        {/* ── Data Management ──────────────────────────────────────────── */}
        <SectionHeader title="Data Management" />
        <SettingsRow>
          <TouchableOpacity
            id="refresh-all-button"
            style={styles.dangerBtn}
            onPress={handleRefreshAll}
            accessibilityLabel="Refresh all backups"
          >
            <Text style={styles.dangerBtnText}>↺  Refresh All Backups</Text>
          </TouchableOpacity>
          <Text style={styles.hintText}>
            Clears the sync cache so every file is re-uploaded on the next sync.
            Use if files are missing on the server.
          </Text>
        </SettingsRow>

        {/* ── About ────────────────────────────────────────────────────── */}
        <SectionHeader title="About" />
        <SettingsRow>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>App Version</Text>
            <Text style={styles.aboutValue}>1.0.0</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>Server Stack</Text>
            <Text style={styles.aboutValue}>Python · FastAPI</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>Framework</Text>
            <Text style={styles.aboutValue}>Expo SDK 57 · React Native</Text>
          </View>
        </SettingsRow>
      </ScrollView>

      {/* Server discovery bottom sheet */}
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
  },
  title: {
    fontSize: TextScale.xl,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
    marginTop: 3,
  },
  scrollContent: {
    paddingHorizontal: Spacing.six,
    gap: Spacing.three,
  },
  sectionHeader: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    color: Colors.textSecondary,
    letterSpacing: 1,
    textTransform: 'uppercase',
    paddingTop: Spacing.three,
    paddingBottom: Spacing.two,
  },
  settingsCard: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  fieldLabel: {
    fontSize: TextScale.xs,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginBottom: -Spacing.two,
  },
  textInput: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    fontSize: TextScale.base,
    color: Colors.text,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: Spacing.three,
    marginTop: Spacing.two,
  },
  outlineBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  outlineBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '600',
    color: Colors.primaryLight,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: Colors.white,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  toggleInfo: {
    flex: 1,
    gap: 3,
  },
  toggleLabel: {
    fontSize: TextScale.base,
    fontWeight: '600',
    color: Colors.text,
  },
  toggleSub: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
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
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.surface,
  },
  presetChipActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  presetText: {
    fontSize: TextScale.sm,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  presetTextActive: {
    color: Colors.primaryLight,
    fontWeight: '700',
  },
  hintText: {
    fontSize: TextScale.xs,
    color: Colors.textMuted,
    lineHeight: 17,
  },
  dangerBtn: {
    backgroundColor: Colors.errorDim,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.error,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  dangerBtnText: {
    fontSize: TextScale.base,
    fontWeight: '700',
    color: Colors.error,
  },
  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.one,
  },
  aboutLabel: {
    fontSize: TextScale.sm,
    color: Colors.textSecondary,
  },
  aboutValue: {
    fontSize: TextScale.sm,
    color: Colors.text,
    fontWeight: '500',
  },
});
