import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  FlatList,
  StatusBar,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Animated,
  LayoutChangeEvent,
  RefreshControl,
  PanResponder,
  Alert,
  DeviceEventEmitter,
} from 'react-native';
import { Image } from 'expo-image';
import { useEvent } from 'expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { ShareModal } from '@/components/ShareModal';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useModalKeyboardHeight } from '@/hooks/useKeyboardHeight';
import {
  getReelsFeed,
  getCachedReelsFeed,
  getLibraryReels,
  sendReelTelemetry,
  getConfig,
  buildSharePreviewUrl,
  buildShareThumbnailUrl,
  reactToMedia,
  getComments,
  addComment,
  deleteComment,
  repostReel,
  cancelRepostReel,
  toggleSaveReel,
  markShareNotificationsSeen,
} from '../../downloader';
import {
  ReelItem,
  ReelAuthorInfo,
  HyperPulseState,
  PlaybackTelemetryEvent,
  loadHyperPulseState,
  persistHyperPulseState,
  processPlaybackTelemetry,
  buildDiverseReelSlate,
  createDefaultState,
} from '@/utils/reelEngine';
import { hapticLight, hapticSuccess, hapticError, hapticLongPress, hapticSelection } from '@/utils/haptics';

export type { ReelItem, ReelAuthorInfo };

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Tab bar height matching _layout.tsx
const TAB_BAR_HEIGHT = Platform.OS === 'android' ? 82 : 88;
const TAB_BAR_BOTTOM_OFFSET = 10;
const TAB_BAR_TOTAL_CLEARANCE = TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_OFFSET + 4;

// ─── Optional expo-video (same lazy-require pattern as restore.tsx) ───────────

type ExpoVideoModule = typeof import('expo-video');
type VideoSource = import('expo-video').VideoSource;
let expoVideoModule: ExpoVideoModule | null = null;
try {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  console.warn('[Reels] expo-video unavailable – falling back to thumbnail-only view');
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ServerConfig = { ip: string; port: string; key: string; deviceId: string } | null;
type ReelSection = 'for-you' | 'backups' | 'shared';

function isLibrarySection(section: ReelSection): section is 'backups' | 'shared' {
  return section === 'backups' || section === 'shared';
}

function reelEngineScope(section: ReelSection): 'default' | 'backups' | 'shared' {
  return section === 'for-you' ? 'default' : section;
}

function reelSectionTitle(section: ReelSection): string {
  if (section === 'backups') return 'Backup Folders';
  if (section === 'shared') return 'Shared Folders';
  return 'Reels';
}

function expectedLibrarySource(section: 'backups' | 'shared'): 'reel_backup' | 'reel_shared' {
  return section === 'backups' ? 'reel_backup' : 'reel_shared';
}

type Comment = {
  id: number;
  text: string;
  source_id: string;
  display_name?: string;
  created_at: number;
  is_own: boolean;
};

const MUTED_KEY = 'reels_muted_v1';


// ─── Media Time Helper ────────────────────────────────────────────────────────

function formatMediaTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Bottom Progress / Seek Bar (YouTube Shorts style) ───────────────────────

const progressStyles = StyleSheet.create({
  track: {
    height: 2.5,
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    position: 'relative',
    justifyContent: 'center',
  },
  trackActive: {
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  fill: {
    height: '100%',
    backgroundColor: '#FFFFFF',
  },
  fillActive: {
    backgroundColor: '#FFFFFF',
  },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFFFFF',
    top: '50%',
    marginTop: -7,
    marginLeft: -7,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 6,
  },
});

// ─── Video player (only rendered when expo-video is available) ────────────────

type VideoPlayerProps = {
  uri: string;
  isActive: boolean;
  isPlaying: boolean;
  speed: number;
  muted: boolean;
  onProgress: (current: number, total: number) => void;
  onReady: () => void;
  playerRef?: React.RefObject<any>;
};

function VideoReelPlayer({ uri, isActive, isPlaying, speed, muted, onProgress, onReady, playerRef }: VideoPlayerProps) {
  const mod = expoVideoModule!;

  const source = useMemo<VideoSource>(() => ({
    uri,
    useCaching: true,
    contentType: 'progressive',
  }), [uri]);

  const player = mod.useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = muted;
    p.preservesPitch = true;
    p.bufferOptions = {
      preferredForwardBufferDuration: 15,
      minBufferForPlayback: 0.25,
      prioritizeTimeOverSizeThreshold: true,
    };
  });

  const { status } = useEvent(player, 'statusChange', { status: player.status });

  const readyFiredRef = useRef(false);
  const onReadyRef = useRef(onReady);
  const onProgressRef = useRef(onProgress);

  useEffect(() => {
    if (playerRef) {
      playerRef.current = player;
    }
  }, [player, playerRef]);

  useEffect(() => {
    onReadyRef.current = onReady;
    onProgressRef.current = onProgress;
  }, [onReady, onProgress]);

  useEffect(() => {
    if (status === 'readyToPlay') {
      if (!readyFiredRef.current) {
        readyFiredRef.current = true;
        onReadyRef.current();
      }
      if (isActive && isPlaying) {
        try { player.play(); } catch {}
      }
    }
  }, [status, isActive, isPlaying, player]);

  // Reset ready flag per source so that swiping back to a cached reel fires
  // onReady again if needed (e.g. the card was recycled while off-screen).
  useEffect(() => {
    readyFiredRef.current = false;
  }, [uri]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isActive) return;
      try {
        const dur = player.duration || 0;
        if (dur > 0) onProgressRef.current(player.currentTime || 0, dur);
      } catch {}
    }, 150);
    return () => clearInterval(interval);
  }, [player, isActive]);

  useEffect(() => {
    try {
      if (isActive && isPlaying) {
        player.play();
      } else {
        player.pause();
      }
    } catch {}
  }, [isActive, isPlaying, player]);

  useEffect(() => {
    // expo-video player properties are mutable refs, not state — assigning them
    // directly is the documented pattern; no lint suppression needed.
    try {
      player.preservesPitch = true;
      player.playbackRate = speed;
      if (isActive && isPlaying) {
        player.play();
      }
    } catch {}
  }, [speed, player, isActive, isPlaying]);

  useEffect(() => {
    try { player.muted = muted; } catch {}
  }, [muted, player]);

  return (
    <mod.VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="contain"
      nativeControls={false}
    />
  );
}

// ─── Single reel card ─────────────────────────────────────────────────────────

const REACTION_EMOJIS = ['❤️', '😂', '😮', '👍'] as const;

type ReelCardProps = {
  item: ReelItem;
  isActive: boolean;
  isMounted?: boolean;
  cardWidth: number;
  cardHeight: number;
  serverConfig: ServerConfig;
  muted: boolean;
  onToggleMute: () => void;
  onReact: (item: ReelItem, emoji: string) => void;
  onOpenComments: (item: ReelItem) => void;
  onOpenRepost: (item: ReelItem) => void;
  onToggleSave: (item: ReelItem) => void;
  onSpeedModeChange?: (reelId: string, isFastForwarding: boolean) => void;
  onPlaybackTelemetry?: (ev: PlaybackTelemetryEvent) => void;
  colors: AppColors;
};

function ReelCardBase({
  item,
  isActive,
  isMounted = true,
  cardWidth,
  cardHeight,
  serverConfig,
  muted,
  onToggleMute,
  onReact,
  onOpenComments,
  onOpenRepost,
  onToggleSave,
  onSpeedModeChange,
  onPlaybackTelemetry,
}: ReelCardProps) {
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1.0);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showControls, setShowControls] = useState(false);
  const [show2x, setShow2x] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const heartScale = useMemo(() => new Animated.Value(0), []);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef(0);
  const isLongPressingRef = useRef(false);
  const lastLongPressEndRef = useRef(0);
  const readyOnceRef = useRef(false);

  // HyperPulse Telemetry Tracking
  const durationRef = useRef(0);
  const activeStartRef = useRef<number>(0);
  const totalWatchMsRef = useRef<number>(0);
  const lastCurTimeRef = useRef<number>(0);
  const loopCountRef = useRef<number>(0);
  const unmutedDuringRef = useRef<boolean>(false);
  const prevMutedRef = useRef<boolean>(muted);
  const onPlaybackTelemetryRef = useRef(onPlaybackTelemetry);
  useEffect(() => { onPlaybackTelemetryRef.current = onPlaybackTelemetry; }, [onPlaybackTelemetry]);

  // Track unmuting during active watch
  useEffect(() => {
    if (isActive && prevMutedRef.current && !muted) {
      unmutedDuringRef.current = true;
    }
    prevMutedRef.current = muted;
  }, [isActive, muted]);

  // Track active transitions to record watch session
  useEffect(() => {
    if (isActive) {
      activeStartRef.current = Date.now();
      totalWatchMsRef.current = 0;
      loopCountRef.current = 0;
      lastCurTimeRef.current = 0;
      unmutedDuringRef.current = false;
    } else if (activeStartRef.current > 0) {
      const sessionMs = Date.now() - activeStartRef.current;
      activeStartRef.current = 0;
      totalWatchMsRef.current += sessionMs;
      const watchSec = totalWatchMsRef.current / 1000;
      const dur = durationRef.current || item.duration || 1;
      const completion = dur > 0 ? watchSec / dur : 0;
      const isFastSkip = watchSec < 1.8 && completion < 0.25;

      const authorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;
      onPlaybackTelemetryRef.current?.({
        share_id: item.share_id,
        reel_id: item.reel_id,
        media_id: item.media_id,
        author_key: authorKey,
        watch_time_sec: watchSec,
        duration_sec: dur,
        completion_rate: completion,
        loops: loopCountRef.current,
        skipped: isFastSkip,
        unmuted: unmutedDuringRef.current,
        liked: Boolean(item.user_reactions && item.user_reactions.length > 0),
        saved: Boolean(item.is_saved),
        reposted: Boolean(item.user_has_reposted),
        tokens: item.tokens,
        group_id: item.group_id,
        timestamp: Date.now(),
      });
    }
  }, [isActive, item]);

  // When unmounting while active, record final telemetry
  useEffect(() => {
    return () => {
      if (activeStartRef.current > 0) {
        const sessionMs = Date.now() - activeStartRef.current;
        const watchSec = (totalWatchMsRef.current + sessionMs) / 1000;
        const dur = durationRef.current || item.duration || 1;
        const completion = dur > 0 ? watchSec / dur : 0;
        const isFastSkip = watchSec < 1.8 && completion < 0.25;
        const authorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;
        onPlaybackTelemetryRef.current?.({
          share_id: item.share_id,
          reel_id: item.reel_id,
          media_id: item.media_id,
          author_key: authorKey,
          watch_time_sec: watchSec,
          duration_sec: dur,
          completion_rate: completion,
          loops: loopCountRef.current,
          skipped: isFastSkip,
          unmuted: unmutedDuringRef.current,
          liked: Boolean(item.user_reactions && item.user_reactions.length > 0),
          saved: Boolean(item.is_saved),
          reposted: Boolean(item.user_has_reposted),
          tokens: item.tokens,
          group_id: item.group_id,
          timestamp: Date.now(),
        });
      }
    };
  }, [item]);


  // Draggable seek state
  const playerRef = useRef<any>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekProgress, setSeekProgress] = useState(0);
  const isSeekingRef = useRef(false);
  const seekProgressRef = useRef(0);
  const wasPlayingBeforeSeekRef = useRef(false);
  const grantPageXRef = useRef(0);
  const grantLocationXRef = useRef(0);
  const seekBarWidthRef = useRef(cardWidth || SCREEN_W);
  const isPlayingRef = useRef(isPlaying);

  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { seekBarWidthRef.current = cardWidth || SCREEN_W; }, [cardWidth]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const videoUrl = serverConfig ? buildSharePreviewUrl(serverConfig, item.share_id) : '';
  const thumbUrl = serverConfig ? buildShareThumbnailUrl(serverConfig, item.share_id) : '';
  const totalReactions = Object.values(item.reaction_counts || {}).reduce((a, b) => a + b, 0);
  const myReaction = item.user_reactions?.[0];
  const isLiked = !!myReaction;
  const initial = (item.shared_by || '').trim().charAt(0).toUpperCase();

  const flashControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setShowControls(false), 2200);
  }, []);

  const handlePress = useCallback(() => {
    // Suppress tap if coming out of a long press (within 400ms) or if currently long pressing
    if (isLongPressingRef.current || (Date.now() - lastLongPressEndRef.current < 400)) {
      return;
    }
    if (showEmojiPicker) { setShowEmojiPicker(false); return; }
    const now = Date.now();
    const isDouble = now - lastTapRef.current < 300;
    lastTapRef.current = now;
    if (isDouble) {
      if (singleTapTimerRef.current) { clearTimeout(singleTapTimerRef.current); singleTapTimerRef.current = null; }
      if (!item.user_reactions?.includes('❤️')) onReact(item, '❤️');
      hapticSuccess();
      setShowHeart(true);
      heartScale.setValue(0);
      Animated.sequence([
        Animated.spring(heartScale, { toValue: 1, friction: 4, useNativeDriver: true }),
        Animated.timing(heartScale, { toValue: 0, duration: 200, delay: 400, useNativeDriver: true }),
      ]).start(() => setShowHeart(false));
    } else {
      singleTapTimerRef.current = setTimeout(() => {
        setIsPlaying(p => {
          const next = !p;
          const pl = playerRef.current;
          if (pl) {
            try {
              if (next) pl.play();
              else pl.pause();
            } catch {}
          }
          return next;
        });
        flashControls();
      }, 300);
    }
  }, [showEmojiPicker, item, onReact, heartScale, flashControls]);

  const handleLongPress = useCallback(() => {
    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
    isLongPressingRef.current = true;
    hapticLongPress();
    setShowControls(false);
    setShowEmojiPicker(false);
    setSpeed(2.0);
    setShow2x(true);
    onSpeedModeChange?.(item.reel_id, true);
  }, [item.reel_id, onSpeedModeChange]);

  const handlePressOut = useCallback(() => {
    if (isLongPressingRef.current) {
      isLongPressingRef.current = false;
      lastLongPressEndRef.current = Date.now();
    }
    setSpeed(1.0);
    setShow2x(false);
    onSpeedModeChange?.(item.reel_id, false);
  }, [item.reel_id, onSpeedModeChange]);

  useEffect(() => {
    if (isActive) {
      setIsPlaying(true);
      setProgress(0);
      setCurrentTime(0);
      setDuration(0);
      setIsSeeking(false);
      isSeekingRef.current = false;
      seekProgressRef.current = 0;
      if (!readyOnceRef.current) setIsLoading(true);
    } else {
      setIsPlaying(false);
      setShowEmojiPicker(false);
      setShow2x(false);
      setSpeed(1.0);
      onSpeedModeChange?.(item.reel_id, false);
      setIsSeeking(false);
      isSeekingRef.current = false;
      seekProgressRef.current = 0;
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      setShowControls(false);
    }
  }, [isActive, item.reel_id, onSpeedModeChange]);

  useEffect(() => () => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
    onSpeedModeChange?.(item.reel_id, false);
  }, [item.reel_id, onSpeedModeChange]);

  const handleProgress = useCallback((cur: number, dur: number) => {
    if (!isSeekingRef.current) {
      setCurrentTime(cur);
      setDuration(dur);
      setProgress(dur > 0 ? cur / dur : 0);

      // Loop detection: if playback wrapped around from near end to start
      if (dur > 2.0 && lastCurTimeRef.current > dur * 0.75 && cur < dur * 0.25) {
        loopCountRef.current += 1;
      }
      lastCurTimeRef.current = cur;
    }
  }, []);

  const handleReady = useCallback(() => {
    readyOnceRef.current = true;
    setIsLoading(false);
  }, []);

  const toggleHeartLike = useCallback(() => {
    hapticLight();
    if (isLiked) {
      onReact(item, myReaction || '❤️');
    } else {
      onReact(item, '❤️');
    }
  }, [isLiked, myReaction, item, onReact]);

  const seekPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (evt) => {
      isSeekingRef.current = true;
      setIsSeeking(true);
      hapticLight();
      const p = playerRef.current;
      if (p) {
        wasPlayingBeforeSeekRef.current = p.playing ?? isPlayingRef.current;
        try { p.pause(); } catch {}
      } else {
        wasPlayingBeforeSeekRef.current = isPlayingRef.current;
      }
      const width = Math.max(1, seekBarWidthRef.current || cardWidth || SCREEN_W);
      const locX = evt.nativeEvent.locationX;
      grantLocationXRef.current = locX;
      grantPageXRef.current = evt.nativeEvent.pageX;
      const ratio = Math.max(0, Math.min(1, locX / width));
      seekProgressRef.current = ratio;
      setSeekProgress(ratio);
      const dur = durationRef.current;
      if (p && dur > 0) {
        try { p.currentTime = ratio * dur; } catch {}
      }
    },
    onPanResponderMove: (evt) => {
      const width = Math.max(1, seekBarWidthRef.current || cardWidth || SCREEN_W);
      const currentX = grantLocationXRef.current + (evt.nativeEvent.pageX - grantPageXRef.current);
      const ratio = Math.max(0, Math.min(1, currentX / width));
      seekProgressRef.current = ratio;
      setSeekProgress(ratio);
      const p = playerRef.current;
      const dur = durationRef.current;
      if (p && dur > 0) {
        try { p.currentTime = ratio * dur; } catch {}
      }
    },
    onPanResponderRelease: () => {
      const finalRatio = seekProgressRef.current;
      const p = playerRef.current;
      const dur = durationRef.current;
      if (p && dur > 0) {
        try { p.currentTime = finalRatio * dur; } catch {}
      }
      isSeekingRef.current = false;
      setIsSeeking(false);
      setProgress(finalRatio);
      setCurrentTime(finalRatio * dur);
      lastCurTimeRef.current = finalRatio * dur;
      hapticSelection();
      if (wasPlayingBeforeSeekRef.current && p) {
        try { p.play(); } catch {}
      }
    },
    onPanResponderTerminate: () => {
      isSeekingRef.current = false;
      setIsSeeking(false);
      const dur = durationRef.current;
      lastCurTimeRef.current = seekProgressRef.current * dur;
      const p = playerRef.current;
      if (wasPlayingBeforeSeekRef.current && p) {
        try { p.play(); } catch {}
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- PanResponder handlers read stable refs
  }), []);

  const activeProgress = isSeeking ? seekProgress : progress;
  const displaySeekTime = isSeeking ? seekProgress * (duration || 0) : currentTime;

  return (
    <View style={[s.reel, { width: cardWidth, height: cardHeight }]}>
      {/* Solid Black letterbox background with contain thumbnail placeholder */}
      {(!expoVideoModule || !videoUrl || !isMounted || isLoading) && thumbUrl ? (
        <Image
          source={{ uri: thumbUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
        />
      ) : null}

      {/* Video View with contain fit and solid black letterboxing */}
      {expoVideoModule && videoUrl && isMounted ? (
        <VideoReelPlayer
          uri={videoUrl}
          isActive={isActive}
          isPlaying={isPlaying && isActive}
          speed={speed}
          muted={muted}
          onProgress={handleProgress}
          onReady={handleReady}
          playerRef={playerRef}
        />
      ) : null}

      {/* Full transparent touch receiver overlay */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handlePress}
        onLongPress={handleLongPress}
        onPressOut={handlePressOut}
        delayLongPress={350}
      />

      {/* 2x speed indicator — above the bottom progress bar */}
      {show2x && (
        <View style={s.speedBadge} pointerEvents="none">
          <Text style={s.speedText}>2x speed</Text>
        </View>
      )}

      {/* Play/Pause flash indicator */}
      {!show2x && showControls && (
        <View style={s.playPauseBadge} pointerEvents="none">
          <AppIcon
            androidName={isPlaying ? 'pause' : 'play_arrow'}
            iosName={isPlaying ? 'pause.fill' : 'play.fill'}
            color="rgba(255,255,255,0.95)"
            size={42}
          />
        </View>
      )}

      {/* Double tap heart animation */}
      {!show2x && showHeart && (
        <Animated.View
          pointerEvents="none"
          style={[s.heartOverlay, { transform: [{ scale: heartScale }], opacity: heartScale }]}
        >
          <AppIcon androidName="favorite" iosName="heart.fill" color="#FF2D55" size={88} />
        </Animated.View>
      )}

      {/* Loading spinner */}
      {!show2x && isLoading && isActive && isMounted && (
        <View style={s.loadingOverlay} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}

      {/* Right Action Bar (Instagram-style modern polished buttons) */}
      <View
        style={[s.rightActions, show2x && s.fastForwardHidden]}
        pointerEvents={show2x ? 'none' : 'box-none'}
        importantForAccessibility={show2x ? 'no-hide-descendants' : 'auto'}
      >
        {/* Like / Reaction Button */}
        <TouchableOpacity
          style={s.actionBtn}
          onPress={toggleHeartLike}
          onLongPress={() => { hapticLongPress(); setShowEmojiPicker(p => !p); }}
          activeOpacity={0.75}
        >
          <View style={s.actionIconWrap}>
            {myReaction && myReaction !== '❤️' ? (
              <Text style={s.actionEmojiText}>{myReaction}</Text>
            ) : (
              <AppIcon
                androidName={isLiked ? 'favorite' : 'favorite_border'}
                iosName={isLiked ? 'heart.fill' : 'heart'}
                color={isLiked ? '#FF2D55' : '#FFFFFF'}
                size={24}
              />
            )}
          </View>
          <Text style={s.actionCount}>
            {totalReactions > 0 ? totalReactions : 'Like'}
          </Text>
        </TouchableOpacity>

        {/* Comments Button */}
        <TouchableOpacity
          style={s.actionBtn}
          onPress={() => { hapticLight(); onOpenComments(item); }}
          activeOpacity={0.75}
        >
          <View style={s.actionIconWrap}>
            <AppIcon
              androidName="chat_bubble_outline"
              iosName="bubble.right.fill"
              color="#FFFFFF"
              size={23}
            />
          </View>
          <Text style={s.actionCount}>
            {item.comment_count > 0 ? item.comment_count : 'Comment'}
          </Text>
        </TouchableOpacity>

        {/* Repost Button */}
        <TouchableOpacity
          style={s.actionBtn}
          onPress={() => { hapticLight(); onOpenRepost(item); }}
          activeOpacity={0.75}
        >
          <View style={s.actionIconWrap}>
            <AppIcon
              androidName="repeat"
              iosName="arrow.2.squarepath"
              color={item.user_has_reposted ? '#38BDF8' : '#FFFFFF'}
              size={23}
            />
          </View>
          <Text style={s.actionCount}>
            {(item.repost_count || 0) > 0 ? item.repost_count : 'Repost'}
          </Text>
        </TouchableOpacity>

        {/* Save / Bookmark Button */}
        <TouchableOpacity
          style={s.actionBtn}
          onPress={() => { onToggleSave(item); }}
          activeOpacity={0.75}
        >
          <View style={s.actionIconWrap}>
            <AppIcon
              androidName={item.is_saved ? 'bookmark' : 'bookmark_border'}
              iosName={item.is_saved ? 'bookmark.fill' : 'bookmark'}
              color={item.is_saved ? '#FBBF24' : '#FFFFFF'}
              size={23}
            />
          </View>
          <Text style={s.actionCount}>
            {item.is_saved ? 'Saved' : 'Save'}
          </Text>
        </TouchableOpacity>

        {/* Mute / Audio Button */}
        <TouchableOpacity
          style={s.actionBtn}
          onPress={() => { hapticSelection(); onToggleMute(); }}
          activeOpacity={0.75}
        >
          <View style={s.actionIconWrap}>
            <AppIcon
              androidName={muted ? 'volume_off' : 'volume_up'}
              iosName={muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
              color="#FFFFFF"
              size={21}
            />
          </View>
          <Text style={s.actionCount}>{muted ? 'Muted' : 'Sound'}</Text>
        </TouchableOpacity>
      </View>

      {/* Floating Emoji Picker */}
      {showEmojiPicker && !show2x && (
        <View style={s.emojiPicker}>
          {REACTION_EMOJIS.map(emoji => {
            const active = item.user_reactions?.includes(emoji);
            return (
              <TouchableOpacity
                key={emoji}
                onPress={() => { hapticSuccess(); onReact(item, emoji); setShowEmojiPicker(false); }}
                style={[s.emojiBtn, active && s.emojiBtnActive]}
                activeOpacity={0.75}
              >
                <Text style={s.emojiText}>{emoji}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Author & Caption Info (Bottom Left) */}
      <View
        style={[s.authorInfo, show2x && s.fastForwardHidden]}
        pointerEvents="none"
        importantForAccessibility={show2x ? 'no-hide-descendants' : 'auto'}
      >
        {item.is_repost && (
          <View style={s.repostBadge}>
            <AppIcon androidName="repeat" iosName="arrow.2.squarepath" color="#FFFFFF" size={13} />
            <Text style={s.repostBadgeText} numberOfLines={1}>
              Reposted by {item.reposted_by?.display_name || item.shared_by}
            </Text>
          </View>
        )}
        <View style={s.authorRow}>
          <View style={s.avatar}>
            {initial ? (
              <Text style={s.avatarInitial}>{initial}</Text>
            ) : (
              <AppIcon androidName="person" iosName="person.fill" color="#fff" size={14} />
            )}
          </View>
          <Text style={s.authorName} numberOfLines={1}>
            {item.is_repost
              ? (item.original_author?.display_name || 'Original creator')
              : (item.shared_by || 'Unknown')}
          </Text>
        </View>
        {!!item.caption && (
          <Text style={s.caption} numberOfLines={3}>
            {item.caption}
          </Text>
        )}
      </View>

      {/* Draggable Progress / Seek Bar (YouTube Shorts style) */}
      <View
        style={[s.progressWrap, show2x && s.fastForwardHidden]}
        pointerEvents={show2x ? 'none' : 'auto'}
        importantForAccessibility={show2x ? 'no-hide-descendants' : 'auto'}
        onLayout={e => {
          const w = e.nativeEvent.layout.width;
          if (w > 0) seekBarWidthRef.current = w;
        }}
        {...seekPanResponder.panHandlers}
      >
        {/* Floating Time Preview Bubble (shown while dragging, like YouTube Shorts) */}
        {isSeeking && (
          <View style={s.seekTimeBubble} pointerEvents="none">
            <Text style={s.seekTimeText}>
              {formatMediaTime(displaySeekTime)} / {formatMediaTime(duration)}
            </Text>
          </View>
        )}

        <View style={[progressStyles.track, isSeeking && progressStyles.trackActive]}>
          <View
            style={[
              progressStyles.fill,
              isSeeking && progressStyles.fillActive,
              { width: `${Math.min(100, Math.max(0, activeProgress * 100))}%` },
            ]}
          />
          {/* Draggable Seek Thumb (glows/expands during drag) */}
          {isSeeking && (
            <View
              style={[
                progressStyles.thumb,
                { left: `${Math.min(100, Math.max(0, activeProgress * 100))}%` },
              ]}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const ReelCard = React.memo(ReelCardBase);

// ─── Comments sheet ───────────────────────────────────────────────────────────

function formatTimeAgo(ts: number): string {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function CommentsSheet({
  visible,
  mediaId,
  colors,
  onClose,
  onCommentAdded,
  onCommentDeleted,
}: {
  visible: boolean;
  mediaId?: number | null;
  colors: AppColors;
  onClose: () => void;
  onCommentAdded: (count: number) => void;
  onCommentDeleted: (count: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const { keyboardHeight } = useModalKeyboardHeight();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!visible || mediaId == null) return;
    let active = true;
    setLoading(true);
    setComments([]);
    getComments(mediaId)
      .then(res => { if (active) setComments(Array.isArray(res?.comments) ? res.comments : []); })
      .catch(() => { if (active) setComments([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible, mediaId]);

  const handleSubmit = async () => {
    if (!text.trim() || mediaId == null) return;
    setSubmitting(true);
    try {
      await addComment(mediaId, text.trim());
      setText('');
      const res = await getComments(mediaId);
      const nextComments = Array.isArray(res?.comments) ? res.comments : [];
      setComments(nextComments);
      onCommentAdded(nextComments.length);
      hapticSuccess();
    } catch { hapticError(); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteComment(id);
      const nextComments = comments.filter(c => c.id !== id);
      setComments(nextComments);
      onCommentDeleted(nextComments.length);
    } catch { hapticError(); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={cs.backdrop} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={cs.kav}>
        <View
          style={[
            cs.sheet,
            {
              backgroundColor: colors.surface,
              paddingBottom: insets.bottom + Spacing.two,
              marginBottom: Platform.OS === 'android' ? keyboardHeight : 0,
              maxHeight: keyboardHeight > 0
                ? Math.min(SCREEN_H * 0.85, SCREEN_H - keyboardHeight - 20)
                : SCREEN_H * 0.85,
            },
          ]}
        >
          <View style={cs.handle} />
          <View style={[cs.header, { borderBottomColor: colors.surfaceBorder }]}>
            <Text style={[cs.title, { color: colors.text }]}>Comments</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={20} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={cs.center}><ActivityIndicator color={colors.primary} /></View>
          ) : comments.length === 0 ? (
            <View style={cs.center}>
              <Text style={[cs.empty, { color: colors.textMuted }]}>No comments yet. Be first!</Text>
            </View>
          ) : (
            <FlatList
              data={comments}
              keyExtractor={c => String(c.id)}
              style={[cs.list, { maxHeight: keyboardHeight > 0 ? SCREEN_H * 0.25 : SCREEN_H * 0.42 }]}
              contentContainerStyle={{ paddingBottom: Spacing.two }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: c }) => (
                <View style={cs.row}>
                  <View style={cs.rowInfo}>
                    <Text style={[cs.author, { color: colors.text }]}>
                      {c.display_name || c.source_id}{c.is_own ? ' (You)' : ''}
                    </Text>
                    <Text style={[cs.cText, { color: colors.text }]}>{c.text}</Text>
                    <Text style={[cs.cTime, { color: colors.textMuted }]}>{formatTimeAgo(c.created_at)}</Text>
                  </View>
                  {c.is_own && (
                    <TouchableOpacity onPress={() => handleDelete(c.id)} hitSlop={10}>
                      <AppIcon androidName="delete" iosName="trash" color={colors.error} size={16} />
                    </TouchableOpacity>
                  )}
                </View>
              )}
            />
          )}

          <View style={[cs.inputRow, { borderTopColor: colors.surfaceBorder }]}>
            <TextInput
              style={[cs.input, { color: colors.text, backgroundColor: colors.surfaceSoft, borderColor: colors.surfaceBorder }]}
              placeholder="Add a comment…"
              placeholderTextColor={colors.textMuted}
              value={text}
              onChangeText={setText}
              returnKeyType="send"
              onSubmitEditing={handleSubmit}
            />
            <TouchableOpacity onPress={handleSubmit} disabled={submitting || !text.trim()} style={cs.sendBtn}>
              {submitting
                ? <ActivityIndicator color={colors.primary} size="small" />
                : <AppIcon androidName="send" iosName="paperplane.fill" color={text.trim() ? colors.primary : colors.textMuted} size={20} />
              }
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const cs = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.5)' },
  kav: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl, maxHeight: SCREEN_H * 0.72 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(128,128,128,0.35)', marginVertical: Spacing.two },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.four, paddingBottom: Spacing.three, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: TextScale.base, fontWeight: '700' },
  center: { paddingVertical: 48, alignItems: 'center' },
  empty: { fontSize: TextScale.sm },
  list: { maxHeight: SCREEN_H * 0.42, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: Spacing.four, paddingVertical: Spacing.three, gap: Spacing.two },
  rowInfo: { flex: 1, gap: 2 },
  author: { fontSize: TextScale.sm, fontWeight: '700' },
  cText: { fontSize: TextScale.sm, lineHeight: 19 },
  cTime: { fontSize: TextScale.xs, marginTop: 2 },
  inputRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.three, paddingTop: Spacing.two, borderTopWidth: StyleSheet.hairlineWidth, gap: Spacing.two },
  input: { flex: 1, borderRadius: Radius.full, borderWidth: 1, paddingHorizontal: Spacing.three, paddingVertical: Platform.OS === 'ios' ? 10 : 8, fontSize: TextScale.sm },
  sendBtn: { padding: Spacing.two },
});

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function ReelsScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const router = useRouter();

  const [reels, setReels] = useState<ReelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [screenFocused, setScreenFocused] = useState(false);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(null);
  const [commentsTarget, setCommentsTarget] = useState<ReelItem | null>(null);
  const [repostTarget, setRepostTarget] = useState<ReelItem | null>(null);
  const [muted, setMuted] = useState(false);
  const [fastForwardingReelId, setFastForwardingReelId] = useState<string | null>(null);
  const [reelSection, setReelSection] = useState<ReelSection>('for-you');
  const [sectionPickerVisible, setSectionPickerVisible] = useState(false);
  const isFastForwarding = fastForwardingReelId !== null;

  // Dynamic layout measurement to cleanly fit between status bar and floating bottom tab bar
  const defaultCardHeight = Math.round(Math.max(300, SCREEN_H - insets.top - TAB_BAR_TOTAL_CLEARANCE));
  const [viewportHeight, setViewportHeight] = useState(defaultCardHeight);
  const [viewportWidth, setViewportWidth] = useState(Math.round(SCREEN_W));

  const listRef = useRef<FlatList<ReelItem>>(null);
  const engineStateRef = useRef<HyperPulseState>(createDefaultState());
  const reelSectionRef = useRef<ReelSection>('for-you');
  const reelsRef = useRef<ReelItem[]>([]);
  useEffect(() => {
    reelsRef.current = reels;
  }, [reels]);
  const hasMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const loadingSectionRef = useRef<ReelSection | null>(null);
  const seedRef = useRef(0);
  const telemetryBatchRef = useRef<PlaybackTelemetryEvent[]>([]);

  const flushTelemetry = useCallback(async () => {
    const batch = telemetryBatchRef.current;
    if (batch.length === 0) return;
    telemetryBatchRef.current = [];
    try {
      await sendReelTelemetry(batch);
    } catch {}
  }, []);

  const handlePlaybackTelemetry = useCallback((ev: PlaybackTelemetryEvent) => {
    processPlaybackTelemetry(engineStateRef.current, ev);
    persistHyperPulseState(
      engineStateRef.current,
      reelEngineScope(reelSectionRef.current),
    ).catch(() => {});
    telemetryBatchRef.current.push(ev);
    if (telemetryBatchRef.current.length >= 5) {
      void flushTelemetry();
    }
  }, [flushTelemetry]);

  useEffect(() => {
    return () => {
      void flushTelemetry();
    };
  }, [flushTelemetry]);

  const handleContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (height > 0) {
      setViewportHeight(Math.round(height));
      setViewportWidth(Math.round(width));
    }
  }, []);

  const loadReels = useCallback(async (
    reset = true,
    options: { skipFullScreenLoading?: boolean } = {},
    requestedSection: ReelSection = reelSectionRef.current,
  ) => {
    if (reloadInFlightRef.current && loadingSectionRef.current === requestedSection) return;
    reloadInFlightRef.current = true;
    loadingSectionRef.current = requestedSection;
    if (reset) {
      offsetRef.current = 0;
    }
    try {
      if (reset) {
        const cached = getCachedReelsFeed(requestedSection);
        if (cached && Array.isArray(cached.reels) && cached.reels.length > 0) {
          const engineScope = reelEngineScope(requestedSection);
          const [cfg, eState] = await Promise.all([getConfig(), loadHyperPulseState(engineScope)]);
          if (requestedSection === reelSectionRef.current) {
            setServerConfig(cfg);
            engineStateRef.current = eState;
            const filtered = isLibrarySection(requestedSection)
              ? (cached.reels || []).filter((r: ReelItem) => r.library_source === expectedLibrarySource(requestedSection))
              : (cached.reels || []).filter((r: ReelItem) => !r.is_own_post && (!cfg?.deviceId || r.shared_by_device_id !== cfg.deviceId));
            const rankedCached = buildDiverseReelSlate(filtered, eState, Date.now());
            if (rankedCached.length > 0) {
              setReels(rankedCached);
              setLoading(false);
            }
          }
        } else if (!options.skipFullScreenLoading) {
          setLoading(true);
        }
        setActiveIndex(0);
      }
      const engineScope = reelEngineScope(requestedSection);
      const [config, engineState] = await Promise.all([getConfig(), loadHyperPulseState(engineScope)]);
      // Ignore an earlier response after the user has picked another shelf.
      if (requestedSection !== reelSectionRef.current) return;
      setServerConfig(config);
      engineStateRef.current = engineState;

      if (reset) seedRef.current = Date.now();
      const currentSeed = seedRef.current;
      const response: { reels: ReelItem[]; has_more: boolean } = isLibrarySection(requestedSection)
        ? await getLibraryReels(requestedSection, reset ? 0 : offsetRef.current, 30, currentSeed)
        : await getReelsFeed(reset ? 0 : offsetRef.current, 30, currentSeed);
      if (requestedSection !== reelSectionRef.current) return;
      const { reels: raw, has_more } = response;
      hasMoreRef.current = has_more && raw.length > 0;
      offsetRef.current = reset ? raw.length : offsetRef.current + raw.length;
      // Keep the shelves strictly separated even if a stale server does not
      // yet honour the source query parameter.
      const filteredRaw = isLibrarySection(requestedSection)
        ? (raw || []).filter(r => r.library_source === expectedLibrarySource(requestedSection))
        : (raw || []).filter(r => !r.is_own_post && (!config?.deviceId || r.shared_by_device_id !== config.deviceId));
      const ranked = buildDiverseReelSlate(filteredRaw, engineState, currentSeed);
      setReels(prev => {
        if (reset) return ranked;
        const existingIds = new Set(prev.map(r => r.reel_id));
        const uniqueRanked = ranked.filter(r => !existingIds.has(r.reel_id));
        return [...prev, ...uniqueRanked];
      });
      if (reset) listRef.current?.scrollToOffset({ offset: 0, animated: false });
      setError(null);
    } catch (e: any) {
      if (reset) setError(e?.message || 'Failed to load reels');
      else hapticError();
    } finally {
      if (loadingSectionRef.current === requestedSection) {
        reloadInFlightRef.current = false;
        loadingSectionRef.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const selectReelSection = useCallback((nextSection: ReelSection) => {
    hapticSelection();
    setSectionPickerVisible(false);
    if (nextSection === reelSectionRef.current) return;
    reelSectionRef.current = nextSection;
    setReelSection(nextSection);
    const cached = getCachedReelsFeed(nextSection);
    if (!cached || !Array.isArray(cached.reels) || cached.reels.length === 0) {
      setReels([]);
    }
    setError(null);
    setActiveIndex(0);
    void loadReels(true, {}, nextSection);
  }, [loadReels]);

  const onRefreshReels = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadReels(true, { skipFullScreenLoading: true });
    } catch {
      setRefreshing(false);
    }
  }, [loadReels]);

  // Tab press: when already on Reels tab, scroll to top and shuffle-refresh.
  useEffect(() => {
    // Expo Router's TypeScript types don't expose `addListener` on the navigation
    // object even though it is present at runtime for tab navigators.
    return (navigation as any)?.addListener?.('tabPress', () => {
      if (!navigation.isFocused() || refreshing || loading || reloadInFlightRef.current) return;
      hapticLight();
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      void onRefreshReels();
    });
  }, [navigation, onRefreshReels, refreshing, loading]);

  useEffect(() => {
    void loadReels(true);
  }, [loadReels]);

  useFocusEffect(useCallback(() => {
    setScreenFocused(true);
    return () => {
      setScreenFocused(false);
      setFastForwardingReelId(null);
      void flushTelemetry();
    };
  }, [flushTelemetry]));

  useEffect(() => {
    AsyncStorage.getItem(MUTED_KEY).then(v => { if (v != null) setMuted(v === '1'); }).catch(() => {});
  }, []);

  const handleToggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      AsyncStorage.setItem(MUTED_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);

  const onViewableItemsChanged = useMemo(() => ({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
    if (viewableItems.length === 0) return;
    const idx = viewableItems[0].index ?? 0;
    setActiveIndex(idx);
    const reel = reelsRef.current[idx];
    if (reel) {
      if (reel.is_unseen && reel.group_id) {
        markShareNotificationsSeen([reel.group_id]).catch(() => {});
      }
    }
  }, []);


  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 60, minimumViewTime: 50 }), []);

  // Global event synchronization for reel interactions (e.g. from Saved Reels screen)
  useEffect(() => {
    const saveSub = DeviceEventEmitter.addListener('reel-save-changed', (data: { reelId: string; shareId?: number; isSaved: boolean }) => {
      setReels(prev => prev.map(r =>
        (r.reel_id === data.reelId || (data.shareId != null && r.share_id === data.shareId))
          ? { ...r, is_saved: data.isSaved }
          : r
      ));
      if (data.isSaved && engineStateRef.current) {
        const item = reelsRef.current.find(r => r.reel_id === data.reelId || (data.shareId != null && r.share_id === data.shareId));
        if (item) {
          const creatorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;
          processPlaybackTelemetry(engineStateRef.current, {
            share_id: item.share_id,
            reel_id: item.reel_id,
            media_id: item.media_id,
            author_key: creatorKey,
            watch_time_sec: 8.0,
            duration_sec: item.duration || 15.0,
            completion_rate: 0.9,
            loops: 0,
            skipped: false,
            saved: true,
            tokens: item.tokens,
            group_id: item.group_id,
            timestamp: Date.now(),
          });
          persistHyperPulseState(engineStateRef.current, reelEngineScope(reelSectionRef.current)).catch(() => {});
        }
      }
    });

    const reactionSub = DeviceEventEmitter.addListener('reel-reaction-changed', (data: { mediaId?: number | null; reelId?: string; counts?: Record<string, number>; userReactions?: string[] }) => {
      setReels(prev => prev.map(r =>
        (r.reel_id === data.reelId || (data.mediaId != null && r.media_id === data.mediaId))
          ? {
              ...r,
              reaction_counts: data.counts ?? r.reaction_counts,
              user_reactions: data.userReactions ?? r.user_reactions,
            }
          : r
      ));
      const hasReaction = (data.userReactions?.length ?? 0) > 0;
      if (hasReaction && engineStateRef.current) {
        const item = reelsRef.current.find(r => r.reel_id === data.reelId || (data.mediaId != null && r.media_id === data.mediaId));
        if (item) {
          const creatorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;
          processPlaybackTelemetry(engineStateRef.current, {
            share_id: item.share_id,
            reel_id: item.reel_id,
            media_id: item.media_id,
            author_key: creatorKey,
            watch_time_sec: 4.0,
            duration_sec: item.duration || 15.0,
            completion_rate: 0.8,
            loops: 0,
            skipped: false,
            liked: true,
            tokens: item.tokens,
            group_id: item.group_id,
            timestamp: Date.now(),
          });
          persistHyperPulseState(engineStateRef.current, reelEngineScope(reelSectionRef.current)).catch(() => {});
        }
      }
    });

    const repostSub = DeviceEventEmitter.addListener('reel-repost-changed', (data: { shareId: number; reelId?: string; mediaId?: number | null; userHasReposted: boolean; repostCount?: number }) => {
      setReels(prev => prev.map(r =>
        (r.share_id === data.shareId || r.reel_id === data.reelId || (data.mediaId != null && r.media_id === data.mediaId))
          ? {
              ...r,
              user_has_reposted: data.userHasReposted,
              repost_count: data.repostCount !== undefined
                ? data.repostCount
                : Math.max(0, (r.repost_count || 0) + (data.userHasReposted ? 1 : -1)),
            }
          : r
      ));
      if (data.userHasReposted && engineStateRef.current) {
        const item = reelsRef.current.find(r => r.share_id === data.shareId || r.reel_id === data.reelId || (data.mediaId != null && r.media_id === data.mediaId));
        if (item) {
          const creatorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;
          processPlaybackTelemetry(engineStateRef.current, {
            share_id: item.share_id,
            reel_id: item.reel_id,
            media_id: item.media_id,
            author_key: creatorKey,
            watch_time_sec: 12.0,
            duration_sec: item.duration || 15.0,
            completion_rate: 1.0,
            loops: 1,
            skipped: false,
            reposted: true,
            tokens: item.tokens,
            group_id: item.group_id,
            timestamp: Date.now(),
          });
          persistHyperPulseState(engineStateRef.current, reelEngineScope(reelSectionRef.current)).catch(() => {});
        }
      }
    });

    const commentSub = DeviceEventEmitter.addListener('reel-comment-changed', (data: { reelId?: string; mediaId?: number | null; count?: number; delta?: number }) => {
      setReels(prev => prev.map(r => {
        const isMatch = (data.reelId && r.reel_id === data.reelId) || (data.mediaId != null && r.media_id === data.mediaId);
        if (!isMatch) return r;
        const nextCount = data.count !== undefined
          ? data.count
          : Math.max(0, r.comment_count + (data.delta || 0));
        return { ...r, comment_count: nextCount };
      }));
    });

    return () => {
      saveSub.remove();
      reactionSub.remove();
      repostSub.remove();
      commentSub.remove();
    };
  }, []);

  const handleReact = useCallback(async (item: ReelItem, emoji: string) => {
    if (item.media_id == null) return;
    const creatorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;
    if (engineStateRef.current) {
      processPlaybackTelemetry(engineStateRef.current, {
        share_id: item.share_id,
        reel_id: item.reel_id,
        media_id: item.media_id,
        author_key: creatorKey,
        watch_time_sec: 4.0,
        duration_sec: item.duration || 15.0,
        completion_rate: 0.8,
        loops: 0,
        skipped: false,
        liked: true,
        tokens: item.tokens,
        group_id: item.group_id,
        timestamp: Date.now(),
      });
      persistHyperPulseState(engineStateRef.current, reelEngineScope(reelSectionRef.current)).catch(() => {});
    }
    try {
      const res = await reactToMedia(item.media_id, emoji);
      const nextCounts = res.counts ?? item.reaction_counts;
      const nextUserReactions = res.user_reactions ?? item.user_reactions;
      setReels(prev => prev.map(r =>
        r.reel_id === item.reel_id || (item.media_id != null && r.media_id === item.media_id)
          ? { ...r, reaction_counts: nextCounts, user_reactions: nextUserReactions }
          : r
      ));
      DeviceEventEmitter.emit('reel-reaction-changed', {
        mediaId: item.media_id,
        reelId: item.reel_id,
        counts: nextCounts,
        userReactions: nextUserReactions,
      });
    } catch { hapticError(); }
  }, []);

  const handleToggleSave = useCallback(async (item: ReelItem) => {
    hapticSelection();
    const nextSaved = !item.is_saved;
    const creatorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;
    if (nextSaved && engineStateRef.current) {
      processPlaybackTelemetry(engineStateRef.current, {
        share_id: item.share_id,
        reel_id: item.reel_id,
        media_id: item.media_id,
        author_key: creatorKey,
        watch_time_sec: 8.0,
        duration_sec: item.duration || 15.0,
        completion_rate: 0.9,
        loops: 0,
        skipped: false,
        saved: true,
        tokens: item.tokens,
        group_id: item.group_id,
        timestamp: Date.now(),
      });
      persistHyperPulseState(engineStateRef.current, reelEngineScope(reelSectionRef.current)).catch(() => {});
    }
    setReels(prev => prev.map(r =>
      r.reel_id === item.reel_id ? { ...r, is_saved: nextSaved } : r
    ));
    DeviceEventEmitter.emit('reel-save-changed', {
      reelId: item.reel_id,
      shareId: item.share_id,
      isSaved: nextSaved,
    });
    try {
      const res = await toggleSaveReel(item.reel_id, item.share_id, item.media_id ?? undefined);
      setReels(prev => prev.map(r =>
        r.reel_id === item.reel_id ? { ...r, is_saved: res.saved } : r
      ));
      if (res.saved !== nextSaved) {
        DeviceEventEmitter.emit('reel-save-changed', {
          reelId: item.reel_id,
          shareId: item.share_id,
          isSaved: res.saved,
        });
      }
    } catch {
      setReels(prev => prev.map(r =>
        r.reel_id === item.reel_id ? { ...r, is_saved: item.is_saved } : r
      ));
      DeviceEventEmitter.emit('reel-save-changed', {
        reelId: item.reel_id,
        shareId: item.share_id,
        isSaved: Boolean(item.is_saved),
      });
      hapticError();
    }
  }, []);

  const handleOpenRepost = useCallback(async (item: ReelItem) => {
    if (item.user_has_reposted) {
      hapticLight();
      const prevReels = reelsRef.current;
      const nextCount = Math.max(0, (item.repost_count || 1) - 1);
      setReels(prev => prev.map(r =>
        r.reel_id === item.reel_id || r.share_id === item.share_id
          ? {
              ...r,
              user_has_reposted: false,
              repost_count: nextCount,
            }
          : r
      ));
      DeviceEventEmitter.emit('reel-repost-changed', {
        shareId: item.share_id,
        reelId: item.reel_id,
        mediaId: item.media_id,
        userHasReposted: false,
        repostCount: nextCount,
      });
      try {
        await cancelRepostReel(item.share_id);
        hapticSuccess();
      } catch (err: any) {
        setReels(prevReels);
        DeviceEventEmitter.emit('reel-repost-changed', {
          shareId: item.share_id,
          reelId: item.reel_id,
          mediaId: item.media_id,
          userHasReposted: true,
          repostCount: item.repost_count,
        });
        hapticError();
        Alert.alert('Could not cancel repost', err?.message || 'Failed to remove repost.');
      }
    } else {
      setRepostTarget(item);
    }
  }, []);

  const handleRepostSubmit = useCallback(async (targetDeviceIds: string[], caption: string) => {
    if (!repostTarget) return;
    const creatorKey = repostTarget.original_author?.device_id || repostTarget.shared_by_device_id || repostTarget.shared_by;
    if (engineStateRef.current) {
      processPlaybackTelemetry(engineStateRef.current, {
        share_id: repostTarget.share_id,
        reel_id: repostTarget.reel_id,
        media_id: repostTarget.media_id,
        author_key: creatorKey,
        watch_time_sec: 12.0,
        duration_sec: repostTarget.duration || 15.0,
        completion_rate: 1.0,
        loops: 1,
        skipped: false,
        reposted: true,
        tokens: repostTarget.tokens,
        group_id: repostTarget.group_id,
        timestamp: Date.now(),
      });
      persistHyperPulseState(engineStateRef.current, reelEngineScope(reelSectionRef.current)).catch(() => {});
    }
    const nextCount = (repostTarget.repost_count || 0) + 1;
    try {
      await repostReel(repostTarget.share_id, targetDeviceIds, caption);
      setReels(prev => prev.map(r =>
        r.reel_id === repostTarget.reel_id
          ? {
              ...r,
              user_has_reposted: true,
              repost_count: nextCount,
            }
          : r
      ));
      DeviceEventEmitter.emit('reel-repost-changed', {
        shareId: repostTarget.share_id,
        reelId: repostTarget.reel_id,
        mediaId: repostTarget.media_id,
        userHasReposted: true,
        repostCount: nextCount,
      });
      hapticSuccess();
      setRepostTarget(null);
    } catch (err: any) {
      hapticError();
      Alert.alert('Could not repost', err?.message || 'Failed to repost reel.');
    }
  }, [repostTarget]);

  const handleCommentAdded = useCallback((reelId: string, count?: number) => {
    const targetItem = reelsRef.current.find(r => r.reel_id === reelId);
    if (targetItem && engineStateRef.current) {
      const creatorKey = targetItem.original_author?.device_id || targetItem.shared_by_device_id || targetItem.shared_by;
      processPlaybackTelemetry(engineStateRef.current, {
        share_id: targetItem.share_id,
        reel_id: targetItem.reel_id,
        media_id: targetItem.media_id,
        author_key: creatorKey,
        watch_time_sec: 10.0,
        duration_sec: targetItem.duration || 15.0,
        completion_rate: 0.9,
        loops: 0,
        skipped: false,
        commented: true,
        tokens: targetItem.tokens,
        group_id: targetItem.group_id,
        timestamp: Date.now(),
      });
      persistHyperPulseState(engineStateRef.current, reelEngineScope(reelSectionRef.current)).catch(() => {});
    }
    const nextCount = count !== undefined ? count : (targetItem ? targetItem.comment_count + 1 : 1);
    setReels(prev => prev.map(r =>
      (r.reel_id === reelId || (targetItem?.media_id != null && r.media_id === targetItem.media_id))
        ? { ...r, comment_count: nextCount }
        : r
    ));
    DeviceEventEmitter.emit('reel-comment-changed', {
      reelId,
      mediaId: targetItem?.media_id,
      count: nextCount,
    });
  }, []);

  const handleCommentDeleted = useCallback((reelId: string, count?: number) => {
    const targetItem = reelsRef.current.find(r => r.reel_id === reelId);
    const nextCount = count !== undefined ? count : Math.max(0, (targetItem ? targetItem.comment_count - 1 : 0));
    setReels(prev => prev.map(r =>
      (r.reel_id === reelId || (targetItem?.media_id != null && r.media_id === targetItem.media_id))
        ? { ...r, comment_count: nextCount }
        : r
    ));
    DeviceEventEmitter.emit('reel-comment-changed', {
      reelId,
      mediaId: targetItem?.media_id,
      count: nextCount,
    });
  }, []);

  const handleLoadMore = useCallback(() => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    loadReels(false).finally(() => { loadingMoreRef.current = false; });
  }, [loadReels]);

  const extraData = useMemo(() => ({
    activeIndex,
    screenFocused,
    muted,
    viewportHeight,
    viewportWidth,
  }), [activeIndex, screenFocused, muted, viewportHeight, viewportWidth]);

  const getItemLayout = useCallback((_: unknown, index: number) => {
    const h = Math.round(viewportHeight);
    return {
      length: h,
      offset: h * index,
      index,
    };
  }, [viewportHeight]);

  const handleSpeedModeChange = useCallback((reelId: string, isFastForwarding: boolean) => {
    setFastForwardingReelId(current => {
      if (isFastForwarding) return reelId;
      // A recycled/off-screen card must not clear fast-forward owned by the
      // currently pressed card.
      return current === reelId ? null : current;
    });
  }, []);

  const renderItem = useCallback(({ item, index }: { item: ReelItem; index: number }) => {
    const isNearActive = Math.abs(index - activeIndex) <= 1;
    return (
      <ReelCard
        key={item.reel_id}
        item={item}
        isActive={index === activeIndex && screenFocused}
        isMounted={isNearActive && screenFocused}
        cardWidth={viewportWidth}
        cardHeight={viewportHeight}
        serverConfig={serverConfig}
        muted={muted}
        onToggleMute={handleToggleMute}
        onReact={handleReact}
        onOpenComments={setCommentsTarget}
        onOpenRepost={handleOpenRepost}
        onToggleSave={handleToggleSave}
        onSpeedModeChange={handleSpeedModeChange}
        onPlaybackTelemetry={handlePlaybackTelemetry}
        colors={colors}
      />
    );
  }, [activeIndex, screenFocused, viewportWidth, viewportHeight, serverConfig, muted, handleToggleMute, handleReact, handleOpenRepost, handleToggleSave, handleSpeedModeChange, handlePlaybackTelemetry, colors]);

  return (
    <View
      style={[
        s.screen,
        {
          paddingTop: insets.top,
          paddingBottom: TAB_BAR_TOTAL_CLEARANCE,
        },
      ]}
    >
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {/* Top Header Bar */}
      {/*
       * Do not unmount this while holding for 2x. The list below pages by its
       * measured height, so removing the header changes every item offset while
       * the Pressable still owns the touch gesture.
       */}
      <View
        style={[s.topBar, isFastForwarding && s.fastForwardHidden]}
        pointerEvents={isFastForwarding ? 'none' : 'box-none'}
        importantForAccessibility={isFastForwarding ? 'no-hide-descendants' : 'auto'}
      >
        <TouchableOpacity
          style={s.headerTitleButton}
          onPress={() => { hapticLight(); setSectionPickerVisible(true); }}
          hitSlop={10}
          accessibilityLabel="Choose reels section"
          accessibilityHint="Opens the Reels, Backup Folders, and Shared Folders selector"
        >
          <Text style={s.headerTitle}>{reelSectionTitle(reelSection)}</Text>
          <AppIcon androidName="arrow_drop_down" iosName="chevron.down" color="#fff" size={20} />
        </TouchableOpacity>

        <View style={s.headerRightActions}>
          {/* Reels Library Screen Redirect (Saved, Liked, Reposts) */}
          <TouchableOpacity
            style={s.headerBtn}
            onPress={() => { hapticLight(); router.push('/saved-reels'); }}
            hitSlop={12}
            accessibilityLabel="Reels Library"
          >
            <AppIcon androidName="video_library" iosName="play.square.stack.fill" color="#fff" size={18} />
          </TouchableOpacity>

          {/* Shuffle Reels */}
          <TouchableOpacity
            style={s.headerBtn}
            onPress={() => { hapticSelection(); loadReels(true); }}
            hitSlop={12}
            accessibilityLabel="Shuffle Reels"
          >
            <AppIcon androidName="shuffle" iosName="shuffle" color="#fff" size={18} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Reels Viewport Container */}
      <View style={s.listContainer} onLayout={handleContainerLayout}>
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={s.loadingText}>Loading Reels…</Text>
          </View>
        ) : reels.length === 0 ? (
          <View style={s.center}>
            <AppIcon androidName="videocam_off" iosName="video.slash" color="rgba(255,255,255,0.55)" size={52} />
            <Text style={s.emptyTitle}>No Reels Yet</Text>
            <Text style={s.emptyBody}>
              {error || (reelSection === 'backups'
                ? 'Videos backed up from this device will appear here.'
                : reelSection === 'shared'
                  ? 'Videos from desktop folders shared with this device will appear here.'
                  : 'Post a video to the feed and it will appear here as a reel.')}
            </Text>
            <TouchableOpacity style={s.retryBtn} onPress={() => loadReels(true)}>
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={reels}
            keyExtractor={item => item.reel_id}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            extraData={extraData}
            pagingEnabled={true}
            snapToInterval={Platform.OS === 'ios' ? Math.round(viewportHeight) : undefined}
            snapToAlignment="start"
            decelerationRate={Platform.OS === 'ios' ? 'fast' : 'normal'}
            disableIntervalMomentum={true}
            showsVerticalScrollIndicator={false}
            overScrollMode="never"
            bounces={false}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.5}
            windowSize={3}
            initialNumToRender={2}
            maxToRenderPerBatch={2}
            removeClippedSubviews={false}
            scrollEventThrottle={16}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefreshReels}
                tintColor="#fff"
                colors={['#fff']}
              />
            }
          />
        )}
      </View>

      <CommentsSheet
        visible={commentsTarget != null}
        mediaId={commentsTarget?.media_id}
        colors={colors}
        onClose={() => setCommentsTarget(null)}
        onCommentAdded={(count) => commentsTarget && handleCommentAdded(commentsTarget.reel_id, count)}
        onCommentDeleted={(count) => commentsTarget && handleCommentDeleted(commentsTarget.reel_id, count)}
      />

      <ShareModal
        visible={repostTarget != null}
        count={1}
        colors={colors}
        excludeDeviceIds={
          repostTarget
            ? [
                repostTarget.original_author?.device_id,
                repostTarget.shared_by_device_id,
                serverConfig?.deviceId,
              ].filter(Boolean) as string[]
            : []
        }
        onClose={() => setRepostTarget(null)}
        onSubmit={handleRepostSubmit}
      />

      <Modal
        visible={sectionPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSectionPickerVisible(false)}
      >
        <Pressable style={s.sectionPickerBackdrop} onPress={() => setSectionPickerVisible(false)}>
          <Pressable style={s.sectionPickerSheet} onPress={() => {}}>
            <Text style={s.sectionPickerTitle}>Choose reels</Text>
            <TouchableOpacity
              style={[s.sectionPickerOption, reelSection === 'for-you' && s.sectionPickerOptionSelected]}
              onPress={() => selectReelSection('for-you')}
            >
              <View style={s.sectionPickerOptionIcon}>
                <AppIcon androidName="smart_display" iosName="sparkles" color="#fff" size={19} />
              </View>
              <View style={s.sectionPickerOptionText}>
                <Text style={s.sectionPickerOptionTitle}>Reels</Text>
                <Text style={s.sectionPickerOptionBody}>Videos shared with you, ranked for you.</Text>
              </View>
              {reelSection === 'for-you' && <AppIcon androidName="check" iosName="checkmark" color="#fff" size={18} />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.sectionPickerOption, reelSection === 'backups' && s.sectionPickerOptionSelected]}
              onPress={() => selectReelSection('backups')}
            >
              <View style={s.sectionPickerOptionIcon}>
                <AppIcon androidName="backup" iosName="externaldrive.fill" color="#fff" size={19} />
              </View>
              <View style={s.sectionPickerOptionText}>
                <Text style={s.sectionPickerOptionTitle}>Backup Folders</Text>
                <Text style={s.sectionPickerOptionBody}>Only videos backed up from this device.</Text>
              </View>
              {reelSection === 'backups' && <AppIcon androidName="check" iosName="checkmark" color="#fff" size={18} />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.sectionPickerOption, reelSection === 'shared' && s.sectionPickerOptionSelected]}
              onPress={() => selectReelSection('shared')}
            >
              <View style={s.sectionPickerOptionIcon}>
                <AppIcon androidName="folder_shared" iosName="folder.badge.person.crop" color="#fff" size={19} />
              </View>
              <View style={s.sectionPickerOptionText}>
                <Text style={s.sectionPickerOptionTitle}>Shared Folders</Text>
                <Text style={s.sectionPickerOptionBody}>Only videos from desktop folders tagged for this device.</Text>
              </View>
              {reelSection === 'shared' && <AppIcon androidName="check" iosName="checkmark" color="#fff" size={18} />}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  listContainer: {
    flex: 1,
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: '#000000',
  },
  loadingText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: TextScale.sm,
    marginTop: Spacing.two,
    fontWeight: '600',
  },
  emptyTitle: {
    color: '#fff',
    fontSize: TextScale.lg,
    fontWeight: '800',
    marginTop: Spacing.two,
  },
  emptyBody: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: TextScale.sm,
    textAlign: 'center',
    paddingHorizontal: Spacing.eight,
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.two + 2,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  retryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: TextScale.sm,
  },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    zIndex: 20,
    backgroundColor: 'transparent',
  },
  headerTitleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    maxWidth: '72%',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: TextScale.xl,
    fontWeight: '900',
    letterSpacing: -0.5,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1.5 },
    textShadowRadius: 4,
  },
  sectionPickerBackdrop: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingTop: Math.max(80, SCREEN_H * 0.12),
    paddingHorizontal: Spacing.four,
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
  },
  sectionPickerSheet: {
    borderRadius: Radius.xl,
    padding: Spacing.three,
    backgroundColor: '#202020',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    ...Shadows.card,
  },
  sectionPickerTitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: TextScale.xs,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one,
    paddingBottom: Spacing.two,
  },
  sectionPickerOption: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.lg,
  },
  sectionPickerOptionSelected: {
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  sectionPickerOptionIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  sectionPickerOptionText: {
    flex: 1,
    gap: 2,
  },
  sectionPickerOptionTitle: {
    color: '#fff',
    fontSize: TextScale.sm,
    fontWeight: '800',
  },
  sectionPickerOptionBody: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: TextScale.xs,
    lineHeight: 16,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  reel: {
    backgroundColor: '#000000',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fastForwardHidden: {
    opacity: 0,
  },

  progressWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 32,
    justifyContent: 'flex-end',
    zIndex: 30,
  },
  seekTimeBubble: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 5,
    zIndex: 35,
  },
  seekTimeText: {
    color: '#FFFFFF',
    fontSize: TextScale.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  speedBadge: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 10,
    zIndex: 16,
  },
  speedText: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: TextScale.sm,
    fontWeight: '400',
    letterSpacing: 0.2,
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  playPauseBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -32,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 12,
  },

  heartOverlay: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -44,
    zIndex: 14,
    shadowColor: '#FF2D55',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.8,
    shadowRadius: 16,
    elevation: 10,
  },

  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    zIndex: 11,
  },

  rightActions: {
    position: 'absolute',
    right: Spacing.three,
    bottom: Spacing.three,
    alignItems: 'center',
    gap: 10,
    zIndex: 35,
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  actionIconWrap: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1.5 },
    shadowOpacity: 0.8,
    shadowRadius: 3,
    elevation: 4,
  },
  actionEmojiText: {
    fontSize: 20,
  },
  actionCount: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  emojiPicker: {
    position: 'absolute',
    right: Spacing.three,
    bottom: 125,
    flexDirection: 'column',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: 'rgba(20, 20, 20, 0.85)',
    padding: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    zIndex: 45,
    ...Shadows.card,
  },
  emojiBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiBtnActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  emojiText: {
    fontSize: 22,
  },

  authorInfo: {
    position: 'absolute',
    left: Spacing.four,
    right: 80,
    bottom: Spacing.three,
    zIndex: 12,
  },
  repostBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 3,
    borderRadius: Radius.full,
    alignSelf: 'flex-start',
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  repostBadgeText: {
    color: '#FFFFFF',
    fontSize: TextScale.xs,
    fontWeight: '700',
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: 6,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 3,
  },
  avatarInitial: {
    color: '#FFFFFF',
    fontSize: TextScale.sm,
    fontWeight: '800',
  },
  authorName: {
    color: '#FFFFFF',
    fontSize: TextScale.sm,
    fontWeight: '800',
    flex: 1,
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  caption: {
    color: 'rgba(255, 255, 255, 0.95)',
    fontSize: TextScale.sm,
    lineHeight: 18,
    fontWeight: '500',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
