import { Tabs, useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as MediaLibrary from 'expo-media-library';
import { registerBackgroundTask } from '../../backgroundTask';
import {
  setupNotifications,
  showMemoriesNotification,
  addMemoriesTapListener,
  getInitialMemoriesTap,
  showFlashbackNotification,
  addFlashbackTapListener,
  getInitialFlashbackTap,
  showStreakRiskNotification,
  showRecapReadyNotification,
  addRecapTapListener,
  getInitialRecapTap,
  getInitialSharedPostTap,
  addSharedPostTapListener,
} from '../../notificationService';
import { checkAndNotifyNewShares } from '../../uploader';
import {
  getLastMemoryNotifiedDate,
  setLastMemoryNotifiedDate,
  getLastFlashbackNotifiedAt,
  setLastFlashbackNotifiedAt,
  getLastRecapNotifiedMonth,
  setLastRecapNotifiedMonth,
  resolveReachableServer,
} from '../../settings';
import { getTodaysMemories, getRandomFlashback, generateRewindReel, getRewindReelStatus } from '../../downloader';
import {
  getStreakData,
  getLastStreakRiskNotifiedDate,
  setLastStreakRiskNotifiedDate,
  todayStr as streakTodayStr,
} from '../../streak';
import { syncWidgetServerConfig } from '../../widget';
import { AppColors, Radius, Shadows, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AppThemeProvider, useAppTheme } from '@/hooks/use-app-theme';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  interpolateColor,
} from 'react-native-reanimated';

type TabIconProps = {
  androidName: string;
  iosName: string;
  focused: boolean;
  colors: AppColors;
  styles: ReturnType<typeof createStyles>;
};

function TabIcon({ androidName, iosName, focused, colors, styles }: TabIconProps) {
  const scale = useSharedValue(focused ? 1 : 0);

  useEffect(() => {
    scale.value = withSpring(focused ? 1 : 0, { damping: 14, stiffness: 350, mass: 0.6 });
  }, [focused, scale]);

  const iconAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.9 + scale.value * 0.1 }],
    backgroundColor: interpolateColor(scale.value, [0, 1], ['transparent', colors.primarySoft]),
  }));

  return (
    <Animated.View style={[styles.iconWrapper, iconAnimStyle]}>
      <AppIcon
        androidName={androidName}
        iosName={iosName}
        size={22}
        color={focused ? colors.primary : colors.textSecondary}
        fallback="*"
      />
    </Animated.View>
  );
}

async function checkAndNotifyMemories() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastNotified = await getLastMemoryNotifiedDate();
  if (lastNotified === todayStr) return;

  const res = await getTodaysMemories();
  const groups = Array.isArray(res?.groups) ? res.groups : [];
  const count = groups.reduce((sum, g) => sum + (Array.isArray(g?.items) ? g.items.length : 0), 0);
  if (count > 0) {
    await showMemoriesNotification(count);
    await setLastMemoryNotifiedDate(todayStr);
  }
}

// Surprise notification unrelated to "On This Day" — fires at a randomized
// 2-5 day interval so it doesn't feel scheduled/predictable.
const FLASHBACK_MIN_INTERVAL_DAYS = 2;
const FLASHBACK_MAX_INTERVAL_DAYS = 5;

async function checkAndNotifyFlashback() {
  const lastNotifiedAt = await getLastFlashbackNotifiedAt();
  const thresholdDays = FLASHBACK_MIN_INTERVAL_DAYS +
    Math.random() * (FLASHBACK_MAX_INTERVAL_DAYS - FLASHBACK_MIN_INTERVAL_DAYS);
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  if (lastNotifiedAt && Date.now() - lastNotifiedAt < thresholdMs) return;

  const item = await getRandomFlashback();
  if (item) {
    await showFlashbackNotification(item);
    await setLastFlashbackNotifiedAt(Date.now());
  } else if (!lastNotifiedAt) {
    // Empty library: avoid re-hitting the API on every cold start before any media exists.
    await setLastFlashbackNotifiedAt(Date.now());
  }
}

// Recap covers the prior calendar month, so it's only worth checking once
// that month is fully over — otherwise the reel would be built from a
// partial month and rebuilt again once more files land.
function previousMonthKey(now: Date): { year: number; month: number; key: string } {
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  return { year, month, key: `${year}-${String(month).padStart(2, '0')}` };
}

async function checkAndNotifyRecap() {
  const { year, month, key } = previousMonthKey(new Date());
  const lastNotified = await getLastRecapNotifiedMonth();
  if (lastNotified === key) return;

  try {
    const status = await getRewindReelStatus(year, month);
    if (status.ready) {
      await showRecapReadyNotification(year, month);
      await setLastRecapNotifiedMonth(key);
      return;
    }
    if (status.status === 'none') {
      // Not enough media that month — stop checking so it doesn't retry every launch.
      await setLastRecapNotifiedMonth(key);
      return;
    }
    if (status.status !== 'generating') {
      await generateRewindReel(year, month).catch(() => {});
    }
    // Still building — leave lastNotified unset so a future app open checks again.
  } catch {
    // Offline or server unreachable — try again next launch.
  }
}

async function checkAndNotifyStreakRisk() {
  const todayStr = streakTodayStr();
  const lastNotified = await getLastStreakRiskNotifiedDate();
  if (lastNotified === todayStr) return;

  const hourNow = new Date().getHours();
  if (hourNow < 18) return; // only warn in the evening, once the day's sync window is closing

  const streak = await getStreakData();
  if (streak.atRisk && streak.currentStreak > 0) {
    await showStreakRiskNotification(streak.currentStreak);
    await setLastStreakRiskNotifiedDate(todayStr);
  }
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppThemeProvider>
        <RootLayoutContent />
      </AppThemeProvider>
    </GestureHandlerRootView>
  );
}

function RootLayoutContent() {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        await MediaLibrary.requestPermissionsAsync().catch(() => {});
      } catch {}
      await setupNotifications().catch(() => {});
      await registerBackgroundTask();
      syncWidgetServerConfig().catch(() => {});
      resolveReachableServer().catch(() => {});
      checkAndNotifyMemories().catch(() => {});
      checkAndNotifyFlashback().catch(() => {});
      checkAndNotifyStreakRisk().catch(() => {});
      checkAndNotifyRecap().catch(() => {});
      checkAndNotifyNewShares().catch(() => {});
    })();

    // Background mesh network roaming / Wi-Fi reconnect listener
    let networkSub: { remove: () => void } | null = null;
    try {
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const Network = require('expo-network');
      if (Network?.addNetworkStateListener) {
        networkSub = Network.addNetworkStateListener((state: any) => {
          if (state?.isConnected && state?.type === Network.NetworkStateType?.WIFI) {
            resolveReachableServer({ force: true }).catch(() => {});
            checkAndNotifyNewShares().catch(() => {});
          }
        });
      }
    } catch {}

    return () => {
      networkSub?.remove?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    // Read once so memories/flashback/shares don't race on the same sticky last-response.
    (async () => {
      const isSharedPost = await getInitialSharedPostTap();
      if (!active) return;
      if (isSharedPost) {
        void AsyncStorage.setItem('feed_force_refresh', '1');
        router.push('/feed');
        return;
      }
      const isFlashback = await getInitialFlashbackTap();
      if (!active) return;
      if (isFlashback) {
        router.push('/memories?flashback=1');
        return;
      }
      const isMemories = await getInitialMemoriesTap();
      if (active && isMemories) {
        router.push('/memories');
        return;
      }
      const recapTarget = await getInitialRecapTap();
      if (active && recapTarget) {
        router.push(`/memories?recap=1&recapYear=${recapTarget.year}&recapMonth=${recapTarget.month ?? ''}`);
      }
    })();
    const unsubscribeMemories = addMemoriesTapListener(() => router.push('/memories'));
    const unsubscribeFlashback = addFlashbackTapListener(() => router.push('/memories?flashback=1'));
    const unsubscribeRecap = addRecapTapListener((target: { year: number; month: number | null }) =>
      router.push(`/memories?recap=1&recapYear=${target.year}&recapMonth=${target.month ?? ''}`)
    );
    const unsubscribeSharedPost = addSharedPostTapListener(() => {
      void AsyncStorage.setItem('feed_force_refresh', '1');
      router.push('/feed');
    });
    return () => {
      active = false;
      unsubscribeMemories();
      unsubscribeFlashback();
      unsubscribeRecap();
      unsubscribeSharedPost();
    };
  }, [router]);

  return (
    <SafeAreaProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarShowLabel: true,
          tabBarStyle: styles.tabBar,
          tabBarBackground: () => <View style={styles.tabBarBg} />,
          tabBarLabelStyle: styles.tabLabel,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarIconStyle: styles.tabIcon,
          tabBarItemStyle: styles.tabItem,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Backup',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" focused={focused} colors={colors} styles={styles} />
            ),
          }}
        />
        <Tabs.Screen
          name="folders"
          options={{
            title: 'Folders',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="folder" iosName="folder" focused={focused} colors={colors} styles={styles} />
            ),
          }}
        />
        <Tabs.Screen
          name="restore"
          options={{
            title: 'Library',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="cloud_download" iosName="icloud.and.arrow.down" focused={focused} colors={colors} styles={styles} />
            ),
          }}
        />
        <Tabs.Screen
          name="feed"
          options={{
            title: 'Feed',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="dynamic_feed" iosName="heart.text.square" focused={focused} colors={colors} styles={styles} />
            ),
          }}
        />
        <Tabs.Screen
          name="history"
          options={{
            title: 'History',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="history" iosName="clock.arrow.circlepath" focused={focused} colors={colors} styles={styles} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="settings" iosName="gearshape" focused={focused} colors={colors} styles={styles} />
            ),
          }}
        />
        <Tabs.Screen
          name="memories"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="wrapped"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="quiz"
          options={{ href: null, tabBarStyle: { display: 'none' }, freezeOnBlur: true }}
        />
        <Tabs.Screen
          name="roulette"
          options={{ href: null, tabBarStyle: { display: 'none' }, freezeOnBlur: true }}
        />
        <Tabs.Screen
          name="pending"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="places"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="free-up"
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
      </Tabs>
    </SafeAreaProvider>
  );
}

const TAB_BAR_HEIGHT = Platform.OS === 'android' ? 82 : 88;

const createStyles = (colors: AppColors) => StyleSheet.create({
  tabBar: {
    position: 'absolute',
    bottom: 10,
    left: 18,
    right: 18,
    height: TAB_BAR_HEIGHT,
    borderTopWidth: 0,
    borderRadius: Radius.xxl,
    backgroundColor: colors.surface,
    ...Shadows.card,
  },
  tabBarBg: {
    flex: 1,
    borderRadius: Radius.xxl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: Platform.OS === 'android' ? 14 : 10,
  },
  tabIcon: {
    width: 44,
    height: 34,
    marginBottom: 0,
  },
  iconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 42,
    height: 32,
    borderRadius: Radius.full,
  },
  tabLabel: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    marginTop: 1,
    paddingBottom: 1,
  },
});