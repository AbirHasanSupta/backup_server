import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Dimensions,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Alert,
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
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Radius, Shadows, Spacing, TextScale } from '@/constants/theme';
import { discoverServers } from '../../serverDiscovery';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { setServerCertFingerprint } from '../../settings';
import { sanitizeErrorMessage } from '@/utils/errorUtils';

const { height: SCREEN_H } = Dimensions.get('window');
const DISMISS_THRESHOLD = 120;

interface Server {
  serverId?: string;
  ip: string;
  port: number;
  name: string;
  version: string;
  certFingerprint?: string;
  all_ips?: string[];
  candidateIps?: string[];
  hostname?: string;
}

interface Props {
  visible: boolean;
  onSelect: (server: Server) => void;
  onClose: () => void;
}

function parseManualAddress(rawInput: string): { ip: string; port: number } | null {
  const raw = rawInput.trim();
  if (!raw) return null;

  let addr = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const slashIdx = addr.indexOf('/');
  if (slashIdx > 0) addr = addr.slice(0, slashIdx);

  // Bracketed IPv6: [fe80::1]:8000 or [fe80::1]
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    if (end > 1) {
      const ip = addr.slice(1, end);
      let port = 8000;
      const rest = addr.slice(end + 1);
      if (rest.startsWith(':')) {
        const maybePort = rest.slice(1);
        if (/^\d+$/.test(maybePort)) {
          const parsed = Number.parseInt(maybePort, 10);
          if (parsed >= 1 && parsed <= 65535) port = parsed;
          else return null;
        } else if (rest.length > 1) {
          return null;
        }
      }
      return ip ? { ip, port } : null;
    }
  }

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

  return ip ? { ip, port } : null;
}

export function ServerDiscoverySheet({ visible, onSelect, onClose }: Props) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { keyboardHeight } = useKeyboardHeight();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [selecting, setSelecting] = useState(false);
  const scanGeneration = useRef(0);
  const mountedRef = useRef(true);
  const selectingRef = useRef(false);

  const translateY = useSharedValue(0);
  const dismiss = useCallback(() => {
    onClose();
  }, [onClose]);

  /* eslint-disable react-hooks/immutability -- Reanimated shared values are designed to be mutated */
  useEffect(() => {
    mountedRef.current = true;
    selectingRef.current = false;
    if (visible) {
      translateY.value = 0;
    }
    return () => {
      mountedRef.current = false;
      selectingRef.current = false;
      // Invalidate in-flight scan callbacks on close/unmount.
      scanGeneration.current += 1;
    };
  }, [visible, translateY]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!selecting)
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
    [dismiss, translateY, selecting]
  );
  /* eslint-enable react-hooks/immutability */

  const sheetAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropAnimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, SCREEN_H * 0.5], [1, 0], Extrapolation.CLAMP),
  }));

  const startScan = useCallback(async () => {
    const generation = ++scanGeneration.current;
    setScanning(true);
    setServers([]);
    setError(null);
    setProgress(0);

    try {
      const found = await discoverServers((pct: number, current: Server[]) => {
        if (generation !== scanGeneration.current || !mountedRef.current) return;
        setProgress(pct);
        setServers([...current]);
      }, {
        shouldStop: () => generation !== scanGeneration.current || !mountedRef.current,
      });
      if (generation !== scanGeneration.current || !mountedRef.current) return;
      setServers(found);
      if (found.length === 0) {
        setError('No backup servers were found on this network.');
      }
    } catch (err: any) {
      if (generation !== scanGeneration.current || !mountedRef.current) return;
      setError(err?.message || 'Scan failed. Check your Wi-Fi connection.');
    } finally {
      if (generation === scanGeneration.current && mountedRef.current) {
        setScanning(false);
        setProgress(100);
      }
    }
  }, []);

  const handleSelect = useCallback(async (server: Server) => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    // Immediately cancel in-flight scan so connection proceeds without waiting
    scanGeneration.current += 1;
    setScanning(false);
    setProgress(100);
    setSelecting(true);
    try {
      if (server.certFingerprint) {
        await setServerCertFingerprint(server.certFingerprint);
      }
      onSelect(server);
      onClose();
    } catch (err: any) {
      selectingRef.current = false;
      if (!mountedRef.current) return;
      Alert.alert('Connection Failed', sanitizeErrorMessage(err, 'Could not save the selected server.'));
      setSelecting(false);
    }
  }, [onSelect, onClose]);

  const handleManualConnect = useCallback(() => {
    if (selectingRef.current) return;
    const parsed = parseManualAddress(manualUrl);
    if (!parsed) {
      Alert.alert('Invalid address', 'Enter an IP, hostname, or URL like 192.168.1.100:8000');
      return;
    }
    selectingRef.current = true;
    setSelecting(true);
    onSelect({ ip: parsed.ip, port: parsed.port, name: parsed.ip, version: '?' });
    setManualUrl('');
    onClose();
  }, [manualUrl, onSelect, onClose]);

  const busy = scanning || selecting;

  const handleRequestClose = useCallback(() => {
    if (selecting) return;
    onClose();
  }, [selecting, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleRequestClose} statusBarTranslucent>
      <GestureHandlerRootView style={styles.modalRoot}>
        <KeyboardAvoidingView
          style={styles.modalRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Animated.View style={[styles.backdrop, backdropAnimStyle]} pointerEvents="box-none">
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={handleRequestClose}
              disabled={selecting}
              accessibilityLabel="Dismiss discovery"
            />
          </Animated.View>

          <Animated.View
            style={[
              styles.sheet,
              sheetAnimStyle,
              { paddingBottom: Math.max(insets.bottom, Spacing.five) + Spacing.two + (Platform.OS === 'android' ? keyboardHeight : 0) },
            ]}
          >
            <GestureDetector gesture={panGesture}>
              <View style={styles.dragArea}>
                <View style={styles.handle} />
              </View>
            </GestureDetector>

            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.title}>Find your server</Text>
                <Text style={styles.subtitle}>Scan your local network for Phone Backup Server.</Text>
              </View>
              <AnimatedPressable
                onPress={handleRequestClose}
                style={styles.closeBtn}
                scaleDown={0.85}
                disabled={selecting}
                accessibilityLabel="Close discovery"
              >
                <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={18} fallback="X" />
              </AnimatedPressable>
            </View>

            {scanning && (
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progress}%` }]} />
              </View>
            )}

            <AnimatedPressable
              style={[styles.scanBtn, busy && styles.scanBtnDisabled]}
              onPress={startScan}
              disabled={busy}
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
                keyExtractor={(item) => (item.serverId ? `${item.serverId}:${item.port}` : `${item.ip}:${item.port}`)}
                style={styles.list}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <AnimatedPressable
                    style={[styles.serverItem, selecting && { opacity: 0.6 }]}
                    onPress={() => handleSelect(item)}
                    disabled={selecting}
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
                    {selecting ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <AppIcon androidName="arrow_forward" iosName="arrow.right" color={colors.primary} size={20} fallback=">" />
                    )}
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
                  editable={!busy}
                  onSubmitEditing={handleManualConnect}
                />
                <AnimatedPressable
                  style={[styles.manualConnectBtn, (!manualUrl.trim() || busy) && { opacity: 0.5 }]}
                  onPress={handleManualConnect}
                  disabled={!manualUrl.trim() || busy}
                  scaleDown={0.9}
                  accessibilityLabel="Connect to manually entered server"
                >
                  <AppIcon androidName="arrow_forward" iosName="arrow.right" color={colors.white} size={18} fallback=">" />
                </AnimatedPressable>
              </View>
            </View>

            <Text style={styles.hint}>Drag the handle down to dismiss. Enter IP, hostname, or full URL with port.</Text>
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(16, 32, 51, 0.42)',
  },
  sheet: {
    zIndex: 2,
    elevation: 8,
    backgroundColor: colors.surface,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    padding: Spacing.six,
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
  headerText: {
    flex: 1,
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
