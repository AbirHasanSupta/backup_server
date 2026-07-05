import AsyncStorage from '@react-native-async-storage/async-storage';

export const getServerIp = async () => (await AsyncStorage.getItem('server_ip')) || '192.168.10.104';
export const setServerIp = (ip) => AsyncStorage.setItem('server_ip', ip);
export const getApiKey = async () => (await AsyncStorage.getItem('api_key')) || 'YOUR_SECRET_KEY';
export const setApiKey = (key) => AsyncStorage.setItem('api_key', key);

export const isUploaded = async (relativePath, modifiedTime) => {
  const v = await AsyncStorage.getItem(`uploaded_${relativePath}`);
  return v === String(modifiedTime);
};

export const markUploaded = (relativePath, modifiedTime) =>
  AsyncStorage.setItem(`uploaded_${relativePath}`, String(modifiedTime));
