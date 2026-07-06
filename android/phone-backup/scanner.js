import * as FileSystem from 'expo-file-system/legacy';
import { getFolders, getFileTypes, FILE_TYPE_EXTENSIONS } from './settings';

function getFileExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

const ALL_KNOWN_EXTENSIONS = new Set(
  Object.values(FILE_TYPE_EXTENSIONS).flat()
);

function shouldIncludeFile(name, selectedTypes) {
  if (selectedTypes.includes('all')) return true;
  const ext = getFileExtension(name);
  const includeOthers = selectedTypes.includes('others');

  // Check if the extension matches any of the selected typed groups
  for (const type of selectedTypes) {
    if (type === 'others') continue;
    const exts = FILE_TYPE_EXTENSIONS[type] || [];
    if (exts.includes(ext)) return true;
  }

  // "others" = any extension not in the known sets
  if (includeOthers && !ALL_KNOWN_EXTENSIONS.has(ext)) return true;

  return false;
}

async function walk(uri, base, result, selectedTypes) {
  let items;
  try {
    items = await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
  } catch {
    // If directory listing fails, treat the URI itself as a file
    const name = decodeURIComponent(uri.split('/').pop() || '');
    if (shouldIncludeFile(name, selectedTypes)) {
      result.push({
        uri,
        relativePath: base,
        modifiedTime: Math.floor(Date.now() / 1000),
        size: 0,
        name,
      });
    }
    return;
  }

  for (const itemUri of items) {
    const name = decodeURIComponent(itemUri.split('/').pop() || '');
    const newBase = `${base}/${name}`;

    // Try to list as a directory
    let isDir = false;
    try {
      await FileSystem.StorageAccessFramework.readDirectoryAsync(itemUri);
      isDir = true;
    } catch {
      isDir = false;
    }

    if (isDir) {
      await walk(itemUri, newBase, result, selectedTypes);
    } else if (shouldIncludeFile(name, selectedTypes)) {
      let info = { size: 0, modificationTime: Date.now() / 1000 };
      try {
        info = await FileSystem.getInfoAsync(itemUri, { size: true }) || info;
      } catch {}
      result.push({
        uri: itemUri,
        relativePath: newBase,
        modifiedTime: Math.floor(info.modificationTime || Date.now() / 1000),
        size: info.size || 0,
        name,
      });
    }
  }
}

export async function scan() {
  const [folders, selectedTypes] = await Promise.all([
    getFolders(),
    getFileTypes(),
  ]);

  const result = [];
  for (const folder of folders) {
    await walk(folder.uri, folder.name, result, selectedTypes);
  }
  return result;
}