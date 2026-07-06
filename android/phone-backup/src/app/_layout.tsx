import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { registerBackgroundTask } from '../../backgroundTask';
import { setupNotifications } from '../../notificationService';
import { Colors, TextScale } from '@/constants/theme';

type TabIconProps = {
  /** Material Symbol name for Android/web */
  androidName: string;
  /** SF Symbol name for iOS */
  iosName: string;
  focused: boolean;
};

function TabIcon({ androidName, iosName, focused }: TabIconProps) {
  const color = focused ? Colors.primary : Colors.textSecondary;
  const size = 24;

  return (
    <View style={styles.iconWrapper}>
      <SymbolView
        name={{ android: androidName as any, web: androidName as any, ios: iosName as any }}
        size={size}
        tintColor={color}
        fallback={null}
      />
    </View>
  );
}

export default function RootLayout() {
  useEffect(() => {
    (async () => {
      // Request permissions — errors are non-fatal
      try {
        const MediaLibrary = require('expo-media-library');
        await MediaLibrary.requestPermissionsAsync().catch(() => {});
      } catch {}
      // Set up notification channel — errors are non-fatal
      await setupNotifications().catch(() => {});
      // Register background fetch — may fail on first launch before permissions
      // are granted; registerBackgroundTask has its own try/catch guard
      await registerBackgroundTask();
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          // Use native labels rendered by the tab bar — avoids vertical clipping issues
          tabBarShowLabel: true,
          tabBarStyle: styles.tabBar,
          tabBarBackground: () => <View style={styles.tabBarBg} />,
          // Label typography
          tabBarLabelStyle: styles.tabLabel,
          // Active / inactive colours applied to both icon and label
          tabBarActiveTintColor: Colors.primary,
          tabBarInactiveTintColor: Colors.textSecondary,
          // Keep the icon slot from growing too large
          tabBarIconStyle: styles.tabIcon,
          // Ensure item fills the full height so icon + label stack correctly
          tabBarItemStyle: styles.tabItem,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Backup',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="cloud" iosName="cloud" focused={focused} />
            ),
          }}
        />
        <Tabs.Screen
          name="folders"
          options={{
            title: 'Folders',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="folder" iosName="folder" focused={focused} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="settings" iosName="gear" focused={focused} />
            ),
          }}
        />
        {/* Hide legacy explore tab */}
        <Tabs.Screen name="explore" options={{ href: null }} />
      </Tabs>
    </SafeAreaProvider>
  );
}

// Bottom tab bar height: leave extra room for the Android nav bar on gesture-nav devices
const TAB_BAR_HEIGHT = Platform.OS === 'android' ? 80 : 88;

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: TAB_BAR_HEIGHT,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
    backgroundColor: Colors.surface,
    elevation: 0,
    shadowOpacity: 0,
  },
  tabBarBg: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  /** Each tab item — full height so icon + label both have room */
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: Platform.OS === 'android' ? 14 : 10,
  },
  /** Keep the icon container a fixed, predictable size */
  tabIcon: {
    width: 24,
    height: 24,
    marginBottom: 2,
  },
  iconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
  },
  tabLabel: {
    fontSize: TextScale.xs,
    fontWeight: '500',
    marginTop: 3,
    paddingBottom: 1,
  },
});
