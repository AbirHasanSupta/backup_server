import { Tabs, useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
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
} from '../../notificationService';
import {
  getLastMemoryNotifiedDate,
  setLastMemoryNotifiedDate,
  getLastFlashbackNotifiedAt,
  setLastFlashbackNotifiedAt,
} from '../../settings';
import { getTodaysMemories, getRandomFlashback } from '../../downloader';
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
      checkAndNotifyMemories().catch(() => {});
      checkAndNotifyFlashback().catch(() => {});
    })();
  }, []);

  useEffect(() => {
    let active = true;
    // Read once so memories/flashback don't race on the same sticky last-response.
    (async () => {
      const isFlashback = await getInitialFlashbackTap();
      if (!active) return;
      if (isFlashback) {
        router.push('/memories?flashback=1');
        return;
      }
      const isMemories = await getInitialMemoriesTap();
      if (active && isMemories) {
        router.push('/memories');
      }
    })();
    const unsubscribeMemories = addMemoriesTapListener(() => router.push('/memories'));
    const unsubscribeFlashback = addFlashbackTapListener(() => router.push('/memories?flashback=1'));
    return () => {
      active = false;
      unsubscribeMemories();
      unsubscribeFlashback();
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
        <Tabs.Screen name="explore" options={{ href: null }} />
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
          options={{ href: null, tabBarStyle: { display: 'none' } }}
        />
        <Tabs.Screen
          name="roulette"
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