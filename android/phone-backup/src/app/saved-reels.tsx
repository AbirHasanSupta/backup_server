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
  RefreshControl,
  PanResponder,
  Alert,
  BackHandler,
} from 'react-native';
import { Image } from 'expo-image';
import { useEvent } from 'expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { ShareModal } from '@/components/ShareModal';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useModalKeyboardHeight } from '@/hooks/useKeyboardHeight';
import {
  getSavedReels,
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
} from '../../downloader';
import { hapticLight, hapticSuccess, hapticError, hapticLongPress, hapticSelection } from '@/utils/haptics';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ─── Optional expo-video ──────────────────────────────────────────────────────

type ExpoVideoModule = typeof import('expo-video');
type VideoSource = import('expo-video').VideoSource;
let expoVideoModule: ExpoVideoModule | null = null;
try {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  console.warn('[SavedReels] expo-video unavailable – falling back to thumbnail-only view');
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ServerConfig = { ip: string; port: string; key: string; deviceId: string } | null;

export type ReelAuthorInfo = {
  device_id: string;
  name?: string | null;
  username?: string | null;
  display_name: string;
};

export type SavedReelItem = {
  reel_id: string;
  share_id: number;
  media_id?: number | null;
  path: string;
  shared_by: string;
  shared_by_device_id: string;
  is_repost?: boolean;
  user_has_reposted?: boolean;
  original_author?: ReelAuthorInfo | null;
  reposted_by?: ReelAuthorInfo | null;
  caption: string | null;
  created_at: number;
  saved_at?: number;
  reaction_counts: Record<string, number>;
  user_reactions: string[];
  comment_count: number;
  repost_count?: number;
  is_own_post: boolean;
  is_saved?: boolean;
  group_id?: string | null;
};

type Comment = {
  id: number;
  text: string;
  source_id: string;
  display_name?: string;
  created_at: number;
  is_own: boolean;
};

const MUTED_KEY = 'reels_muted_v1';
const REACTION_EMOJIS = ['❤️', '😂', '😮', '👍', '🔥', '👏'] as const;

function formatMediaTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatTimeAgo(ts: number): string {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// ─── Progress bar styles ──────────────────────────────────────────────────────

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

// ─── Full-screen Video Player Component ──────────────────────────────────────

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

function VideoPlayer({ uri, isActive, isPlaying, speed, muted, onProgress, onReady, playerRef }: VideoPlayerProps) {
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
      preferredForwardBufferDuration: 6,
      minBufferForPlayback: 0.25,
      prioritizeTimeOverSizeThreshold: true,
    };
  });

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const readyFiredRef = useRef(false);
  const onReadyRef = useRef(onReady);
  const onProgressRef = useRef(onProgress);

  useEffect(() => {
    if (playerRef) playerRef.current = player;
  }, [player, playerRef]);

  useEffect(() => {
    onReadyRef.current = onReady;
    onProgressRef.current = onProgress;
  }, [onReady, onProgress]);

  useEffect(() => {
    if (status === 'readyToPlay' && !readyFiredRef.current) {
      readyFiredRef.current = true;
      onReadyRef.current();
    }
  }, [status]);

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
    try {
      player.preservesPitch = true;
      player.playbackRate = speed;
    } catch {}
  }, [speed, player]);

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

// ─── Saved Reel Fullscreen Card ──────────────────────────────────────────────

type SavedReelCardProps = {
  item: SavedReelItem;
  isActive: boolean;
  serverConfig: ServerConfig;
  muted: boolean;
  onToggleMute: () => void;
  onReact: (item: SavedReelItem, emoji: string) => void;
  onOpenComments: (item: SavedReelItem) => void;
  onOpenRepost: (item: SavedReelItem) => void;
  onToggleSave: (item: SavedReelItem) => void;
  onCloseViewer: () => void;
};

function SavedReelCard({
  item,
  isActive,
  serverConfig,
  muted,
  onToggleMute,
  onReact,
  onOpenComments,
  onOpenRepost,
  onToggleSave,
  onCloseViewer,
}: SavedReelCardProps) {
  const insets = useSafeAreaInsets();
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
  const longPressRef = useRef(false);
  const readyOnceRef = useRef(false);

  const playerRef = useRef<any>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekProgress, setSeekProgress] = useState(0);
  const isSeekingRef = useRef(false);
  const seekProgressRef = useRef(0);
  const wasPlayingBeforeSeekRef = useRef(false);
  const grantLocationXRef = useRef(0);
  const grantPageXRef = useRef(0);
  const durationRef = useRef(0);
  const isPlayingRef = useRef(isPlaying);

  useEffect(() => { durationRef.current = duration; }, [duration]);
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
    if (longPressRef.current) { longPressRef.current = false; return; }
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
        setIsPlaying(p => !p);
        flashControls();
      }, 300);
    }
  }, [showEmojiPicker, item, onReact, heartScale, flashControls]);

  const handleLongPress = useCallback(() => {
    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
    longPressRef.current = true;
    hapticLongPress();
    setSpeed(2.0);
    setShow2x(true);
  }, []);

  const handlePressOut = useCallback(() => {
    setSpeed(1.0);
    setShow2x(false);
    setTimeout(() => { longPressRef.current = false; }, 50);
  }, []);

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
      setIsSeeking(false);
      isSeekingRef.current = false;
      seekProgressRef.current = 0;
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      setShowControls(false);
    }
  }, [isActive]);

  useEffect(() => () => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
  }, []);

  const handleProgress = useCallback((cur: number, dur: number) => {
    if (!isSeekingRef.current) {
      setCurrentTime(cur);
      setDuration(dur);
      setProgress(dur > 0 ? cur / dur : 0);
    }
  }, []);

  const handleReady = useCallback(() => {
    readyOnceRef.current = true;
    setIsLoading(false);
  }, []);

  const toggleHeartLike = useCallback(() => {
    hapticLight();
    onReact(item, myReaction || '❤️');
  }, [myReaction, item, onReact]);

  const seekPanResponder = useRef(PanResponder.create({
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
      const width = SCREEN_W;
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
      const width = SCREEN_W;
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
      hapticSelection();
      if (wasPlayingBeforeSeekRef.current && p) {
        try { p.play(); } catch {}
      }
    },
    onPanResponderTerminate: () => {
      isSeekingRef.current = false;
      setIsSeeking(false);
      const p = playerRef.current;
      if (wasPlayingBeforeSeekRef.current && p) {
        try { p.play(); } catch {}
      }
    },
  })).current;

  const activeProgress = isSeeking ? seekProgress : progress;
  const displaySeekTime = isSeeking ? seekProgress * (duration || 0) : currentTime;

  return (
    <View style={[s.fullReel, { width: SCREEN_W, height: SCREEN_H }]}>
      {/* Thumbnail placeholder */}
      {(!expoVideoModule || !videoUrl || isLoading) && thumbUrl ? (
        <Image
          source={{ uri: thumbUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
        />
      ) : null}

      {/* Video View */}
      {expoVideoModule && videoUrl ? (
        <VideoPlayer
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

      {/* Top Left Close Button */}
      <TouchableOpacity
        style={[s.viewerCloseBtn, { top: insets.top + Spacing.two }]}
        onPress={onCloseViewer}
        hitSlop={14}
      >
        <AppIcon androidName="close" iosName="xmark" color="#fff" size={22} />
      </TouchableOpacity>

      {/* 2x speed badge */}
      {show2x && (
        <View style={s.speedBadge} pointerEvents="none">
          <Text style={s.speedText}>2x speed</Text>
        </View>
      )}

      {/* Play/Pause flash badge */}
      {showControls && (
        <View style={s.playPauseBadge} pointerEvents="none">
          <AppIcon
            androidName={isPlaying ? 'pause' : 'play_arrow'}
            iosName={isPlaying ? 'pause.fill' : 'play.fill'}
            color="rgba(255,255,255,0.95)"
            size={42}
          />
        </View>
      )}

      {/* Double tap heart */}
      {showHeart && (
        <Animated.View
          pointerEvents="none"
          style={[s.heartOverlay, { transform: [{ scale: heartScale }], opacity: heartScale }]}
        >
          <AppIcon androidName="favorite" iosName="heart.fill" color="#FF2D55" size={88} />
        </Animated.View>
      )}

      {/* Loading spinner */}
      {isLoading && isActive && (
        <View style={s.loadingOverlay} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}

      {/* Right Action Bar (Instagram clean style) */}
      <View style={s.rightActions} pointerEvents="box-none">
        {/* Like */}
        <TouchableOpacity style={s.actionBtn} onPress={toggleHeartLike} activeOpacity={0.75}>
          <View style={s.actionIconWrap}>
            {myReaction && myReaction !== '❤️' ? (
              <Text style={s.actionEmojiText}>{myReaction}</Text>
            ) : (
              <AppIcon
                androidName={isLiked ? 'favorite' : 'favorite_border'}
                iosName={isLiked ? 'heart.fill' : 'heart'}
                color={isLiked ? '#FF2D55' : '#FFFFFF'}
                size={30}
              />
            )}
          </View>
          <Text style={s.actionCount}>{totalReactions > 0 ? totalReactions : 'Like'}</Text>
        </TouchableOpacity>

        {/* Comments */}
        <TouchableOpacity style={s.actionBtn} onPress={() => { hapticLight(); onOpenComments(item); }} activeOpacity={0.75}>
          <View style={s.actionIconWrap}>
            <AppIcon androidName="chat_bubble_outline" iosName="bubble.right.fill" color="#FFFFFF" size={28} />
          </View>
          <Text style={s.actionCount}>{item.comment_count > 0 ? item.comment_count : 'Comment'}</Text>
        </TouchableOpacity>

        {/* Repost */}
        <TouchableOpacity style={s.actionBtn} onPress={() => { hapticLight(); onOpenRepost(item); }} activeOpacity={0.75}>
          <View style={s.actionIconWrap}>
            <AppIcon androidName="repeat" iosName="arrow.2.squarepath" color={item.user_has_reposted ? '#38BDF8' : '#FFFFFF'} size={28} />
          </View>
          <Text style={s.actionCount}>{(item.repost_count || 0) > 0 ? item.repost_count : 'Repost'}</Text>
        </TouchableOpacity>

        {/* Save / Bookmark Toggle */}
        <TouchableOpacity style={s.actionBtn} onPress={() => onToggleSave(item)} activeOpacity={0.75}>
          <View style={s.actionIconWrap}>
            <AppIcon
              androidName={item.is_saved ? 'bookmark' : 'bookmark_border'}
              iosName={item.is_saved ? 'bookmark.fill' : 'bookmark'}
              color={item.is_saved ? '#FBBF24' : '#FFFFFF'}
              size={28}
            />
          </View>
          <Text style={s.actionCount}>{item.is_saved ? 'Saved' : 'Save'}</Text>
        </TouchableOpacity>

        {/* Sound / Mute */}
        <TouchableOpacity style={s.actionBtn} onPress={() => { hapticSelection(); onToggleMute(); }} activeOpacity={0.75}>
          <View style={s.actionIconWrap}>
            <AppIcon
              androidName={muted ? 'volume_off' : 'volume_up'}
              iosName={muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
              color="#FFFFFF"
              size={26}
            />
          </View>
          <Text style={s.actionCount}>{muted ? 'Muted' : 'Sound'}</Text>
        </TouchableOpacity>
      </View>

      {/* Floating Emoji Picker */}
      {showEmojiPicker && (
        <View style={s.emojiPicker}>
          {REACTION_EMOJIS.map(emoji => (
            <TouchableOpacity
              key={emoji}
              onPress={() => { hapticSuccess(); onReact(item, emoji); setShowEmojiPicker(false); }}
              style={[s.emojiBtn, item.user_reactions?.includes(emoji) && s.emojiBtnActive]}
              activeOpacity={0.75}
            >
              <Text style={s.emojiText}>{emoji}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Author & Caption Info (Bottom Left) */}
      <View style={s.authorInfo} pointerEvents="none">
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
          <Text style={s.caption} numberOfLines={3}>{item.caption}</Text>
        )}
      </View>

      {/* Draggable Progress / Seek Bar */}
      <View style={s.progressWrap} {...seekPanResponder.panHandlers}>
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

// ─── Comments Sheet ───────────────────────────────────────────────────────────

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
  onCommentAdded: () => void;
  onCommentDeleted: () => void;
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
      setComments(Array.isArray(res?.comments) ? res.comments : []);
      onCommentAdded();
      hapticSuccess();
    } catch { hapticError(); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteComment(id);
      setComments(prev => prev.filter(c => c.id !== id));
      onCommentDeleted();
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

// ─── Main Saved Reels Screen ──────────────────────────────────────────────────

export default function SavedReelsScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [savedReels, setSavedReels] = useState<SavedReelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(null);

  // Full-screen viewer modal state
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [activeViewerIndex, setActiveViewerIndex] = useState(0);
  const [commentsTarget, setCommentsTarget] = useState<SavedReelItem | null>(null);
  const [repostTarget, setRepostTarget] = useState<SavedReelItem | null>(null);
  const [muted, setMuted] = useState(false);

  const viewerListRef = useRef<FlatList<SavedReelItem>>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [config, res] = await Promise.all([
        getConfig(),
        getSavedReels(0, 100),
      ]);
      setServerConfig(config);
      const items = Array.isArray(res?.reels) ? res.reels : [];
      setSavedReels(items);
    } catch (e: any) {
      setError(e?.message || 'Failed to load saved reels');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void loadData();
  }, [loadData]);

  const handleToggleSave = useCallback(async (item: SavedReelItem) => {
    hapticSelection();
    // Optimistic removal from saved reels list
    setSavedReels(prev => {
      const next = prev.filter(r => r.reel_id !== item.reel_id);
      if (next.length === 0) {
        setViewerIndex(null);
      }
      return next;
    });
    try {
      await toggleSaveReel(item.reel_id, item.share_id, item.media_id ?? undefined);
    } catch {
      // Rollback on failure
      setSavedReels(prev => [item, ...prev]);
      hapticError();
    }
  }, []);

  const handleCommentAdded = useCallback((reelId: string) => {
    setSavedReels(prev => prev.map(r =>
      r.reel_id === reelId ? { ...r, comment_count: r.comment_count + 1 } : r
    ));
  }, []);

  const handleCommentDeleted = useCallback((reelId: string) => {
    setSavedReels(prev => prev.map(r =>
      r.reel_id === reelId ? { ...r, comment_count: Math.max(0, r.comment_count - 1) } : r
    ));
  }, []);

  const handleReact = useCallback(async (item: SavedReelItem, emoji: string) => {
    if (item.media_id == null) return;
    try {
      const res = await reactToMedia(item.media_id, emoji);
      setSavedReels(prev => prev.map(r =>
        r.reel_id === item.reel_id
          ? { ...r, reaction_counts: res.counts ?? r.reaction_counts, user_reactions: res.user_reactions ?? r.user_reactions }
          : r
      ));
    } catch { hapticError(); }
  }, []);

  const handleOpenRepost = useCallback((item: SavedReelItem) => {
    if (item.user_has_reposted) {
      Alert.alert(
        'Repost Options',
        'You have reposted this reel. Would you like to remove your repost or share with more devices?',
        [
          {
            text: 'Remove Repost',
            style: 'destructive',
            onPress: async () => {
              try {
                await cancelRepostReel(item.share_id);
                setSavedReels(prev => prev.map(r =>
                  r.reel_id === item.reel_id
                    ? {
                        ...r,
                        user_has_reposted: false,
                        repost_count: Math.max(0, (r.repost_count || 1) - 1),
                      }
                    : r
                ));
                hapticSuccess();
              } catch (err: any) {
                hapticError();
                Alert.alert('Could not cancel repost', err?.message || 'Failed to remove repost.');
              }
            },
          },
          {
            text: 'Repost to More Devices...',
            onPress: () => setRepostTarget(item),
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    } else {
      setRepostTarget(item);
    }
  }, []);

  const handleRepostSubmit = useCallback(async (targetDeviceIds: string[], caption: string) => {
    if (!repostTarget) return;
    try {
      await repostReel(repostTarget.share_id, targetDeviceIds, caption);
      setSavedReels(prev => prev.map(r =>
        r.reel_id === repostTarget.reel_id
          ? {
              ...r,
              user_has_reposted: true,
              repost_count: (r.repost_count || 0) + 1,
            }
          : r
      ));
      hapticSuccess();
      setRepostTarget(null);
    } catch (err: any) {
      hapticError();
      Alert.alert('Could not repost', err?.message || 'Failed to repost reel.');
    }
  }, [repostTarget]);

  // Handle hardware back press on Android (and back gesture): returns to normal Reels tab
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewerIndex != null) {
        setViewerIndex(null);
        return true;
      }
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/reels');
      }
      return true;
    });
    return () => sub.remove();
  }, [viewerIndex, router]);

  const openViewerAt = useCallback((index: number) => {
    hapticLight();
    setActiveViewerIndex(index);
    setViewerIndex(index);
  }, []);

  const onViewerItemsChanged = useMemo(() => ({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
    if (viewableItems.length > 0 && viewableItems[0].index != null) {
      setActiveViewerIndex(viewableItems[0].index);
    }
  }, []);

  const renderGridItem = useCallback(({ item, index }: { item: SavedReelItem; index: number }) => {
    const thumbUrl = serverConfig ? buildShareThumbnailUrl(serverConfig, item.share_id) : '';
    const authorName = item.is_repost
      ? (item.original_author?.display_name || item.shared_by)
      : item.shared_by;
    const initial = (authorName || '').trim().charAt(0).toUpperCase();

    return (
      <TouchableOpacity
        style={s.gridCard}
        onPress={() => openViewerAt(index)}
        activeOpacity={0.85}
      >
        {thumbUrl ? (
          <Image source={{ uri: thumbUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={s.gridPlaceholder}>
            <AppIcon androidName="movie" iosName="play.rectangle.fill" color="rgba(255,255,255,0.4)" size={32} />
          </View>
        )}

        {/* Top Badges */}
        <View style={s.gridTopRow} pointerEvents="none">
          {item.is_repost ? (
            <View style={s.gridPillBadge}>
              <AppIcon androidName="repeat" iosName="arrow.2.squarepath" color="#fff" size={11} />
            </View>
          ) : <View />}
          <View style={s.gridSavedBadge}>
            <AppIcon androidName="bookmark" iosName="bookmark.fill" color="#FBBF24" size={13} />
          </View>
        </View>

        {/* Bottom Card Overlay */}
        <View style={s.gridBottomOverlay} pointerEvents="none">
          <View style={s.gridAuthorRow}>
            <View style={s.gridAvatar}>
              {initial ? (
                <Text style={s.gridAvatarText}>{initial}</Text>
              ) : (
                <AppIcon androidName="person" iosName="person.fill" color="#fff" size={10} />
              )}
            </View>
            <Text style={s.gridAuthorName} numberOfLines={1}>
              {authorName}
            </Text>
          </View>
          {!!item.caption && (
            <Text style={s.gridCaption} numberOfLines={1}>{item.caption}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  }, [serverConfig, openViewerAt]);

  return (
    <View style={[s.screen, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {/* Header Bar */}
      <View style={[s.headerBar, { borderBottomColor: colors.surfaceBorder }]}>
        <TouchableOpacity
          style={s.headerBackBtn}
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace('/reels');
            }
          }}
          hitSlop={14}
          accessibilityLabel="Go back to reels"
        >
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>

        <View style={s.headerTitleWrap}>
          <Text style={[s.headerTitle, { color: colors.text }]}>Saved Reels</Text>
          {savedReels.length > 0 && (
            <View style={[s.countBadge, { backgroundColor: colors.primarySoft }]}>
              <Text style={[s.countBadgeText, { color: colors.primary }]}>{savedReels.length}</Text>
            </View>
          )}
        </View>

        <View style={{ width: 36 }} />
      </View>

      {/* Body Content */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={[s.loadingText, { color: colors.textSecondary }]}>Loading saved reels…</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <AppIcon androidName="error_outline" iosName="exclamationmark.circle" color={colors.error} size={48} />
          <Text style={[s.emptyTitle, { color: colors.text }]}>Could not load saved reels</Text>
          <Text style={[s.emptyBody, { color: colors.textSecondary }]}>{error}</Text>
          <TouchableOpacity style={[s.retryBtn, { backgroundColor: colors.primary }]} onPress={loadData}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : savedReels.length === 0 ? (
        <View style={s.center}>
          <View style={[s.emptyIconWrap, { backgroundColor: colors.surfaceSoft }]}>
            <AppIcon androidName="bookmark_border" iosName="bookmark" color={colors.textMuted} size={52} />
          </View>
          <Text style={[s.emptyTitle, { color: colors.text }]}>No Saved Reels Yet</Text>
          <Text style={[s.emptyBody, { color: colors.textSecondary }]}>
            Tap the bookmark icon on any reel in the Reels tab to save it here for easy access.
          </Text>
          <TouchableOpacity
            style={[s.exploreBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.replace('/reels')}
          >
            <Text style={s.exploreBtnText}>Browse Reels</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={savedReels}
          keyExtractor={item => item.reel_id}
          numColumns={2}
          contentContainerStyle={s.gridListContent}
          columnWrapperStyle={s.gridRow}
          renderItem={renderGridItem}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        />
      )}

      {/* Full-Screen Video Viewer Modal */}
      {viewerIndex != null && (
        <Modal
          visible={viewerIndex != null}
          animationType="fade"
          transparent={false}
          onRequestClose={() => setViewerIndex(null)}
        >
          <View style={s.modalContainer}>
            <FlatList
              ref={viewerListRef}
              data={savedReels}
              keyExtractor={item => item.reel_id}
              initialScrollIndex={viewerIndex}
              getItemLayout={(_, index) => ({ length: SCREEN_H, offset: SCREEN_H * index, index })}
              pagingEnabled
              showsVerticalScrollIndicator={false}
              onViewableItemsChanged={onViewerItemsChanged}
              viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
              renderItem={({ item, index }) => (
                <SavedReelCard
                  key={item.reel_id}
                  item={item}
                  isActive={index === activeViewerIndex}
                  serverConfig={serverConfig}
                  muted={muted}
                  onToggleMute={handleToggleMute}
                  onReact={handleReact}
                  onOpenComments={setCommentsTarget}
                  onOpenRepost={handleOpenRepost}
                  onToggleSave={handleToggleSave}
                  onCloseViewer={() => setViewerIndex(null)}
                />
              )}
            />
          </View>
        </Modal>
      )}

      {/* Comments Sheet */}
      <CommentsSheet
        visible={commentsTarget != null}
        mediaId={commentsTarget?.media_id}
        colors={colors}
        onClose={() => setCommentsTarget(null)}
        onCommentAdded={() => commentsTarget && handleCommentAdded(commentsTarget.reel_id)}
        onCommentDeleted={() => commentsTarget && handleCommentDeleted(commentsTarget.reel_id)}
      />

      {/* Repost Modal */}
      <ShareModal
        visible={repostTarget != null}
        count={1}
        colors={colors}
        onClose={() => setRepostTarget(null)}
        onSubmit={handleRepostSubmit}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBackBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerTitle: {
    fontSize: TextScale.lg,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  countBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  countBadgeText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.six,
    gap: Spacing.three,
  },
  loadingText: {
    fontSize: TextScale.sm,
    fontWeight: '600',
  },
  emptyIconWrap: {
    width: 90,
    height: 90,
    borderRadius: 45,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.two,
  },
  emptyTitle: {
    fontSize: TextScale.lg,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: TextScale.sm,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: Spacing.four,
  },
  exploreBtn: {
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.six,
    paddingVertical: Spacing.three,
    borderRadius: Radius.full,
    ...Shadows.card,
  },
  exploreBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: TextScale.sm,
  },
  retryBtn: {
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.two + 2,
    borderRadius: Radius.full,
  },
  retryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: TextScale.sm,
  },

  // Grid
  gridListContent: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  gridRow: {
    gap: Spacing.three,
  },
  gridCard: {
    flex: 1,
    height: (SCREEN_W / 2 - Spacing.three * 1.5) * 1.55,
    borderRadius: Radius.lg,
    backgroundColor: '#1E1E1E',
    overflow: 'hidden',
    position: 'relative',
    ...Shadows.card,
  },
  gridPlaceholder: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#181818',
  },
  gridTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: Spacing.two,
    zIndex: 5,
  },
  gridPillBadge: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  gridSavedBadge: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  gridBottomOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    padding: Spacing.two,
    gap: 2,
  },
  gridAuthorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  gridAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridAvatarText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  gridAuthorName: {
    color: '#FFFFFF',
    fontSize: TextScale.xs,
    fontWeight: '700',
    flex: 1,
  },
  gridCaption: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
  },

  // Full-screen viewer modal
  modalContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  fullReel: {
    backgroundColor: '#000000',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerCloseBtn: {
    position: 'absolute',
    left: Spacing.four,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 40,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  speedBadge: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 40,
    zIndex: 16,
  },
  speedText: {
    color: '#fff',
    fontSize: TextScale.sm,
    fontWeight: '600',
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
    bottom: 50,
    alignItems: 'center',
    gap: Spacing.four,
    zIndex: 35,
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionIconWrap: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1.5 },
    shadowOpacity: 0.8,
    shadowRadius: 3,
    elevation: 4,
  },
  actionEmojiText: {
    fontSize: 24,
  },
  actionCount: {
    color: '#FFFFFF',
    fontSize: TextScale.xs,
    fontWeight: '700',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  emojiPicker: {
    position: 'absolute',
    right: Spacing.three,
    bottom: 160,
    flexDirection: 'column',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: 'rgba(20, 20, 20, 0.85)',
    padding: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    zIndex: 45,
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
    bottom: 40,
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
    zIndex: 35,
  },
  seekTimeText: {
    color: '#FFFFFF',
    fontSize: TextScale.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});

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
