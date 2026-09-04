import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';

export const MAX_PREVIEW_CACHE_ITEMS = 10;

const TEMP_FILE_PREFIXES = [
  'restore_tmp_',
  'upload_tmp_',
  'freeup_preview_',
  'pending_preview_',
  'direct_post_',
  'memory_save_',
  'memory_share_',
  'media_save_',
  'media_share_',
  'flashback_save_',
  'roulette_',
  'roulette_share_',
  'rewind_',
  'recap_',
  'places_',
  'quiz_',
  'ReactNative-snapshot-',
  'tmp_',
];

/**
 * Dynamically returns the preview cache directory path.
 */
export function getPreviewCacheDir(): string {
  if (!FileSystem.cacheDirectory) return '';
  return `${FileSystem.cacheDirectory}preview_cache/`;
}

/**
 * Ensures that the preview cache directory exists on disk.
 */
export async function ensurePreviewCacheDir(): Promise<string> {
  const dir = getPreviewCacheDir();
  if (!dir) return '';
  try {
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (dirInfo.exists && !dirInfo.isDirectory) {
      await FileSystem.deleteAsync(dir, { idempotent: true });
    }
    if (!dirInfo.exists || !dirInfo.isDirectory) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return dir;
  } catch {
    return dir;
  }
}

/**
 * LRU Cache Pruner:
 * Keeps at most `maxItems` (default 10) preview files in the cache.
 * Deletes older preview files and stale temporary files to prevent cache expansion.
 */
export async function prunePreviewCache(maxItems: number = MAX_PREVIEW_CACHE_ITEMS): Promise<{ prunedCount: number; remainingCount: number }> {
  try {
    if (!FileSystem.cacheDirectory) return { prunedCount: 0, remainingCount: 0 };
    const dir = await ensurePreviewCacheDir();
    if (!dir) return { prunedCount: 0, remainingCount: 0 };

    // 1. Scan preview_cache directory
    const filenames = await FileSystem.readDirectoryAsync(dir);
    const fileEntries: { uri: string; mtime: number; size: number }[] = [];

    for (const name of filenames) {
      const uri = dir + name;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && !info.isDirectory) {
          const rawMtime = info.modificationTime ?? 0;
          const mtimeSec = rawMtime > 1e11 ? rawMtime / 1000 : rawMtime;
          fileEntries.push({
            uri,
            mtime: mtimeSec,
            size: (info as any).size ?? 0,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Sort descending by modification time (most recent first)
    fileEntries.sort((a, b) => b.mtime - a.mtime);

    let prunedCount = 0;

    // Delete entries exceeding maxItems
    if (fileEntries.length > maxItems) {
      const toRemove = fileEntries.slice(maxItems);
      for (const entry of toRemove) {
        try {
          await FileSystem.deleteAsync(entry.uri, { idempotent: true });
          prunedCount++;
        } catch {
          // Ignore deletion errors
        }
      }
    }

    // 2. Clean up stale temporary files in root cache directory older than 2 minutes
    try {
      const rootFiles = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
      const now = Date.now() / 1000;
      for (const fname of rootFiles) {
        if (TEMP_FILE_PREFIXES.some((prefix) => fname.startsWith(prefix))) {
          const rootUri = `${FileSystem.cacheDirectory}${fname}`;
          const info = await FileSystem.getInfoAsync(rootUri);
          if (info.exists) {
            const rawMtime = info.modificationTime ?? 0;
            const mtimeSec = rawMtime > 1e11 ? rawMtime / 1000 : rawMtime;
            if (mtimeSec > 0 && now - mtimeSec > 120) {
              await FileSystem.deleteAsync(rootUri, { idempotent: true }).catch(() => {});
            }
          }
        }
      }
    } catch {
      // Ignore root cache cleanup errors
    }

    // 3. Clean up stale temporary files in documentDirectory older than 2 minutes
    if (FileSystem.documentDirectory) {
      try {
        const docFiles = await FileSystem.readDirectoryAsync(FileSystem.documentDirectory);
        const now = Date.now() / 1000;
        for (const fname of docFiles) {
          if (TEMP_FILE_PREFIXES.some((prefix) => fname.startsWith(prefix))) {
            const docUri = `${FileSystem.documentDirectory}${fname}`;
            const info = await FileSystem.getInfoAsync(docUri);
            if (info.exists && !info.isDirectory) {
              const rawMtime = info.modificationTime ?? 0;
              const mtimeSec = rawMtime > 1e11 ? rawMtime / 1000 : rawMtime;
              if (mtimeSec > 0 && now - mtimeSec > 120) {
                await FileSystem.deleteAsync(docUri, { idempotent: true }).catch(() => {});
              }
            }
          }
        }
      } catch {
        // Ignore doc temp cleanup errors
      }
    }

    const remainingCount = Math.min(fileEntries.length, maxItems);
    return { prunedCount, remainingCount };
  } catch (err) {
    console.warn('[CacheManager] Error pruning preview cache:', err);
    return { prunedCount: 0, remainingCount: 0 };
  }
}

/**
 * Returns current statistics of all disk caches (file count & total bytes).
 */
export async function getPreviewCacheStats(): Promise<{ count: number; sizeBytes: number; formattedSize: string }> {
  try {
    if (!FileSystem.cacheDirectory) return { count: 0, sizeBytes: 0, formattedSize: '0 B' };

    let sizeBytes = 0;
    let count = 0;

    const visitedUris = new Set<string>();

    async function measureDir(dirUri: string) {
      if (visitedUris.has(dirUri)) return;
      visitedUris.add(dirUri);
      try {
        const filenames = await FileSystem.readDirectoryAsync(dirUri);
        for (const name of filenames) {
          const uri = dirUri.endsWith('/') ? `${dirUri}${name}` : `${dirUri}/${name}`;
          try {
            const info = await FileSystem.getInfoAsync(uri);
            if (info.exists) {
              if (info.isDirectory) {
                await measureDir(uri);
              } else {
                count++;
                sizeBytes += (info as any).size ?? 0;
              }
            }
          } catch {}
        }
      } catch {}
    }

    await measureDir(FileSystem.cacheDirectory);

    // Also count temporary files in documentDirectory
    if (FileSystem.documentDirectory) {
      try {
        const docEntries = await FileSystem.readDirectoryAsync(FileSystem.documentDirectory);
        for (const fname of docEntries) {
          if (TEMP_FILE_PREFIXES.some((p) => fname.startsWith(p))) {
            const uri = `${FileSystem.documentDirectory}${fname}`;
            const info = await FileSystem.getInfoAsync(uri);
            if (info.exists && !info.isDirectory) {
              count++;
              sizeBytes += (info as any).size ?? 0;
            }
          }
        }
      } catch {}
    }

    const formattedSize = formatBytes(sizeBytes);
    return { count, sizeBytes, formattedSize };
  } catch {
    return { count: 0, sizeBytes: 0, formattedSize: '0 B' };
  }
}

/**
 * Completely clears all preview files, temp files, image caches, and document directory temp files.
 */
export async function clearAllDiskCache(): Promise<void> {
  try {
    // 1. Clear Expo Image memory and disk cache
    try {
      Image.clearMemoryCache();
      await Image.clearDiskCache().catch(() => {});
    } catch {}

    // 2. Clear everything in FileSystem.cacheDirectory
    if (FileSystem.cacheDirectory) {
      try {
        const rootEntries = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
        for (const entry of rootEntries) {
          const entryUri = `${FileSystem.cacheDirectory}${entry}`;
          await FileSystem.deleteAsync(entryUri, { idempotent: true }).catch(() => {});
        }
      } catch (err) {
        console.warn('[CacheManager] Error deleting cacheDirectory entries:', err);
      }
      // Re-ensure preview cache dir
      await ensurePreviewCacheDir().catch(() => {});
    }

    // 3. Scan and delete temporary files in FileSystem.documentDirectory
    if (FileSystem.documentDirectory) {
      try {
        const docEntries = await FileSystem.readDirectoryAsync(FileSystem.documentDirectory);
        for (const fname of docEntries) {
          if (TEMP_FILE_PREFIXES.some((prefix) => fname.startsWith(prefix))) {
            const docUri = `${FileSystem.documentDirectory}${fname}`;
            await FileSystem.deleteAsync(docUri, { idempotent: true }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[CacheManager] Error deleting documentDirectory temp files:', err);
      }
    }
  } catch (err) {
    console.warn('[CacheManager] Error clearing disk cache:', err);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}


