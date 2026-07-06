import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { registerBackgroundTask } from '../../backgroundTask';
import { setupNotifications } from '../../notificationService';
import { Colors, Radius, TextScale } from '@/constants/theme';

type TabIconProps = {
  emoji: string;
  label: string;
  focused: boolean;
};

function TabIcon({ emoji, label, focused }: TabIconProps) {
  return (
    <View style={[styles.tabItem, focused && styles.tabItemFocused]}>
      <Text style={styles.tabEmoji}>{emoji}</Text>
      <Text style={[styles.tabLabel, focused && styles.tabLabelFocused]}>
        {label}
      </Text>
    </View>
  );
}

export default function RootLayout() {
  useEffect(() => {
    (async () => {
      await MediaLibrary.requestPermissionsAsync();
      await setupNotifications();
      await registerBackgroundTask();
    })();
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: styles.tabBar,
        tabBarBackground: () => <View style={styles.tabBarBg} />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => (
            <TabIcon emoji="☁️" label="Backup" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="folders"
        options={{
          title: 'Folders',
          tabBarIcon: ({ focused }) => (
            <TabIcon emoji="📁" label="Folders" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ focused }) => (
            <TabIcon emoji="⚙️" label="Settings" focused={focused} />
          ),
        }}
      />
      {/* Hide legacy explore tab */}
      <Tabs.Screen name="explore" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
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
  tabItem: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingTop: 8,
    paddingHorizontal: 12,
    borderRadius: Radius.lg,
    opacity: 0.5,
  },
  tabItemFocused: {
    opacity: 1,
  },
  tabEmoji: {
    fontSize: 22,
  },
  tabLabel: {
    fontSize: TextScale.xs,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  tabLabelFocused: {
    color: Colors.primary,
    fontWeight: '700',
  },
});