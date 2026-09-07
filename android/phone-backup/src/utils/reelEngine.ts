/**
 * HyperPulse Recommendation Engine (Local-Only)
 *
 * Advanced, fully deterministic, multi-factor personalized reel recommendation
 * algorithm running completely on local calculations. No external AI, no LLMs,
 * zero network dependencies for scoring.
 *
 * Capabilities:
 * - Continuous micro-behavioral utility tracking (completion rates, loops, fast skips, dwell).
 * - Multi-dimensional vector profiles: Ebbinghaus time-decayed author affinity,
 *   caption/hashtag TF-IDF vector, format/duration affinity, and session momentum.
 * - Bayesian public quality smoothing and cold-start exploration bandit (UCB1).
 * - Deterministic Maximal Marginal Relevance (MMR) slate diversification:
 *   author spacing (>= 2 slots), group de-clustering (>= 3 slots), and quarantine cooldowns.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types & Interfaces ───────────────────────────────────────────────────────

export type ReelAuthorInfo = {
  device_id: string;
  name?: string | null;
  username?: string | null;
  display_name: string;
};

export type ReelItem = {
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
  reaction_counts: Record<string, number>;
  user_reactions: string[];
  comment_count: number;
  repost_count?: number;
  view_count?: number;
  duration?: number;
  quality_score?: number;
  tokens?: string[];
  size?: number;
  is_own_post: boolean;
  is_saved?: boolean;
  is_unseen?: boolean;
  group_id?: string | null;
};

export type PlaybackTelemetryEvent = {
  share_id: number;
  reel_id: string;
  media_id?: number | null;
  author_key: string;
  watch_time_sec: number;
  duration_sec: number;
  completion_rate: number;
  loops: number;
  skipped: boolean;
  unmuted?: boolean;
  liked?: boolean;
  saved?: boolean;
  reposted?: boolean;
  commented?: boolean;
  tokens?: string[];
  group_id?: string | null;
  timestamp: number;
};

export type CreatorAffinity = {
  score: number;       // Range: -5.0 to +10.0
  lastUpdated: number; // Unix ms
  skipStreak: number;
  exposureCount: number;
};

export type TopicAffinity = {
  score: number;       // Range: -3.0 to +8.0
  lastUpdated: number; // Unix ms
  count: number;
};

export type DurationBucket = 'micro' | 'short' | 'medium' | 'long';

export type DurationStats = {
  completionSum: number;
  count: number;
};

export type WatchedRecord = {
  lastWatched: number;
  utility: number;
  watchCount: number;
};

export type HyperPulseState = {
  creators: Record<string, CreatorAffinity>;
  topics: Record<string, TopicAffinity>;
  durations: Record<DurationBucket, DurationStats>;
  watched: Record<string, WatchedRecord>;
  sessionMomentumTokens: string[];
  sessionMomentumCreators: string[];
  lastSessionTimestamp: number;
};

// ─── Storage Keys & Constants ─────────────────────────────────────────────────

const STATE_STORAGE_KEY = 'reels_hyperpulse_state_v1';
const LEGACY_WATCHED_KEY = 'reels_watched_v2';
const LEGACY_AFFINITY_KEY = 'reels_creator_affinity_v2';

const MAX_STORED_WATCHED = 800;
const MAX_STORED_CREATORS = 150;
const MAX_STORED_TOPICS = 300;
const MAX_SESSION_MOMENTUM = 10;

// Ebbinghaus exponential decay constant: Half-life = 14 days
// lambda = ln(2) / (14 * 86400 * 1000) ms^-1
const DECAY_LAMBDA_PER_MS = Math.LN2 / (14 * 86400 * 1000);

// Stopwords for local caption parsing
const STOPWORDS = new Set([
  'the', 'and', 'this', 'that', 'with', 'from', 'for', 'have', 'you', 'your',
  'was', 'were', 'are', 'been', 'will', 'what', 'when', 'where', 'who', 'which',
  'there', 'here', 'just', 'some', 'like', 'into', 'than', 'then', 'more', 'also',
  'about', 'would', 'could', 'should', 'their', 'them', 'these', 'those', 'post', 'reel',
]);

// ─── Tokenizer Helper ─────────────────────────────────────────────────────────

const HASHTAG_REGEX = /#[\w\d_-]+/gu;
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu;
const WORD_REGEX = /\b[a-zA-Z]{3,15}\b/g;

export function extractTokensLocally(caption?: string | null): string[] {
  if (!caption) return [];
  const tokens = new Set<string>();

  const hashtags = caption.match(HASHTAG_REGEX);
  if (hashtags) {
    for (const ht of hashtags) tokens.add(ht.toLowerCase());
  }

  const emojis = caption.match(EMOJI_REGEX);
  if (emojis) {
    for (const em of emojis) tokens.add(em);
  }

  const words = caption.toLowerCase().match(WORD_REGEX);
  if (words) {
    for (const w of words) {
      if (!STOPWORDS.has(w)) tokens.add(w);
    }
  }

  return Array.from(tokens).slice(0, 15);
}

// ─── Format / Duration Bucket Helper ──────────────────────────────────────────

export function getDurationBucket(durationSec: number): DurationBucket {
  if (durationSec <= 0 || durationSec < 12) return 'micro';
  if (durationSec < 25) return 'short';
  if (durationSec < 50) return 'medium';
  return 'long';
}

// ─── State Initialization & Migration ─────────────────────────────────────────

export function createDefaultState(): HyperPulseState {
  return {
    creators: {},
    topics: {},
    durations: {
      micro: { completionSum: 1.0, count: 2 },
      short: { completionSum: 1.5, count: 2 },
      medium: { completionSum: 1.2, count: 2 },
      long: { completionSum: 1.0, count: 2 },
    },
    watched: {},
    sessionMomentumTokens: [],
    sessionMomentumCreators: [],
    lastSessionTimestamp: Date.now(),
  };
}

export async function loadHyperPulseState(): Promise<HyperPulseState> {
  try {
    const raw = await AsyncStorage.getItem(STATE_STORAGE_KEY);
    let state: HyperPulseState;
    if (raw) {
      state = JSON.parse(raw) as HyperPulseState;
      if (!state.creators) state.creators = {};
      if (!state.topics) state.topics = {};
      if (!state.durations) {
        state.durations = {
          micro: { completionSum: 1.0, count: 2 },
          short: { completionSum: 1.5, count: 2 },
          medium: { completionSum: 1.2, count: 2 },
          long: { completionSum: 1.0, count: 2 },
        };
      }
      if (!state.watched) state.watched = {};
      if (!state.sessionMomentumTokens) state.sessionMomentumTokens = [];
      if (!state.sessionMomentumCreators) state.sessionMomentumCreators = [];
    } else {
      state = createDefaultState();
      // Backward-compatible migration from v2 legacy keys
      const [legacyWatchedRaw, legacyAffinityRaw] = await Promise.all([
        AsyncStorage.getItem(LEGACY_WATCHED_KEY),
        AsyncStorage.getItem(LEGACY_AFFINITY_KEY),
      ]);

      if (legacyWatchedRaw) {
        try {
          const list: string[] = JSON.parse(legacyWatchedRaw);
          const now = Date.now();
          for (const id of list) {
            state.watched[id] = { lastWatched: now, utility: 0.5, watchCount: 1 };
          }
        } catch {}
      }

      if (legacyAffinityRaw) {
        try {
          const aff: Record<string, number> = JSON.parse(legacyAffinityRaw);
          const now = Date.now();
          for (const [key, val] of Object.entries(aff)) {
            state.creators[key] = {
              score: Math.min(10.0, Math.max(0.0, val)),
              lastUpdated: now,
              skipStreak: 0,
              exposureCount: 3,
            };
          }
        } catch {}
      }
    }

    // Apply Ebbinghaus forgetting decay to loaded state
    applyStateDecay(state);
    return state;
  } catch {
    return createDefaultState();
  }
}

export async function persistHyperPulseState(state: HyperPulseState): Promise<void> {
  try {
    // Prune collections before saving to avoid unbounded storage growth
    pruneState(state);
    await AsyncStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));

    // Keep legacy keys updated for 100% backward compatibility
    const legacyWatched = Object.keys(state.watched).slice(-500);
    const legacyAffinity: Record<string, number> = {};
    for (const [k, v] of Object.entries(state.creators)) {
      legacyAffinity[k] = Math.max(0, Math.round(v.score));
    }
    await Promise.all([
      AsyncStorage.setItem(LEGACY_WATCHED_KEY, JSON.stringify(legacyWatched)).catch(() => {}),
      AsyncStorage.setItem(LEGACY_AFFINITY_KEY, JSON.stringify(legacyAffinity)).catch(() => {}),
    ]);
  } catch {}
}

function applyStateDecay(state: HyperPulseState): void {
  const now = Date.now();
  for (const creator of Object.values(state.creators)) {
    const elapsed = Math.max(0, now - (creator.lastUpdated || now));
    if (elapsed > 3600000) { // Decay hourly/daily
      const decayFactor = Math.exp(-DECAY_LAMBDA_PER_MS * elapsed);
      creator.score = creator.score * decayFactor;
      creator.lastUpdated = now;
    }
  }

  for (const topic of Object.values(state.topics)) {
    const elapsed = Math.max(0, now - (topic.lastUpdated || now));
    if (elapsed > 3600000) {
      const decayFactor = Math.exp(-DECAY_LAMBDA_PER_MS * elapsed);
      topic.score = topic.score * decayFactor;
      topic.lastUpdated = now;
    }
  }
  state.lastSessionTimestamp = now;
}

function pruneState(state: HyperPulseState): void {
  const watchedKeys = Object.keys(state.watched);
  if (watchedKeys.length > MAX_STORED_WATCHED) {
    watchedKeys.sort((a, b) => state.watched[a].lastWatched - state.watched[b].lastWatched);
    const removeCount = watchedKeys.length - MAX_STORED_WATCHED;
    for (let i = 0; i < removeCount; i++) delete state.watched[watchedKeys[i]];
  }

  const creatorKeys = Object.keys(state.creators);
  if (creatorKeys.length > MAX_STORED_CREATORS) {
    creatorKeys.sort((a, b) => state.creators[a].lastUpdated - state.creators[b].lastUpdated);
    const removeCount = creatorKeys.length - MAX_STORED_CREATORS;
    for (let i = 0; i < removeCount; i++) delete state.creators[creatorKeys[i]];
  }

  const topicKeys = Object.keys(state.topics);
  if (topicKeys.length > MAX_STORED_TOPICS) {
    topicKeys.sort((a, b) => state.topics[a].lastUpdated - state.topics[b].lastUpdated);
    const removeCount = topicKeys.length - MAX_STORED_TOPICS;
    for (let i = 0; i < removeCount; i++) delete state.topics[topicKeys[i]];
  }
}

// ─── Utility Metric & Telemetry Processing ────────────────────────────────────

/**
 * Calculate the true satisfaction utility U(r) for a playback session.
 */
export function calculateReelUtility(ev: PlaybackTelemetryEvent): number {
  let u = 0.0;

  const hasExplicitEngagement = Boolean(ev.liked || ev.saved || ev.reposted || ev.commented);
  const watchTime = Math.max(0, isNaN(ev.watch_time_sec) ? 0 : ev.watch_time_sec);
  const completionRate = Math.max(0, isNaN(ev.completion_rate) ? 0 : ev.completion_rate);
  const isSkip = !hasExplicitEngagement && (ev.skipped || (completionRate < 0.20 && watchTime < 2.0));

  // 1. Completion & Watch Duration Signal
  if (isSkip) {
    u -= 1.8; // Aggressive skip penalty
  } else if (completionRate < 0.50) {
    u -= hasExplicitEngagement ? 0.0 : 0.3; // Passive exit
  } else if (completionRate < 0.85) {
    u += 0.7; // Engaged
  } else {
    u += 1.5; // Full completion
  }

  // 2. Loop Multiplier (strongest implicit signal on short-form video)
  const loops = Math.max(0, isNaN(ev.loops) ? 0 : ev.loops);
  if (loops > 0) {
    u += Math.min(loops, 3) * 1.2;
  }

  // 3. Audio Intent
  if (ev.unmuted) {
    u += 0.8;
  }

  // 4. Explicit Engagements
  if (ev.liked) u += 1.6;
  if (ev.saved) u += 2.5;
  if (ev.reposted) u += 3.0;
  if (ev.commented) u += 2.2;

  return u;
}

/**
 * Update HyperPulse dynamic user vectors with the latest playback interaction.
 */
export function processPlaybackTelemetry(
  state: HyperPulseState,
  ev: PlaybackTelemetryEvent,
): void {
  const utility = calculateReelUtility(ev);
  const now = Date.now();

  // 1. Update Watched Record
  const existingWatch = state.watched[ev.reel_id];
  state.watched[ev.reel_id] = {
    lastWatched: now,
    utility,
    watchCount: (existingWatch?.watchCount || 0) + 1,
  };

  // 2. Update Creator Affinity
  const authorKey = ev.author_key;
  if (authorKey) {
    if (!state.creators[authorKey]) {
      state.creators[authorKey] = { score: 0.0, lastUpdated: now, skipStreak: 0, exposureCount: 0 };
    }
    const creator = state.creators[authorKey];
    creator.exposureCount++;
    creator.lastUpdated = now;

    if (ev.skipped || utility < -1.0) {
      creator.skipStreak++;
      // Immediate skip penalty: scales with consecutive skips
      creator.score = Math.max(-5.0, creator.score - 1.2 * creator.skipStreak);
    } else {
      creator.skipStreak = 0;
      // Positive boost
      creator.score = Math.min(10.0, creator.score + Math.max(0.2, utility * 0.5));
    }
  }

  // 3. Update Topic / Hashtag Affinities
  const tokens = ev.tokens || [];
  for (const t of tokens) {
    if (!state.topics[t]) {
      state.topics[t] = { score: 0.0, lastUpdated: now, count: 0 };
    }
    const topic = state.topics[t];
    topic.count++;
    topic.lastUpdated = now;
    if (utility > 0) {
      topic.score = Math.min(8.0, topic.score + utility * 0.3);
    } else {
      topic.score = Math.max(-3.0, topic.score + utility * 0.2);
    }
  }

  // 4. Update Duration Affinity
  if (ev.duration_sec > 0) {
    const bucket = getDurationBucket(ev.duration_sec);
    if (!state.durations) {
      state.durations = createDefaultState().durations;
    }
    const durStat = state.durations[bucket];
    if (durStat) {
      durStat.completionSum += Math.min(2.0, ev.completion_rate);
      durStat.count += 1;
    }
  }

  // 5. Update In-Session Momentum
  if (utility >= 1.0) {
    if (authorKey && !state.sessionMomentumCreators.includes(authorKey)) {
      state.sessionMomentumCreators.unshift(authorKey);
      if (state.sessionMomentumCreators.length > MAX_SESSION_MOMENTUM) state.sessionMomentumCreators.pop();
    }
    for (const t of tokens) {
      if (!state.sessionMomentumTokens.includes(t)) {
        state.sessionMomentumTokens.unshift(t);
        if (state.sessionMomentumTokens.length > MAX_SESSION_MOMENTUM) state.sessionMomentumTokens.pop();
      }
    }
  }
}

// ─── Mathematical Scoring Function ────────────────────────────────────────────

function fastHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0);
}

/**
 * Score an individual reel candidate for the current user and session.
 */
export function scoreReelCandidate(
  item: ReelItem,
  state: HyperPulseState,
  sessionSeed: number,
): number {
  const watchRecord = state.watched[item.reel_id];
  const isWatched = Boolean(watchRecord);

  // Top Priority: Direct newly received unseen shared/reposted reel
  if (!isWatched && item.is_unseen) {
    return 100000 + (item.created_at || 0);
  }

  const now = sessionSeed > 0 ? sessionSeed : Date.now();
  const authorKey = item.original_author?.device_id || item.shared_by_device_id || item.shared_by;

  // 1. Creator Affinity Factor
  const creatorEntry = authorKey ? state.creators[authorKey] : null;
  const rawCreatorScore = creatorEntry ? creatorEntry.score : 0;
  // Normalized to [-0.5, 1.0]
  const creatorAffinity = Math.max(-0.5, Math.min(1.0, rawCreatorScore / 8.0));

  // 2. Topic & Content Affinity Factor (Local TF-IDF matching)
  const tokens = item.tokens && item.tokens.length > 0 ? item.tokens : extractTokensLocally(item.caption);
  let topicAffinitySum = 0.0;
  for (const t of tokens) {
    const entry = state.topics[t];
    if (entry) topicAffinitySum += entry.score;
  }
  const contentAffinity = tokens.length > 0
    ? Math.max(-0.3, Math.min(1.0, topicAffinitySum / (Math.sqrt(tokens.length) * 4.0)))
    : 0.0;

  // 3. Recency Decay (Exponential half-life ~ 14 days)
  const createdAt = item.created_at || (now / 1000);
  const ageDays = Math.max(0, now / 1000 - createdAt) / 86400;
  const recency = Math.exp(-ageDays / 14);

  // 4. Bayesian Public Quality
  let publicQuality = item.quality_score;
  if (publicQuality === undefined) {
    const totalReactions = Object.values(item.reaction_counts || {}).reduce((a, b) => a + b, 0);
    const ownReactionCount = (item.user_reactions && item.user_reactions.length > 0) ? 1 : 0;
    const othersReactions = Math.max(0, totalReactions - ownReactionCount);
    const totalComments = item.comment_count || 0;
    const totalReposts = item.repost_count || 0;
    const ownRepostCount = item.user_has_reposted ? 1 : 0;
    const othersReposts = Math.max(0, totalReposts - ownRepostCount);
    const weighted = othersReactions * 1.0 + totalComments * 1.8 + othersReposts * 2.5;
    publicQuality = Math.min(1.0, Math.log1p(weighted) / Math.log1p(30.0));
  }

  // 5. Duration Bucket Preference Factor
  let durationAffinity = 0.0;
  if (item.duration && item.duration > 0 && state.durations) {
    const bucket = getDurationBucket(item.duration);
    const durStat = state.durations[bucket];
    if (durStat && durStat.count > 0) {
      const avgCompletion = durStat.completionSum / durStat.count;
      durationAffinity = Math.max(-0.15, Math.min(0.15, (avgCompletion - 0.60) * 0.35));
    }
  }

  // 6. In-Session Momentum Boost (riding the current session "vibe")
  let sessionBoost = 0.0;
  if (authorKey && state.sessionMomentumCreators.includes(authorKey)) {
    sessionBoost += 0.20;
  }
  let matchingTokens = 0;
  for (const t of tokens) {
    if (state.sessionMomentumTokens.includes(t)) matchingTokens++;
  }
  if (matchingTokens > 0) {
    sessionBoost += Math.min(0.25, matchingTokens * 0.10);
  }

  // 7. Cold-Start Bandit Exploration (Upper Confidence Bound)
  // Give fair exposure to creators with low exposure counts
  let banditExploration = 0.0;
  const exposureCount = creatorEntry ? creatorEntry.exposureCount : 0;
  if (exposureCount < 3) {
    banditExploration = 0.22 / (1 + exposureCount);
  }

  // 8. Watch & Interaction Fatigue Penalties
  let watchPenalty = 0.0;
  const hasUserInteracted = Boolean(
    (item.user_reactions && item.user_reactions.length > 0) ||
    item.user_has_reposted ||
    item.is_saved
  );

  if (isWatched) {
    const lastWatched = watchRecord.lastWatched;
    const daysSinceWatch = Math.max(0, (now - lastWatched) / (86400 * 1000));
    if (watchRecord.utility < -0.5) {
      // Skipped video: quarantine for 30 days
      watchPenalty = daysSinceWatch > 30 ? -0.80 : -2.50;
    } else {
      // Re-watchable video: mild cooldown that softens over time
      watchPenalty = -0.70 * Math.exp(-daysSinceWatch / 14);
    }
  } else {
    // Unwatched fresh boost
    watchPenalty = 0.30;
  }

  if (hasUserInteracted) {
    // Already interacted content belongs in library (saved-reels), deprioritized in feed
    watchPenalty -= 0.50;
  }

  // 9. Social Boost for Curated Reposts
  const socialBoost = item.is_repost ? 0.08 : 0.02;

  // 10. Controlled Deterministic Noise per session
  const noise = ((fastHash(item.reel_id + '_' + sessionSeed) % 1000) / 1000) * 0.10;

  return (
    recency * 0.20 +
    publicQuality * 0.25 +
    creatorAffinity * 0.25 +
    contentAffinity * 0.15 +
    durationAffinity +
    sessionBoost +
    banditExploration +
    watchPenalty +
    socialBoost +
    noise
  );
}

// ─── Slate Diversification (Deterministic MMR Re-Ranking) ─────────────────────

/**
 * Re-rank and interleave reels into a diverse, non-repetitive feed.
 *
 * Enforces:
 * - Direct unseen reels placed at the very top.
 * - Minimum author spacing of 2 slots (no 2 consecutive reels from the same creator).
 * - Minimum share group de-clustering of 3 slots (no bursting of 10 videos from one album).
 * - Multi-tiered pool fallback: Unseen -> Fresh Unwatched -> Bandit -> Nostalgia Replay -> Interacted.
 */
export function buildDiverseReelSlate(
  items: ReelItem[],
  state: HyperPulseState,
  sessionSeed: number,
): ReelItem[] {
  const scored = [...items].map(item => {
    const watchRecord = state.watched[item.reel_id];
    const isWatched = Boolean(watchRecord);
    const hasInteracted = Boolean(
      (item.user_reactions && item.user_reactions.length > 0) ||
      item.user_has_reposted ||
      item.is_saved
    );
    return {
      item,
      score: scoreReelCandidate(item, state, sessionSeed),
      isWatched,
      hasInteracted,
      utility: watchRecord ? watchRecord.utility : 0,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // Multi-tiered pool separation
  const unseenDirect: ReelItem[] = [];
  const freshUnwatched: ReelItem[] = [];
  const nostalgiaReplay: ReelItem[] = [];
  const alreadyInteracted: ReelItem[] = [];

  for (const entry of scored) {
    const { item, isWatched, hasInteracted, utility } = entry;
    if (!isWatched && item.is_unseen) {
      unseenDirect.push(item);
    } else if (!isWatched && !hasInteracted) {
      freshUnwatched.push(item);
    } else if (isWatched && utility >= 0.5 && !hasInteracted) {
      nostalgiaReplay.push(item);
    } else {
      alreadyInteracted.push(item);
    }
  }

  const result: ReelItem[] = [...unseenDirect];
  const candidatePool = [...freshUnwatched, ...nostalgiaReplay, ...alreadyInteracted];

  // Slate diversification trackers
  const recentAuthors: string[] = result.map(
    it => it.original_author?.display_name || it.shared_by || it.shared_by_device_id || 'unknown'
  ).slice(-3);

  const recentGroups: string[] = result.map(
    it => it.group_id || ''
  ).filter(Boolean).slice(-4);

  while (candidatePool.length > 0) {
    let pickIndex = 0;

    // Search for a candidate that satisfies author and group separation constraints
    for (let i = 0; i < Math.min(candidatePool.length, 12); i++) {
      const cand = candidatePool[i];
      const candAuthor = cand.original_author?.display_name || cand.shared_by || cand.shared_by_device_id || 'unknown';
      const candGroup = cand.group_id;

      const violatesAuthor = recentAuthors.length > 0 && recentAuthors[recentAuthors.length - 1] === candAuthor;
      const violatesGroup = candGroup && recentGroups.includes(candGroup);

      if (!violatesAuthor && !violatesGroup) {
        pickIndex = i;
        break;
      }
      if (!violatesAuthor && pickIndex === 0) {
        pickIndex = i;
      }
    }

    const [picked] = candidatePool.splice(pickIndex, 1);
    const author = picked.original_author?.display_name || picked.shared_by || picked.shared_by_device_id || 'unknown';
    recentAuthors.push(author);
    if (recentAuthors.length > 3) recentAuthors.shift();

    if (picked.group_id) {
      recentGroups.push(picked.group_id);
      if (recentGroups.length > 4) recentGroups.shift();
    }

    result.push(picked);
  }

  return result;
}
