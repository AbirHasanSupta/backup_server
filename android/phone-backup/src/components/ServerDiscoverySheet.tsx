import React, { useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Colors, Spacing, Radius, TextScale } from '@/constants/theme';
import { discoverServers } from '../../serverDiscovery';

interface Server {
  ip: string;
  port: number;
  name: string;
  version: string;
}

interface Props {
  visible: boolean;
  onSelect: (server: Server) => void;
  onClose: () => void;
}

export function ServerDiscoverySheet({ visible, onSelect, onClose }: Props) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState<string | null>(null);

  const progressWidth = useSharedValue(0);

  const progressBarStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value}%` as any,
  }));

  const startScan = useCallback(async () => {
    setScanning(true);
    setServers([]);
    setError(null);
    setProgress(0);
    progressWidth.value = 0;

    try {
      const found = await discoverServers((pct: number, current: Server[]) => {
        setProgress(pct);
        progressWidth.value = withTiming(pct, {
          duration: 200,
          easing: Easing.out(Easing.ease),
        });
        setServers([...current]);
      });
      setServers(found);
      if (found.length === 0) {
        setError('No backup servers found on this network.');
      }
    } catch (err: any) {
      setError(err?.message || 'Scan failed. Check your WiFi connection.');
    } finally {
      setScanning(false);
      progressWidth.value = withTiming(100, { duration: 200 });
    }
  }, []);

  const handleSelect = (server: Server) => {
    onSelect(server);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        {/* Handle bar */}
        <View style={styles.handle} />

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Discover Servers</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.subtitle}>
          Scanning for backup servers on your local network
        </Text>

        {/* Progress bar */}
        {scanning && (
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, progressBarStyle]} />
          </View>
        )}

        {/* Scan button */}
        <TouchableOpacity
          style={[styles.scanBtn, scanning && styles.scanBtnDisabled]}
          onPress={startScan}
          disabled={scanning}
          accessibilityLabel="Scan for servers"
        >
          {scanning ? (
            <ActivityIndicator color={Colors.white} size="small" />
          ) : (
            <Text style={styles.scanBtnText}>
              {servers.length > 0 ? '↻ Scan Again' : '🔍 Start Scan'}
            </Text>
          )}
        </TouchableOpacity>

        {/* Error message */}
        {error && !scanning && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Server list */}
        {servers.length > 0 && (
          <FlatList
            data={servers}
            keyExtractor={(item) => item.ip}
            style={styles.list}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.serverItem}
                onPress={() => handleSelect(item)}
                accessibilityLabel={`Connect to ${item.name} at ${item.ip}`}
              >
                <View style={styles.serverIcon}>
                  <Text style={{ fontSize: 22 }}>🖥️</Text>
                </View>
                <View style={styles.serverInfo}>
                  <Text style={styles.serverName}>{item.name}</Text>
                  <Text style={styles.serverMeta}>
                    {item.ip}:{item.port} · v{item.version}
                  </Text>
                </View>
                <Text style={styles.connectArrow}>→</Text>
              </TouchableOpacity>
            )}
          />
        )}

        {/* Manual entry hint */}
        <Text style={styles.hint}>
          Not finding your server? Enter its IP manually in Settings.
        </Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    padding: Spacing.six,
    paddingBottom: Spacing.seven,
    minHeight: 400,
    maxHeight: '80%',
    borderTopWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceBorder,
    alignSelf: 'center',
    marginBottom: Spacing.five,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.two,
  },
  title: {
    fontSize: TextScale.lg,
    fontWeight: '700',
    color: Colors.text,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: TextScale.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.five,
  },
  progressTrack: {
    height: 3,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceBorder,
    marginBottom: Spacing.four,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.full,
    backgroundColor: Colors.primary,
  },
  scanBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.four,
  },
  scanBtnDisabled: {
    opacity: 0.6,
  },
  scanBtnText: {
    color: Colors.white,
    fontSize: TextScale.base,
    fontWeight: '600',
  },
  errorBox: {
    backgroundColor: Colors.errorDim,
    borderRadius: Radius.md,
    padding: Spacing.three,
    marginBottom: Spacing.four,
  },
  errorText: {
    color: Colors.error,
    fontSize: TextScale.sm,
  },
  list: {
    maxHeight: 200,
  },
  serverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.four,
    marginBottom: Spacing.two,
  },
  serverIcon: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverInfo: {
    flex: 1,
    gap: 2,
  },
  serverName: {
    fontSize: TextScale.base,
    fontWeight: '600',
    color: Colors.text,
  },
  serverMeta: {
    fontSize: TextScale.xs,
    color: Colors.textSecondary,
  },
  connectArrow: {
    fontSize: 18,
    color: Colors.primary,
    fontWeight: '700',
  },
  hint: {
    fontSize: TextScale.xs,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: Spacing.four,
  },
});
