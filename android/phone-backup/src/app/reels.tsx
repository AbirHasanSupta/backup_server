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
} from 'react-native';
import { Image } from 'expo-image';
import { useEvent } from 'expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
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

// ─── Optional expo-video (same lazy-require pattern as restore.tsx) ───────────

type ExpoVideoModule = typeof import('expo-video');
type VideoSource = import('expo-video').VideoSource;
let expoVideoModule: ExpoVideoModule | null = null;
try {
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
//
//  Score breakdown (weights always sum to 1.0):
//    recency    0.25 – exponential half-life of 14 days
//    engagement 0.15 – log-scaled reaction count (≥10 reactions ≈ max score)
//    freshness  0.35 – unwatched reels get a flat +0.35 bonus
//    noise      0.25 – pure random factor for variety and anti-filter-bubble

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

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ReelProgressBar({ progress }: { progress: number }) {
  const pct = `${Math.min(100, Math.max(0, progress * 100))}%` as const;
  return (
    <View style={progressStyles.track}>
      <View style={[progressStyles.fill, { width: pct }]} />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: { height: 2.5, backgroundColor: 'rgba(255,255,255,0.28)', borderRadius: 2 },
  fill: { height: '100%', borderRadius: 2, backgroundColor: '#fff' },
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
  onReadyRef.current = onReady;
  onProgressRef.current = onProgress;

  useEffect(() => {
    if (status === 'readyToPlay' && !readyFiredRef.current) {
      readyFiredRef.current = true;
      onReadyRef.current();
    }
  }, [status]);

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
    try { isActive && isPlaying ? player.play() : player.pause(); } catch {}
  }, [isActive, isPlaying, player]);

  useEffect(() => {
    try { player.playbackRate = speed; } catch {}
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

const REACTION_EMOJIS = ['❤️', '😂', '😮', '👍'] as const;

type ReelCardProps = {
  item: ReelItem;
  isActive: boolean;
  serverConfig: ServerConfig;
  muted: boolean;
  onToggleMute: () => void;
  onReact: (item: ReelItem, emoji: string) => void;
  onOpenComments: (item: ReelItem) => void;
  colors: AppColors;
};

function ReelCard({ item, isActive, serverConfig, muted, onToggleMute, onReact, onOpenComments, colors }: ReelCardProps) {
  const insets = useSafeAreaInsets();
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
    /* eslint-disable react-hooks/set-state-in-effect */
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
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isActive]);

  useEffect(() => () => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
  }, []);

  const handleProgress = useCallback((cur: number, dur: number) => {
    setProgress(dur > 0 ? cur / dur : 0);
  }, []);

  const handleReady = useCallback(() => { readyOnceRef.current = true; setIsLoading(false); }, []);

  return (
    <View style={[s.reel, { width: SCREEN_W, height: SCREEN_H }]}>
      <Image source={{ uri: thumbUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />

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

      <View style={s.gradientTop} pointerEvents="none" />
      <View style={s.gradientBottom} pointerEvents="none" />

      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handlePress}
        onLongPress={handleLongPress}
        onPressOut={handlePressOut}
        delayLongPress={350}
      />

      <View style={[s.progressWrap, { top: insets.top + 52 }]} pointerEvents="none">
        <ReelProgressBar progress={progress} />
      </View>

      {show2x && (
        <View style={s.speedBadge} pointerEvents="none">
          <Text style={s.speedText}>2×</Text>
        </View>
      )}

      {showControls && (
        <View style={s.playPauseBadge} pointerEvents="none">
          <AppIcon
            androidName={isPlaying ? 'pause' : 'play_arrow'}
            iosName={isPlaying ? 'pause.fill' : 'play.fill'}
            color="rgba(255,255,255,0.92)"
            size={46}
          />
        </View>
      )}

      {showHeart && (
        <Animated.View
          pointerEvents="none"
          style={[s.heartOverlay, { transform: [{ scale: heartScale }], opacity: heartScale }]}
        >
          <AppIcon androidName="favorite" iosName="heart.fill" color="#fff" size={80} />
        </Animated.View>
      )}

      {isLoading && isActive && (
        <View style={s.loadingOverlay} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}

      <View style={[s.rightActions, { bottom: insets.bottom + 90 }]} pointerEvents="box-none">
        <TouchableOpacity style={s.actionBtn} onPress={() => { hapticLight(); setShowEmojiPicker(p => !p); }} activeOpacity={0.8}>
          <Text style={s.actionEmoji}>{myReaction || '❤️'}</Text>
          {totalReactions > 0 && <Text style={s.actionCount}>{totalReactions}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={s.actionBtn} onPress={() => { hapticLight(); onOpenComments(item); }} activeOpacity={0.8}>
          <AppIcon androidName="chat_bubble" iosName="bubble.left.fill" color="#fff" size={28} />
          {item.comment_count > 0 && <Text style={s.actionCount}>{item.comment_count}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={s.actionBtn} onPress={() => { hapticSelection(); onToggleMute(); }} activeOpacity={0.8}>
          <AppIcon
            androidName={muted ? 'volume_off' : 'volume_up'}
            iosName={muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
            color="#fff"
            size={26}
          />
        </TouchableOpacity>
      </View>

      {showEmojiPicker && (
        <View style={[s.emojiPicker, { bottom: insets.bottom + 200 }]}>
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

      <View style={[s.authorInfo, { bottom: insets.bottom + 20 }]} pointerEvents="none">
        <View style={s.authorRow}>
          <View style={s.avatar}>
            {initial
              ? <Text style={s.avatarInitial}>{initial}</Text>
              : <AppIcon androidName="person" iosName="person.fill" color="#fff" size={14} />
            }
          </View>
          <Text style={s.authorName} numberOfLines={1}>{item.shared_by || 'Unknown'}</Text>
        </View>
        {!!item.caption && <Text style={s.caption} numberOfLines={2}>{item.caption}</Text>}
      </View>
    </View>
  );
}

// ─── Comments sheet ───────────────────────────────────────────────────────────

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
  const { keyboardHeight } = useKeyboardHeight();
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

  function ago(ts: number) {
    const d = Math.floor(Date.now() / 1000) - ts;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={cs.backdrop} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={cs.kav}>
        <View
          style={[
            cs.sheet,
            {
              backgroundColor: colors.surface,
              paddingBottom: insets.bottom + Spacing.two + (Platform.OS === 'android' ? keyboardHeight : 0),
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
              style={cs.list}
              contentContainerStyle={{ paddingBottom: Spacing.two }}
              renderItem={({ item: c }) => (
                <View style={cs.row}>
                  <View style={cs.rowInfo}>
                    <Text style={[cs.author, { color: colors.text }]}>
                      {c.display_name || c.source_id}{c.is_own ? ' (You)' : ''}
                    </Text>
                    <Text style={[cs.cText, { color: colors.text }]}>{c.text}</Text>
                    <Text style={[cs.cTime, { color: colors.textMuted }]}>{ago(c.created_at)}</Text>
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
  list: { maxHeight: SCREEN_H * 0.42 },
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
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [reels, setReels] = useState<ReelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [screenFocused, setScreenFocused] = useState(false);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(null);
  const [commentsTarget, setCommentsTarget] = useState<ReelItem | null>(null);
  const [muted, setMuted] = useState(false);

  const listRef = useRef<FlatList<ReelItem>>(null);
  const watchedRef = useRef<Set<string>>(new Set());
  const reelsRef = useRef<ReelItem[]>([]);
  reelsRef.current = reels;
  const hasMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const seedRef = useRef(Date.now());

  const loadReels = useCallback(async (reset = true) => {
    try {
      if (reset) {
        setLoading(true);
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
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    void loadReels(true);
    /* eslint-enable react-hooks/set-state-in-effect */
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

  const extraData = useMemo(() => ({ activeIndex, screenFocused, muted }), [activeIndex, screenFocused, muted]);

  const getItemLayout = useCallback((_: unknown, index: number) => ({
    length: SCREEN_H,
    offset: SCREEN_H * index,
    index,
  }), []);

  const renderItem = useCallback(({ item, index }: { item: ReelItem; index: number }) => (
    <ReelCard
      item={item}
      isActive={index === activeIndex && screenFocused}
      serverConfig={serverConfig}
      muted={muted}
      onToggleMute={handleToggleMute}
      onReact={handleReact}
      onOpenComments={setCommentsTarget}
      colors={colors}
    />
  ), [activeIndex, screenFocused, serverConfig, muted, handleToggleMute, handleReact, colors]);

  const handleClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  if (loading) {
    return (
      <View style={[s.screen, s.center]}>
        <StatusBar hidden />
        <ActivityIndicator color="#fff" size="large" />
        <Text style={s.loadingText}>Loading Reels…</Text>
      </View>
    );
  }

  if (reels.length === 0) {
    return (
      <View style={[s.screen, s.center]}>
        <StatusBar hidden />
        <TouchableOpacity style={[s.headerBtn, { position: 'absolute', top: insets.top + 8, left: Spacing.three }]} onPress={handleClose} hitSlop={12}>
          <AppIcon androidName="arrow_back" iosName="chevron.left" color="#fff" size={22} />
        </TouchableOpacity>
        <AppIcon androidName="videocam_off" iosName="video.slash" color="rgba(255,255,255,0.55)" size={52} />
        <Text style={s.emptyTitle}>No Reels Yet</Text>
        <Text style={s.emptyBody}>
          {error || 'Post a video to the feed and it will appear here as a reel.'}
        </Text>
        <TouchableOpacity style={s.retryBtn} onPress={() => loadReels(true)}>
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <StatusBar hidden />

      <FlatList
        ref={listRef}
        data={reels}
        keyExtractor={item => item.reel_id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        extraData={extraData}
        pagingEnabled
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
      />

      {/* Top header bar */}
      <View style={[s.topBar, { top: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity style={s.headerBtn} onPress={handleClose} hitSlop={12}>
          <AppIcon androidName="close" iosName="xmark" color="#fff" size={21} />
        </TouchableOpacity>

        <Text style={s.headerTitle}>Reels</Text>

        <TouchableOpacity
          style={s.headerBtn}
          onPress={() => { hapticSelection(); loadReels(true); }}
          hitSlop={12}
        >
          <AppIcon androidName="shuffle" iosName="shuffle" color="#fff" size={19} />
        </TouchableOpacity>
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
  screen: { flex: 1, backgroundColor: '#000' },
  center: { justifyContent: 'center', alignItems: 'center', gap: Spacing.three },
  loadingText: { color: 'rgba(255,255,255,0.7)', fontSize: TextScale.sm, marginTop: Spacing.two },
  emptyTitle: { color: '#fff', fontSize: TextScale.lg, fontWeight: '800', marginTop: Spacing.two },
  emptyBody: { color: 'rgba(255,255,255,0.65)', fontSize: TextScale.sm, textAlign: 'center', paddingHorizontal: Spacing.eight, lineHeight: 20 },
  retryBtn: { marginTop: Spacing.two, paddingHorizontal: Spacing.five, paddingVertical: Spacing.two + 2, borderRadius: Radius.full, backgroundColor: 'rgba(255,255,255,0.15)' },
  retryText: { color: '#fff', fontWeight: '700', fontSize: TextScale.sm },

  topBar: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    zIndex: 20,
  },
  headerTitle: { color: '#fff', fontSize: TextScale.base, fontWeight: '800' },
  headerBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },

  reel: { backgroundColor: '#000', overflow: 'hidden' },
  gradientTop: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 130,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  gradientBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0, height: 300,
    backgroundColor: 'rgba(0,0,0,0.52)',
  },
  progressWrap: { position: 'absolute', left: Spacing.three, right: Spacing.three },
  speedBadge: {
    position: 'absolute', alignSelf: 'center', top: '38%',
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: Radius.md,
    paddingHorizontal: Spacing.four, paddingVertical: Spacing.two,
  },
  speedText: { color: '#fff', fontSize: TextScale.xl, fontWeight: '900', letterSpacing: 1 },
  playPauseBadge: {
    position: 'absolute', alignSelf: 'center', top: '50%', marginTop: -33,
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: 'rgba(0,0,0,0.42)',
    alignItems: 'center', justifyContent: 'center',
  },
  heartOverlay: {
    position: 'absolute', alignSelf: 'center', top: '50%', marginTop: -40,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },

  rightActions: {
    position: 'absolute', right: Spacing.three,
    alignItems: 'center', gap: Spacing.five,
  },
  actionBtn: { alignItems: 'center', gap: 4 },
  actionEmoji: { fontSize: 30 },
  actionCount: { color: '#fff', fontSize: TextScale.xs, fontWeight: '700' },

  emojiPicker: {
    position: 'absolute', right: Spacing.three,
    alignItems: 'center', gap: Spacing.two,
  },
  emojiBtn: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.18)',
  },
  emojiBtnActive: { backgroundColor: 'rgba(255,255,255,0.28)', borderColor: 'rgba(255,255,255,0.6)' },
  emojiText: { fontSize: 24 },

  authorInfo: { position: 'absolute', left: Spacing.three, right: 80 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, marginBottom: 4 },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.55)',
  },
  avatarInitial: { color: '#fff', fontSize: TextScale.sm, fontWeight: '700' },
  authorName: { color: '#fff', fontSize: TextScale.sm, fontWeight: '700', flex: 1 },
  caption: { color: 'rgba(255,255,255,0.88)', fontSize: TextScale.sm, lineHeight: 18 },
});