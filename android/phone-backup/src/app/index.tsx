import { useEffect, useState } from 'react';
import { View, Text, Button, FlatList, StyleSheet } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { getFolders, addFolder, removeFolder } from '../../settings';
import { runSync } from '../../backgroundTask';

type Folder = { uri: string; name: string };

export default function Index() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState('');

  const load = async () => setFolders(await getFolders());

  useEffect(() => { load(); }, []);

  const pickFolder = async () => {
    const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perm.granted) return;
    const name = decodeURIComponent(perm.directoryUri.split('/').pop() as string);
    await addFolder(perm.directoryUri, name);
    await load();
  };

  const removeF = async (uri: string) => {
    await removeFolder(uri);
    await load();
  };

  const sync = async () => {
    setSyncing(true);
    setStatus('Syncing...');
    const uploadedAny = await runSync();
    setStatus(uploadedAny ? 'Synced new files' : 'Nothing new to sync');
    setSyncing(false);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Phone Backup</Text>
      <Button title="Add Folder" onPress={pickFolder} />
      <FlatList
        data={folders}
        keyExtractor={(item) => item.uri}
        renderItem={({ item }: { item: Folder }) => (
          <View style={styles.row}>
            <Text style={styles.folderName}>{item.name}</Text>
            <Button title="Remove" onPress={() => removeF(item.uri)} />
          </View>
        )}
      />
      <Button title={syncing ? 'Syncing...' : 'Sync Now'} onPress={sync} disabled={syncing} />
      <Text>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 10 },
  title: { fontSize: 20, fontWeight: 'bold' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  folderName: { fontSize: 16 }
});