import { useEffect } from 'react';
import { View, Text } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { registerBackgroundTask } from './backgroundTask';
import { setServerIp, setApiKey } from './settings';

export default function App() {
  useEffect(() => {
    (async () => {
      await MediaLibrary.requestPermissionsAsync();
      await setServerIp('192.168.10.104');
      await setApiKey('YOUR_SECRET_KEY');
      await registerBackgroundTask();
    })();
  }, []);

  return (
    <View>
      <Text>Phone Backup Running</Text>
    </View>
  );
}
