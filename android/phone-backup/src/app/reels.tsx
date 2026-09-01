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
} from 'react-native';
import { Image } from 'expo-image';
import { useEvent } from 'expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useModalKeyboardHeight } from '@/hooks/useKeyboardHeight';
import {
  getReelsFeed,
  getConfig,
  buildSharePreviewUrl,
  buildShareThumbnailUrl,
  reactToMedia,
  getComments,
  addComment,
  deleteComment,
} from '../../downloader';
import { hapticLight, hapticSuccess, hapticError, hapticLongPress, hapticSelection } from '@/utils/haptics';

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

export type ReelItem = {
  reel_id: string;
  share_id: number;
  media_id?: number | null;
  path: string;
  shared_by: string;
  shared_by_device_id: string;
  caption: string | null;
  created_at: number;
  reaction_counts: Record<string, number>;
  user_reactions: string[];
  comment_count: number;
  is_own_post: boolean;
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

// ─── Watch-history helpers ─────────────────────────────────────────────────────

const WATCHED_KEY = 'reels_watched_v2';
const MAX_WATCHED = 500;
const MUTED_KEY = 'reels_muted_v1';

async function loadWatched(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(WATCHED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

async function persistWatched(watched: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(WATCHED_KEY, JSON.stringify(Array.from(watched).slice(-MAX_WATCHED)));
  } catch {}
}

// ─── Reel ranking algorithm ───────────────────────────────────────────────────

function scoreReel(item: ReelItem, watched: Set<string>, now: number): number {
  const reactions = Object.values(item.reaction_counts || {}).reduce((a, b) => a + b, 0);
  const ageDays = Math.max(0, now / 1000 - (item.created_at || 0)) / 86400;
  const recency = Math.exp(-ageDays / 14);
  const engagement = Math.min(Math.log1p(reactions) / Math.log1p(10), 1);
  const freshBonus = watched.has(item.reel_id) ? 0 : 0.35;
  const noise = (Math.sin(now + (item.created_at || 0)) + 1) * 0.125;
  return recency * 0.25 + engagement * 0.15 + freshBonus * 0.35 + noise * 0.25;
}

function rankReels(items: ReelItem[], watched: Set<string>): ReelItem[] {
  const now = Date.now();
  return [...items]
    .map(item => ({ item, score: scoreReel(item, watched, now) }))
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

// ─── Bottom Progress bar (Instagram-style) ────────────────────────────────────

function ReelProgressBar({ progress }: { progress: number }) {
  const pct = `${Math.min(100, Math.max(0, progress * 100))}%` as const;
  return (
    <View style={progressStyles.track}>
      <View style={[progressStyles.fill, { width: pct }]} />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    height: 2.5,
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
  },
  fill: {
    height: '100%',
    backgroundColor: '#FFFFFF',
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
};

function VideoReelPlayer({ uri, isActive, isPlaying, speed, muted, onProgress, onReady }: VideoPlayerProps) {
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
      preferredForwardBufferDuration: 1.5,
      minBufferForPlayback: 0.15,
      prioritizeTimeOverSizeThreshold: true,
    };
  });

  const { status } = useEvent(player, 'statusChange', { status: player.status });

  const readyFiredRef = useRef(false);
  const onReadyRef = useRef(onReady);
  const onProgressRef = useRef(onProgress);

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
    }, 200);
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

// ─── Single reel card ─────────────────────────────────────────────────────────

const REACTION_EMOJIS = ['❤️', '😂', '😮', '👍', '🔥', '👏'] as const;

type ReelCardProps = {
  item: ReelItem;
  isActive: boolean;
  cardWidth: number;
  cardHeight: number;
  serverConfig: ServerConfig;
  muted: boolean;
  onToggleMute: () => void;
  onReact: (item: ReelItem, emoji: string) => void;
  onOpenComments: (item: ReelItem) => void;
  colors: AppColors;
};

function ReelCard({
  item,
  isActive,
  cardWidth,
  cardHeight,
  serverConfig,
  muted,
  onToggleMute,
  onReact,
  onOpenComments,
}: ReelCardProps) {
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState(1.0);
  const [progress, setProgress] = useState(0);
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
      if (!readyOnceRef.current) setIsLoading(true);
    } else {
      setIsPlaying(false);
      setShowEmojiPicker(false);
      setShow2x(false);
      setSpeed(1.0);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      setShowControls(false);
    }
  }, [isActive]);

  useEffect(() => () => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
  }, []);

  const handleProgress = useCallback((cur: number, dur: number) => {
    setProgress(dur > 0 ? cur / dur : 0);
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

  return (
    <View style={[s.reel, { width: cardWidth, height: cardHeight }]}>
      {/* Solid Black letterbox background with contain thumbnail placeholder */}
      {(!expoVideoModule || !videoUrl || isLoading) && thumbUrl ? (
        <Image
          source={{ uri: thumbUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
        />
      ) : null}

      {/* Video View with contain fit and solid black letterboxing */}
      {expoVideoModule && videoUrl ? (
        <VideoReelPlayer
          uri={videoUrl}
          isActive={isActive}
          isPlaying={isPlaying && isActive}
          speed={speed}
          muted={muted}
          onProgress={handleProgress}
          onReady={handleReady}
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

      {/* Double tap heart animation */}
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

      {/* Right Action Bar (Instagram-style modern polished buttons) */}
      <View style={s.rightActions} pointerEvents="box-none">
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
                size={30}
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
              size={28}
            />
          </View>
          <Text style={s.actionCount}>
            {item.comment_count > 0 ? item.comment_count : 'Comment'}
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
              size={26}
            />
          </View>
          <Text style={s.actionCount}>{muted ? 'Muted' : 'Sound'}</Text>
        </TouchableOpacity>
      </View>

      {/* Floating Emoji Picker */}
      {showEmojiPicker && (
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
      <View style={s.authorInfo} pointerEvents="none">
        <View style={s.authorRow}>
          <View style={s.avatar}>
            {initial ? (
              <Text style={s.avatarInitial}>{initial}</Text>
            ) : (
              <AppIcon androidName="person" iosName="person.fill" color="#fff" size={14} />
            )}
          </View>
          <Text style={s.authorName} numberOfLines={1}>
            {item.shared_by || 'Unknown'}
          </Text>
        </View>
        {!!item.caption && (
          <Text style={s.caption} numberOfLines={3}>
            {item.caption}
          </Text>
        )}
      </View>

      {/* Bottom Progress Bar (Instagram style) */}
      <View style={s.progressWrap} pointerEvents="none">
        <ReelProgressBar progress={progress} />
      </View>
    </View>
  );
}

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

  const [reels, setReels] = useState<ReelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [screenFocused, setScreenFocused] = useState(false);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(null);
  const [commentsTarget, setCommentsTarget] = useState<ReelItem | null>(null);
  const [muted, setMuted] = useState(false);

  // Dynamic layout measurement to cleanly fit between status bar and floating bottom tab bar
  const defaultCardHeight = Math.max(300, SCREEN_H - insets.top - TAB_BAR_TOTAL_CLEARANCE);
  const [viewportHeight, setViewportHeight] = useState(defaultCardHeight);
  const [viewportWidth, setViewportWidth] = useState(SCREEN_W);

  const listRef = useRef<FlatList<ReelItem>>(null);
  const watchedRef = useRef<Set<string>>(new Set());
  const reelsRef = useRef<ReelItem[]>([]);
  useEffect(() => {
    reelsRef.current = reels;
  }, [reels]);
  const hasMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const seedRef = useRef(0);

  const handleContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (height > 0) {
      setViewportHeight(height);
      setViewportWidth(width);
    }
  }, []);

  const loadReels = useCallback(async (reset = true, options: { skipFullScreenLoading?: boolean } = {}) => {
    if (reloadInFlightRef.current) return;
    reloadInFlightRef.current = true;
    if (reset) {
      offsetRef.current = 0;
    }
    try {
      if (reset) {
        if (!options.skipFullScreenLoading) setLoading(true);
        setActiveIndex(0);
      }
      const [config, watched] = await Promise.all([getConfig(), loadWatched()]);
      setServerConfig(config);
      watchedRef.current = watched;

      if (reset) seedRef.current = Date.now();
      const { reels: raw, has_more } = await getReelsFeed(reset ? 0 : offsetRef.current, 30, seedRef.current);
      hasMoreRef.current = has_more && raw.length > 0;
      offsetRef.current = reset ? raw.length : offsetRef.current + raw.length;

      const ranked = rankReels(raw, watched);
      setReels(prev => reset ? ranked : [...prev, ...ranked]);
      if (reset) listRef.current?.scrollToOffset({ offset: 0, animated: false });
      setError(null);
    } catch (e: any) {
      if (reset) setError(e?.message || 'Failed to load reels');
      else hapticError();
    } finally {
      reloadInFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

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
    return () => setScreenFocused(false);
  }, []));

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
      watchedRef.current.add(reel.reel_id);
      persistWatched(watchedRef.current).catch(() => {});
    }
  }, []);

  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 75, minimumViewTime: 150 }), []);

  const handleReact = useCallback(async (item: ReelItem, emoji: string) => {
    if (item.media_id == null) return;
    try {
      const res = await reactToMedia(item.media_id, emoji);
      setReels(prev => prev.map(r =>
        r.reel_id === item.reel_id
          ? { ...r, reaction_counts: res.counts ?? r.reaction_counts, user_reactions: res.user_reactions ?? r.user_reactions }
          : r
      ));
    } catch { hapticError(); }
  }, []);

  const handleCommentAdded = useCallback((reelId: string) => {
    setReels(prev => prev.map(r =>
      r.reel_id === reelId ? { ...r, comment_count: r.comment_count + 1 } : r
    ));
  }, []);

  const handleCommentDeleted = useCallback((reelId: string) => {
    setReels(prev => prev.map(r =>
      r.reel_id === reelId ? { ...r, comment_count: Math.max(0, r.comment_count - 1) } : r
    ));
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

  const getItemLayout = useCallback((_: unknown, index: number) => ({
    length: viewportHeight,
    offset: viewportHeight * index,
    index,
  }), [viewportHeight]);

  const renderItem = useCallback(({ item, index }: { item: ReelItem; index: number }) => (
    <ReelCard
      key={item.reel_id}
      item={item}
      isActive={index === activeIndex && screenFocused}
      cardWidth={viewportWidth}
      cardHeight={viewportHeight}
      serverConfig={serverConfig}
      muted={muted}
      onToggleMute={handleToggleMute}
      onReact={handleReact}
      onOpenComments={setCommentsTarget}
      colors={colors}
    />
  ), [activeIndex, screenFocused, viewportWidth, viewportHeight, serverConfig, muted, handleToggleMute, handleReact, colors]);

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
      <View style={s.topBar} pointerEvents="box-none">
        <Text style={s.headerTitle}>Reels</Text>

        <View style={s.headerRightActions}>
          <TouchableOpacity
            style={s.headerBtn}
            onPress={() => { hapticSelection(); loadReels(true); }}
            hitSlop={12}
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
              {error || 'Post a video to the feed and it will appear here as a reel.'}
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
            pagingEnabled
            snapToInterval={viewportHeight}
            snapToAlignment="start"
            decelerationRate="fast"
            showsVerticalScrollIndicator={false}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={3}
            windowSize={3}
            initialNumToRender={1}
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
        onCommentAdded={() => commentsTarget && handleCommentAdded(commentsTarget.reel_id)}
        onCommentDeleted={() => commentsTarget && handleCommentDeleted(commentsTarget.reel_id)}
      />
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
  headerTitle: {
    color: '#FFFFFF',
    fontSize: TextScale.xl,
    fontWeight: '900',
    letterSpacing: -0.5,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1.5 },
    textShadowRadius: 4,
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

  progressWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2.5,
    zIndex: 15,
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
    bottom: Spacing.four,
    alignItems: 'center',
    gap: Spacing.four,
    zIndex: 12,
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
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
    bottom: 140,
    flexDirection: 'column',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: 'rgba(20, 20, 20, 0.85)',
    padding: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    zIndex: 25,
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