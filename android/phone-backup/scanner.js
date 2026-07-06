import * as FileSystem from 'expo-file-system/legacy';
import { getFolders } from './settings';

async function walk(uri, base, result) {
  let items;
  try {
    items = await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
  } catch {
    result.push({
      uri,
      relativePath: base,
      modifiedTime: Math.floor(Date.now() / 1000),
      size: 0
    });
    return;
  }
  for (const itemUri of items) {
    const name = decodeURIComponent(itemUri.split('/').pop());
    await walk(itemUri, `${base}/${name}`, result);
  }
}

export async function scan() {
  const folders = await getFolders();
  const result = [];
  for (const folder of folders) {
    await walk(folder.uri, folder.name, result);
  }
  return result;
}