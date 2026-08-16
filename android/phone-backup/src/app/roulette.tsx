import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, StatusBar, Animated, Easing, Alert, BackHandler, AppState } from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';

import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import {
  getRouletteItem,
  getConfig,
  buildPreviewUrl,
  buildVideoPreviewUrl,
  downloadFile,
  downloadSharedFile,
} from '../../downloader';

type ExpoSensorsModule = typeof import('expo-sensors');
type ExpoVideoModule = typeof import('expo-video');
type VideoSource = import('expo-video').VideoSource;

let expoSensorsModule: ExpoSensorsModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  expoSensorsModule = require('expo-sensors') as ExpoSensorsModule;
} catch {
  console.warn('[Roulette] expo-sensors unavailable — shake-to-spin disabled, manual spin still works.');
}

let expoVideoModule: ExpoVideoModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  console.warn('[Roulette] expo-video unavailable — video results will show as a static card.');
}

const SHAKE_THRESHOLD = 1.6;
const SHAKE_DEBOUNCE_MS = 3000;

interface ServerConfig {
  ip: string;
  port: string;
  key: string;
  deviceId: string;
}

interface RouletteItem {
  source_type: string;
  source_id: string;
  source_label: string;
  relative_path: string;
  size: number;
  capture_time: number | null;
  is_video: boolean;
  year: number | null;
}

type Phase = 'idle' | 'spinning' | 'revealed' | 'empty' | 'error';

function safeCall(fn: () => void) {
  try { fn(); } catch (e) { console.warn('[Roulette] media call failed:', e); }
}

export default function RouletteScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [item, setItem] = useState<RouletteItem | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const phaseRef = useRef<Phase>('idle');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const spinRotate = useMemo(() => new Animated.Value(0), []);
  const revealScale = useMemo(() => new Animated.Value(0.85), []);
  const revealOpacity = useMemo(() => new Animated.Value(0), []);
  const spinLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    getConfig().then(setServerConfig).catch(() => {});
  }, []);

  const startSpinAnimation = useCallback(() => {
    spinRotate.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spinRotate, { toValue: 1, duration: 650, easing: Easing.linear, useNativeDriver: true }),
    );
    spinLoopRef.current = loop;
    loop.start();
  }, [spinRotate]);

  const stopSpinAnimation = useCallback(() => {
    spinLoopRef.current?.stop();
    spinLoopRef.current = null;
  }, []);

  const spin = useCallback(async () => {
    if (phaseRef.current === 'spinning') return;
    setPhase('spinning');
    setErrorMsg(null);
    revealOpacity.setValue(0);
    revealScale.setValue(0.85);
    startSpinAnimation();

    const minSpinTime = new Promise(resolve => setTimeout(resolve, 700));
    try {
      const [result] = await Promise.all([getRouletteItem(), minSpinTime]);
      stopSpinAnimation();
      if (!result) {
        setPhase('empty');
        return;
      }
      setItem(result);
      setPhase('revealed');
      Animated.parallel([
        Animated.spring(revealScale, { toValue: 1, useNativeDriver: true, speed: 16, bounciness: 8 }),
        Animated.timing(revealOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } catch (err: any) {
      stopSpinAnimation();
      setErrorMsg(sanitizeErrorMessage(err, 'Could not reach the server.'));
      setPhase('error');
    }
  }, [revealOpacity, revealScale, startSpinAnimation, stopSpinAnimation]);

  // Shake-to-spin — only listens while this screen is mounted.
  useEffect(() => {
    if (!expoSensorsModule) return;
    let subscription: { remove: () => void } | null = null;
    let cancelled = false;

    (async () => {
      try {
        const available = await expoSensorsModule!.Accelerometer.isAvailableAsync();
        if (!available || cancelled) return;
        expoSensorsModule!.Accelerometer.setUpdateInterval(120);
        let lastShake = 0;
        subscription = expoSensorsModule!.Accelerometer.addListener(({ x, y, z }) => {
          const magnitude = Math.sqrt(x * x + y * y + z * z);
          const delta = Math.abs(magnitude - 1);
          const now = Date.now();
          if (delta > SHAKE_THRESHOLD && now - lastShake > SHAKE_DEBOUNCE_MS && phaseRef.current !== 'spinning') {
            lastShake = now;
            spin();
          }
        });
      } catch (e) {
        console.warn('[Roulette] Accelerometer unavailable:', e);
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [spin]);

  useEffect(() => () => stopSpinAnimation(), [stopSpinAnimation]);

  // Screen can stay mounted in the background (tab navigator) — stop any
  // playing video/animation and reset to a fresh state when it loses focus.
  useFocusEffect(
    useCallback(() => {
      return () => {
        stopSpinAnimation();
        setPhase('idle');
        setItem(null);
        setErrorMsg(null);
      };
    }, [stopSpinAnimation]),
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/memories');
      return true;
    });
    return () => sub.remove();
  }, [router]);

  // App backgrounded (home button / app switcher) — screen keeps focus in the
  // tab navigator so useFocusEffect's blur cleanup never fires; stop the
  // video/spin explicitly or it silently keeps playing behind the OS.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        stopSpinAnimation();
        setPhase('idle');
        setItem(null);
      }
    });
    return () => sub.remove();
  }, [stopSpinAnimation]);

  const handleSave = async () => {
    if (!item || saving) return;
    setSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        setSaving(false);
        return;
      }
      const displayName = item.relative_path.split(/[/\\]/).pop() ?? `roulette_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}roulette_${Date.now()}_${displayName}`;

      if (item.source_type === 'shared') {
        await downloadSharedFile(item.source_id, item.relative_path, tmpUri);
      } else {
        await downloadFile(item.relative_path, tmpUri);
      }
      await MediaLibrary.saveToLibraryAsync(tmpUri);
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      Alert.alert('Saved', 'Saved to your gallery!');
    } catch (err: any) {
      Alert.alert('Save Failed', sanitizeErrorMessage(err, 'Could not save to device.'));
    } finally {
      setSaving(false);
    }
  };

  const handleShare = async () => {
    if (!item || sharing) return;
    setSharing(true);
    try {
      const displayName = item.relative_path.split(/[/\\]/).pop() ?? `roulette_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}roulette_share_${Date.now()}_${displayName}`;

      if (item.source_type === 'shared') {
        await downloadSharedFile(item.source_id, item.relative_path, tmpUri);
      } else {
        await downloadFile(item.relative_path, tmpUri);
      }

      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Sharing Unavailable', 'Sharing is not available on this device.');
        return;
      }
      await Sharing.shareAsync(tmpUri);
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
    } catch (err: any) {
      Alert.alert('Share Failed', sanitizeErrorMessage(err, 'Could not share this memory.'));
    } finally {
      setSharing(false);
    }
  };

  const mediaUrl = item && serverConfig
    ? (item.is_video
      ? buildVideoPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id)
      : buildPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id))
    : '';

  const spinRotateInterpolate = spinRotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.replace('/memories')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <AppIcon androidName="close" iosName="xmark" color="#fff" size={22} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Photo Roulette</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.stage}>
        {phase === 'idle' && (
          <View style={styles.centered}>
            <View style={styles.diceIconWrap}>
              <AppIcon androidName="casino" iosName="die.face.5.fill" color={colors.primary} size={40} />
            </View>
            <Text style={styles.idleTitle}>Feeling lucky?</Text>
            <Text style={styles.idleSubtitle}>Spin to pull a random memory from your backup.{expoSensorsModule ? '\nOr just shake your phone.' : ''}</Text>
          </View>
        )}

        {phase === 'spinning' && (
          <View style={styles.centered}>
            <Animated.View style={[styles.spinnerWrap, { transform: [{ rotate: spinRotateInterpolate }] }]}>
              <AppIcon androidName="casino" iosName="die.face.5.fill" color={colors.primary} size={40} />
            </Animated.View>
            <Text style={styles.idleSubtitle}>Rolling…</Text>
          </View>
        )}

        {phase === 'empty' && (
          <View style={styles.centered}>
            <AppIcon androidName="image_not_supported" iosName="exclamationmark.triangle" color="#fff" size={44} />
            <Text style={styles.idleSubtitle}>Nothing backed up yet — spin again once you have synced some photos.</Text>
          </View>
        )}

        {phase === 'error' && (
          <View style={styles.centered}>
            <AppIcon androidName="cloud_off" iosName="wifi.slash" color="#fff" size={44} />
            <Text style={styles.idleSubtitle}>{errorMsg}</Text>
          </View>
        )}

        {phase === 'revealed' && item && (
          <Animated.View style={[styles.revealCard, { opacity: revealOpacity, transform: [{ scale: revealScale }] }]}>
            <View style={styles.revealMediaWrap}>
              {item.is_video ? (
                <RouletteVideoPlayer uri={mediaUrl} />
              ) : (
                <Image source={{ uri: mediaUrl }} style={styles.revealMedia} contentFit="cover" transition={150} />
              )}
            </View>
            <View style={styles.revealMetaRow}>
              <Text style={styles.revealMetaText}>
                {item.year ? item.year : item.source_label}
              </Text>
              <View style={styles.revealActions}>
                <TouchableOpacity onPress={handleShare} disabled={sharing} style={styles.revealSaveBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  {sharing ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={20} />
                  )}
                </TouchableOpacity>
                <TouchableOpacity onPress={handleSave} disabled={saving} style={styles.revealSaveBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  {saving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={20} />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        )}
      </View>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 20) + Spacing.four }]}>
        <TouchableOpacity
          style={styles.spinBtn}
          onPress={spin}
          disabled={phase === 'spinning'}
          activeOpacity={0.85}
        >
          <AppIcon androidName="casino" iosName="die.face.5.fill" color="#fff" size={20} />
          <Text style={styles.spinBtnText}>{phase === 'idle' ? 'Spin' : 'Spin Again'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function RouletteVideoPlayer({ uri }: { uri: string }) {
  if (!expoVideoModule || !uri) {
    return (
      <View style={styles_fallback.wrap}>
        <AppIcon androidName="videocam" iosName="video" color="#fff" size={40} />
      </View>
    );
  }
  return <NativeRouletteVideoPlayer uri={uri} videoModule={expoVideoModule} />;
}

function NativeRouletteVideoPlayer({ uri, videoModule }: { uri: string; videoModule: ExpoVideoModule }) {
  const source = useMemo<VideoSource>(() => ({ uri, useCaching: true, contentType: 'progressive' }), [uri]);
  const player = videoModule.useVideoPlayer(source, p => {
    p.loop = true;
    p.muted = false;
    safeCall(() => p.play());
  });
  // Belt-and-suspenders: explicitly pause before the player is released so
  // audio never keeps running behind a transition even if unmount is delayed.
  useEffect(() => () => safeCall(() => player.pause()), [player]);
  return <videoModule.VideoView style={{ width: '100%', height: '100%' }} player={player} nativeControls={false} contentFit="cover" surfaceType="textureView" />;
}

const styles_fallback = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
});

const createStyles = (colors: AppColors, insets: any) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: Math.max(insets.top, 16),
      paddingHorizontal: Spacing.five,
      paddingBottom: Spacing.three,
    },
    closeBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.12)',
    },
    headerTitle: { color: '#fff', fontSize: TextScale.lg, fontWeight: '800' },

    stage: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.six },
    centered: { alignItems: 'center', justifyContent: 'center' },

    diceIconWrap: {
      width: 88, height: 88, borderRadius: 44,
      backgroundColor: colors.primarySoft,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: Spacing.four,
    },
    idleTitle: { color: '#fff', fontSize: TextScale.xl, fontWeight: '800', marginBottom: Spacing.two },
    idleSubtitle: { color: 'rgba(255,255,255,0.65)', fontSize: TextScale.sm, textAlign: 'center', lineHeight: 20 },

    spinnerWrap: {
      width: 88, height: 88, borderRadius: 44,
      backgroundColor: colors.primarySoft,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: Spacing.four,
    },

    revealCard: {
      width: '100%',
      borderRadius: Radius.xxl,
      overflow: 'hidden',
      backgroundColor: '#111',
    },
    revealMediaWrap: { width: '100%', aspectRatio: 3 / 4, backgroundColor: '#111' },
    revealMedia: { width: '100%', height: '100%' },
    revealMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.five,
      paddingVertical: Spacing.three,
      backgroundColor: 'rgba(255,255,255,0.06)',
    },
    revealMetaText: { color: '#fff', fontSize: TextScale.base, fontWeight: '700' },
    revealActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    revealSaveBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.12)',
    },

    footer: { paddingHorizontal: Spacing.six, paddingTop: Spacing.three, alignItems: 'center' },
    spinBtn: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
      backgroundColor: colors.primary,
      paddingHorizontal: Spacing.eight, paddingVertical: Spacing.four,
      borderRadius: Radius.full,
      width: '100%',
      justifyContent: 'center',
    },
    spinBtnText: { color: '#fff', fontWeight: '800', fontSize: TextScale.base },
  });