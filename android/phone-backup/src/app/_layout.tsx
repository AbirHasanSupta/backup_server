import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import { registerBackgroundTask } from '../../backgroundTask';
import { setupNotifications } from '../../notificationService';
import { Colors, Radius, Shadows, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';

type TabIconProps = {
  androidName: string;
  iosName: string;
  focused: boolean;
};

function TabIcon({ androidName, iosName, focused }: TabIconProps) {
  return (
    <View style={[styles.iconWrapper, focused && styles.iconWrapperFocused]}>
      <AppIcon
        androidName={androidName}
        iosName={iosName}
        size={22}
        color={focused ? Colors.primary : Colors.textSecondary}
        fallback="*"
      />
    </View>
  );
}

export default function RootLayout() {
  useEffect(() => {
    (async () => {
      try {
        await MediaLibrary.requestPermissionsAsync().catch(() => {});
      } catch {}
      await setupNotifications().catch(() => {});
      await registerBackgroundTask();
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarShowLabel: true,
          tabBarStyle: styles.tabBar,
          tabBarBackground: () => <View style={styles.tabBarBg} />,
          tabBarLabelStyle: styles.tabLabel,
          tabBarActiveTintColor: Colors.primary,
          tabBarInactiveTintColor: Colors.textSecondary,
          tabBarIconStyle: styles.tabIcon,
          tabBarItemStyle: styles.tabItem,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Backup',
            tabBarIcon: ({ focused }) => (
              <TabIcon androidName="cloud_upload" iosName="icloud.and.arrow.up" focused={focused} />
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
              <TabIcon androidName="settings" iosName="gearshape" focused={focused} />
            ),
          }}
        />
        <Tabs.Screen name="explore" options={{ href: null }} />
      </Tabs>
    </SafeAreaProvider>
  );
}

const TAB_BAR_HEIGHT = Platform.OS === 'android' ? 82 : 88;

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    bottom: 10,
    left: 18,
    right: 18,
    height: TAB_BAR_HEIGHT,
    borderTopWidth: 0,
    borderRadius: Radius.xxl,
    backgroundColor: Colors.surface,
    ...Shadows.card,
  },
  tabBarBg: {
    flex: 1,
    borderRadius: Radius.xxl,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
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
  iconWrapperFocused: {
    backgroundColor: Colors.primarySoft,
  },
  tabLabel: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    marginTop: 1,
    paddingBottom: 1,
  },
});
