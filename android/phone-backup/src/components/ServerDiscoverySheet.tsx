import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Dimensions,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { AppColors, Radius, Shadows, Spacing, TextScale } from '@/constants/theme';
import { discoverServers } from '../../serverDiscovery';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { setServerCertFingerprint } from '../../settings';

const { height: SCREEN_H } = Dimensions.get('window');
const DISMISS_THRESHOLD = 120;

interface Server {
  ip: string;
  port: number;
  name: string;
  version: string;
  certFingerprint?: string;
}

interface Props {
  visible: boolean;
  onSelect: (server: Server) => void;
  onClose: () => void;
}

export function ServerDiscoverySheet({ visible, onSelect, onClose }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');

  const translateY = useSharedValue(0);
  const dismiss = useCallback(() => {
    onClose();
  }, [onClose]);

  /* eslint-disable react-hooks/immutability -- Reanimated shared values are designed to be mutated */
  useEffect(() => {
    if (visible) {
      translateY.value = 0;
    }
  }, [visible, translateY]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((e) => {
          if (e.translationY > 0) {
            translateY.value = e.translationY;
          }
        })
        .onEnd((e) => {
          if (e.translationY > DISMISS_THRESHOLD || e.velocityY > 500) {
            translateY.value = withTiming(SCREEN_H, { duration: 250 }, (finished) => {
              if (finished) {
                runOnJS(dismiss)();
              }
            });
          } else {
            translateY.value = withSpring(0, { damping: 20, stiffness: 300 });
          }
        }),
    [dismiss, translateY]
  );
  /* eslint-enable react-hooks/immutability */

  const sheetAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropAnimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, SCREEN_H * 0.5], [1, 0], Extrapolation.CLAMP),
  }));

  const startScan = useCallback(async () => {
    setScanning(true);
    setServers([]);
    setError(null);
    setProgress(0);

    try {
      const found = await discoverServers((pct: number, current: Server[]) => {
        setProgress(pct);
        setServers([...current]);
      });
      setServers(found);
      if (found.length === 0) {
        setError('No backup servers were found on this network.');
      }
    } catch (err: any) {
      setError(err?.message || 'Scan failed. Check your Wi-Fi connection.');
    } finally {
      setScanning(false);
      setProgress(100);
    }
  }, []);

  const handleSelect = async (server: Server) => {
    if (server.certFingerprint) {
      await setServerCertFingerprint(server.certFingerprint);
    }
    onSelect(server);
    onClose();
  };

  const handleManualConnect = () => {
    const raw = manualUrl.trim();
    if (!raw) return;
    let addr = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const slashIdx = addr.indexOf('/');
    if (slashIdx > 0) addr = addr.slice(0, slashIdx);
    let ip = addr;
    let port = 8000;
    const colonIdx = addr.lastIndexOf(':');
    if (colonIdx > 0) {
      const maybePort = addr.slice(colonIdx + 1);
      if (/^\d+$/.test(maybePort)) {
        const parsed = Number.parseInt(maybePort, 10);
        if (parsed >= 1 && parsed <= 65535) {
          port = parsed;
          ip = addr.slice(0, colonIdx);
        }
      }
    }
    if (!ip) return;
    onSelect({ ip, port, name: ip, version: '?' });
    setManualUrl('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.backdrop, backdropAnimStyle]}>
        <AnimatedPressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.sheet, sheetAnimStyle]}>
        <GestureDetector gesture={panGesture}>
          <View style={styles.dragArea}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>

        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Find your server</Text>
            <Text style={styles.subtitle}>Scan your local network for Phone Backup Server.</Text>
          </View>
          <AnimatedPressable onPress={onClose} style={styles.closeBtn} scaleDown={0.85} accessibilityLabel="Close discovery">
            <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={18} fallback="X" />
          </AnimatedPressable>
        </View>

        {scanning && (
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        )}

        <AnimatedPressable
          style={[styles.scanBtn, scanning && styles.scanBtnDisabled]}
          onPress={startScan}
          disabled={scanning}
          scaleDown={0.96}
          accessibilityLabel="Scan for servers"
        >
          {scanning ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <>
              <AppIcon androidName="search" iosName="magnifyingglass" color={colors.white} size={18} fallback="S" />
              <Text style={styles.scanBtnText}>{servers.length > 0 ? 'Scan again' : 'Start scan'}</Text>
            </>
          )}
        </AnimatedPressable>

        {error && !scanning && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {servers.length > 0 && (
          <FlatList
            data={servers}
            keyExtractor={(item) => item.ip}
            style={styles.list}
            renderItem={({ item }) => (
              <AnimatedPressable
                style={styles.serverItem}
                onPress={() => handleSelect(item)}
                scaleDown={0.97}
                accessibilityLabel={`Connect to ${item.name} at ${item.ip}`}
              >
                <View style={styles.serverIcon}>
                  <AppIcon androidName="desktop_windows" iosName="desktopcomputer" color={colors.primary} size={24} fallback="PC" />
                </View>
                <View style={styles.serverInfo}>
                  <Text style={styles.serverName}>{item.name}</Text>
                  <Text style={styles.serverMeta}>
                    {item.ip}:{item.port} - v{item.version}
                  </Text>
                </View>
                <AppIcon androidName="arrow_forward" iosName="arrow.right" color={colors.primary} size={20} fallback=">" />
              </AnimatedPressable>
            )}
          />
        )}

        <View style={styles.manualSection}>
          <Text style={styles.manualLabel}>Or enter address manually</Text>
          <View style={styles.manualRow}>
            <TextInput
              style={styles.manualInput}
              value={manualUrl}
              onChangeText={setManualUrl}
              placeholder="http://192.168.1.100:8000"
              placeholderTextColor={colors.textMuted}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleManualConnect}
            />
            <AnimatedPressable
              style={[styles.manualConnectBtn, !manualUrl.trim() && { opacity: 0.5 }]}
              onPress={handleManualConnect}
              disabled={!manualUrl.trim()}
              scaleDown={0.9}
              accessibilityLabel="Connect to manually entered server"
            >
              <AppIcon androidName="arrow_forward" iosName="arrow.right" color={colors.white} size={18} fallback=">" />
            </AnimatedPressable>
          </View>
        </View>

        <Text style={styles.hint}>Drag the handle down to dismiss. Enter IP, hostname, or full URL with port.</Text>
      </Animated.View>
    </Modal>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(16, 32, 51, 0.42)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    padding: Spacing.six,
    paddingBottom: Spacing.seven,
    minHeight: 390,
    maxHeight: '82%',
    borderTopWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  dragArea: {
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.five,
  },
  handle: {
    width: 42,
    height: 5,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceBorder,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: Spacing.four,
    marginBottom: Spacing.five,
  },
  title: {
    fontSize: TextScale.lg,
    fontWeight: '800',
    color: colors.text,
  },
  subtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    marginTop: Spacing.one,
    lineHeight: 19,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    height: 5,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceBorder,
    marginBottom: Spacing.four,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.full,
    backgroundColor: colors.primary,
  },
  scanBtn: {
    minHeight: 48,
    backgroundColor: colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: Spacing.four,
    ...Shadows.soft,
  },
  scanBtnDisabled: {
    opacity: 0.72,
  },
  scanBtnText: {
    color: colors.white,
    fontSize: TextScale.base,
    fontWeight: '800',
  },
  errorBox: {
    backgroundColor: colors.errorSoft,
    borderRadius: Radius.md,
    padding: Spacing.three,
    marginBottom: Spacing.four,
  },
  errorText: {
    color: colors.error,
    fontSize: TextScale.sm,
    fontWeight: '600',
  },
  list: {
    maxHeight: 220,
  },
  serverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    padding: Spacing.four,
    marginBottom: Spacing.two,
    ...Shadows.card,
  },
  serverIcon: {
    width: 46,
    height: 46,
    borderRadius: Radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverInfo: {
    flex: 1,
    gap: 3,
  },
  serverName: {
    fontSize: TextScale.base,
    fontWeight: '800',
    color: colors.text,
  },
  serverMeta: {
    fontSize: TextScale.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  hint: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: Spacing.four,
    lineHeight: 17,
  },
  manualSection: {
    marginTop: Spacing.five,
    gap: Spacing.two,
  },
  manualLabel: {
    fontSize: TextScale.xs,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  manualRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
  },
  manualInput: {
    flex: 1,
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
  manualConnectBtn: {
    width: 46,
    height: 46,
    borderRadius: Radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadows.soft,
  },
});
