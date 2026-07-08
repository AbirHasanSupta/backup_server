import * as FileSystem from 'expo-file-system/legacy';
import { getFolders, getFileTypes, FILE_TYPE_EXTENSIONS } from './settings';

function getFileExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

const ALL_KNOWN_EXTENSIONS = new Set(
  Object.values(FILE_TYPE_EXTENSIONS).flat()
);

const SCAN_BATCH_SIZE = 8;

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

async function walk(uri, base, result, selectedTypes, onActivity, counters) {
  let items;
  try {
    items = await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
  } catch {
    // If directory listing fails, treat the URI itself as a file
    const decoded = decodeURIComponent(uri.split('/').pop() || '');
    const name = decoded.substring(Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf(':')) + 1);
    if (shouldIncludeFile(name, selectedTypes)) {
      result.push({
        uri,
        relativePath: base,
        modifiedTime: 0,
        size: 0,
        name,
        id: uri, // Use URI as a unique identifier for SAF items
      });
      counters.files++;
      onActivity && onActivity({ phase: 'scanning', files: counters.files, currentFile: base });
    }
    return;
  }

  async function processItem(itemUri) {
    const decoded = decodeURIComponent(itemUri.split('/').pop() || '');
    const name = decoded.substring(Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf(':')) + 1);
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
      await walk(itemUri, newBase, result, selectedTypes, onActivity, counters);
    } else if (shouldIncludeFile(name, selectedTypes)) {
      let info = { size: 0, modificationTime: 0 };
      try {
        info = await FileSystem.getInfoAsync(itemUri, { size: true }) || info;
      } catch {}
      result.push({
        uri: itemUri,
        relativePath: newBase,
        modifiedTime: Math.floor(info.modificationTime || 0),
        size: info.size || 0,
        name,
        id: itemUri,
      });
      counters.files++;
      onActivity && onActivity({ phase: 'scanning', files: counters.files, currentFile: newBase });
    }
  }

  for (let i = 0; i < items.length; i += SCAN_BATCH_SIZE) {
    await Promise.all(items.slice(i, i + SCAN_BATCH_SIZE).map(processItem));
  }
}

export async function scan(onActivity, targetFolderUri) {
  const [folders, selectedTypes] = await Promise.all([
    getFolders(),
    getFileTypes(),
  ]);

  const foldersToScan = targetFolderUri
    ? folders.filter((f) => f.uri === targetFolderUri)
    : folders;

  const result = [];
  const counters = { files: 0 };
  for (const folder of foldersToScan) {
    onActivity && onActivity({ phase: 'scanning', currentFile: folder.name, files: counters.files });
    await walk(folder.uri, folder.name, result, selectedTypes, onActivity, counters);
  }
  return result;
}
