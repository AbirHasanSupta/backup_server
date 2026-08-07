import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Dimensions,
  Pressable,
  PanResponder,
  Alert,
  StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';

import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  getTodaysMemories,
  getConfig,
  buildPreviewUrl,
  buildVideoPreviewUrl,
  downloadFile,
  downloadSharedFile,
} from '../../downloader';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

type ExpoVideoModule = typeof import('expo-video');
type VideoSource = import('expo-video').VideoSource;

let expoVideoModule: ExpoVideoModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  console.warn('[Memories] ExpoVideo module is unavailable.');
}

interface MemoryItem {
  source_type: string;
  source_id: string;
  source_label: string;
  relative_path: string;
  size: number;
  capture_time: number | null;
  is_video: boolean;
}

interface YearGroup {
  year: number;
  years_ago: number;
  items: MemoryItem[];
}

interface ServerConfig {
  ip: string;
  port: string;
  key: string;
  deviceId: string;
}

export default function MemoriesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ today: { month: number; day: number }; groups: YearGroup[] } | null>(null);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);

  // Story Viewer state
  const [activeGroupIdx, setActiveGroupIdx] = useState<number | null>(null);
  const [activeItemIdx, setActiveItemIdx] = useState<number>(0);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [savingItem, setSavingItem] = useState<boolean>(false);

  const photoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [progressRatio, setProgressRatio] = useState<number>(0);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, res] = await Promise.all([getConfig(), getTodaysMemories()]);
      setServerConfig(cfg);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([getConfig(), getTodaysMemories()])
      .then(([cfg, res]) => {
        if (active) {
          setServerConfig(cfg);
          setData(res);
          setLoading(false);
        }
      })
      .catch((err: any) => {
        if (active) {
          setError(err.message || 'Failed to load memories');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // Story Auto-Advance logic for photos (~4 seconds)
  const currentGroup = activeGroupIdx !== null && data?.groups ? data.groups[activeGroupIdx] : null;
  const currentItem = currentGroup && currentGroup.items[activeItemIdx] ? currentGroup.items[activeItemIdx] : null;

  const advanceItem = useCallback(() => {
    if (activeGroupIdx === null || !data?.groups) return;
    const group = data.groups[activeGroupIdx];
    if (activeItemIdx < group.items.length - 1) {
      setActiveItemIdx(idx => idx + 1);
      setProgressRatio(0);
    } else if (activeGroupIdx < data.groups.length - 1) {
      setActiveGroupIdx(gIdx => (gIdx !== null ? gIdx + 1 : null));
      setActiveItemIdx(0);
      setProgressRatio(0);
    } else {
      setActiveGroupIdx(null);
      setActiveItemIdx(0);
    }
  }, [activeGroupIdx, activeItemIdx, data]);

  const prevItem = useCallback(() => {
    if (activeGroupIdx === null || !data?.groups) return;
    if (activeItemIdx > 0) {
      setActiveItemIdx(idx => idx - 1);
      setProgressRatio(0);
    } else if (activeGroupIdx > 0) {
      const prevGIdx = activeGroupIdx - 1;
      const prevGroup = data.groups[prevGIdx];
      setActiveGroupIdx(prevGIdx);
      setActiveItemIdx(prevGroup.items.length - 1);
      setProgressRatio(0);
    }
  }, [activeGroupIdx, activeItemIdx, data]);

  useEffect(() => {
    if (activeGroupIdx === null || !currentItem || isPaused) {
      if (photoTimerRef.current) clearInterval(photoTimerRef.current);
      return;
    }

    if (currentItem.is_video) {
      return;
    }

    let elapsed = 0;
    const duration = 4000;
    const interval = 80;

    photoTimerRef.current = setInterval(() => {
      elapsed += interval;
      const ratio = Math.min(elapsed / duration, 1);
      setProgressRatio(ratio);
      if (elapsed >= duration) {
        if (photoTimerRef.current) clearInterval(photoTimerRef.current);
        advanceItem();
      }
    }, interval);

    return () => {
      if (photoTimerRef.current) clearInterval(photoTimerRef.current);
    };
  }, [activeGroupIdx, activeItemIdx, currentItem, isPaused, advanceItem]);

  // Handle saving current item to device library
  const handleSaveItem = async (item: MemoryItem) => {
    if (savingItem) return;
    setSavingItem(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Needed', 'Media library permission is required to save photos and videos.');
        setSavingItem(false);
        return;
      }

      const displayName = item.relative_path.split(/[/\\]/).pop() ?? `memory_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}memory_save_${Date.now()}_${displayName}`;

      if (item.source_type === 'shared') {
        await downloadSharedFile(item.source_id, item.relative_path, tmpUri);
      } else {
        await downloadFile(item.relative_path, tmpUri);
      }

      await MediaLibrary.saveToLibraryAsync(tmpUri);
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      Alert.alert('Saved', 'Photo/Video saved to your gallery!');
    } catch (err: any) {
      Alert.alert('Save Failed', err.message || 'Could not save file to device.');
    } finally {
      setSavingItem(false);
    }
  };

  // PanResponder for swipe down to dismiss story
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dy > 30 && Math.abs(gestureState.dx) < 40,
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dy > 50) {
            setActiveGroupIdx(null);
          }
        },
      }),
    [],
  );

  const getMediaUrl = (item: MemoryItem) => {
    if (!serverConfig) return '';
    if (item.is_video) {
      return buildVideoPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id);
    }
    return buildPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id);
  };

  // Format header date string
  const todayDateStr = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* Screen Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerTitle}>On This Day</Text>
          <Text style={styles.headerSubtitle}>{todayDateStr}</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={fetchMemories} disabled={loading}>
          <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={20} />
        </TouchableOpacity>
      </View>

      {/* Body Content */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Finding your memories…</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <AppIcon androidName="cloud_off" iosName="wifi.slash" color={colors.error} size={48} />
          <Text style={styles.errorText}>Server Unreachable</Text>
          <Text style={styles.errorSubtext}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={fetchMemories}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !data || !data.groups || data.groups.length === 0 ? (
        <View style={styles.centered}>
          <View style={styles.emptyIconBg}>
            <AppIcon androidName="auto_awesome" iosName="sparkles" color={colors.primary} size={40} />
          </View>
          <Text style={styles.emptyTitle}>No Memories Today</Text>
          <Text style={styles.emptySubtitle}>Check back tomorrow to relive photos and videos from past years.</Text>
        </View>
      ) : (
        <View style={styles.cardList}>
          {data.groups.map((group, index) => {
            const coverItem = group.items[0];
            const coverUrl = coverItem ? getMediaUrl(coverItem) : '';
            const photoCount = group.items.filter(i => !i.is_video).length;
            const videoCount = group.items.filter(i => i.is_video).length;
            const countsStr = [
              photoCount > 0 ? `${photoCount} photo${photoCount > 1 ? 's' : ''}` : null,
              videoCount > 0 ? `${videoCount} video${videoCount > 1 ? 's' : ''}` : null,
            ]
              .filter(Boolean)
              .join(' · ');

            return (
              <AnimatedPressable
                key={group.year}
                style={styles.yearCardContainer}
                onPress={() => {
                  setActiveGroupIdx(index);
                  setActiveItemIdx(0);
                  setProgressRatio(0);
                }}
                scaleDown={0.97}
              >
                {/* Stacked Photo Layer Effect */}
                <View style={[styles.stackLayer, styles.stackLayerBack]} />
                <View style={[styles.stackLayer, styles.stackLayerMiddle]} />

                {/* Main Cover Card */}
                <View style={styles.cardMain}>
                  {coverUrl ? (
                    <Image source={{ uri: coverUrl }} style={styles.cardImage} contentFit="cover" transition={200} />
                  ) : (
                    <View style={styles.cardImagePlaceholder} />
                  )}

                  {/* Gradient Overlay & Text */}
                  <View style={styles.cardGradientOverlay}>
                    <View style={styles.cardBadge}>
                      <Text style={styles.cardBadgeText}>{group.year}</Text>
                    </View>
                    <View style={styles.cardTextContainer}>
                      <Text style={styles.cardYearsAgo}>
                        {group.years_ago} {group.years_ago === 1 ? 'Year' : 'Years'} Ago
                      </Text>
                      <Text style={styles.cardCountText}>{countsStr}</Text>
                    </View>
                  </View>
                </View>
              </AnimatedPressable>
            );
          })}
        </View>
      )}

      {/* Full-Screen Story Viewer Modal */}
      {currentGroup && currentItem && (
        <Modal
          visible={activeGroupIdx !== null}
          transparent={false}
          animationType="fade"
          onRequestClose={() => setActiveGroupIdx(null)}
        >
          <View style={styles.storyContainer} {...panResponder.panHandlers}>
            <StatusBar barStyle="light-content" />

            {/* Story Media Display */}
            {currentItem.is_video ? (
              <StoryVideoPlayer
                uri={getMediaUrl(currentItem)}
                isPaused={isPaused}
                onEnded={advanceItem}
                onProgressRatio={setProgressRatio}
                styles={styles}
              />
            ) : (
              <Image
                source={{ uri: getMediaUrl(currentItem) }}
                style={styles.storyMedia}
                contentFit="contain"
              />
            )}

            {/* Touch Areas: Left (Prev), Right (Next), Center Hold (Pause) */}
            <View style={styles.touchAreaContainer}>
              <Pressable style={styles.touchLeft} onPress={prevItem} />
              <Pressable
                style={styles.touchCenter}
                onPressIn={() => setIsPaused(true)}
                onPressOut={() => setIsPaused(false)}
              />
              <Pressable style={styles.touchRight} onPress={advanceItem} />
            </View>

            {/* Top Bar: Progress Segments + Close Button */}
            <View style={[styles.storyTopBar, { paddingTop: Math.max(insets.top, 16) }]}>
              <View style={styles.segmentContainer}>
                {currentGroup.items.map((it, idx) => {
                  let fill = 0;
                  if (idx < activeItemIdx) fill = 1;
                  else if (idx === activeItemIdx) fill = progressRatio;

                  return (
                    <View key={idx} style={styles.segmentTrack}>
                      <View style={[styles.segmentFill, { width: `${fill * 100}%` }]} />
                    </View>
                  );
                })}
              </View>

              <View style={styles.storyHeaderRow}>
                <View style={styles.storyHeaderInfo}>
                  <Text style={styles.storyYearTitle}>
                    {currentGroup.years_ago} {currentGroup.years_ago === 1 ? 'Year' : 'Years'} Ago ({currentGroup.year})
                  </Text>
                  <Text style={styles.storySourceSub}>{currentItem.source_label}</Text>
                </View>
                <TouchableOpacity
                  style={styles.closeBtn}
                  onPress={() => setActiveGroupIdx(null)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Bottom Action Row: Save to Device */}
            <View style={[styles.storyBottomBar, { paddingBottom: Math.max(insets.bottom, 20) }]}>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={() => handleSaveItem(currentItem)}
                disabled={savingItem}
              >
                {savingItem ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={20} />
                    <Text style={styles.saveBtnText}>Save to Device</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

function safeMediaCall(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn('[Memories] Player error:', e);
  }
}

// Subcomponent for Video Playback inside Story Modal
function StoryVideoPlayer({
  uri,
  isPaused,
  onEnded,
  onProgressRatio,
  styles,
}: {
  uri: string;
  isPaused: boolean;
  onEnded: () => void;
  onProgressRatio: (r: number) => void;
  styles: any;
}) {
  if (!expoVideoModule) {
    return (
      <View style={styles.videoFallbackContainer}>
        <AppIcon androidName="videocam" iosName="video" color="#fff" size={48} />
        <Text style={styles.videoFallbackText}>Video Playback Unavailable</Text>
      </View>
    );
  }

  return (
    <NativeStoryVideoPlayer
      uri={uri}
      isPaused={isPaused}
      onEnded={onEnded}
      onProgressRatio={onProgressRatio}
      videoModule={expoVideoModule}
      styles={styles}
    />
  );
}

function NativeStoryVideoPlayer({
  uri,
  isPaused,
  onEnded,
  onProgressRatio,
  videoModule,
  styles,
}: {
  uri: string;
  isPaused: boolean;
  onEnded: () => void;
  onProgressRatio: (r: number) => void;
  videoModule: ExpoVideoModule;
  styles: any;
}) {
  const source = useMemo<VideoSource>(
    () => ({
      uri,
      useCaching: true,
      contentType: 'progressive',
    }),
    [uri],
  );

  const player = videoModule.useVideoPlayer(source, p => {
    p.loop = false;
    safeMediaCall(() => p.play());
  });

  useEffect(() => {
    if (isPaused) {
      safeMediaCall(() => player.pause());
    } else {
      safeMediaCall(() => player.play());
    }
  }, [isPaused, player]);

  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      onProgressRatio(1);
      onEnded();
    });
    return () => sub.remove();
  }, [player, onEnded, onProgressRatio]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (player.duration > 0) {
        const ratio = Math.min(player.currentTime / player.duration, 1);
        onProgressRatio(ratio);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [player, onProgressRatio]);

  return (
    <View style={styles.videoContainer}>
      <videoModule.VideoView style={styles.videoFull} player={player} nativeControls={false} />
    </View>
  );
}

const createStyles = (colors: AppColors, insets: any) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: Math.max(insets.top, 12),
      paddingBottom: Spacing.three,
      paddingHorizontal: Spacing.four,
      backgroundColor: colors.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.surfaceBorder,
    },
    backBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
    },
    headerTitleContainer: { alignItems: 'center' },
    headerTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text },
    headerSubtitle: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '600' },
    refreshBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },

    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.five },
    loadingText: { marginTop: Spacing.three, fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600' },
    errorText: { fontSize: TextScale.lg, fontWeight: '800', color: colors.error, marginTop: Spacing.two },
    errorSubtext: { fontSize: TextScale.xs, color: colors.textSecondary, textAlign: 'center', marginTop: 4 },
    retryBtn: {
      marginTop: Spacing.four,
      paddingHorizontal: Spacing.five,
      paddingVertical: Spacing.two,
      backgroundColor: colors.primary,
      borderRadius: Radius.md,
    },
    retryBtnText: { color: '#fff', fontWeight: '700', fontSize: TextScale.sm },

    emptyIconBg: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Spacing.three,
    },
    emptyTitle: { fontSize: TextScale.xl, fontWeight: '800', color: colors.text },
    emptySubtitle: {
      fontSize: TextScale.sm,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: Spacing.two,
      maxWidth: 280,
      lineHeight: 20,
    },

    cardList: { padding: Spacing.five, gap: Spacing.five },
    yearCardContainer: { height: 220, marginVertical: Spacing.two },
    stackLayer: {
      position: 'absolute',
      left: 12,
      right: 12,
      height: 200,
      borderRadius: Radius.xl,
      backgroundColor: colors.surface,
    },
    stackLayerBack: {
      top: -8,
      transform: [{ rotate: '-3deg' }],
      opacity: 0.4,
    },
    stackLayerMiddle: {
      top: -4,
      transform: [{ rotate: '2deg' }],
      opacity: 0.7,
    },
    cardMain: {
      flex: 1,
      borderRadius: Radius.xl,
      overflow: 'hidden',
      backgroundColor: colors.surface,
      elevation: 4,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
    },
    cardImage: { width: '100%', height: '100%' },
    cardImagePlaceholder: { width: '100%', height: '100%', backgroundColor: colors.surfaceBorder },
    cardGradientOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'space-between',
      padding: Spacing.four,
    },
    cardBadge: {
      alignSelf: 'flex-start',
      paddingHorizontal: Spacing.three,
      paddingVertical: 4,
      borderRadius: Radius.sm,
      backgroundColor: 'rgba(0,0,0,0.6)',
    },
    cardBadgeText: { color: '#fff', fontWeight: '800', fontSize: TextScale.xs },
    cardTextContainer: { gap: 2 },
    cardYearsAgo: { color: '#fff', fontSize: TextScale.xl, fontWeight: '900', letterSpacing: -0.5 },
    cardCountText: { color: 'rgba(255,255,255,0.85)', fontSize: TextScale.xs, fontWeight: '600' },

    /* Story Modal Styles */
    storyContainer: { flex: 1, backgroundColor: '#000' },
    storyMedia: { width: SCREEN_W, height: SCREEN_H },
    touchAreaContainer: {
      ...StyleSheet.absoluteFill,
      flexDirection: 'row',
      zIndex: 10,
    },
    touchLeft: { width: '30%', height: '100%' },
    touchCenter: { width: '40%', height: '100%' },
    touchRight: { width: '30%', height: '100%' },

    storyTopBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 20,
      paddingHorizontal: Spacing.four,
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    segmentContainer: { flexDirection: 'row', gap: 4, marginBottom: Spacing.three },
    segmentTrack: { flex: 1, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
    segmentFill: { height: '100%', backgroundColor: '#fff' },

    storyHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: Spacing.three },
    storyHeaderInfo: { gap: 2 },
    storyYearTitle: { color: '#fff', fontWeight: '800', fontSize: TextScale.md },
    storySourceSub: { color: 'rgba(255,255,255,0.75)', fontSize: TextScale.xs, fontWeight: '500' },
    closeBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
    },

    storyBottomBar: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 20,
      paddingHorizontal: Spacing.five,
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    saveBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      paddingHorizontal: Spacing.five,
      paddingVertical: Spacing.three,
      borderRadius: Radius.full,
      backgroundColor: 'rgba(255,255,255,0.25)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.4)',
    },
    saveBtnText: { color: '#fff', fontWeight: '700', fontSize: TextScale.sm },

    videoContainer: { width: SCREEN_W, height: SCREEN_H, justifyContent: 'center', alignItems: 'center' },
    videoFull: { width: '100%', height: '100%' },
    videoFallbackContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    videoFallbackText: { color: '#fff', fontSize: TextScale.sm, marginTop: Spacing.two, fontWeight: '600' },
  });
