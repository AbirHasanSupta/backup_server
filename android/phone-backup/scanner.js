import * as FileSystem from 'expo-file-system/legacy';
import { getFolders, getFileTypes, FILE_TYPE_EXTENSIONS } from './settings';

function getFileExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

const ALL_KNOWN_EXTENSIONS = new Set(
  Object.values(FILE_TYPE_EXTENSIONS).flat()
);

const SCAN_BATCH_SIZE = 16;
const METADATA_BATCH_SIZE = 24;
const SCAN_PROGRESS_INTERVAL_MS = 500;
const SCAN_PROGRESS_FILE_STEP = 50;

function safeDecodeUriPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getSafName(itemUri) {
  const decoded = safeDecodeUriPart(itemUri.split('/').pop() || '');
  return decoded.substring(Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf(':')) + 1);
}

function createFileMatcher(selectedTypes) {
  if (selectedTypes.includes('all')) return () => true;

  const includeOthers = selectedTypes.includes('others');
  const selectedExtensions = new Set();

  for (const type of selectedTypes) {
    if (type === 'others') continue;
    for (const ext of FILE_TYPE_EXTENSIONS[type] || []) {
      selectedExtensions.add(ext);
    }
  }

  return (name) => {
    const ext = getFileExtension(name);
    if (selectedExtensions.has(ext)) return true;
    return includeOthers && !ALL_KNOWN_EXTENSIONS.has(ext);
  };
}

function createScanReporter(onActivity) {
  let lastReportAt = 0;
  let lastReportFiles = 0;

  return (detail, force = false) => {
    if (!onActivity) return;
    const files = detail.files || 0;
    const now = Date.now();
    const enoughFiles = files - lastReportFiles >= SCAN_PROGRESS_FILE_STEP;
    const enoughTime = now - lastReportAt >= SCAN_PROGRESS_INTERVAL_MS;

    if (!force && files > 0 && !enoughFiles && !enoughTime) return;

    lastReportAt = now;
    lastReportFiles = files;
    onActivity(detail);
  };
}

function createMetadataScheduler(reportActivity) {
  const queue = [];
  let active = 0;
  let completed = 0;
  let total = 0;
  let drainResolve = null;

  function pump() {
    while (active < METADATA_BATCH_SIZE && queue.length > 0) {
      const task = queue.shift();
      active++;
      task().finally(() => {
        active--;
        completed++;
        pump();
        if (active === 0 && queue.length === 0 && drainResolve) {
          drainResolve();
          drainResolve = null;
        }
      });
    }
  }

  return {
    add(file) {
      total++;
      queue.push(async () => {
        const enriched = await enrichFileMetadata(file);
        Object.assign(file, enriched);
        reportActivity({
          phase: 'scanning',
          files: total,
          metadata: completed + 1,
          totalMetadata: total,
          currentFile: file.relativePath,
        });
      });
      pump();
    },
    async drain() {
      if (active === 0 && queue.length === 0) return;
      await new Promise((resolve) => {
        drainResolve = resolve;
      });
    },
  };
}

export async function enrichFileMetadata(file) {
  if (file.metadataLoaded) return file;

  let info = { size: 0, modificationTime: 0 };
  try {
    info = await FileSystem.getInfoAsync(file.uri, { size: true }) || info;
  } catch {}

  return {
    ...file,
    modifiedTime: Math.floor(info.modificationTime || 0),
    size: info.size || 0,
    metadataLoaded: true,
  };
}

function addFile(uri, relativePath, name, result, shouldInclude, reportActivity, counters, metadataScheduler) {
  if (!shouldInclude(name)) return;

  const file = {
    uri,
    relativePath,
    modifiedTime: 0,
    size: 0,
    name,
    id: uri,
    metadataLoaded: false,
  };
  result.push(file);
  counters.files++;
  metadataScheduler.add(file);
  reportActivity({ phase: 'scanning', files: counters.files, currentFile: relativePath });
}

async function walk(uri, base, result, shouldInclude, reportActivity, counters, metadataScheduler, knownItems = null) {
  let items = knownItems;
  try {
    if (!items) {
      items = await FileSystem.StorageAccessFramework.readDirectoryAsync(uri);
    }
  } catch {
    const name = getSafName(uri);
    addFile(uri, base, name, result, shouldInclude, reportActivity, counters, metadataScheduler);
    return;
  }

  async function processItem(itemUri) {
    const name = getSafName(itemUri);
    const newBase = `${base}/${name}`;

    let childItems = null;
    try {
      childItems = await FileSystem.StorageAccessFramework.readDirectoryAsync(itemUri);
    } catch {
      childItems = null;
    }

    if (childItems) {
      await walk(itemUri, newBase, result, shouldInclude, reportActivity, counters, metadataScheduler, childItems);
    } else {
      addFile(itemUri, newBase, name, result, shouldInclude, reportActivity, counters, metadataScheduler);
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
  const shouldInclude = createFileMatcher(selectedTypes);
  const reportActivity = createScanReporter(onActivity);

  const foldersToScan = targetFolderUri
    ? folders.filter((f) => f.uri === targetFolderUri)
    : folders;

  const result = [];
  const counters = { files: 0 };
  const metadataScheduler = createMetadataScheduler(reportActivity);
  for (const folder of foldersToScan) {
    reportActivity({ phase: 'scanning', currentFile: folder.name, files: counters.files }, true);
    await walk(folder.uri, folder.name, result, shouldInclude, reportActivity, counters, metadataScheduler);
  }
  await metadataScheduler.drain();
  reportActivity({ phase: 'scanning', currentFile: '', files: counters.files }, true);
  return result;
}
