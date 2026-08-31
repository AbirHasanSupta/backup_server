import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  PanResponder,
  Alert,
  StatusBar,
  ScrollView,
  AppState,
  RefreshControl,
  BackHandler,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';

import { AppColors, Spacing, Radius, TextScale, BottomTabInset } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import { hapticLight, hapticMedium, hapticSelection, hapticSuccess, hapticError } from '@/utils/haptics';
import { ShareModal } from '@/components/ShareModal';
import {
  getRecentMemories,
  getConfig,
  buildPreviewUrl,
  buildVideoPreviewUrl,
  buildThumbnailUrl,
  downloadFile,
  downloadSharedFile,
  getRandomFlashback,
  generateRewindReel,
  getRewindReelStatus,
  buildRewindReelStreamUrl,
  downloadRewindReel,
  createDeviceShare,
} from '../../downloader';
import { consumePendingFlashbackItem } from '../../notificationService';

const DAY_CARD_W = 132;
const DAY_CARD_H = 208;
const DAY_CARD_GAP = 14;


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

interface StoryItem extends MemoryItem {
  year: number;
  years_ago: number;
}

interface YearGroup {
  year: number;
  years_ago: number;
  items: MemoryItem[];
}

interface DayMemory {
  date: { month: number; day: number; year: number };
  days_ago: number;
  is_today: boolean;
  groups: YearGroup[];
}

interface MemoriesResponse {
  days: DayMemory[];
}

interface ServerConfig {
  ip: string;
  port: string;
  key: string;
  deviceId: string;
}

interface FlashbackItem extends MemoryItem {
  year: number;
  years_ago: number;
}

type RewindStatus = 'idle' | 'checking' | 'generating' | 'ready' | 'none' | 'error';
const REWIND_POLL_MAX_ATTEMPTS = 45;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function dayItemCount(day: DayMemory): number {
  return day.groups.reduce((sum, g) => sum + g.items.length, 0);
}

/**
 * Format a Unix epoch timestamp into a human-readable date string.
 * Returns something like "Aug 14, 2022 · 3:41 PM" when a valid timestamp
 * is provided, or an empty string when capture_time is null/undefined.
 */
function formatCaptureDate(captureTime: number | null | undefined): string {
  if (!captureTime) return '';
  try {
    const d = new Date(captureTime * 1000);
    const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${datePart} · ${timePart}`;
  } catch {
    return '';
  }
}

function flattenGroupItems(group: YearGroup): StoryItem[] {
  return group.items.map(it => ({ ...it, year: group.year, years_ago: group.years_ago }));
}

function flattenDayItems(day: DayMemory): StoryItem[] {
  const flat: StoryItem[] = [];
  for (const g of day.groups) {
    for (const it of g.items) {
      flat.push({ ...it, year: g.year, years_ago: g.years_ago });
    }
  }
  return flat;
}

function formatDayLabel(day: DayMemory): string {
  if (day.days_ago === 0) return 'Today';
  if (day.days_ago === 1) return 'Yesterday';
  const d = new Date(day.date.year, day.date.month - 1, day.date.day);
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

function formatDayDate(day: DayMemory): string {
  const d = new Date(day.date.year, day.date.month - 1, day.date.day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function MemoriesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MemoriesResponse | null>(null);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const serverConfigRef = useRef<ServerConfig | null>(null);

  // Story Viewer state
  const [activeDayIdx, setActiveDayIdx] = useState<number | null>(null);
  const [activeGroupIdx, setActiveGroupIdx] = useState<number | null>(null);
  const [activeItemIdx, setActiveItemIdx] = useState<number>(0);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [savingItem, setSavingItem] = useState<boolean>(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [shareItem, setShareItem] = useState<MemoryItem | null>(null);
  // When sharing a full memory card (multiple files), shareItems overrides shareItem
  const [shareItems, setShareItems] = useState<MemoryItem[]>([]);
  const [shareKind, setShareKind] = useState<string | null>(null);
  const [shareTitle, setShareTitle] = useState<string | null>(null);

  const photoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [progressRatio, setProgressRatio] = useState<number>(0);

  // Refs that mirror modal-open state so the BackHandler can read current
  // values without being listed as effect dependencies (which would cause
  // the effect to re-register on every open/close and run the cleanup
  // prematurely, instantly dismissing whatever just opened).
  const activeDayIdxRef = useRef<number | null>(null);
  const flashbackVisibleRef = useRef(false);
  const rewindVisibleRef = useRef(false);
  const rewindPickerVisibleRef = useRef(false);
  const stopAllPlaybackRef = useRef<() => void>(() => {});
  const closeFlashbackRef = useRef<() => void>(() => {});
  const closeRewindRef = useRef<() => void>(() => {});
  const routerRef = useRef(router);

  // Flashback state
  const params = useLocalSearchParams<{ flashback?: string; recap?: string; recapYear?: string; recapMonth?: string }>();
  const [flashbackVisible, setFlashbackVisible] = useState(false);
  const [flashbackLoading, setFlashbackLoading] = useState(false);
  const [flashbackHistory, setFlashbackHistory] = useState<FlashbackItem[]>([]);
  const [flashbackIndex, setFlashbackIndex] = useState<number>(0);
  const [flashbackError, setFlashbackError] = useState<string | null>(null);
  const [flashbackSaving, setFlashbackSaving] = useState(false);

  const flashbackItem = flashbackHistory[flashbackIndex] || null;

  // Rewind Reel state
  const [rewindVisible, setRewindVisible] = useState(false);
  const [rewindYear, setRewindYear] = useState<number | null>(null);
  const [rewindMonth, setRewindMonth] = useState<number | null>(null);
  const [rewindStatus, setRewindStatus] = useState<RewindStatus>('idle');
  const [rewindSaving, setRewindSaving] = useState(false);
  const [rewindSharing, setRewindSharing] = useState(false);
  const rewindPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Rewind & Recap Picker state
  const [rewindPickerVisible, setRewindPickerVisible] = useState(false);
  const [pickerType, setPickerType] = useState<'monthly' | 'yearly'>('monthly');
  const initialDate = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() - 1, 1);
  }, []);
  const [pickerYear, setPickerYear] = useState(initialDate.getFullYear());
  const [pickerMonth, setPickerMonth] = useState(initialDate.getMonth() + 1);

  const openRewindPicker = useCallback((type?: 'monthly' | 'yearly', year?: number, month?: number) => {
    hapticMedium();
    const d = new Date();
    const prevMonthDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    setPickerType(type || 'monthly');
    setPickerYear(year ?? (type === 'yearly' ? d.getFullYear() - 1 : prevMonthDate.getFullYear()));
    setPickerMonth(month ?? (prevMonthDate.getMonth() + 1));
    setRewindPickerVisible(true);
  }, []);

  const fetchMemories = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [cfg, res] = await Promise.all([getConfig(), getRecentMemories(7)]);
      setServerConfig(cfg);
      setData(res);
      setError(null);
    } catch (err: any) {
      if (!opts?.silent) {
        setError(sanitizeErrorMessage(err, 'Could not load your memories right now.'));
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchMemories({ silent: true });
    } finally {
      setRefreshing(false);
    }
  }, [fetchMemories]);

  useEffect(() => {
    let active = true;
    Promise.all([getConfig(), getRecentMemories(7)])
      .then(([cfg, res]) => {
        if (active) {
          setServerConfig(cfg);
          setData(res);
          setLoading(false);
        }
      })
      .catch((err: any) => {
        if (active) {
          setError(sanitizeErrorMessage(err, 'Could not load your memories right now.'));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const todayDay = data?.days && data.days.length > 0 ? data.days[0] : null;
  const historyDaysAll = data?.days && data.days.length > 1 ? data.days.slice(1) : [];
  const historyDays = historyDaysAll.filter(day => dayItemCount(day) > 0);
  const totalItemsAcrossAllDays = data?.days ? data.days.reduce((sum, d) => sum + dayItemCount(d), 0) : 0;

  const activeDay = activeDayIdx !== null && data?.days ? data.days[activeDayIdx] : null;
  const activeItems = useMemo<StoryItem[]>(() => {
    if (!activeDay) return [];
    if (activeGroupIdx !== null && activeDay.groups[activeGroupIdx]) {
      return flattenGroupItems(activeDay.groups[activeGroupIdx]);
    }
    return flattenDayItems(activeDay);
  }, [activeDay, activeGroupIdx]);
  const currentItem = activeItems[activeItemIdx] ?? null;

  const openDayStory = useCallback((dayIdx: number, startOffset: number = 0) => {
    hapticMedium();
    setActiveDayIdx(dayIdx);
    setActiveGroupIdx(null);
    setActiveItemIdx(startOffset);
    setProgressRatio(0);
    setIsPaused(false);
  }, []);

  const openYearGroupStory = useCallback(
    (dayIdx: number, groupIdx: number) => {
      hapticMedium();
      setActiveDayIdx(dayIdx);
      setActiveGroupIdx(groupIdx);
      setActiveItemIdx(0);
      setProgressRatio(0);
      setIsPaused(false);
    },
    [],
  );

  const advanceItem = useCallback(() => {
    if (activeItemIdx < activeItems.length - 1) {
      setActiveItemIdx(idx => idx + 1);
      setProgressRatio(0);
    } else {
      setActiveDayIdx(null);
      setActiveGroupIdx(null);
      setActiveItemIdx(0);
    }
  }, [activeItemIdx, activeItems.length]);

  const prevItem = useCallback(() => {
    if (activeItemIdx > 0) {
      setActiveItemIdx(idx => idx - 1);
      setProgressRatio(0);
    }
  }, [activeItemIdx]);

  useEffect(() => {
    if (activeDayIdx === null || !currentItem || isPaused || shareVisible) {
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
  }, [activeDayIdx, activeItemIdx, currentItem, isPaused, shareVisible, advanceItem]);

  const openFlashback = useCallback(async (prefetched?: FlashbackItem | null) => {
    setFlashbackVisible(true);
    setFlashbackLoading(true);
    setFlashbackError(null);
    try {
      if (!serverConfigRef.current) {
        const cfg = await getConfig();
        setServerConfig(cfg);
        serverConfigRef.current = cfg;
      }
      const pending = prefetched || consumePendingFlashbackItem();
      if (pending?.relative_path) {
        const item = pending as FlashbackItem;
        setFlashbackHistory([item]);
        setFlashbackIndex(0);
        return;
      }
      const item = await getRandomFlashback();
      if (item) {
        setFlashbackHistory([item]);
        setFlashbackIndex(0);
      } else {
        setFlashbackError('No flashback available yet — keep backing up!');
      }
    } catch (err: any) {
      setFlashbackError(sanitizeErrorMessage(err, 'Could not load a flashback right now.'));
    } finally {
      setFlashbackLoading(false);
    }
  }, []);

  const handleNextSurprise = useCallback(async () => {
    if (flashbackLoading) return;
    hapticLight();
    if (flashbackIndex < flashbackHistory.length - 1) {
      setFlashbackIndex((idx) => idx + 1);
      return;
    }
    setFlashbackLoading(true);
    setFlashbackError(null);
    try {
      const item = await getRandomFlashback();
      if (item) {
        setFlashbackHistory((prev) => [...prev, item]);
        setFlashbackIndex((idx) => idx + 1);
      } else {
        setFlashbackError('No more surprise memories available right now.');
      }
    } catch (err: any) {
      setFlashbackError(sanitizeErrorMessage(err, 'Could not load next surprise.'));
    } finally {
      setFlashbackLoading(false);
    }
  }, [flashbackLoading, flashbackIndex, flashbackHistory.length]);

  const handlePrevSurprise = useCallback(() => {
    if (flashbackLoading) return;
    if (flashbackIndex > 0) {
      hapticLight();
      setFlashbackIndex((idx) => idx - 1);
    }
  }, [flashbackLoading, flashbackIndex]);

  const closeFlashback = useCallback(() => {
    setFlashbackVisible(false);
    setFlashbackHistory([]);
    setFlashbackIndex(0);
    setFlashbackError(null);
  }, []);

  const clearRewindPoll = useCallback(() => {
    if (rewindPollRef.current) {
      clearInterval(rewindPollRef.current);
      rewindPollRef.current = null;
    }
  }, []);

  const openRewind = useCallback(async (year: number, month?: number) => {
    setRewindVisible(true);
    setRewindYear(year);
    setRewindMonth(month ?? null);
    setRewindStatus('checking');
    if (!serverConfigRef.current) {
      try {
        const cfg = await getConfig();
        setServerConfig(cfg);
        serverConfigRef.current = cfg;
      } catch {}
    }
    try {
      let status = await getRewindReelStatus(year, month);
      if (status.ready) {
        setRewindStatus('ready');
        return;
      }
      if (status.status === 'none') {
        setRewindStatus('none');
        return;
      }
      // Start (or restart after a prior failure) unless already generating.
      if (status.status !== 'generating') {
        const started = await generateRewindReel(year, month);
        if (started?.status === 'none') {
          setRewindStatus('none');
          return;
        }
        if (started?.status === 'ready') {
          setRewindStatus('ready');
          return;
        }
      }
      setRewindStatus('generating');
      clearRewindPoll();
      let attempts = 0;
      rewindPollRef.current = setInterval(async () => {
        attempts += 1;
        try {
          const poll = await getRewindReelStatus(year, month);
          if (poll.ready) {
            setRewindStatus('ready');
            clearRewindPoll();
          } else if (poll.status === 'none') {
            setRewindStatus('none');
            clearRewindPoll();
          } else if (poll.status === 'failed') {
            setRewindStatus('error');
            clearRewindPoll();
          } else if (attempts >= REWIND_POLL_MAX_ATTEMPTS) {
            setRewindStatus('error');
            clearRewindPoll();
          }
          // Keep polling for generating / not_generated — job may still be starting.
        } catch {
          if (attempts >= REWIND_POLL_MAX_ATTEMPTS) {
            setRewindStatus('error');
            clearRewindPoll();
          }
        }
      }, 2000);
    } catch {
      setRewindStatus('error');
    }
  }, [clearRewindPoll]);

  const closeRewind = useCallback(() => {
    clearRewindPoll();
    setRewindVisible(false);
    setRewindYear(null);
    setRewindMonth(null);
    setRewindStatus('idle');
  }, [clearRewindPoll]);

  useEffect(() => () => clearRewindPoll(), [clearRewindPoll]);

  const handledFlashbackParamRef = useRef(false);
  useEffect(() => {
    if (params.flashback === '1' && !handledFlashbackParamRef.current) {
      handledFlashbackParamRef.current = true;
      queueMicrotask(() => {
        openFlashback();
      });
    }
  }, [params.flashback, openFlashback]);

  const handledRecapParamRef = useRef<string | null>(null);
  useEffect(() => {
    if (params.recap === '1' && params.recapYear) {
      const paramKey = `${params.recapYear}-${params.recapMonth ?? ''}`;
      if (handledRecapParamRef.current !== paramKey) {
        handledRecapParamRef.current = paramKey;
        const year = Number(params.recapYear);
        const month = params.recapMonth ? Number(params.recapMonth) : undefined;
        if (Number.isFinite(year)) {
          queueMicrotask(() => {
            openRewind(year, month);
          });
        }
      }
    }
  }, [params.recap, params.recapYear, params.recapMonth, openRewind]);

  const handleSaveFlashback = async () => {
    if (!flashbackItem || flashbackSaving) return;
    setFlashbackSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Storage permission is required to save photos.');
        return;
      }

      const cacheDir = FileSystem.cacheDirectory ?? '';
      const displayName = flashbackItem.relative_path.split(/[/\\\\]/).pop() ?? `flashback_${Date.now()}`;
      const safeName = displayName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmpUri = `${cacheDir}flashback_save_${Date.now()}_${safeName}`;

      if (flashbackItem.source_type === 'shared') {
        await downloadSharedFile(flashbackItem.source_id, flashbackItem.relative_path, tmpUri);
      } else {
        await downloadFile(flashbackItem.relative_path, tmpUri);
      }

      await MediaLibrary.saveToLibraryAsync(tmpUri);
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      hapticSuccess();
      Alert.alert('Saved', 'Photo/Video saved to your gallery!');
    } catch (err: any) {
      hapticError();
      Alert.alert('Save Failed', sanitizeErrorMessage(err, 'Could not save file to device.'));
    } finally {
      setFlashbackSaving(false);
    }
  };

  // Stop any story/flashback/rewind video and dismiss their modals so audio
  // never keeps playing behind another tab (e.g. navigating to Guess the
  // Year or Roulette) or behind the OS when the app is backgrounded.
  const stopAllPlayback = useCallback(() => {
    clearRewindPoll();
    setActiveDayIdx(null);
    setActiveGroupIdx(null);
    setActiveItemIdx(0);
    setIsPaused(false);
    setFlashbackVisible(false);
    setFlashbackHistory([]);
    setFlashbackIndex(0);
    setFlashbackError(null);
    setRewindVisible(false);
    setRewindYear(null);
    setRewindMonth(null);
    setRewindStatus('idle');
    setRewindPickerVisible(false);
  }, [clearRewindPoll]);

  // Keep all mutable refs in sync with React state and callbacks outside of render.
  useEffect(() => {
    activeDayIdxRef.current = activeDayIdx;
    flashbackVisibleRef.current = flashbackVisible;
    rewindVisibleRef.current = rewindVisible;
    rewindPickerVisibleRef.current = rewindPickerVisible;
    serverConfigRef.current = serverConfig;
    stopAllPlaybackRef.current = stopAllPlayback;
    closeFlashbackRef.current = closeFlashback;
    closeRewindRef.current = closeRewind;
    routerRef.current = router;
  }, [
    activeDayIdx,
    flashbackVisible,
    rewindVisible,
    rewindPickerVisible,
    serverConfig,
    stopAllPlayback,
    closeFlashback,
    closeRewind,
    router,
  ]);

  // Simple focus-blur guard: stop all playback when the screen loses focus
  // (e.g. navigating to Roulette, Quiz, etc.). Kept dependency-free so it
  // does NOT re-register — and does NOT fire its cleanup — every time a modal
  // opens or closes (which would instantly dismiss the just-opened modal).
  useFocusEffect(
    useCallback(() => {
      return () => {
        stopAllPlaybackRef.current();
      };
    }, []),
  );

  // Hardware back-button: dismiss modals in order of priority.
  // Reads modal state via refs so this effect NEVER needs to re-register
  // (empty dep array). Without refs the handler would be stale, and with
  // state deps it would re-register on every open/close — both broken.
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (rewindPickerVisibleRef.current) {
          setRewindPickerVisible(false);
          return true;
        }
        if (flashbackVisibleRef.current) {
          closeFlashbackRef.current();
          return true;
        }
        if (rewindVisibleRef.current) {
          closeRewindRef.current();
          return true;
        }
        if (activeDayIdxRef.current !== null) {
          setActiveDayIdx(null);
          setActiveGroupIdx(null);
          return true;
        }
        if (routerRef.current.canGoBack()) {
          routerRef.current.back();
        } else {
          routerRef.current.replace('/');
        }
        return true;
      };

      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => sub.remove();
    }, []),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        stopAllPlayback();
      }
    });
    return () => sub.remove();
  }, [stopAllPlayback]);

  const handleSaveRewind = async () => {
    if (!rewindYear || rewindSaving) return;
    setRewindSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Needed', 'Media library permission is required to save videos.');
        setRewindSaving(false);
        return;
      }
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}rewind_${rewindYear}_${rewindMonth || 'y'}_${Date.now()}.mp4`;
      await downloadRewindReel(rewindYear, rewindMonth ?? undefined, tmpUri);
      await MediaLibrary.saveToLibraryAsync(tmpUri);
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      hapticSuccess();
      Alert.alert('Saved', 'Rewind Reel saved to your gallery!');
    } catch (err: any) {
      hapticError();
      Alert.alert('Save Failed', sanitizeErrorMessage(err, 'Could not save the reel to device.'));
    } finally {
      setRewindSaving(false);
    }
  };

  const handleShareRewind = async () => {
    if (!rewindYear || rewindSharing) return;
    setRewindSharing(true);
    try {
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}recap_${rewindYear}_${rewindMonth || 'y'}_${Date.now()}.mp4`;
      await downloadRewindReel(rewindYear, rewindMonth ?? undefined, tmpUri);
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Sharing Unavailable', 'Sharing is not available on this device.');
        return;
      }
      await Sharing.shareAsync(tmpUri, {
        mimeType: 'video/mp4',
        dialogTitle: `Share Recap (${rewindMonth ? MONTH_NAMES[rewindMonth - 1] + ' ' : ''}${rewindYear})`,
      });
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
    } catch (err: any) {
      hapticError();
      Alert.alert('Share Failed', sanitizeErrorMessage(err, 'Could not share the reel.'));
    } finally {
      setRewindSharing(false);
    }
  };

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
      hapticSuccess();
      Alert.alert('Saved', 'Photo/Video saved to your gallery!');
    } catch (err: any) {
      hapticError();
      Alert.alert('Save Failed', sanitizeErrorMessage(err, 'Could not save file to device.'));
    } finally {
      setSavingItem(false);
    }
  };

  const handleShareSubmit = useCallback(async (targetIds: string[], caption: string) => {
    if (targetIds.length === 0) return;
    // Use all items if sharing a full memory card; fall back to single shareItem
    const itemsToShare = shareItems.length > 0 ? shareItems : (shareItem ? [shareItem] : []);
    if (itemsToShare.length === 0) return;
    const items = itemsToShare.map(i => ({
      source_type: i.source_type,
      source_key: i.source_id,
      relative_path: i.relative_path,
      size: i.size || 0,
      modified_time: i.capture_time || 0,
    }));
    try {
      await createDeviceShare(targetIds, caption, items, { postKind: shareKind, postTitle: shareTitle });
      hapticSuccess();
      setShareVisible(false);
      setShareItem(null);
      setShareItems([]);
      setShareKind(null);
      setShareTitle(null);
    } catch (err: any) {
      hapticError();
      Alert.alert('Share Failed', sanitizeErrorMessage(err, 'Could not share to feed.'));
    }
  }, [shareItem, shareItems, shareKind, shareTitle]);

  // PanResponder for swipe gestures in flashback:
  // Swipe right (dx > 50) -> next surprise
  // Swipe left (dx < -50) -> previous surprise
  // Swipe down (dy > 50) -> dismiss flashback modal
  const flashbackPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          (Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy)) ||
          (g.dy > 30 && Math.abs(g.dy) > Math.abs(g.dx)),
        onPanResponderRelease: (_, g) => {
          if (g.dy > 50 && Math.abs(g.dy) > Math.abs(g.dx)) {
            hapticMedium();
            closeFlashback();
          } else if (g.dx > 50 && Math.abs(g.dx) > Math.abs(g.dy) && !flashbackLoading) {
            handleNextSurprise();
          } else if (g.dx < -50 && Math.abs(g.dx) > Math.abs(g.dy) && !flashbackLoading) {
            handlePrevSurprise();
          }
        },
      }),
    [flashbackLoading, handleNextSurprise, handlePrevSurprise, closeFlashback],
  );

  // PanResponder for swipe down to dismiss story
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dy > 30 && Math.abs(gestureState.dx) < 40,
        onPanResponderRelease: (_, gestureState) => {
          if (gestureState.dy > 50) {
            hapticMedium();
            setActiveDayIdx(null);
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

  // Image components cannot render video streams — prefer a displayable photo cover,
  // otherwise fall back to a server-generated static poster frame for a video cover.
  const getCoverUrl = (items: MemoryItem[]) => {
    if (!serverConfig || !items?.length) return '';
    const photo = items.find(i => !i.is_video && /\.(jpe?g|png|webp|gif|bmp)$/i.test(i.relative_path));
    if (photo) return buildPreviewUrl(serverConfig, photo.relative_path, photo.source_type, photo.source_id);
    const video = items.find(i => i.is_video);
    if (video) return buildThumbnailUrl(serverConfig, video.relative_path, video.source_type, video.source_id);
    return '';
  };

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
        <View style={styles.headerActionsRow}>
          <TouchableOpacity style={styles.surpriseBtn} onPress={() => { hapticLight(); openFlashback(); }}>
            <AppIcon androidName="shuffle" iosName="shuffle" color={colors.primary} size={18} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.surpriseBtn} onPress={() => router.push('/wrapped')}>
            <AppIcon androidName="insights" iosName="chart.bar.fill" color={colors.primary} size={18} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.refreshBtn} onPress={() => fetchMemories()} disabled={loading}>
            <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.primary} size={20} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Body Content */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Finding your memories…</Text>
        </View>
      ) : error ? (
        <ScrollView
          contentContainerStyle={[styles.centered, { flexGrow: 1 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        >
          <AppIcon androidName="cloud_off" iosName="wifi.slash" color={colors.error} size={48} />
          <Text style={styles.errorText}>Server Unreachable</Text>
          <Text style={styles.errorSubtext}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => fetchMemories()}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : !data || !data.days || data.days.length === 0 || totalItemsAcrossAllDays === 0 ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        >
          <View style={styles.gamesRow}>
            <TouchableOpacity style={styles.gameCard} onPress={() => router.push('/roulette')} activeOpacity={0.85}>
              <View style={[styles.gameIconWrap, { backgroundColor: '#F59E0B22' }]}>
                <AppIcon androidName="casino" iosName="die.face.5.fill" color="#F59E0B" size={20} />
              </View>
              <Text style={styles.gameCardText}>Photo Roulette</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.gameCard} onPress={() => router.push('/quiz')} activeOpacity={0.85}>
              <View style={[styles.gameIconWrap, { backgroundColor: '#8B5CF622' }]}>
                <AppIcon androidName="psychology" iosName="brain" color="#8B5CF6" size={20} />
              </View>
              <Text style={styles.gameCardText}>Guess the Year</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.gameCard}
              onPress={() => openRewindPicker()}
              activeOpacity={0.85}
            >
              <View style={[styles.gameIconWrap, { backgroundColor: '#06B6D422' }]}>
                <AppIcon androidName="movie" iosName="film" color="#06B6D4" size={20} />
              </View>
              <Text style={styles.gameCardText}>Rewind Reel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.gameCard} onPress={() => router.push('/places')} activeOpacity={0.85}>
              <View style={[styles.gameIconWrap, { backgroundColor: '#10B98122' }]}>
                <AppIcon androidName="place" iosName="mappin.and.ellipse" color="#10B981" size={20} />
              </View>
              <Text style={styles.gameCardText}>Places</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.centeredEmpty}>
            <View style={styles.emptyIconBg}>
              <AppIcon androidName="auto_awesome" iosName="sparkles" color={colors.primary} size={40} />
            </View>
            <Text style={styles.emptyTitle}>No Memories Yet</Text>
            <Text style={styles.emptySubtitle}>Check back over the next few days to relive photos and videos from past years — or try Roulette, Guess the Year, Rewind, and Places above.</Text>
          </View>
        </ScrollView>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        >
          {/* Games Shelf */}
          <View style={styles.gamesRow}>
            <TouchableOpacity style={styles.gameCard} onPress={() => router.push('/roulette')} activeOpacity={0.85}>
              <View style={[styles.gameIconWrap, { backgroundColor: '#F59E0B22' }]}>
                <AppIcon androidName="casino" iosName="die.face.5.fill" color="#F59E0B" size={20} />
              </View>
              <Text style={styles.gameCardText}>Photo Roulette</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.gameCard} onPress={() => router.push('/quiz')} activeOpacity={0.85}>
              <View style={[styles.gameIconWrap, { backgroundColor: '#8B5CF622' }]}>
                <AppIcon androidName="psychology" iosName="brain" color="#8B5CF6" size={20} />
              </View>
              <Text style={styles.gameCardText}>Guess the Year</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.gameCard}
              onPress={() => openRewindPicker()}
              activeOpacity={0.85}
            >
              <View style={[styles.gameIconWrap, { backgroundColor: '#06B6D422' }]}>
                <AppIcon androidName="movie" iosName="film" color="#06B6D4" size={20} />
              </View>
              <Text style={styles.gameCardText}>Rewind Reel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.gameCard} onPress={() => router.push('/places')} activeOpacity={0.85}>
              <View style={[styles.gameIconWrap, { backgroundColor: '#10B98122' }]}>
                <AppIcon androidName="place" iosName="mappin.and.ellipse" color="#10B981" size={20} />
              </View>
              <Text style={styles.gameCardText}>Places</Text>
            </TouchableOpacity>
          </View>

          {/* Today Section — highlighted and featured at the top */}
          <View style={styles.sectionHeaderRow}>
            <View style={styles.todayBadge}>
              <AppIcon androidName="auto_awesome" iosName="sparkles" color={colors.primary} size={14} />
              <Text style={styles.todayBadgeText}>TODAY</Text>
            </View>
            <Text style={styles.sectionSubtitle}>{todayDateStr}</Text>
          </View>

          {!todayDay || todayDay.groups.length === 0 ? (
            <View style={styles.todayEmptyCard}>
              <AppIcon androidName="auto_awesome" iosName="sparkles" color={colors.textMuted} size={22} />
              <Text style={styles.todayEmptyText}>No memories from past years today</Text>
            </View>
          ) : (
            <View style={styles.cardList}>
              {todayDay.groups.map((group, groupIndex) => {
                const coverUrl = getCoverUrl(group.items);
                const photoCount = group.items.filter(i => !i.is_video).length;
                const videoCount = group.items.filter(i => i.is_video).length;
                const countsStr = [
                  photoCount > 0 ? `${photoCount} photo${photoCount > 1 ? 's' : ''}` : null,
                  videoCount > 0 ? `${videoCount} video${videoCount > 1 ? 's' : ''}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ');

                return (
                  <View key={group.year} style={styles.featuredCardContainer}>
                    <AnimatedPressable
                      style={StyleSheet.absoluteFill}
                      onPress={() => openYearGroupStory(0, groupIndex)}
                      scaleDown={0.97}
                    >
                      <View style={[styles.stackLayer, styles.stackLayerBack]} />
                      <View style={[styles.stackLayer, styles.stackLayerMiddle]} />

                      <View style={styles.featuredCardMain}>
                        {coverUrl ? (
                          <Image source={{ uri: coverUrl }} style={styles.cardImage} contentFit="cover" transition={200} />
                        ) : (
                          <View style={styles.cardImagePlaceholder}>
                            <AppIcon androidName="videocam" iosName="video.fill" color="rgba(255,255,255,0.55)" size={36} />
                          </View>
                        )}

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

                    {group.items.length > 0 && (
                      <TouchableOpacity
                        style={styles.rewindBtn}
                        onPress={() => {
                          hapticLight();
                          setShareItems(group.items);
                          setShareItem(null);
                          setShareKind('memory');
                          setShareTitle(`${group.years_ago} ${group.years_ago === 1 ? 'Year' : 'Years'} Ago · ${group.year}`);
                          setShareVisible(true);
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={14} />
                        <Text style={styles.rewindBtnText}>Share</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {/* History Section — Snapchat-style swipeable day cards */}
          {historyDays.length > 0 && (
            <>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Past Days</Text>
                <Text style={styles.sectionSubtitle}>Swipe to explore</Text>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                snapToInterval={DAY_CARD_W + DAY_CARD_GAP}
                decelerationRate="fast"
                contentContainerStyle={styles.historyRow}
              >
                {historyDays.map(day => {
                  const dayIdx = historyDaysAll.indexOf(day) + 1;
                  const count = dayItemCount(day);
                  const coverItems = day.groups.flatMap(g => g.items);
                  const coverUrl = getCoverUrl(coverItems);

                  return (
                    <View key={`${day.date.month}-${day.date.day}-${day.date.year}`} style={styles.dayCardContainer}>
                      <AnimatedPressable
                        style={StyleSheet.absoluteFill}
                        onPress={() => openDayStory(dayIdx, 0)}
                        scaleDown={0.95}
                      >
                        <View style={styles.dayCardMain}>
                          {coverUrl ? (
                            <Image source={{ uri: coverUrl }} style={styles.cardImage} contentFit="cover" transition={200} />
                          ) : (
                            <View style={styles.dayCardEmptyIconWrap}>
                              <AppIcon androidName="videocam" iosName="video.fill" color={colors.textMuted} size={22} />
                            </View>
                          )}

                          <View style={styles.dayCardGradientOverlay}>
                            <View style={styles.dayCardCountBadge}>
                              <Text style={styles.dayCardCountBadgeText}>{count}</Text>
                            </View>
                            <View>
                              <Text style={styles.dayCardLabel}>{formatDayLabel(day)}</Text>
                              <Text style={styles.dayCardDate}>{formatDayDate(day)}</Text>
                            </View>
                          </View>
                        </View>
                      </AnimatedPressable>
                      {coverItems.length > 0 && (
                        <TouchableOpacity
                          style={styles.dayCardShareBtn}
                          onPress={() => {
                            hapticLight();
                            setShareItems(coverItems);
                            setShareItem(null);
                            setShareKind('memory');
                            setShareTitle(formatDayLabel(day));
                            setShareVisible(true);
                          }}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={15} />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            </>
          )}
        </ScrollView>
      )}

      {/* Full-Screen Story Viewer Modal */}
      {activeDay && currentItem && (
        <Modal
          visible={activeDayIdx !== null}
          transparent={false}
          animationType="fade"
          onRequestClose={() => { setActiveDayIdx(null); setActiveGroupIdx(null); }}
        >
          <View style={styles.storyContainer} {...panResponder.panHandlers}>
            <StatusBar barStyle="light-content" />

            {/* Story Media Display */}
            {currentItem.is_video ? (
              <StoryVideoPlayer
                uri={getMediaUrl(currentItem)}
                isPaused={isPaused || shareVisible}
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
              <Pressable
                style={styles.touchLeft}
                onPress={() => {
                  hapticSelection();
                  prevItem();
                }}
              />
              <Pressable
                style={styles.touchCenter}
                onPressIn={() => setIsPaused(true)}
                onPressOut={() => setIsPaused(false)}
              />
              <Pressable
                style={styles.touchRight}
                onPress={() => {
                  hapticSelection();
                  advanceItem();
                }}
              />
            </View>

            {/* Top Bar: Progress Segments + Close Button */}
            <View style={[styles.storyTopBar, { paddingTop: Math.max(insets.top, 16) }]}>
              <View style={styles.segmentContainer}>
                {activeItems.map((it, idx) => {
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
                  {!activeDay.is_today && (
                    <View style={styles.storyDayPill}>
                      <Text style={styles.storyDayPillText}>{formatDayLabel(activeDay)}</Text>
                    </View>
                  )}
                  <Text style={styles.storyYearTitle}>
                    {currentItem.years_ago} {currentItem.years_ago === 1 ? 'Year' : 'Years'} Ago ({currentItem.year})
                  </Text>
                  {currentItem.capture_time ? (
                    <Text style={styles.storyCaptureDate}>{formatCaptureDate(currentItem.capture_time)}</Text>
                  ) : null}
                  <Text style={styles.storySourceSub}>{currentItem.source_label}</Text>
                </View>
                <TouchableOpacity
                  style={styles.closeBtn}
                  onPress={() => {
                    hapticLight();
                    setActiveDayIdx(null);
                    setActiveGroupIdx(null);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Bottom Action Row: Share / Save to Device */}
            <View style={[styles.storyBottomBar, { paddingBottom: Math.max(insets.bottom, 20) }]}>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={() => { setShareItem(currentItem); setShareItems([]); setShareKind('memory'); setShareTitle(activeDay ? formatDayLabel(activeDay) : 'A memory'); setShareVisible(true); }}
              >
                <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={20} />
                <Text style={styles.saveBtnText}>Share</Text>
              </TouchableOpacity>
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

      {/* Flashback Modal — surprise single-item viewer, separate from the day/year story flow */}
      <Modal
        visible={flashbackVisible}
        transparent={false}
        animationType="fade"
        onRequestClose={closeFlashback}
      >
        <View style={styles.storyContainer} {...flashbackPanResponder.panHandlers}>
          <StatusBar barStyle="light-content" />

          {flashbackLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={[styles.loadingText, { color: '#fff' }]}>Finding a surprise memory…</Text>
              <TouchableOpacity style={[styles.closeBtn, { marginTop: Spacing.six }]} onPress={closeFlashback}>
                <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
              </TouchableOpacity>
            </View>
          ) : flashbackError || !flashbackItem ? (
            <View style={styles.centered}>
              <AppIcon androidName="auto_awesome" iosName="sparkles" color="#fff" size={40} />
              <Text style={[styles.errorSubtext, { color: '#fff', marginTop: Spacing.three }]}>
                {flashbackError || 'No flashback available yet.'}
              </Text>
              <TouchableOpacity style={[styles.closeBtn, { marginTop: Spacing.six }]} onPress={closeFlashback}>
                <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {flashbackItem.is_video ? (
                <StoryVideoPlayer
                  uri={getMediaUrl(flashbackItem)}
                  isPaused={false}
                  onEnded={() => {}}
                  onProgressRatio={() => {}}
                  styles={styles}
                />
              ) : (
                <Image
                  source={{ uri: getMediaUrl(flashbackItem) }}
                  style={styles.storyMedia}
                  contentFit="contain"
                />
              )}

              <View style={[styles.storyTopBar, { paddingTop: Math.max(insets.top, 16) }]}>
                <View style={styles.storyHeaderRow}>
                  <View style={styles.storyHeaderInfo}>
                    <View style={styles.storyDayPill}>
                      <Text style={styles.storyDayPillText}>
                        {flashbackHistory.length > 1
                          ? `FLASHBACK ${flashbackIndex + 1}/${flashbackHistory.length}`
                          : 'FLASHBACK'}
                      </Text>
                    </View>
                    <Text style={styles.storyYearTitle}>
                      {flashbackItem.years_ago} {flashbackItem.years_ago === 1 ? 'Year' : 'Years'} Ago ({flashbackItem.year})
                    </Text>
                    {(() => {
                      const dateStr = formatCaptureDate(flashbackItem.capture_time);
                      return dateStr ? <Text style={styles.storyCaptureDate}>{dateStr}</Text> : null;
                    })()}
                    <Text style={styles.storySourceSub}>{flashbackItem.source_label}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.closeBtn}
                    onPress={() => {
                      hapticLight();
                      closeFlashback();
                    }}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  >
                    <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={[styles.storyBottomBar, { paddingBottom: Math.max(insets.bottom, 20) }]}>
                {flashbackIndex > 0 && (
                  <TouchableOpacity
                    style={styles.flashbackIconBtn}
                    onPress={handlePrevSurprise}
                    disabled={flashbackLoading}
                    activeOpacity={0.8}
                    accessibilityLabel="Previous"
                  >
                    <AppIcon androidName="arrow_back" iosName="arrow.left" color="#fff" size={20} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={styles.flashbackIconBtn}
                  onPress={handleNextSurprise}
                  disabled={flashbackLoading}
                  activeOpacity={0.8}
                  accessibilityLabel="Next surprise"
                >
                  <AppIcon androidName="shuffle" iosName="shuffle" color="#fff" size={20} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.flashbackIconBtn}
                  onPress={() => { setShareItem(flashbackItem); setShareItems([]); setShareKind('flashback'); setShareTitle(flashbackItem?.capture_time ? formatCaptureDate(flashbackItem.capture_time) : 'A flashback'); setShareVisible(true); }}
                  accessibilityLabel="Share to feed"
                >
                  <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={20} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.flashbackIconBtn}
                  onPress={handleSaveFlashback}
                  disabled={flashbackSaving}
                  accessibilityLabel="Save to device"
                >
                  {flashbackSaving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={20} />
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* Rewind Reel Modal — server-generated year slideshow video */}
      <Modal
        visible={rewindVisible}
        transparent={false}
        animationType="fade"
        onRequestClose={closeRewind}
      >
        <View style={styles.storyContainer}>
          <StatusBar barStyle="light-content" />

          {rewindStatus === 'ready' && serverConfig && rewindYear ? (
            <RewindVideoPlayer
              uri={buildRewindReelStreamUrl(serverConfig, rewindYear, rewindMonth ?? undefined)}
              styles={styles}
            />
          ) : (
            <View style={styles.centered}>
              {(rewindStatus === 'checking' || rewindStatus === 'generating') && (
                <>
                  <ActivityIndicator size="large" color="#fff" />
                  <Text style={[styles.loadingText, { color: '#fff' }]}>
                    {rewindStatus === 'checking' ? 'Checking your reel…' : 'Building your Rewind Reel…'}
                  </Text>
                </>
              )}
              {rewindStatus === 'none' && (
                <>
                  <AppIcon androidName="movie" iosName="film" color="#fff" size={40} />
                  <Text style={[styles.errorSubtext, { color: '#fff', marginTop: Spacing.three }]}>
                    Not enough photos from {rewindMonth ? `${MONTH_NAMES[rewindMonth - 1]} ` : ''}{rewindYear} yet to build a reel.
                  </Text>
                </>
              )}
              {rewindStatus === 'error' && (
                <>
                  <AppIcon androidName="cloud_off" iosName="wifi.slash" color="#fff" size={40} />
                  <Text style={[styles.errorSubtext, { color: '#fff', marginTop: Spacing.three }]}>
                    Could not build the reel right now.
                  </Text>
                  {rewindYear != null && (
                    <TouchableOpacity
                      style={[styles.retryBtn, { marginTop: Spacing.four }]}
                      onPress={() => openRewind(rewindYear, rewindMonth ?? undefined)}
                    >
                      <Text style={styles.retryBtnText}>Try Again</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          )}

          <View style={[styles.storyTopBar, { paddingTop: Math.max(insets.top, 16) }]}>
            <View style={styles.storyHeaderRow}>
              <View style={styles.storyHeaderInfo}>
                <View style={styles.storyDayPill}>
                  <Text style={styles.storyDayPillText}>{rewindMonth ? 'RECAP' : 'REWIND REEL'}</Text>
                </View>
                <Text style={styles.storyYearTitle}>
                  {rewindMonth ? `${MONTH_NAMES[rewindMonth - 1]} ${rewindYear}` : rewindYear}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={closeRewind}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
              </TouchableOpacity>
            </View>
          </View>

          {rewindStatus === 'ready' && (
            <View style={[styles.storyBottomBar, { paddingBottom: Math.max(insets.bottom, 20) }]}>
              <TouchableOpacity
                style={styles.saveBtnCompact}
                onPress={handleShareRewind}
                disabled={rewindSharing}
              >
                {rewindSharing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={18} />
                    <Text style={styles.saveBtnText}>Share</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveBtnCompact}
                onPress={() => {
                  if (!rewindYear) return;
                  setShareItems([]);
                  setShareItem({
                    source_type: 'rewind',
                    source_id: serverConfig?.deviceId || '',
                    source_label: rewindMonth ? `${MONTH_NAMES[rewindMonth - 1]} ${rewindYear} Recap` : `${rewindYear} Rewind Reel`,
                    relative_path: `${rewindYear}${rewindMonth ? '-' + rewindMonth : ''}`,
                    size: 0,
                    capture_time: null,
                    is_video: true,
                  });
                  setShareKind('rewind');
                  setShareTitle(rewindMonth ? `${MONTH_NAMES[rewindMonth - 1]} ${rewindYear} Recap` : `${rewindYear} Rewind Reel`);
                  setShareVisible(true);
                }}
              >
                <AppIcon androidName="post_add" iosName="square.and.arrow.up.on.square" color="#fff" size={18} />
                <Text style={styles.saveBtnText}>Feed</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveBtnCompact}
                onPress={handleSaveRewind}
                disabled={rewindSaving}
              >
                {rewindSaving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={18} />
                    <Text style={styles.saveBtnText}>Save</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* Rewind & Recap Selector Modal */}
      <Modal
        visible={rewindPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRewindPickerVisible(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={[styles.pickerCard, { backgroundColor: colors.surface }]}>
            <View style={styles.pickerHeader}>
              <Text style={[styles.pickerTitle, { color: colors.text }]}>Rewind & Recaps</Text>
              <TouchableOpacity
                style={styles.pickerCloseBtn}
                onPress={() => setRewindPickerVisible(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <AppIcon androidName="close" iosName="xmark" color={colors.textMuted} size={20} />
              </TouchableOpacity>
            </View>

            {/* Segmented Type Control */}
            <View style={[styles.pickerSegmentRow, { backgroundColor: colors.surfaceSoft }]}>
              <TouchableOpacity
                style={[
                  styles.pickerSegmentBtn,
                  pickerType === 'monthly' && [styles.pickerSegmentBtnActive, { backgroundColor: colors.primary }],
                ]}
                onPress={() => { hapticLight(); setPickerType('monthly'); }}
              >
                <AppIcon
                  androidName="calendar_month"
                  iosName="calendar"
                  color={pickerType === 'monthly' ? '#fff' : colors.textSecondary}
                  size={16}
                />
                <Text
                  style={[
                    styles.pickerSegmentText,
                    { color: pickerType === 'monthly' ? '#fff' : colors.textSecondary },
                  ]}
                >
                  Monthly Recap
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.pickerSegmentBtn,
                  pickerType === 'yearly' && [styles.pickerSegmentBtnActive, { backgroundColor: colors.primary }],
                ]}
                onPress={() => { hapticLight(); setPickerType('yearly'); }}
              >
                <AppIcon
                  androidName="movie"
                  iosName="film"
                  color={pickerType === 'yearly' ? '#fff' : colors.textSecondary}
                  size={16}
                />
                <Text
                  style={[
                    styles.pickerSegmentText,
                    { color: pickerType === 'yearly' ? '#fff' : colors.textSecondary },
                  ]}
                >
                  Yearly Rewind
                </Text>
              </TouchableOpacity>
            </View>

            {/* Year Stepper */}
            <View style={styles.pickerYearRow}>
              <TouchableOpacity
                style={[styles.pickerArrowBtn, { backgroundColor: colors.surfaceSoft }]}
                onPress={() => setPickerYear((y) => Math.max(2000, y - 1))}
                disabled={pickerYear <= 2000}
              >
                <AppIcon androidName="chevron_left" iosName="chevron.left" color={pickerYear <= 2000 ? colors.textMuted : colors.text} size={22} />
              </TouchableOpacity>
              <Text style={[styles.pickerYearText, { color: colors.text }]}>{pickerYear}</Text>
              <TouchableOpacity
                style={[styles.pickerArrowBtn, { backgroundColor: colors.surfaceSoft }]}
                onPress={() => setPickerYear((y) => Math.min(new Date().getFullYear(), y + 1))}
                disabled={pickerYear >= new Date().getFullYear()}
              >
                <AppIcon androidName="chevron_right" iosName="chevron.right" color={pickerYear >= new Date().getFullYear() ? colors.textMuted : colors.text} size={22} />
              </TouchableOpacity>
            </View>

            {/* If Monthly, Month Grid (Jan..Dec) */}
            {pickerType === 'monthly' && (
              <View style={styles.pickerMonthsGrid}>
                {MONTH_NAMES.map((name, idx) => {
                  const mNum = idx + 1;
                  const isSelected = pickerMonth === mNum;
                  const currentYear = new Date().getFullYear();
                  const currentMonth = new Date().getMonth() + 1;
                  const isFuture = pickerYear > currentYear || (pickerYear === currentYear && mNum > currentMonth);
                  const shortName = name.slice(0, 3);
                  return (
                    <TouchableOpacity
                      key={name}
                      style={[
                        styles.pickerMonthChip,
                        {
                          backgroundColor: isSelected
                            ? colors.primary
                            : colors.surfaceSoft,
                          opacity: isFuture ? 0.35 : 1,
                        },
                      ]}
                      onPress={() => {
                        if (!isFuture) {
                          hapticLight();
                          setPickerMonth(mNum);
                        }
                      }}
                      disabled={isFuture}
                    >
                      <Text
                        style={[
                          styles.pickerMonthChipText,
                          { color: isSelected ? '#fff' : colors.text },
                          isSelected && { fontWeight: '800' },
                        ]}
                      >
                        {shortName}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Quick Shortcuts */}
            <View style={styles.pickerShortcutsRow}>
              <TouchableOpacity
                style={[styles.pickerShortcutChip, { backgroundColor: colors.primarySoft }]}
                onPress={() => {
                  hapticLight();
                  const d = new Date();
                  const prevMonthDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
                  setPickerType('monthly');
                  setPickerYear(prevMonthDate.getFullYear());
                  setPickerMonth(prevMonthDate.getMonth() + 1);
                }}
              >
                <Text style={[styles.pickerShortcutText, { color: colors.primary }]}>⚡ Last Month</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pickerShortcutChip, { backgroundColor: colors.primarySoft }]}
                onPress={() => {
                  hapticLight();
                  setPickerType('yearly');
                  setPickerYear(new Date().getFullYear() - 1);
                }}
              >
                <Text style={[styles.pickerShortcutText, { color: colors.primary }]}>⚡ Last Year</Text>
              </TouchableOpacity>
            </View>

            {/* Action CTA Button */}
            <TouchableOpacity
              style={[styles.pickerPlayBtn, { backgroundColor: colors.primary }]}
              onPress={() => {
                setRewindPickerVisible(false);
                openRewind(pickerYear, pickerType === 'monthly' ? pickerMonth : undefined);
              }}
            >
              <AppIcon androidName="play_arrow" iosName="play.fill" color="#fff" size={20} />
              <Text style={styles.pickerPlayBtnText}>
                {pickerType === 'monthly'
                  ? `Play ${MONTH_NAMES[pickerMonth - 1]} ${pickerYear} Recap`
                  : `Play ${pickerYear} Rewind Reel`}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ShareModal
        visible={shareVisible}
        count={shareItems.length > 0 ? shareItems.length : 1}
        colors={colors}
        onClose={() => { setShareVisible(false); setShareItem(null); setShareItems([]); setShareKind(null); setShareTitle(null); }}
        onSubmit={handleShareSubmit}
      />
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
    p.muted = false;
    p.volume = 1;
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

  // Belt-and-suspenders: explicitly pause before the player is released so
  // audio never keeps running behind a transition (next story item, modal
  // close, or tab switch) even if unmount is delayed.
  useEffect(() => () => safeMediaCall(() => player.pause()), [player]);

  return (
    <View style={styles.videoContainer}>
      <videoModule.VideoView
        style={styles.videoFull}
        player={player}
        nativeControls={false}
        contentFit="contain"
        surfaceType="textureView"
      />
    </View>
  );
}

function RewindVideoPlayer({ uri, styles }: { uri: string; styles: any }) {
  if (!expoVideoModule) {
    return (
      <View style={styles.videoFallbackContainer}>
        <AppIcon androidName="videocam" iosName="video" color="#fff" size={48} />
        <Text style={styles.videoFallbackText}>Video Playback Unavailable</Text>
      </View>
    );
  }
  return <NativeRewindVideoPlayer uri={uri} videoModule={expoVideoModule} styles={styles} />;
}

function NativeRewindVideoPlayer({
  uri,
  videoModule,
  styles,
}: {
  uri: string;
  videoModule: ExpoVideoModule;
  styles: any;
}) {
  const source = useMemo<VideoSource>(() => ({ uri, useCaching: true, contentType: 'progressive' }), [uri]);
  const player = videoModule.useVideoPlayer(source, p => {
    p.loop = true;
    p.muted = false;
    p.volume = 1;
    safeMediaCall(() => p.play());
  });

  useEffect(() => () => safeMediaCall(() => player.pause()), [player]);

  return (
    <View style={styles.videoContainer}>
      <videoModule.VideoView
        style={styles.videoFull}
        player={player}
        nativeControls={false}
        contentFit="contain"
        surfaceType="textureView"
      />
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
    headerActionsRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    surpriseBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },
    refreshBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },

    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.five },
    centeredEmpty: { alignItems: 'center', justifyContent: 'center', padding: Spacing.five, paddingTop: Spacing.eight },
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

    scrollContent: { paddingBottom: BottomTabInset + insets.bottom + Spacing.eight },

    gamesRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Spacing.three,
      paddingHorizontal: Spacing.five,
      marginTop: Spacing.four,
    },
    gameCard: {
      flexGrow: 1,
      flexBasis: '40%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      borderRadius: Radius.lg,
      paddingVertical: Spacing.three,
      paddingHorizontal: Spacing.three,
    },
    gameIconWrap: {
      width: 34, height: 34, borderRadius: 17,
      alignItems: 'center', justifyContent: 'center',
    },
    gameCardText: { fontSize: TextScale.xs, fontWeight: '700', color: colors.text, flexShrink: 1 },

    sectionHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.five,
      marginTop: Spacing.five,
      marginBottom: Spacing.three,
    },
    sectionTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text },
    sectionSubtitle: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '600' },
    todayBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: Spacing.three,
      paddingVertical: 6,
      borderRadius: Radius.full,
      backgroundColor: colors.primarySoft,
    },
    todayBadgeText: { color: colors.primary, fontWeight: '900', fontSize: TextScale.xs, letterSpacing: 0.6 },

    todayEmptyCard: {
      marginHorizontal: Spacing.five,
      paddingVertical: Spacing.six,
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.two,
      borderRadius: Radius.xl,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      borderStyle: 'dashed',
    },
    todayEmptyText: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600' },

    cardList: { paddingHorizontal: Spacing.five, gap: Spacing.five },
    featuredCardContainer: { height: 240, marginVertical: Spacing.two },
    rewindBtn: {
      position: 'absolute',
      top: Spacing.three,
      right: Spacing.four + Spacing.two,
      zIndex: 10,
      elevation: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: Spacing.three,
      paddingVertical: 6,
      borderRadius: Radius.full,
      backgroundColor: 'rgba(0,0,0,0.55)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.35)',
    },
    rewindBtnText: { color: '#fff', fontWeight: '700', fontSize: TextScale.xs },
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
    featuredCardMain: {
      flex: 1,
      borderRadius: Radius.xl,
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderWidth: 2,
      borderColor: colors.primary,
      elevation: 6,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.25,
      shadowRadius: 14,
    },
    cardImage: { width: '100%', height: '100%' },
    cardImagePlaceholder: {
      width: '100%', height: '100%', backgroundColor: colors.surfaceBorder,
      alignItems: 'center', justifyContent: 'center',
    },
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

    historyRow: { paddingHorizontal: Spacing.five, gap: DAY_CARD_GAP },
    dayCardContainer: { width: DAY_CARD_W, height: DAY_CARD_H },
    dayCardShareBtn: {
      position: 'absolute',
      top: 8,
      left: 8,
      backgroundColor: 'rgba(0,0,0,0.45)',
      borderRadius: Radius.full,
      padding: 6,
      zIndex: 10,
      elevation: 4,
    },
    dayCardMain: {
      flex: 1,
      borderRadius: Radius.lg,
      overflow: 'hidden',
      backgroundColor: colors.surface,
      elevation: 3,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 6,
    },
    dayCardMainEmpty: {
      borderWidth: 1.5,
      borderColor: colors.surfaceBorder,
      borderStyle: 'dashed',
      justifyContent: 'space-between',
    },
    dayCardEmptyIconWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dayCardEmptyFooter: {
      alignItems: 'center',
      paddingBottom: Spacing.three,
    },
    dayCardLabelEmpty: { color: colors.textSecondary, fontWeight: '800', fontSize: TextScale.sm },
    dayCardDateEmpty: { color: colors.textMuted, fontWeight: '600', fontSize: TextScale.xs, marginTop: 2 },
    dayCardGradientOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: 'rgba(0,0,0,0.3)',
      justifyContent: 'space-between',
      padding: Spacing.three,
    },
    dayCardCountBadge: {
      alignSelf: 'flex-end',
      minWidth: 22,
      height: 22,
      paddingHorizontal: 6,
      borderRadius: Radius.full,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    dayCardCountBadgeText: { color: '#fff', fontWeight: '800', fontSize: TextScale.xs },
    dayCardLabel: { color: '#fff', fontWeight: '800', fontSize: TextScale.sm },
    dayCardDate: { color: 'rgba(255,255,255,0.85)', fontWeight: '600', fontSize: TextScale.xs, marginTop: 1 },

    /* Story Modal Styles */
    storyContainer: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
    storyMedia: { flex: 1, width: '100%', height: '100%' },
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
      elevation: 20,
      paddingHorizontal: Spacing.four,
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    segmentContainer: { flexDirection: 'row', gap: 4, marginBottom: Spacing.three },
    segmentTrack: { flex: 1, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
    segmentFill: { height: '100%', backgroundColor: '#fff' },

    storyHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: Spacing.three },
    storyHeaderInfo: { gap: 2 },
    storyDayPill: {
      alignSelf: 'flex-start',
      paddingHorizontal: Spacing.two,
      paddingVertical: 2,
      borderRadius: Radius.sm,
      backgroundColor: 'rgba(255,255,255,0.2)',
      marginBottom: 2,
    },
    storyDayPillText: { color: '#fff', fontWeight: '700', fontSize: TextScale.xs },
    storyYearTitle: { color: '#fff', fontWeight: '800', fontSize: TextScale.md },
    storySourceSub: { color: 'rgba(255,255,255,0.75)', fontSize: TextScale.xs, fontWeight: '500' },
    storyCaptureDate: { color: 'rgba(255,255,255,0.65)', fontSize: TextScale.xs, fontWeight: '500', marginTop: 1 },
    nextSurpriseBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      paddingHorizontal: Spacing.four,
      paddingVertical: Spacing.two,
      borderRadius: Radius.full,
      backgroundColor: 'rgba(255,255,255,0.18)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.3)',
      alignSelf: 'center',
    },
    nextSurpriseBtnText: { color: '#fff', fontSize: TextScale.xs, fontWeight: '700' },
    flashbackIconBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.18)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.3)',
    },
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
      elevation: 20,
      paddingHorizontal: Spacing.five,
      paddingTop: Spacing.three,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.three,
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
    saveBtnCompact: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: Spacing.three,
      paddingVertical: Spacing.three,
      borderRadius: Radius.full,
      backgroundColor: 'rgba(255,255,255,0.25)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.4)',
      flexShrink: 1,
    },

    videoContainer: { flex: 1, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
    videoFull: { width: '100%', height: '100%' },
    videoFallbackContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    videoFallbackText: { color: '#fff', fontSize: TextScale.sm, marginTop: Spacing.two, fontWeight: '600' },

    /* Rewind & Recap Picker Styles */
    pickerOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: Spacing.four,
    },
    pickerCard: {
      width: '100%',
      maxWidth: 380,
      borderRadius: Radius.xl,
      padding: Spacing.five,
      gap: Spacing.four,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      elevation: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
    },
    pickerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    pickerTitle: {
      fontSize: TextScale.lg,
      fontWeight: '800',
    },
    pickerCloseBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pickerSegmentRow: {
      flexDirection: 'row',
      padding: 3,
      borderRadius: Radius.lg,
      gap: 4,
    },
    pickerSegmentBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: Spacing.two,
      borderRadius: Radius.md,
    },
    pickerSegmentBtnActive: {
      elevation: 2,
    },
    pickerSegmentText: {
      fontSize: TextScale.xs,
      fontWeight: '700',
    },
    pickerYearRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.five,
    },
    pickerArrowBtn: {
      width: 40,
      height: 40,
      borderRadius: Radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pickerYearText: {
      fontSize: TextScale.xl,
      fontWeight: '900',
      minWidth: 80,
      textAlign: 'center',
    },
    pickerMonthsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Spacing.two,
      justifyContent: 'space-between',
    },
    pickerMonthChip: {
      width: '23%',
      paddingVertical: Spacing.two,
      borderRadius: Radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pickerMonthChipText: {
      fontSize: TextScale.xs,
      fontWeight: '600',
    },
    pickerShortcutsRow: {
      flexDirection: 'row',
      gap: Spacing.two,
      justifyContent: 'center',
    },
    pickerShortcutChip: {
      paddingHorizontal: Spacing.three,
      paddingVertical: 6,
      borderRadius: Radius.full,
    },
    pickerShortcutText: {
      fontSize: TextScale.xs,
      fontWeight: '700',
    },
    pickerPlayBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.two,
      paddingVertical: Spacing.three,
      borderRadius: Radius.lg,
      marginTop: 2,
    },
    pickerPlayBtnText: {
      color: '#fff',
      fontSize: TextScale.sm,
      fontWeight: '800',
    },
  });