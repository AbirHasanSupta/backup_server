import { NativeModules, Platform } from 'react-native';
import { getServerIp, getServerPort, getDeviceToken, getApiKey, getDeviceId } from './settings';

const { PhoneBackupWidget } = NativeModules;

export async function syncWidgetServerConfig() {
  if (Platform.OS !== 'android' || !PhoneBackupWidget) return false;
  try {
    const [ip, port, token, apiKey, deviceId] = await Promise.all([
      getServerIp(),
      getServerPort(),
      getDeviceToken(),
      getApiKey(),
      getDeviceId(),
    ]);

    const activeToken = token || apiKey || '';
    if (ip && deviceId) {
      await PhoneBackupWidget.updateServerConfig(ip, port || 8000, activeToken, deviceId);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[Widget] syncWidgetServerConfig failed:', e?.message);
    return false;
  }
}

export async function triggerWidgetRefresh() {
  if (Platform.OS !== 'android' || !PhoneBackupWidget) return false;
  try {
    await PhoneBackupWidget.refreshWidget();
    return true;
  } catch (e) {
    console.warn('[Widget] triggerWidgetRefresh failed:', e?.message);
    return false;
  }
}
