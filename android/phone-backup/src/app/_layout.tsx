import { Slot } from 'expo-router';
import { useEffect } from 'react';
import { registerBackgroundTask } from '../../backgroundTask';
import { setServerIp, setApiKey } from '../../settings';

export default function RootLayout() {
  useEffect(() => {
    (async () => {
      await setServerIp('192.168.10.104');
      await setApiKey('YOUR_SECRET_KEY');
      await registerBackgroundTask();
    })();
  }, []);
  return <Slot />;
}