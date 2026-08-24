import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Alert,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  Modal,
  Dimensions,
  Pressable,
  PanResponder,
  Animated,
  Easing,
  Linking,
  TextInput,
  RefreshControl,
} from 'react-native';
import ReAnimated from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useEvent } from 'expo';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import { AppColors, Spacing, Radius, TextScale, BottomTabInset, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useCollapsibleHeader } from '@/hooks/useCollapsibleHeader';
import {
  downloadFile,
  listSharedSources,
  downloadSharedFile,
  getConfig,
  buildPreviewUrl,
  buildThumbnailUrl,
  buildVideoPreviewUrl,
  warmVideoPreviews,
  getTodaysMemories,
  browseFiles,
  browseSharedFiles,
  searchFiles,
  searchSharedFiles,
  listServerFiles,
  listSharedFiles,
  reactToMedia,
  getSharedFeed,
} from '../../downloader';
import { checkDeviceConnection } from '../../uploader';
import { getServerIp } from '../../settings';
import { getCurrentSyncState } from '../../backgroundTask';
import { prunePreviewCache } from '@/utils/previewCacheManager';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import { hapticSelection, hapticLongPress, hapticSuccess, hapticError } from '@/utils/haptics';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const getCurrentTimestamp = (): number => Date.now();

type ExpoVideoModule = typeof import('expo-video');
type VideoSource = import('expo-video').VideoSource;
type ExpoAudioModule = typeof import('expo-audio');

// This project can be run by an already-installed development client. Such a
// client may predate expo-video/expo-audio, so importing either module at the
// top level would crash the complete Restore route before it can render.
let expoVideoModule: ExpoVideoModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  console.warn('[Media] ExpoVideo is unavailable; using the external-player fallback.');
}

let expoAudioModule: ExpoAudioModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  expoAudioModule = require('expo-audio') as ExpoAudioModule;
} catch {
  console.warn('[Media] ExpoAudio is unavailable; using the external-player fallback.');
}

/** Guard native player controls — never throw into RN from teardown races. */
function safeMediaCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn('[Media] Player control failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SourceMode = 'phone' | 'shared';

type SharedSource = { id: string; label: string };

type RemoteFile = {
  path: string;
  size: number;
  modified_time: number;
  sha256?: string;
  uploaded_time?: number;
  media_id?: number;
  reaction_counts?: Record<string, number>;
  user_reactions?: string[];
  is_video?: boolean;
};

type ServerConfig = { ip: string; port: string; key: string; deviceId: string } | null;

/** A node in the recursive folder tree */
type TreeNode = {
  name: string;
  key: string;
  isFolder: boolean;
  file?: RemoteFile;
  children: TreeNode[];
  totalSize: number;
  fileCount: number;
  filePaths: string[];
  loaded?: boolean;
  loading?: boolean;
};

type FlatRow = { node: TreeNode; depth: number };

type SortField = 'name' | 'date' | 'type' | 'size';
type SortDir   = 'asc' | 'desc';
type SortPreference = { field: SortField; dir: SortDir };

type FileCategory = 'image' | 'video' | 'audio' | 'other';

const RESTORE_SORT_PREFERENCE_KEY = 'restore_sort_preference_v1';

function parseSortPreference(raw: string | null): SortPreference | null {
  if (!raw) return null;
  try {
    const preference: unknown = JSON.parse(raw);
    if (
      typeof preference === 'object' &&
      preference !== null &&
      ['name', 'date', 'type', 'size'].includes((preference as SortPreference).field) &&
      ['asc', 'desc'].includes((preference as SortPreference).dir)
    ) {
      return preference as SortPreference;
    }
  } catch {
    // Ignore malformed preferences and use the date default instead.
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// File-type helpers
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v', 'wmv', 'flv', 'ts', 'mts']);
const AUDIO_EXTS = new Set(['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'wma', 'aiff']);

function getExt(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase();
}

function getFileCategory(name: string): FileCategory {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'other';
}

function isMediaExtension(ext: string): boolean {
  return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

/** Returns a color/icon for a file category to use in the metadata card */
function categoryMeta(cat: FileCategory): { icon: string; iosIcon: string; label: string } {
  switch (cat) {
    case 'image': return { icon: 'image', iosIcon: 'photo', label: 'Image' };
    case 'video': return { icon: 'videocam', iosIcon: 'video', label: 'Video' };
    case 'audio': return { icon: 'music_note', iosIcon: 'music.note', label: 'Audio' };
    default:      return { icon: 'insert_drive_file', iosIcon: 'doc', label: 'File' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function formatMediaTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function sanitizeRelativePath(raw: string): string {
  const normalised = raw.replace(/\\/g, '/');
  const match = normalised.match(/^([^/]+):(.+)$/);
  if (!match) return normalised;
  const [, volume, rest] = match;
  if (volume.toLowerCase() === 'primary') return rest;
  return `${volume}/${rest}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree construction & helpers
// ─────────────────────────────────────────────────────────────────────────────

function nodeFromBrowseFolder(entry: { name: string; path: string; file_count?: number; total_size?: number }): TreeNode {
  return {
    name: entry.name,
    key: entry.path,
    isFolder: true,
    children: [],
    totalSize: entry.total_size ?? 0,
    fileCount: entry.file_count ?? 0,
    filePaths: [],
    loaded: false,
  };
}

function nodeFromBrowseFile(file: RemoteFile): TreeNode {
  const name = sanitizeRelativePath(file.path).split('/').pop() ?? file.path;
  return {
    name,
    key: file.path,
    isFolder: false,
    file,
    children: [],
    totalSize: file.size,
    fileCount: 1,
    filePaths: [file.path],
  };
}

function buildRootFromBrowse(data: { folders: any[]; files: RemoteFile[] }): TreeNode {
  const children: TreeNode[] = [
    ...data.folders.map(nodeFromBrowseFolder),
    ...data.files.map(nodeFromBrowseFile),
  ];
  return { name: '__root__', key: '__root__', isFolder: true, children, totalSize: 0, fileCount: 0, filePaths: [], loaded: true };
}

function replaceNodeChildren(node: TreeNode, targetKey: string, children: TreeNode[]): TreeNode {
  if (node.key === targetKey) return { ...node, children, loaded: true, loading: false };
  if (!node.children.length) return node;
  return { ...node, children: node.children.map(c => replaceNodeChildren(c, targetKey, children)) };
}

function markNodeLoading(node: TreeNode, targetKey: string, loading: boolean): TreeNode {
  if (node.key === targetKey) return { ...node, loading };
  if (!node.children.length) return node;
  return { ...node, children: node.children.map(c => markNodeLoading(c, targetKey, loading)) };
}

function collectSubtreePaths(node: TreeNode): string[] {
  if (!node.isFolder) {
    return node.file ? [node.file.path] : [node.key];
  }
  const result: string[] = [];
  for (const child of node.children) {
    result.push(...collectSubtreePaths(child));
  }
  return result;
}

function collectSubtreeFiles(node: TreeNode): RemoteFile[] {
  if (!node.isFolder) {
    return node.file ? [node.file] : [];
  }
  const result: RemoteFile[] = [];
  for (const child of node.children) {
    result.push(...collectSubtreeFiles(child));
  }
  return result;
}

function isSubtreeFullyLoaded(node: TreeNode): boolean {
  if (!node.isFolder) return true;
  if (!node.loaded) return false;
  return node.children.every(isSubtreeFullyLoaded);
}

function folderSelectionState(node: TreeNode, selectedPaths: Set<string>): 'none' | 'partial' | 'all' {
  if (selectedPaths.size === 0) return 'none';
  const loadedPaths = collectSubtreePaths(node);
  if (loadedPaths.length > 0) {
    let selected = 0;
    for (const p of loadedPaths) {
      if (selectedPaths.has(p)) selected++;
    }
    if (selected === 0) return 'none';
    if (selected === loadedPaths.length && (node.fileCount <= 0 || selected >= node.fileCount)) return 'all';
    return 'partial';
  }
  const prefix = node.key.endsWith('/') ? node.key : `${node.key}/`;
  let matching = 0;
  for (const p of selectedPaths) {
    if (p.startsWith(prefix) || p === node.key) matching++;
  }
  if (matching === 0) return 'none';
  if ((node.fileCount > 0 && matching >= node.fileCount) || (node.fileCount <= 0 && matching > 0)) return 'all';
  return 'partial';
}

function flattenVisibleRows(nodes: TreeNode[], depth: number, expandedKeys: Set<string>, out: FlatRow[]): void {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.isFolder && node.children.length > 0 && expandedKeys.has(node.key)) {
      flattenVisibleRows(node.children, depth + 1, expandedKeys, out);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort helpers
// ─────────────────────────────────────────────────────────────────────────────

function sortTreeChildren(node: TreeNode, field: SortField, dir: SortDir): TreeNode {
  if (!node.isFolder) return node;
  const sorted = [...node.children].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;

    let cmp = 0;
    if (field === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (field === 'size') {
      cmp = a.totalSize - b.totalSize;
    } else if (field === 'date') {
      const ta = a.file?.uploaded_time ?? a.file?.modified_time ?? 0;
      const tb = b.file?.uploaded_time ?? b.file?.modified_time ?? 0;
      cmp = ta - tb;
    } else if (field === 'type') {
      const ea = getExt(a.name);
      const eb = getExt(b.name);
      cmp = ea.localeCompare(eb);
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return { ...node, children: sorted.map(c => sortTreeChildren(c, field, dir)) };
}

function compareRemoteFiles(a: RemoteFile, b: RemoteFile, field: SortField, dir: SortDir): number {
  const nameA = a.path.split(/[/\\]/).pop() ?? a.path;
  const nameB = b.path.split(/[/\\]/).pop() ?? b.path;
  let cmp = 0;
  if (field === 'name') {
    cmp = nameA.localeCompare(nameB);
  } else if (field === 'size') {
    cmp = (a.size ?? 0) - (b.size ?? 0);
  } else if (field === 'date') {
    cmp = (a.uploaded_time ?? a.modified_time ?? 0) - (b.uploaded_time ?? b.modified_time ?? 0);
  } else if (field === 'type') {
    cmp = getExt(a.path).localeCompare(getExt(b.path));
    if (cmp === 0) cmp = nameA.localeCompare(nameB);
  }
  return dir === 'asc' ? cmp : -cmp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reaction Bar & Feed Card Components
// ─────────────────────────────────────────────────────────────────────────────

const REACTION_EMOJIS = ['❤️', '😂', '😮', '👍'];

function ReactionEmojiBar({
  reactionCounts,
  userReactions,
  onReact,
  colors,
}: {
  reactionCounts?: Record<string, number>;
  userReactions?: string[];
  onReact: (emoji: string) => void;
  colors: AppColors;
}) {
  return (
    <View style={reactionStyles.bar}>
      {REACTION_EMOJIS.map((emoji) => {
        const count = reactionCounts?.[emoji] || 0;
        const active = userReactions?.includes(emoji) || false;
        return (
          <TouchableOpacity
            key={emoji}
            onPress={() => onReact(emoji)}
            style={[
              reactionStyles.emojiBtn,
              {
                backgroundColor: active ? colors.primarySoft : colors.surfaceSoft,
                borderColor: active ? colors.primary : colors.surfaceBorder,
              },
            ]}
            activeOpacity={0.7}
          >
            <Text style={reactionStyles.emojiText}>{emoji}</Text>
            {count > 0 && (
              <Text
                style={[
                  reactionStyles.countText,
                  { color: active ? colors.primary : colors.textSecondary },
                ]}
              >
                {count}
              </Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SharedFeedCard({
  item,
  serverConfig,
  sourceId,
  onPreview,
  onReact,
  colors,
}: {
  item: RemoteFile;
  serverConfig: ServerConfig;
  sourceId: string;
  onPreview: (file: RemoteFile) => void;
  onReact: (file: RemoteFile, emoji: string) => void;
  colors: AppColors;
}) {
  const category = getFileCategory(item.path);
  const isVideo = category === 'video';
  const fileName = item.path.split(/[/\\]/).pop() ?? item.path;
  const thumbUrl = serverConfig
    ? isVideo
      ? buildThumbnailUrl(serverConfig, item.path, 'shared', sourceId)
      : buildPreviewUrl(serverConfig, item.path, 'shared', sourceId)
    : '';

  return (
    <View style={[feedCardStyles.card, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}>
      <TouchableOpacity
        style={feedCardStyles.mediaWrap}
        onPress={() => onPreview(item)}
        activeOpacity={0.9}
      >
        <Image
          source={{ uri: thumbUrl }}
          style={feedCardStyles.mediaImage}
          contentFit="cover"
          transition={150}
        />
        {isVideo && (
          <View style={feedCardStyles.videoBadge}>
            <AppIcon androidName="play_arrow" iosName="play.fill" color="#fff" size={24} />
          </View>
        )}
      </TouchableOpacity>

      <View style={feedCardStyles.body}>
        <View style={feedCardStyles.headerRow}>
          <Text style={[feedCardStyles.fileName, { color: colors.text }]} numberOfLines={1}>
            {fileName}
          </Text>
          <Text style={[feedCardStyles.fileDate, { color: colors.textMuted }]}>
            {formatDate(item.modified_time)}
          </Text>
        </View>
        <Text style={[feedCardStyles.fileSize, { color: colors.textSecondary }]}>
          {formatSize(item.size)}
        </Text>

        <ReactionEmojiBar
          reactionCounts={item.reaction_counts}
          userReactions={item.user_reactions}
          onReact={(emoji) => onReact(item, emoji)}
          colors={colors}
        />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Selector
// ─────────────────────────────────────────────────────────────────────────────

type SourceSelectorProps = {
  mode: SourceMode;
  sharedSources: SharedSource[];
  selectedSourceId: string | null;
  sharedViewMode?: 'feed' | 'folder';
  onSharedViewModeChange?: (vmode: 'feed' | 'folder') => void;
  isLoadingSources: boolean;
  isOffline: boolean;
  sortEnabled: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onModeChange: (mode: SourceMode) => void;
  onSourceSelect: (source: SharedSource) => void;
  onSortChange: (field: SortField, dir: SortDir) => void;
  colors: AppColors;
};

function SourceSelector({
  mode, sharedSources, selectedSourceId, sharedViewMode = 'feed', onSharedViewModeChange,
  isLoadingSources, isOffline, sortEnabled, sortField, sortDir,
  onModeChange, onSourceSelect, onSortChange, colors,
}: SourceSelectorProps) {
  const [showSourceMenu, setShowSourceMenu] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const selectedSource = sharedSources.find(s => s.id === selectedSourceId);

  const handleSortSelect = (field: SortField) => {
    onSortChange(field, field === sortField && sortDir === 'asc' ? 'desc' : 'asc');
    setShowSortMenu(false);
  };

  return (
    <View style={[srcStyles.container, { backgroundColor: colors.surface, borderBottomColor: colors.surfaceBorder }]}>
      <View style={srcStyles.pillRow}>
        <TouchableOpacity
          onPress={() => {
            setShowSourceMenu(false);
            setShowSortMenu(false);
            onModeChange('phone');
          }}
          style={[
            srcStyles.pill,
            { borderColor: mode === 'phone' ? colors.primary : colors.surfaceBorder,
              backgroundColor: mode === 'phone' ? colors.primarySoft : 'transparent' },
          ]}
          activeOpacity={0.75}
        >
          <AppIcon androidName="smartphone" iosName="iphone" color={mode === 'phone' ? colors.primary : colors.textSecondary} size={14} />
          <Text style={[srcStyles.pillText, { color: mode === 'phone' ? colors.primary : colors.textSecondary }]}>
            Phone Backups
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            setShowSortMenu(false);
            onModeChange('shared');
          }}
          style={[
            srcStyles.pill,
            { borderColor: mode === 'shared' ? colors.primary : colors.surfaceBorder,
              backgroundColor: mode === 'shared' ? colors.primarySoft : 'transparent' },
          ]}
          activeOpacity={0.75}
        >
          <AppIcon androidName="folder_open" iosName="folder" color={mode === 'shared' ? colors.primary : colors.textSecondary} size={14} />
          <Text style={[srcStyles.pillText, { color: mode === 'shared' ? colors.primary : colors.textSecondary }]}>
            Shared Folders
          </Text>
        </TouchableOpacity>

        {sortEnabled && (
          <TouchableOpacity
            onPress={() => {
              setShowSourceMenu(false);
              setShowSortMenu(visible => !visible);
            }}
            style={[
              srcStyles.sortButton,
              {
                backgroundColor: showSortMenu ? colors.primarySoft : 'transparent',
                borderColor: showSortMenu ? colors.primary : colors.surfaceBorder,
              },
            ]}
            activeOpacity={0.75}
            accessibilityLabel="Sort files"
            accessibilityHint={`Currently sorted by ${sortField}, ${sortDir === 'asc' ? 'asc' : 'desc'}`}
          >
            <AppIcon
              androidName="sort"
              iosName="arrow.up.arrow.down"
              color={showSortMenu ? colors.primary : colors.textSecondary}
              size={18}
              fallback="↕"
            />
          </TouchableOpacity>
        )}
      </View>

      {showSortMenu && sortEnabled && (
        <View style={[srcStyles.sortMenu, { backgroundColor: colors.surfaceElevated, borderColor: colors.surfaceBorder }]}>
          {SORT_OPTIONS.map(option => {
            const isActive = option.field === sortField;
            return (
              <TouchableOpacity
                key={option.field}
                style={[
                  srcStyles.sortMenuItem,
                  isActive && { backgroundColor: colors.primarySoft },
                ]}
                onPress={() => handleSortSelect(option.field)}
                activeOpacity={0.75}
              >
                <Text
                  style={[
                    srcStyles.sortMenuItemText,
                    { color: isActive ? colors.primary : colors.text },
                  ]}
                >
                  {option.label}
                </Text>
                {isActive && (
                  <View style={srcStyles.sortDirection}>
                    <Text style={[srcStyles.sortDirectionText, { color: colors.primary }]}>
                      {sortDir === 'asc' ? '↑' : '↓'}
                    </Text>
                    <AppIcon
                      androidName="check"
                      iosName="checkmark"
                      color={colors.primary}
                      size={14}
                    />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {mode === 'shared' && (
        <View style={srcStyles.sourceRow}>
          {isOffline ? (
            <Text style={[srcStyles.noSourceText, { color: colors.textMuted }]}>
              Connect to a server to load shared folders.
            </Text>
          ) : isLoadingSources ? (
            <View style={srcStyles.sourceLoadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[srcStyles.sourceLoadingText, { color: colors.textSecondary }]}>
                Loading shared sources…
              </Text>
            </View>
          ) : sharedSources.length === 0 ? (
            <Text style={[srcStyles.noSourceText, { color: colors.textMuted }]}>
              No shared folders configured. Add folders in the Desktop app → Settings.
            </Text>
          ) : (
            <>
              <View style={srcStyles.sharedControlsRow}>
                <TouchableOpacity
                  style={[srcStyles.sourcePicker, { backgroundColor: colors.surfaceElevated, borderColor: colors.surfaceBorder }]}
                  onPress={() => setShowSourceMenu(v => !v)}
                  activeOpacity={0.8}
                >
                  <AppIcon androidName="folder" iosName="folder.fill" color={colors.primary} size={16} />
                  <Text style={[srcStyles.sourcePickerText, { color: colors.text }]} numberOfLines={1}>
                    {selectedSource ? selectedSource.label : 'Select a folder…'}
                  </Text>
                  <AppIcon androidName={showSourceMenu ? 'expand_less' : 'expand_more'} iosName={showSourceMenu ? 'chevron.up' : 'chevron.down'} color={colors.textSecondary} size={18} />
                </TouchableOpacity>

                {selectedSourceId && (
                  <View style={[srcStyles.viewSwitcherWrap, { backgroundColor: colors.surfaceSoft }]}>
                    <TouchableOpacity
                      style={[
                        srcStyles.viewSwitchBtn,
                        sharedViewMode === 'feed' && [srcStyles.viewSwitchBtnActive, { backgroundColor: colors.primary }],
                      ]}
                      onPress={() => onSharedViewModeChange?.('feed')}
                      activeOpacity={0.8}
                    >
                      <AppIcon
                        androidName="dynamic_feed"
                        iosName="rectangle.grid.1x2"
                        color={sharedViewMode === 'feed' ? '#fff' : colors.textSecondary}
                        size={14}
                      />
                      <Text style={[srcStyles.viewSwitchBtnText, { color: sharedViewMode === 'feed' ? '#fff' : colors.textSecondary }]}>
                        Feed
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        srcStyles.viewSwitchBtn,
                        sharedViewMode === 'folder' && [srcStyles.viewSwitchBtnActive, { backgroundColor: colors.primary }],
                      ]}
                      onPress={() => onSharedViewModeChange?.('folder')}
                      activeOpacity={0.8}
                    >
                      <AppIcon
                        androidName="folder"
                        iosName="folder"
                        color={sharedViewMode === 'folder' ? '#fff' : colors.textSecondary}
                        size={14}
                      />
                      <Text style={[srcStyles.viewSwitchBtnText, { color: sharedViewMode === 'folder' ? '#fff' : colors.textSecondary }]}>
                        Tree
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {showSourceMenu && (
                <View style={[srcStyles.sourceMenu, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}>
                  {sharedSources.map(src => (
                    <TouchableOpacity
                      key={src.id}
                      style={[
                        srcStyles.sourceMenuItem,
                        src.id === selectedSourceId && { backgroundColor: colors.primarySoft },
                      ]}
                      onPress={() => {
                        onSourceSelect(src);
                        setShowSourceMenu(false);
                      }}
                      activeOpacity={0.75}
                    >
                      <AppIcon androidName="folder" iosName="folder.fill" color={src.id === selectedSourceId ? colors.primary : colors.textSecondary} size={16} />
                      <Text style={[srcStyles.sourceMenuItemText, { color: src.id === selectedSourceId ? colors.primary : colors.text }]}>
                        {src.label}
                      </Text>
                      {src.id === selectedSourceId && (
                        <AppIcon androidName="check" iosName="checkmark" color={colors.primary} size={14} />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const reactionStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  emojiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 5,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  emojiText: {
    fontSize: TextScale.sm,
  },
  countText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
});

const feedCardStyles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: Spacing.four,
  },
  mediaWrap: {
    width: '100%',
    height: 220,
    backgroundColor: '#000',
    position: 'relative',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  videoBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -20,
    marginLeft: -20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: Spacing.three,
    gap: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  fileName: {
    fontSize: TextScale.base,
    fontWeight: '700',
    flex: 1,
  },
  fileDate: {
    fontSize: TextScale.xs,
  },
  fileSize: {
    fontSize: TextScale.xs,
    marginTop: 1,
  },
});

const srcStyles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: Spacing.two,
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.three,
    paddingVertical: 7,
    borderRadius: Radius.full,
    borderWidth: 1.5,
  },
  pillText: { fontSize: TextScale.xs, fontWeight: '700' },
  sortButton: {
    width: 32,
    height: 32,
    marginLeft: 'auto',
    borderWidth: 1,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortMenu: {
    marginHorizontal: Spacing.four,
    marginTop: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  sortMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  sortMenuItemText: { flex: 1, fontSize: TextScale.sm, fontWeight: '600' },
  sortDirection: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  sortDirectionText: { fontSize: TextScale.sm, fontWeight: '800' },
  sourceRow: { paddingHorizontal: Spacing.four, paddingTop: Spacing.two },
  sourceLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  sourceLoadingText: { fontSize: TextScale.xs },
  noSourceText: { fontSize: TextScale.xs, lineHeight: 18 },
  sharedControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  sourcePicker: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
  },
  sourcePickerText: { flex: 1, fontSize: TextScale.sm, fontWeight: '500' },
  sourceMenu: {
    marginTop: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  sourceMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  sourceMenuItemText: { flex: 1, fontSize: TextScale.sm, fontWeight: '500' },
  viewSwitcherWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: Radius.full,
    padding: 2,
  },
  viewSwitchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.two + 2,
    paddingVertical: 6,
    borderRadius: Radius.full,
  },
  viewSwitchBtnActive: {},
  viewSwitchBtnText: { fontSize: TextScale.xs, fontWeight: '700' },
});

function LibraryFilterBar({
  query,
  onQueryChange,
  matchCount,
  totalCount,
  colors,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  matchCount: number;
  totalCount: number;
  colors: AppColors;
}) {
  const isFiltering = query.trim().length > 0;
  return (
    <View style={[filterStyles.wrap, { borderBottomColor: colors.surfaceBorder }]}>
      <View style={[filterStyles.searchBox, { backgroundColor: colors.surfaceElevated, borderColor: colors.surfaceBorder }]}>
        <AppIcon androidName="search" iosName="magnifyingglass" color={colors.textMuted} size={16} />
        <TextInput
          style={[filterStyles.searchInput, { color: colors.text }]}
          value={query}
          onChangeText={onQueryChange}
          placeholder="Search files by name"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          underlineColorAndroid="transparent"
          accessibilityLabel="Search files by name"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => onQueryChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <AppIcon androidName="close" iosName="xmark.circle.fill" color={colors.textMuted} size={16} />
          </TouchableOpacity>
        )}
      </View>
      {isFiltering && (
        <Text style={[filterStyles.matchLabel, { color: colors.textMuted }]}>
          {matchCount.toLocaleString()} of {totalCount.toLocaleString()} files
        </Text>
      )}
    </View>
  );
}

const filterStyles = StyleSheet.create({
  wrap: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    gap: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.three,
    minHeight: 40,
  },
  searchInput: {
    flex: 1,
    fontSize: TextScale.sm,
    fontWeight: '600',
    paddingVertical: 8,
  },
  matchLabel: { fontSize: TextScale.xs, fontWeight: '600' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview Modal
// ─────────────────────────────────────────────────────────────────────────────

type PreviewModalProps = {
  file: RemoteFile | null;
  fileList: RemoteFile[];      // ordered flat list of all previewable files
  currentIndex: number;        // index of `file` in fileList
  sourceMode: SourceMode;
  selectedSourceId: string | null;
  serverConfig: ServerConfig;
  onClose: () => void;
  onNavigate: (index: number) => void;  // called when user navigates
  onDownload: (file: RemoteFile) => void;
  colors: AppColors;
};

type TransitionState = {
  toIndex: number;
};

const PreviewModal = React.memo(function PreviewModal({
  file, fileList, currentIndex, sourceMode, selectedSourceId, serverConfig,
  onClose, onNavigate, onDownload, colors,
}: PreviewModalProps) {
  const insets = useSafeAreaInsets();

  // Keep a local override only while this modal is driving navigation.
  const [internalActiveIdx, setInternalActiveIdx] = useState<number | null>(null);
  const activeIdx = internalActiveIdx ?? currentIndex;

  const currentFile = fileList[activeIdx] ?? file;
  const category = currentFile ? getFileCategory(currentFile.path) : 'other';
  const fileName = currentFile ? (currentFile.path.split(/[/\\]/).pop() ?? currentFile.path) : '';

  // Synchronous preview URL generator
  const getUrlForFile = useCallback((f: RemoteFile | null): string => {
    if (!f || !serverConfig) return '';
    return buildPreviewUrl(serverConfig, f.path, sourceMode, selectedSourceId);
  }, [serverConfig, sourceMode, selectedSourceId]);

  const getVideoPreviewUrlForFile = useCallback((f: RemoteFile | null): string => {
    if (!f || !serverConfig) return '';
    return buildVideoPreviewUrl(serverConfig, f.path, sourceMode, selectedSourceId);
  }, [serverConfig, sourceMode, selectedSourceId]);

  const previewUrl = useMemo(() => getUrlForFile(currentFile), [getUrlForFile, currentFile]);
  const prevFile = fileList[activeIdx - 1] ?? null;
  const nextFile = fileList[activeIdx + 1] ?? null;
  const prevVideoPreviewUrl = useMemo(() => getVideoPreviewUrlForFile(prevFile), [getVideoPreviewUrlForFile, prevFile]);
  const nextVideoPreviewUrl = useMemo(() => getVideoPreviewUrlForFile(nextFile), [getVideoPreviewUrlForFile, nextFile]);

  // Loading state for images
  const [imgLoading, setImgLoading] = useState(category === 'image');
  const [transition, setTransition] = useState<TransitionState | null>(null);
  // Pause native players while still mounted, then unmount — avoids the
  // close/swipe crash from controlling a player mid-teardown.
  const [isDismissing, setIsDismissing] = useState(false);
  const mediaActive = !transition && !isDismissing;

  // Session-level de-dupe so we don't repeatedly warm the same video.
  const warmedPreviewPathsRef = useRef<Set<string>>(new Set());

  // Warm current/adjacent videos when the user navigates via swipe.
  useEffect(() => {
    if (sourceMode === 'shared' && !selectedSourceId) return;

    const candidates = [
      fileList[activeIdx],
      fileList[activeIdx - 1],
      fileList[activeIdx + 1],
    ].filter(Boolean) as RemoteFile[];

    const newlyWarm = candidates
      .filter(f => getFileCategory(f.path) === 'video')
      .filter(f => !warmedPreviewPathsRef.current.has(f.path))
      .slice(0, 3);

    if (newlyWarm.length === 0) return;

    newlyWarm.forEach(f => warmedPreviewPathsRef.current.add(f.path));
    void warmVideoPreviews(
      newlyWarm.map(f => f.path),
      sourceMode,
      sourceMode === 'shared' ? selectedSourceId : null,
    ).catch(() => undefined);
  }, [activeIdx, fileList, sourceMode, selectedSourceId]);

  // ── Swipe navigation animation ──────────────────────────────────────────────
  const [slideAnim] = useState(() => new Animated.Value(0));
  const [incomingSlideAnim] = useState(() => new Animated.Value(0));
  const [isAnimating, setIsAnimating] = useState(false);

  // Automatically prune disk cache to last 10 preview items
  useEffect(() => {
    prunePreviewCache(10);
  }, [activeIdx]);

  // Prefetch adjacent image files to make preview swiping instantaneous
  useEffect(() => {
    const nextFile = fileList[activeIdx + 1];
    const prevFile = fileList[activeIdx - 1];
    [nextFile, prevFile].forEach(f => {
      if (f && (getFileCategory(f.path) === 'image')) {
        const url = getUrlForFile(f);
        if (url) {
          Image.prefetch(url);
        }
      }
    });
  }, [activeIdx, fileList, getUrlForFile]);

  const hasPrev = activeIdx > 0;
  const hasNext = activeIdx < fileList.length - 1;
  const canZoom = category === 'image' || category === 'video';
  // Zoom UI (buttons + pill) only for images — video outer panResponder is disabled so no gesture zoom
  const canZoomUI = category === 'image';

  // Zoom parameters
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 5;
  const DOUBLE_TAP_ZOOM = 2.5;

  const [scaleAnim] = useState(() => new Animated.Value(1));
  const [translateXAnim] = useState(() => new Animated.Value(0));
  const [translateYAnim] = useState(() => new Animated.Value(0));

  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef({ x: 0, y: 0 });
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null);
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaleDisplayRafRef = useRef<number | null>(null);

  const [currentScaleDisplay, setCurrentScaleDisplay] = useState(1);

  useEffect(() => {
    return () => {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      if (scaleDisplayRafRef.current != null) {
        cancelAnimationFrame(scaleDisplayRafRef.current);
        scaleDisplayRafRef.current = null;
      }
    };
  }, []);

  const scheduleScaleDisplay = useCallback((nextScale: number) => {
    if (scaleDisplayRafRef.current != null) return;
    scaleDisplayRafRef.current = requestAnimationFrame(() => {
      scaleDisplayRafRef.current = null;
      setCurrentScaleDisplay(nextScale);
    });
  }, []);

  const resetZoom = useCallback((animated: boolean) => {
    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
    setCurrentScaleDisplay(1);
    if (animated) {
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 0 }),
        Animated.spring(translateXAnim, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 0 }),
        Animated.spring(translateYAnim, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 0 }),
      ]).start();
    } else {
      scaleAnim.setValue(1);
      translateXAnim.setValue(0);
      translateYAnim.setValue(0);
    }
  }, [scaleAnim, translateXAnim, translateYAnim]);

  // Fullscreen mode state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chromeAnim] = useState(() => new Animated.Value(0));

  // Reset zoom and fullscreen when file changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsFullscreen(false);
    scaleAnim.setValue(1);
    translateXAnim.setValue(0);
    translateYAnim.setValue(0);
    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
  }, [currentFile?.path, scaleAnim, translateXAnim, translateYAnim]);

  const setZoomTo = useCallback((targetScale: number) => {
    const nextScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetScale));
    scaleRef.current = nextScale;
    setCurrentScaleDisplay(nextScale);
    if (nextScale === 1) {
      translateRef.current = { x: 0, y: 0 };
    }
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: nextScale, useNativeDriver: true, speed: 22, bounciness: 0 }),
      Animated.spring(translateXAnim, { toValue: translateRef.current.x, useNativeDriver: true, speed: 22, bounciness: 0 }),
      Animated.spring(translateYAnim, { toValue: translateRef.current.y, useNativeDriver: true, speed: 22, bounciness: 0 }),
    ]).start();
  }, [scaleAnim, translateXAnim, translateYAnim]);

  const zoomIn = useCallback(() => {
    setZoomTo(scaleRef.current + 0.5);
  }, [setZoomTo]);

  const zoomOut = useCallback(() => {
    setZoomTo(scaleRef.current - 0.5);
  }, [setZoomTo]);

  // Smooth slide navigation helper
  const animateToFile = useCallback((targetIndex: number, startDx?: number) => {
    if (isDismissing || isAnimating || targetIndex < 0 || targetIndex >= fileList.length || targetIndex === activeIdx) return;
    setIsAnimating(true);

    const isNext = targetIndex > activeIdx;
    const direction: 1 | -1 = isNext ? 1 : -1;
    const slideOutVal = direction === 1 ? -SCREEN_W : SCREEN_W;
    const slideInStartVal = direction === 1 ? SCREEN_W : -SCREEN_W;

    const fromVal = startDx !== undefined ? startDx : 0;
    slideAnim.setValue(fromVal);
    incomingSlideAnim.setValue(slideInStartVal + fromVal);
    setTransition({ toIndex: targetIndex });

    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: slideOutVal,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(incomingSlideAnim, {
        toValue: 0,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      setInternalActiveIdx(targetIndex);
      onNavigate(targetIndex);
      setTransition(null);
      setIsAnimating(false);
      slideAnim.setValue(0);
      incomingSlideAnim.setValue(0);
      scaleAnim.setValue(1);
      translateXAnim.setValue(0);
      translateYAnim.setValue(0);
      scaleRef.current = 1;
      translateRef.current = { x: 0, y: 0 };
    });
  }, [isDismissing, isAnimating, fileList.length, activeIdx, slideAnim, incomingSlideAnim, onNavigate, scaleAnim, translateXAnim, translateYAnim]);

  const handleClose = useCallback(() => {
    if (isDismissing) return;
    setIsDismissing(true);
  }, [isDismissing]);

  useEffect(() => {
    if (!isDismissing) return;
    // After players observe isActive=false and pause, unmount the modal.
    const timer = setTimeout(() => {
      onClose();
    }, 60);
    return () => clearTimeout(timer);
  }, [isDismissing, onClose]);

  // ── Fullscreen mode (tap content to hide/show chrome) ──────────────────────
  useEffect(() => {
    Animated.timing(chromeAnim, {
      toValue: isFullscreen ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [isFullscreen, chromeAnim]);

  const latestRef = useRef({ activeIdx, category, fileListLen: fileList.length, animateToFile, hasNext, hasPrev, canZoom, resetZoom, setZoomTo, slideAnim, scaleAnim, translateXAnim, translateYAnim, isAnimating });
  useEffect(() => {
    latestRef.current = { activeIdx, category, fileListLen: fileList.length, animateToFile, hasNext, hasPrev, canZoom, resetZoom, setZoomTo, slideAnim, scaleAnim, translateXAnim, translateYAnim, isAnimating };
  }, [activeIdx, category, fileList.length, animateToFile, hasNext, hasPrev, canZoom, resetZoom, setZoomTo, slideAnim, scaleAnim, translateXAnim, translateYAnim, isAnimating]);

  const getTouchDistance = (touches: { pageX: number; pageY: number }[]) => {
    const [a, b] = touches;
    return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
  };

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  // ── Memoized PanResponder ──────────────────
  const panResponder = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: (evt) => {
        // For video files, let all touches go directly to the video controls/seekbar.
        // The video player has its own panResponder with capture flags.
        const cur = latestRef.current;
        if (cur.category === 'video') return false;
        return true;
      },
      onMoveShouldSetPanResponder: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        // Never steal moves from the video controls
        if (cur.category === 'video') return false;
        if (cur.canZoom && touches.length === 2) return true;
        if (cur.canZoom && scaleRef.current > 1.02) return true;
        return Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.2;
      },
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        if (cur.canZoom && touches.length === 2) {
          pinchStartRef.current = { distance: getTouchDistance(touches), scale: scaleRef.current };
        } else {
          panStartRef.current = { ...translateRef.current };
          if (scaleRef.current <= 1.02) {
            cur.slideAnim.setValue(0);
          }
        }
      },
      onPanResponderMove: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        if (cur.canZoom && touches.length === 2 && pinchStartRef.current) {
          const dist = getTouchDistance(touches);
          // Elastic pinch scaling (0.8x to 5.5x during active pinch gesture)
          const rawScale = pinchStartRef.current.scale * (dist / pinchStartRef.current.distance);
          const newScale = clamp(rawScale, 0.8, 5.5);
          scaleRef.current = newScale;
          scheduleScaleDisplay(newScale);
          cur.scaleAnim.setValue(newScale);
        } else if (cur.canZoom && scaleRef.current > 1.02) {
          const maxX = (SCREEN_W * (scaleRef.current - 1)) / 2;
          const maxY = (SCREEN_H * (scaleRef.current - 1)) / 2;
          const nx = clamp(panStartRef.current.x + gs.dx, -maxX, maxX);
          const ny = clamp(panStartRef.current.y + gs.dy, -maxY, maxY);
          translateRef.current = { x: nx, y: ny };
          cur.translateXAnim.setValue(nx);
          cur.translateYAnim.setValue(ny);
        } else {
          if (!cur.isAnimating) {
            cur.slideAnim.setValue(gs.dx);
          }
        }
      },
      onPanResponderRelease: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        const cur = latestRef.current;
        if (cur.canZoom && (pinchStartRef.current || scaleRef.current > 1.02)) {
          pinchStartRef.current = null;
          if (touches.length === 0) {
            if (scaleRef.current < 1.05) {
              cur.resetZoom(true);
            } else if (scaleRef.current > ZOOM_MAX) {
              cur.setZoomTo(ZOOM_MAX);
            } else {
              panStartRef.current = { ...translateRef.current };
            }
          }
          return;
        }

        // Tap handling (single vs double tap) using reliable timestamp helper
        if (Math.abs(gs.dx) < 8 && Math.abs(gs.dy) < 8) {
          const now = getCurrentTimestamp();
          if (now - lastTapRef.current < 280) {
            if (tapTimerRef.current) {
              clearTimeout(tapTimerRef.current);
              tapTimerRef.current = null;
            }
            lastTapRef.current = 0;
            if (cur.canZoom) {
              cur.setZoomTo(scaleRef.current > 1.02 ? 1 : DOUBLE_TAP_ZOOM);
            }
          } else {
            lastTapRef.current = now;
            tapTimerRef.current = setTimeout(() => {
              setIsFullscreen(f => !f);
              lastTapRef.current = 0;
            }, 260);
          }
          return;
        }

        // Swipe navigation release
        const flung = Math.abs(gs.vx) > 0.4;
        if ((gs.dx < -50 || (flung && gs.vx < 0)) && cur.hasNext) {
          cur.animateToFile(cur.activeIdx + 1, gs.dx);
        } else if ((gs.dx > 50 || (flung && gs.vx > 0)) && cur.hasPrev) {
          cur.animateToFile(cur.activeIdx - 1, gs.dx);
        } else {
          Animated.spring(cur.slideAnim, { toValue: 0, useNativeDriver: true, speed: 22, bounciness: 4 }).start();
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!currentFile) return null;

  const uploadedDate = formatDate(currentFile.uploaded_time ?? currentFile.modified_time);

  const renderContentForFile = (targetFile: RemoteFile | null, targetUrl: string, keyPrefix: string) => {
    if (!targetFile) return null;

    const targetCategory = getFileCategory(targetFile.path);
    const targetFileName = targetFile.path.split(/[/\\]/).pop() ?? targetFile.path;
    const targetCat = categoryMeta(targetCategory);
    const targetUploadedDate = formatDate(targetFile.uploaded_time ?? targetFile.modified_time);
    const targetModDate = formatDate(targetFile.modified_time);

    if (!targetUrl) {
      return (
        <View key={`${keyPrefix}-loading`} style={pvStyles.centeredBox}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[pvStyles.loadingText, { color: colors.textSecondary }]}>Loading server preview…</Text>
        </View>
      );
    }

    if (targetCategory === 'image') {
      return (
        <Animated.View
          key={`${keyPrefix}-image`}
          style={[
            pvStyles.zoomWrap,
            { transform: [{ scale: scaleAnim }, { translateX: translateXAnim }, { translateY: translateYAnim }] },
          ]}
        >
          <Image
            source={{ uri: targetUrl }}
            style={pvStyles.imageFull}
            contentFit="contain"
            cachePolicy="memory-disk"
            // Adjacent images are prefetched. A second fade after the swipe
            // completes reads as a one-frame blink, so show cached pixels directly.
            transition={0}
            onLoadStart={() => setImgLoading(true)}
            onLoad={() => setImgLoading(false)}
            onError={() => setImgLoading(false)}
          />
          {imgLoading && (
            <View style={pvStyles.imgLoadingOverlay} pointerEvents="none">
              <ActivityIndicator size="large" color="#fff" />
            </View>
          )}
        </Animated.View>
      );
    }

    if (targetCategory === 'video') {
      return (
        <Animated.View
          key={`${keyPrefix}-video`}
          style={[
            pvStyles.zoomWrap,
            { transform: [{ scale: scaleAnim }, { translateX: translateXAnim }, { translateY: translateYAnim }] },
          ]}
        >
          <VideoPreviewPlayer
            previewUri={getVideoPreviewUrlForFile(targetFile)}
            originalUri={targetUrl}
            fileSize={targetFile.size}
            isActive={mediaActive}
          />
        </Animated.View>
      );
    }

    if (targetCategory === 'audio') {
      return (
        <AudioPlayer
          key={`${keyPrefix}-audio`}
          uri={targetUrl}
          colors={colors}
          fileName={targetFileName}
          isActive={mediaActive}
        />
      );
    }

    // Other — Metadata card
    return (
      <View key={`${keyPrefix}-meta`} style={pvStyles.metaCard}>
        <View style={[pvStyles.metaIconWrap, { backgroundColor: colors.primarySoft }]}>
          <AppIcon androidName={targetCat.icon} iosName={targetCat.iosIcon} color={colors.primary} size={48} />
        </View>
        <Text style={[pvStyles.metaFileName, { color: colors.text }]}>{targetFileName}</Text>
        <View style={[pvStyles.metaTable, { borderColor: colors.surfaceBorder }]}>
          <MetaRow label="Size" value={formatSize(targetFile.size)} colors={colors} />
          <MetaRow label="Uploaded" value={targetUploadedDate} colors={colors} />
          <MetaRow label="Modified" value={targetModDate} colors={colors} />
          <MetaRow label="Type" value={getExt(targetFileName).toUpperCase() || '—'} colors={colors} last />
        </View>
        <Text style={[pvStyles.metaNote, { color: colors.textMuted }]}>
          This file type cannot be previewed. Download it to open on your device.
        </Text>
      </View>
    );
  };

  const transitionTargetFile = transition ? fileList[transition.toIndex] ?? null : null;
  const transitionTargetUrl = transitionTargetFile ? getUrlForFile(transitionTargetFile) : '';

  const chromeOpacity = chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const topBarTranslate = chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -70] });
  const bottomBarTranslate = chromeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 70] });

  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={handleClose} statusBarTranslucent>
      <View style={[pvStyles.root, { backgroundColor: '#000' }]}>
        <StatusBar barStyle="light-content" backgroundColor="#000" hidden={isFullscreen} />

        {/* Floating Zoom level indicator / reset pill */}
        {canZoomUI && currentScaleDisplay > 1.02 && (
          <TouchableOpacity
            style={pvStyles.zoomPill}
            onPress={() => resetZoom(true)}
            activeOpacity={0.8}
          >
            <Text style={pvStyles.zoomPillText}>Zoom {currentScaleDisplay.toFixed(1)}x · Tap to Reset</Text>
          </TouchableOpacity>
        )}

        {/* Main Content Area with gestures */}
        <View style={pvStyles.contentArea} {...panResponder.panHandlers}>
          {transition ? (
            <>
              <Animated.View
                style={[pvStyles.transitionLayer, { transform: [{ translateX: slideAnim }] }]}
                pointerEvents="none"
              >
                {renderContentForFile(currentFile, previewUrl, 'current')}
              </Animated.View>
              <Animated.View
                style={[pvStyles.transitionLayer, { transform: [{ translateX: incomingSlideAnim }] }]}
                pointerEvents="none"
              >
                {renderContentForFile(transitionTargetFile, transitionTargetUrl, 'incoming')}
              </Animated.View>
            </>
          ) : (
            <Animated.View style={{ transform: [{ translateX: slideAnim }] }}>
              {renderContentForFile(currentFile, previewUrl, 'active')}
            </Animated.View>
          )}
        </View>

        <VideoPreviewPreloader uri={prevFile && getFileCategory(prevFile.path) === 'video' ? prevVideoPreviewUrl : ''} />
        <VideoPreviewPreloader uri={nextFile && getFileCategory(nextFile.path) === 'video' ? nextVideoPreviewUrl : ''} />

        {/* Top Header Bar */}
        <Animated.View
          style={[
            pvStyles.topBar,
            { paddingTop: insets.top + Spacing.two, backgroundColor: 'rgba(0,0,0,0.85)' },
            { opacity: chromeOpacity, transform: [{ translateY: topBarTranslate }] },
          ]}
          pointerEvents={isFullscreen ? 'none' : 'auto'}
        >
          <TouchableOpacity onPress={handleClose} style={pvStyles.topBarBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <AppIcon androidName="close" iosName="xmark" color="#fff" size={22} />
          </TouchableOpacity>
          <View style={pvStyles.topBarCenter}>
            <Text style={pvStyles.topBarTitle} numberOfLines={1}>{fileName}</Text>
            {fileList.length > 1 && (
              <Text style={pvStyles.topBarCounter}>
                {activeIdx + 1} / {fileList.length}
              </Text>
            )}
          </View>
          <View style={pvStyles.topBarRightActions}>
            {/* Zoom Out */}
            {canZoomUI && (
              <TouchableOpacity onPress={zoomOut} style={pvStyles.topBarBtn}>
                <AppIcon androidName="zoom_out" iosName="minus.magnifyingglass" color="#fff" size={18} />
              </TouchableOpacity>
            )}
            {/* Zoom In */}
            {canZoomUI && (
              <TouchableOpacity onPress={zoomIn} style={pvStyles.topBarBtn}>
                <AppIcon androidName="zoom_in" iosName="plus.magnifyingglass" color="#fff" size={18} />
              </TouchableOpacity>
            )}
            {/* Fullscreen Toggle */}
            <TouchableOpacity onPress={() => setIsFullscreen(v => !v)} style={pvStyles.topBarBtn}>
              <AppIcon
                androidName={isFullscreen ? 'fullscreen_exit' : 'fullscreen'}
                iosName={isFullscreen ? 'arrow.down.right.and.arrow.up.left' : 'arrow.up.left.and.arrow.down.right'}
                color="#fff"
                size={20}
              />
            </TouchableOpacity>
            {/* Save Button */}
            <TouchableOpacity
              onPress={() => onDownload(currentFile)}
              style={[pvStyles.topBarBtn, pvStyles.downloadBtn]}
            >
              <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={20} />
              <Text style={pvStyles.downloadBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Left / Right Nav Arrows
            • Videos: always visible and tappable (only navigation method — no swipe)
            • Photos: fade with chrome, hidden in fullscreen (swipe is primary navigation) */}
        {hasPrev && (
          <Animated.View
            style={[
              pvStyles.navArrowLeft,
              category === 'video'
                ? pvStyles.navArrowVideoPosition
                : { opacity: chromeOpacity },
            ]}
            pointerEvents={category === 'video' ? 'auto' : (isFullscreen ? 'none' : 'auto')}
          >
            <TouchableOpacity
              style={pvStyles.navArrowBtnInner}
              onPress={() => animateToFile(activeIdx - 1)}
              hitSlop={{ top: 20, bottom: 20, left: 10, right: 10 }}
            >
              <AppIcon androidName="chevron_left" iosName="chevron.left" color="rgba(255,255,255,0.85)" size={28} />
            </TouchableOpacity>
          </Animated.View>
        )}
        {hasNext && (
          <Animated.View
            style={[
              pvStyles.navArrowRight,
              category === 'video'
                ? pvStyles.navArrowVideoPosition
                : { opacity: chromeOpacity },
            ]}
            pointerEvents={category === 'video' ? 'auto' : (isFullscreen ? 'none' : 'auto')}
          >
            <TouchableOpacity
              style={pvStyles.navArrowBtnInner}
              onPress={() => animateToFile(activeIdx + 1)}
              hitSlop={{ top: 20, bottom: 20, left: 10, right: 10 }}
            >
              <AppIcon androidName="chevron_right" iosName="chevron.right" color="rgba(255,255,255,0.85)" size={28} />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Bottom Info Strip */}
        <Animated.View
          style={[
            pvStyles.bottomBar,
            { paddingBottom: insets.bottom + Spacing.two, backgroundColor: 'rgba(0,0,0,0.8)' },
            { opacity: chromeOpacity, transform: [{ translateY: bottomBarTranslate }] },
          ]}
          pointerEvents="none"
        >
          <Text style={pvStyles.bottomSize}>{formatSize(currentFile.size)}</Text>
          <Text style={pvStyles.bottomDot}>·</Text>
          <Text style={pvStyles.bottomDate}>{uploadedDate}</Text>
        </Animated.View>
      </View>
    </Modal>
  );
});

// ── MetaRow ──────────────────────────────────────────────────────────────────
function MetaRow({ label, value, colors, last }: { label: string; value: string; colors: AppColors; last?: boolean }) {
  return (
    <View style={[pvStyles.metaRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surfaceBorder }]}>
      <Text style={[pvStyles.metaLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[pvStyles.metaValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

// ── Video Preview Player ──────────────────────────────────────────────────────
type VideoPreviewPlayerProps = {
  previewUri: string;
  originalUri: string;
  fileSize: number;
  isActive?: boolean;
};

function VideoPreviewPlayer(props: VideoPreviewPlayerProps) {
  if (!expoVideoModule) {
    return <ExternalMediaPlayer uri={props.previewUri || props.originalUri} mediaType="video" />;
  }
  return <NativeVideoPreviewPlayer {...props} videoModule={expoVideoModule} />;
}

function NativeVideoPreviewPlayer({
  previewUri,
  originalUri,
  fileSize,
  isActive = true,
  videoModule,
}: VideoPreviewPlayerProps & { videoModule: ExpoVideoModule }) {
  const PREVIEW_TRANSCODE_MIN_BYTES = 40 * 1024 * 1024;
  const shouldUpgrade = previewUri !== originalUri && fileSize >= PREVIEW_TRANSCODE_MIN_BYTES;
  const upgradedRef = useRef(false);
  const upgradeScheduledRef = useRef(false);
  const upgradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoViewRef = useRef<InstanceType<ExpoVideoModule['VideoView']> | null>(null);

  const enterFullscreen = useCallback(() => {
    safeMediaCall(() => { videoViewRef.current?.enterFullscreen(); });
  }, []);

  const source = useMemo<VideoSource>(() => ({
    uri: previewUri,
    useCaching: true,
    contentType: 'progressive',
  }), [previewUri]);

  const player = videoModule.useVideoPlayer(source, p => {
    p.loop = true;
    p.bufferOptions = {
      preferredForwardBufferDuration: 1.5,
      minBufferForPlayback: 0.15,
      prioritizeTimeOverSizeThreshold: true,
    };
    if (isActive) {
      p.play();
    }
  });

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const isBuffering = status !== 'readyToPlay' && status !== 'error';

  const insets = useSafeAreaInsets();
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  // Seeking state — while the user drags the bar we freeze the position display
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekProgress, setSeekProgress] = useState(0);
  // Ref mirror of seekProgress so onPanResponderRelease can read it without stale closures
  const seekProgressRef = useRef(0);
  // Layout width of the seekbar track, measured on layout
  const seekBarWidthRef = useRef(1);
  const wasPlayingBeforeSeekRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isSeeking) return;
      safeMediaCall(() => {
        setPositionSec(player.currentTime || 0);
        setDurationSec(player.duration || 0);
      });
    }, 250);
    return () => clearInterval(interval);
  }, [player, isSeeking]);

  const togglePlay = useCallback(() => {
    if (player.playing) {
      safeMediaCall(() => player.pause());
    } else {
      safeMediaCall(() => player.play());
    }
  }, [player]);

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      safeMediaCall(() => { player.muted = next; });
      return next;
    });
  }, [player]);

  const skipBackward = useCallback(() => {
    safeMediaCall(() => {
      const next = Math.max(0, (player.currentTime || 0) - 10);
      player.currentTime = next;
      setPositionSec(next);
    });
  }, [player]);

  const skipForward = useCallback(() => {
    safeMediaCall(() => {
      const dur = player.duration || 0;
      if (dur <= 0) return;
      const next = Math.min(dur, (player.currentTime || 0) + 10);
      player.currentTime = next;
      setPositionSec(next);
    });
  }, [player]);

  // Seekbar PanResponder — handles tap + drag to seek
  // seekProgressRef/seekBarWidthRef/wasPlayingBeforeSeekRef are accessed only inside gesture
  // event callbacks (grant/move/release/terminate), never during render — disable is correct.
  // eslint-disable-next-line react-hooks/refs
  const seekPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // Steal the touch from the parent gallery pan-responder so seek works
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (evt) => {
      wasPlayingBeforeSeekRef.current = player.playing;
      safeMediaCall(() => player.pause());
      setIsSeeking(true);
      const ratio = Math.max(0, Math.min(1, evt.nativeEvent.locationX / seekBarWidthRef.current));
      seekProgressRef.current = ratio;
      setSeekProgress(ratio);
    },
    onPanResponderMove: (evt) => {
      // locationX is the touch position within the seekbar track view — use it directly.
      const ratio = Math.max(0, Math.min(1, evt.nativeEvent.locationX / seekBarWidthRef.current));
      seekProgressRef.current = ratio;
      setSeekProgress(ratio);
    },
    onPanResponderRelease: () => {
      // Use the ref to get the current ratio — avoids stale-closure from useMemo deps.
      const finalRatio = seekProgressRef.current;
      // Read duration directly from player at release time — freshest possible value,
      // no stale closure risk regardless of when the useMemo was last created.
      const dur = player.duration || 0;
      const newTime = finalRatio * dur;
      safeMediaCall(() => { player.currentTime = newTime; });
      setPositionSec(newTime);
      setIsSeeking(false);
      if (wasPlayingBeforeSeekRef.current) {
        safeMediaCall(() => player.play());
      }
    },
    onPanResponderTerminate: () => {
      setIsSeeking(false);
      if (wasPlayingBeforeSeekRef.current) {
        safeMediaCall(() => player.play());
      }
    },
  }), [player]);

  useEffect(() => {
    upgradedRef.current = false;
    upgradeScheduledRef.current = false;
    if (upgradeTimerRef.current) {
      clearTimeout(upgradeTimerRef.current);
      upgradeTimerRef.current = null;
    }
  }, [previewUri, originalUri]);

  useEffect(() => {
    // Never call pause/play from an unmount cleanup — tearing down the native
    // player while invoking controls races and can kill the whole app.
    if (isActive) {
      safeMediaCall(() => player.play());
    } else {
      safeMediaCall(() => player.pause());
    }
  }, [isActive, player]);

  useEffect(() => {
    if (
      !shouldUpgrade ||
      upgradedRef.current ||
      upgradeScheduledRef.current ||
      status !== 'readyToPlay' ||
      !isActive
    ) {
      return;
    }

    let cancelled = false;
    upgradeScheduledRef.current = true;
    const timer = setTimeout(async () => {
      if (cancelled || upgradedRef.current) return;
      const position = player.currentTime;
      const wasPlaying = player.playing;
      try {
        await player.replaceAsync({
          uri: originalUri,
          useCaching: true,
          contentType: 'progressive',
        });
        if (cancelled) return;
        upgradedRef.current = true;
        player.currentTime = position;
        if (wasPlaying) {
          safeMediaCall(() => player.play());
        }
      } catch {
        // Allow another attempt later.
        upgradedRef.current = false;
        upgradeScheduledRef.current = false;
      }
    }, 1500);
    upgradeTimerRef.current = timer;

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (upgradeTimerRef.current === timer) {
        upgradeTimerRef.current = null;
      }
      if (!upgradedRef.current) {
        upgradeScheduledRef.current = false;
      }
    };
  }, [shouldUpgrade, status, isActive, originalUri, player]);

  // Displayed position/progress: while dragging show the seek thumb position
  const displayProgress = isSeeking ? seekProgress : (durationSec > 0 ? positionSec / durationSec : 0);
  // While seeking, use the freshest duration (player.duration falls back if state hasn't ticked yet)
  const liveDuration = durationSec > 0 ? durationSec : (player.duration || 0);
  const displayPosition = isSeeking ? seekProgress * liveDuration : positionSec;
  const remaining = Math.max(0, liveDuration - displayPosition);

  return (
    <View style={pvStyles.videoContainer}>
      <videoModule.VideoView
        ref={videoViewRef}
        player={player}
        style={pvStyles.videoFull}
        contentFit="contain"
        nativeControls={false}
        surfaceType="textureView"
        fullscreenOptions={{ enable: true }}
      />
      {isBuffering && (
        <View style={pvStyles.imgLoadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={pvStyles.videoLoadingText}>Buffering video…</Text>
        </View>
      )}

      {/* ── Full video controls panel ── */}
      <View
        style={[pvStyles.videoControlsPanel, { bottom: insets.bottom + Spacing.two }]}
        pointerEvents="auto"
      >
        {/* Seekbar row */}
        <View style={pvStyles.videoSeekRow} pointerEvents="auto">
          <Text style={pvStyles.videoTimeLabel}>{formatMediaTime(displayPosition)}</Text>
          {/* Seekbar track — touchable for tap+drag seeking */}
          <View
            style={pvStyles.videoSeekTrackWrap}
            onLayout={e => { seekBarWidthRef.current = e.nativeEvent.layout.width || 1; }}
            {...seekPanResponder.panHandlers}
          >
            {/* Background track */}
            <View style={pvStyles.videoSeekTrackBg} />
            {/* Filled portion */}
            <View
              style={[pvStyles.videoSeekTrackFill, { width: `${Math.min(displayProgress * 100, 100)}%` }]}
            />
            {/* Thumb */}
            <View
              style={[
                pvStyles.videoSeekThumb,
                { left: `${Math.min(displayProgress * 100, 100)}%` },
                isSeeking && pvStyles.videoSeekThumbActive,
              ]}
            />
          </View>
          <Text style={pvStyles.videoTimeLabel}>-{formatMediaTime(remaining)}</Text>
        </View>

        {/* Buttons row */}
        <View style={pvStyles.videoButtonRow} pointerEvents="auto">
          {/* Mute / Volume */}
          <TouchableOpacity
            onPress={toggleMute}
            style={pvStyles.videoCtrlBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
          >
            <AppIcon
              androidName={isMuted ? 'volume_off' : 'volume_up'}
              iosName={isMuted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
              color="#fff"
              size={20}
            />
          </TouchableOpacity>

          {/* −10 s rewind */}
          <TouchableOpacity
            onPress={skipBackward}
            style={pvStyles.videoCtrlBtn}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            accessibilityLabel="Rewind 10 seconds"
          >
            <AppIcon
              androidName="replay_10"
              iosName="gobackward.10"
              color="#fff"
              size={22}
              fallback="↺"
            />
          </TouchableOpacity>

          {/* Play / Pause (centre, larger) */}
          <TouchableOpacity
            onPress={togglePlay}
            style={pvStyles.videoPlayBtnLarge}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
          >
            <AppIcon
              androidName={isPlaying ? 'pause' : 'play_arrow'}
              iosName={isPlaying ? 'pause.fill' : 'play.fill'}
              color="#fff"
              size={26}
            />
          </TouchableOpacity>

          {/* +10 s forward */}
          <TouchableOpacity
            onPress={skipForward}
            style={pvStyles.videoCtrlBtn}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            accessibilityLabel="Skip forward 10 seconds"
          >
            <AppIcon
              androidName="forward_10"
              iosName="goforward.10"
              color="#fff"
              size={22}
              fallback="↻"
            />
          </TouchableOpacity>

          {/* Duration / total time */}
          <View style={pvStyles.videoCtrlBtn}>
            <Text style={pvStyles.videoDurationText}>{formatMediaTime(durationSec)}</Text>
          </View>

          {/* Fullscreen */}
          <TouchableOpacity
            onPress={enterFullscreen}
            style={pvStyles.videoCtrlBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Play fullscreen"
          >
            <AppIcon androidName="fullscreen" iosName="arrow.up.left.and.arrow.down.right" color="#fff" size={20} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function VideoPreviewPreloader({ uri }: { uri: string }) {
  if (!expoVideoModule || !uri) return null;
  return <NativeVideoPreviewPreloader uri={uri} videoModule={expoVideoModule} />;
}

function NativeVideoPreviewPreloader({ uri, videoModule }: { uri: string; videoModule: ExpoVideoModule }) {
  const source = useMemo<VideoSource | null>(() => (
    { uri, useCaching: true, contentType: 'progressive' }
  ), [uri]);

  videoModule.useVideoPlayer(source, player => {
    player.loop = true;
    player.bufferOptions = {
      preferredForwardBufferDuration: 1.5,
      minBufferForPlayback: 0.15,
      prioritizeTimeOverSizeThreshold: true,
    };
  });

  return null;
}

function ExternalMediaPlayer({ uri, mediaType }: { uri: string; mediaType: 'video' | 'audio' }) {
  const [opening, setOpening] = useState(false);

  const openExternalPlayer = useCallback(async () => {
    if (!uri || opening) return;
    setOpening(true);
    try {
      await Linking.openURL(uri);
    } catch {
      Alert.alert(
        `Unable to open ${mediaType}`,
        'No installed app could open this media file. Install or update a media player, then try again.',
      );
    } finally {
      setOpening(false);
    }
  }, [mediaType, opening, uri]);

  return (
    <View style={pvStyles.externalMediaPlayer}>
      <View style={pvStyles.externalMediaIcon}>
        <AppIcon
          androidName={mediaType === 'video' ? 'videocam' : 'music_note'}
          iosName={mediaType === 'video' ? 'video' : 'music.note'}
          color="#fff"
          size={46}
        />
      </View>
      <Text style={pvStyles.externalMediaTitle}>Open {mediaType} player</Text>
      <Text style={pvStyles.externalMediaBody}>
        Playback will continue in an installed media app.
      </Text>
      <TouchableOpacity
        style={pvStyles.externalMediaButton}
        onPress={openExternalPlayer}
        disabled={!uri || opening}
        activeOpacity={0.8}
      >
        {opening ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <AppIcon androidName="open_in_new" iosName="arrow.up.forward.app" color="#fff" size={18} />
        )}
        <Text style={pvStyles.externalMediaButtonText}>{opening ? 'Opening…' : `Open ${mediaType}`}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Audio Player ─────────────────────────────────────────────────────────────
function AudioPlayer({
  uri,
  colors,
  fileName,
  isActive = true,
}: {
  uri: string;
  colors: AppColors;
  fileName: string;
  isActive?: boolean;
}) {
  if (!expoAudioModule) {
    return <ExternalMediaPlayer uri={uri} mediaType="audio" />;
  }
  return (
    <NativeAudioPlayer
      uri={uri}
      colors={colors}
      fileName={fileName}
      isActive={isActive}
      audioModule={expoAudioModule}
    />
  );
}

function NativeAudioPlayer({
  uri,
  colors,
  fileName,
  isActive = true,
  audioModule,
}: {
  uri: string;
  colors: AppColors;
  fileName: string;
  isActive?: boolean;
  audioModule: ExpoAudioModule;
}) {
  // useAudioPlayer already releases via useReleasingSharedObject on unmount.
  // Calling player.remove() here double-frees the native object and crashes
  // the app when closing or swiping away from audio — same class of bug as the
  // old video pause-on-unmount teardown.
  const player = audioModule.useAudioPlayer(uri);
  const status = audioModule.useAudioPlayerStatus(player);

  useEffect(() => {
    if (!isActive) {
      safeMediaCall(() => player.pause());
    }
  }, [isActive, player]);

  const togglePlay = () => {
    if (status.playing) {
      safeMediaCall(() => player.pause());
    } else {
      safeMediaCall(() => player.play());
    }
  };

  const positionSec = status.currentTime ?? 0;
  const durationSec = status.duration ?? 0;
  const progress = durationSec > 0 ? positionSec / durationSec : 0;

  return (
    <View style={pvStyles.audioPlayer} pointerEvents="box-none">
      <View style={[pvStyles.audioIconWrap, { backgroundColor: colors.primarySoft }]} pointerEvents="none">
        <AppIcon androidName="music_note" iosName="music.note" color={colors.primary} size={52} />
      </View>
      <Text style={pvStyles.audioFileName} numberOfLines={2} pointerEvents="none">{fileName}</Text>

      <View style={pvStyles.audioProgressBg} pointerEvents="none">
        <View style={[pvStyles.audioProgressFill, { width: `${progress * 100}%`, backgroundColor: colors.primary }]} />
      </View>
      <View style={pvStyles.audioTimings} pointerEvents="none">
        <Text style={pvStyles.audioTime}>{formatMediaTime(positionSec)}</Text>
        <Text style={pvStyles.audioTime}>{formatMediaTime(durationSec)}</Text>
      </View>

      <TouchableOpacity onPress={togglePlay} style={[pvStyles.audioPlayBtn, { backgroundColor: colors.primary }]}>
        <AppIcon
          androidName={status.playing ? 'pause' : 'play_arrow'}
          iosName={status.playing ? 'pause.fill' : 'play.fill'}
          color="#fff"
          size={28}
        />
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort Bar
// ─────────────────────────────────────────────────────────────────────────────

const SORT_OPTIONS: { field: SortField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'date', label: 'Date' },
  { field: 'type', label: 'Type' },
  { field: 'size', label: 'Size' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tree Node Renderer
// ─────────────────────────────────────────────────────────────────────────────

type TreeNodeViewProps = {
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  selectedPaths: Set<string>;
  selectionMode: boolean;
  isLoadingSelection?: boolean;
  onToggleNode: (node: TreeNode) => void;
  onToggleExpand: (nodeKey: string) => void;
  onPreview: (file: RemoteFile) => void;
  onWarmPreview: (file: RemoteFile) => void;
  onEnterSelectionMode: (node: TreeNode) => void;
  styles: ReturnType<typeof createStyles>;
  colors: AppColors;
};

const TreeNodeView = React.memo(function TreeNodeView({
  node, depth, isExpanded, selectedPaths, selectionMode, isLoadingSelection, onToggleNode, onToggleExpand, onPreview, onWarmPreview, onEnterSelectionMode, styles, colors,
}: TreeNodeViewProps) {
  const indent = depth * 16;

  if (!node.isFolder) {
    const isSelected = selectedPaths.has(node.key);
    const category = getFileCategory(node.name);
    const catMeta = categoryMeta(category);

    // Modern interaction model (matches Google Photos / Files):
    //  - Tap always opens preview (or toggles selection if in selection mode)
    //  - Long-press always starts/toggles selection
    //  - Checkbox always toggles selection directly
    const handlePress = () => {
      if (selectionMode) {
        onToggleNode(node);
      } else {
        node.file && onPreview(node.file);
      }
    };

    const handleLongPress = () => {
      if (selectionMode) {
        onToggleNode(node);
      } else {
        onEnterSelectionMode(node);
      }
    };

    const handleCheckboxPress = () => {
      if (selectionMode) {
        onToggleNode(node);
      } else {
        onEnterSelectionMode(node);
      }
    };

    return (
      <Pressable
        style={[styles.fileRow, { paddingLeft: indent + Spacing.four }, isSelected && styles.fileRowSelected]}
        onPress={handlePress}
        onPressIn={() => {
          if (node.file) {
            onWarmPreview(node.file);
          }
        }}
        onLongPress={handleLongPress}
        delayLongPress={400}
        android_ripple={{ color: colors.primarySoft }}
      >
        {selectionMode ? (
          <TouchableOpacity
            onPress={handleCheckboxPress}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            activeOpacity={0.7}
          >
            <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
              {isSelected ? (
                <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={13} />
              ) : null}
            </View>
          </TouchableOpacity>
        ) : (
          <View style={styles.fileIconWrap}>
            <AppIcon androidName={catMeta.icon} iosName={catMeta.iosIcon} color={colors.primary} size={18} />
          </View>
        )}

        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>{node.name}</Text>
          <View style={styles.fileMetaRow}>
            <Text style={styles.fileSize}>{formatSize(node.file!.size)}</Text>
            <Text style={styles.fileDot}>·</Text>
            <Text style={styles.fileDate}>{formatDate(node.file!.uploaded_time ?? node.file!.modified_time)}</Text>
          </View>
        </View>

        <AppIcon
          androidName={selectionMode ? (isSelected ? 'check_circle' : 'radio_button_unchecked') : 'chevron_right'}
          iosName={selectionMode ? (isSelected ? 'checkmark.circle.fill' : 'circle') : 'chevron.right'}
          color={selectionMode ? (isSelected ? colors.primary : colors.textMuted) : colors.textMuted}
          size={selectionMode ? 20 : 14}
        />
      </Pressable>
    );
  }

  // Folder row
  const selState = folderSelectionState(node, selectedPaths);
  const isPartial = selState === 'partial';
  const isAllSelected = selState === 'all';
  const checkboxStyle = [styles.checkbox, (isAllSelected || isPartial) && styles.checkboxSelected, isPartial && styles.checkboxPartial];

  return (
    <View style={[styles.folderRow, { paddingLeft: indent + Spacing.four }]}>
      <TouchableOpacity style={styles.chevronBtn} onPress={() => onToggleExpand(node.key)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}>
        <AppIcon androidName={isExpanded ? 'expand_more' : 'chevron_right'} iosName={isExpanded ? 'chevron.down' : 'chevron.right'} color={colors.textSecondary} size={22} />
      </TouchableOpacity>
      <TouchableOpacity
        style={checkboxStyle}
        onPress={() => {
          if (selectionMode) {
            onToggleNode(node);
          } else {
            onEnterSelectionMode(node);
          }
        }}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
      >
        {isLoadingSelection ? (
          <ActivityIndicator size="small" color={isAllSelected ? colors.white : colors.primary} />
        ) : (
          <>
            {isAllSelected && <AppIcon androidName="check" iosName="checkmark" color={colors.white} size={13} />}
            {isPartial && <View style={styles.partialDot} />}
          </>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.folderLabelBtn}
        onPress={() => onToggleExpand(node.key)}
        onLongPress={() => {
          if (selectionMode) {
            onToggleNode(node);
          } else {
            onEnterSelectionMode(node);
          }
        }}
        delayLongPress={400}
        activeOpacity={0.7}
      >
        <AppIcon androidName="folder" iosName="folder.fill" color={colors.primary} size={18} />
        <Text style={styles.folderName} numberOfLines={1}>{node.name}</Text>
      </TouchableOpacity>
      {node.fileCount > 0 ? (
        <View style={styles.folderBadge}>
          <Text style={styles.folderBadgeText}>{node.fileCount} {node.fileCount === 1 ? 'file' : 'files'}</Text>
          <Text style={styles.folderBadgeSize}>{formatSize(node.totalSize)}</Text>
        </View>
      ) : node.loaded && node.children.length === 0 ? (
        <View style={styles.folderBadge}>
          <Text style={styles.folderBadgeText}>Empty</Text>
        </View>
      ) : null}
    </View>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Main Restore Screen Component
// ─────────────────────────────────────────────────────────────────────────────

export default function RestoreScreen() {
  const { colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  // Memories availability state
  const [hasMemories, setHasMemories] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      getTodaysMemories()
        .then(res => {
          if (active && res && Array.isArray(res.groups) && res.groups.length > 0) {
            setHasMemories(true);
          } else if (active) {
            setHasMemories(false);
          }
        })
        .catch(() => {
          if (active) setHasMemories(false);
        });
      return () => {
        active = false;
      };
    }, [])
  );

  // Source mode state
  const [sourceMode, setSourceMode] = useState<SourceMode>('phone');
  const [sharedSources, setSharedSources] = useState<SharedSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sharedViewMode, setSharedViewMode] = useState<'feed' | 'folder'>('feed');
  const [isLoadingSources, setIsLoadingSources] = useState(false);

  // Server Config cache
  const [serverConfig, setServerConfig] = useState<ServerConfig>(null);

  const loadServerConfig = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setServerConfig(cfg);
    } catch {
      setServerConfig(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getConfig()
      .then(cfg => { if (active) setServerConfig(cfg); })
      .catch(() => { if (active) setServerConfig(null); });
    return () => { active = false; };
  }, []);

  // File list & tree state
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [isFetching, setIsFetching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ current: number; total: number; fileName: string; bytesWritten: number; bytesTotal: number } | null>(null);
  const [serverStatus, setServerStatus] = useState<'connected' | 'disconnected' | 'unknown' | 'checking'>('unknown');
  const downloadActiveRef = useRef(false);
  const fetchingRef = useRef(false);
  const downloadSingleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreMountedRef = useRef(true);

  // Sort state
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(RESTORE_SORT_PREFERENCE_KEY)
      .then(raw => {
        const preference = parseSortPreference(raw);
        if (!active || !preference) return;
        setSortField(preference.field);
        setSortDir(preference.dir);
      })
      .catch(() => {
        // Storage failures should not prevent the Restore screen from working.
      });
    return () => { active = false; };
  }, []);

  // Selection mode state
  const [selectionMode, setSelectionMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RemoteFile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGenRef = useRef(0);
  const [refreshing, setRefreshing] = useState(false);

  // Preview state
  const [previewFile, setPreviewFile] = useState<RemoteFile | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number>(0);
  const [warmPreviewFile, setWarmPreviewFile] = useState<RemoteFile | null>(null);

  const headerHeight = Spacing.five + 88 + 130;
  const {
    containerPaddingTop,
    onScroll: onListScroll,
    onScrollEndDrag: onListScrollEndDrag,
    onMomentumScrollEnd: onListMomentumScrollEnd,
    headerAnimatedStyle,
    onHeaderLayout,
    expandHeader,
  } = useCollapsibleHeader({
    headerHeight,
    topInset: insets.top,
  });

  useEffect(() => {
    // Keep the collapsible header expanded around downloads so it does not
    // reappear collapsed (empty gap) when the progress banner unmounts.
    expandHeader();
  }, [isDownloading, expandHeader]);

  useEffect(() => {
    restoreMountedRef.current = true;
    return () => {
      restoreMountedRef.current = false;
      downloadActiveRef.current = false;
      if (downloadSingleTimerRef.current) {
        clearTimeout(downloadSingleTimerRef.current);
        downloadSingleTimerRef.current = null;
      }
    };
  }, []);

  const sourceModeRef = useRef(sourceMode);
  const sharedSourcesGen = useRef(0);
  useEffect(() => {
    sourceModeRef.current = sourceMode;
  }, [sourceMode]);

  // Load shared sources — invoke when not offline (connected or checking)
  const loadSharedSources = useCallback(async () => {
    const generation = ++sharedSourcesGen.current;
    setIsLoadingSources(true);
    try {
      const sources: SharedSource[] = await listSharedSources();
      if (generation !== sharedSourcesGen.current || !restoreMountedRef.current) return;
      if (sourceModeRef.current !== 'shared') return;
      setSharedSources(sources);
      setSelectedSourceId(prev => {
        if (sources.length === 0) return null;
        if (!prev) return sources[0].id;
        if (!sources.some(s => s.id === prev)) return sources[0].id;
        return prev;
      });
    } catch (e: any) {
      if (generation !== sharedSourcesGen.current || !restoreMountedRef.current) return;
      if (sourceModeRef.current === 'shared') {
        Alert.alert('Shared Folders', sanitizeErrorMessage(e, 'Server unreachable — check that the desktop server is running.'));
      }
      setSharedSources([]);
      setSelectedSourceId(null);
    } finally {
      if (generation === sharedSourcesGen.current && restoreMountedRef.current) {
        setIsLoadingSources(false);
      }
    }
  }, []);

  // Server connection check
  const checkServer = useCallback(async (alive?: () => boolean) => {
    const stillAlive = alive ?? (() => true);
    const ip = await getServerIp();
    if (!stillAlive()) return;
    if (!ip) {
      sharedSourcesGen.current += 1;
      setIsLoadingSources(false);
      setServerStatus('unknown');
      return;
    }

    const snapshot = await getCurrentSyncState().catch(() => null);
    if (!stillAlive()) return;
    if (snapshot?.active) {
      setServerStatus('connected');
      loadServerConfig();
      if (sourceModeRef.current === 'shared') {
        void loadSharedSources();
      }
      return;
    }

    // Keep showing connected while re-probing to avoid offline UI flash.
    setServerStatus(prev => (prev === 'connected' ? prev : 'checking'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const result = await checkDeviceConnection({ signal: controller.signal });
      if (!stillAlive()) return;
      if (result.connected) {
        setServerStatus('connected');
        loadServerConfig();
        if (sourceModeRef.current === 'shared') {
          void loadSharedSources();
        }
      } else {
        sharedSourcesGen.current += 1;
        setIsLoadingSources(false);
        setServerStatus('disconnected');
      }
    } catch {
      if (!stillAlive()) return;
      sharedSourcesGen.current += 1;
      setIsLoadingSources(false);
      setServerStatus('disconnected');
    } finally {
      clearTimeout(timeout);
    }
  }, [loadServerConfig, loadSharedSources]);

  useFocusEffect(useCallback(() => {
    let alive = true;
    checkServer(() => alive);
    return () => { alive = false; };
  }, [checkServer]));

  // True offline only — "checking" stays fully interactive like before.
  const isOffline = serverStatus === 'disconnected' || serverStatus === 'unknown';

  const handleModeChange = useCallback((mode: SourceMode) => {
    if (mode === sourceModeRef.current) return;
    setSourceMode(mode);
    setFiles([]);
    setTree(null);
    setExpandedKeys(new Set());
    setSelectedPaths(new Set());
    setSelectionMode(false);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchGenRef.current += 1;
    setSearchQuery('');
    setSearchResults([]);
    setIsSearching(false);
    if (mode !== 'shared') {
      sharedSourcesGen.current += 1;
      setIsLoadingSources(false);
      setSharedSources([]);
      setSelectedSourceId(null);
      return;
    }
    // Load whenever we are not offline (connected or checking).
    if (serverStatus !== 'disconnected' && serverStatus !== 'unknown') {
      void loadSharedSources();
    }
  }, [loadSharedSources, serverStatus]);

  const handleSourceSelect = useCallback((source: SharedSource) => {
    setSelectedSourceId(source.id);
    setFiles([]);
    setTree(null);
    setExpandedKeys(new Set());
    setSelectedPaths(new Set());
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchGenRef.current += 1;
    setSearchQuery('');
    setSearchResults([]);
    setIsSearching(false);
  }, []);

  // Sorted tree — only recomputed when the file list or sort choice changes,
  // never on folder expand/collapse.
  const sortedTree = useMemo(() => {
    if (!tree) return null;
    return sortTreeChildren(tree, sortField, sortDir);
  }, [tree, sortField, sortDir]);

  const visibleRows = useMemo<FlatRow[]>(() => {
    if (!sortedTree) return [];
    const out: FlatRow[] = [];
    flattenVisibleRows(sortedTree.children, 0, expandedKeys, out);
    return out;
  }, [sortedTree, expandedKeys]);

  const isFiltering = searchQuery.trim().length > 0;

  const filteredFiles = useMemo(() => {
    if (!isFiltering) return files;
    return [...searchResults].sort((a, b) => compareRemoteFiles(a, b, sortField, sortDir));
  }, [isFiltering, searchResults, sortField, sortDir, files]);

  const runSearch = useCallback((query: string) => {
    const trimmed = query.trim();
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!trimmed) {
      searchGenRef.current += 1;
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    searchDebounceRef.current = setTimeout(async () => {
      const generation = ++searchGenRef.current;
      setIsSearching(true);
      try {
        const results: RemoteFile[] = sourceMode === 'shared' && selectedSourceId
          ? await searchSharedFiles(selectedSourceId, trimmed)
          : await searchFiles(trimmed);
        if (generation !== searchGenRef.current || !restoreMountedRef.current) return;
        setSearchResults(results);
      } catch (err: any) {
        if (generation !== searchGenRef.current || !restoreMountedRef.current) return;
        setSearchResults([]);
        Alert.alert('Search Failed', sanitizeErrorMessage(err, 'Could not search files on server.'));
      } finally {
        if (generation === searchGenRef.current && restoreMountedRef.current) setIsSearching(false);
      }
    }, 350);
  }, [sourceMode, selectedSourceId]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const listRows = useMemo<FlatRow[]>(() => {
    if (!isFiltering) return visibleRows;
    return filteredFiles.map(file => {
      const name = file.path.split(/[/\\]/).pop() ?? file.path;
      return {
        depth: 0,
        node: {
          name,
          key: file.path,
          isFolder: false,
          file,
          children: [],
          totalSize: file.size,
          fileCount: 1,
          filePaths: [file.path],
        },
      };
    });
  }, [isFiltering, visibleRows, filteredFiles]);

  const isFeedMode = sourceMode === 'shared' && sharedViewMode === 'feed' && !!selectedSourceId;

  // Reaction handler
  const handleToggleReaction = useCallback(async (file: RemoteFile, emoji: string) => {
    if (!file.media_id) return;
    hapticSelection();

    const currentReactions = file.user_reactions || [];
    const currentCounts = { ...(file.reaction_counts || {}) };
    const hasReacted = currentReactions.includes(emoji);

    const updatedReactions = hasReacted
      ? currentReactions.filter(e => e !== emoji)
      : [...currentReactions, emoji];

    const updatedCounts = {
      ...currentCounts,
      [emoji]: Math.max(0, (currentCounts[emoji] || 0) + (hasReacted ? -1 : 1)),
    };

    const updateList = (list: RemoteFile[]) =>
      list.map(f =>
        f.path === file.path
          ? { ...f, user_reactions: updatedReactions, reaction_counts: updatedCounts }
          : f
      );

    setFiles(updateList);

    try {
      const res = await reactToMedia(file.media_id, emoji);
      if (res?.counts && res?.user_reactions) {
        const syncServer = (list: RemoteFile[]) =>
          list.map(f =>
            f.path === file.path
              ? { ...f, user_reactions: res.user_reactions, reaction_counts: res.counts }
              : f
          );
        setFiles(syncServer);
      }
    } catch (err) {
      console.warn('[Restore] reaction error:', err);
      const revertList = (list: RemoteFile[]) =>
        list.map(f =>
          f.path === file.path
            ? { ...f, user_reactions: currentReactions, reaction_counts: currentCounts }
            : f
        );
      setFiles(revertList);
    }
  }, []);

  const handleSharedViewModeChange = useCallback((vmode: 'feed' | 'folder') => {
    setSharedViewMode(vmode);
  }, []);

  // Periodic refresh of reactions/feed when in shared feed view
  useEffect(() => {
    if (!isFeedMode || isOffline) return;
    const interval = setInterval(() => {
      if (fetchingRef.current || isDownloading || !selectedSourceId) return;
      getSharedFeed(selectedSourceId)
        .then(res => {
          if (!restoreMountedRef.current || !res?.items) return;
          const feedFiles: RemoteFile[] = res.items.map((f: any) => ({
            path: f.path,
            size: f.size,
            modified_time: f.modified_time,
            media_id: f.media_id,
            reaction_counts: f.reaction_counts,
            user_reactions: f.user_reactions,
            is_video: f.is_video,
          }));
          setFiles(feedFiles);
        })
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [isFeedMode, selectedSourceId, isOffline, isDownloading]);

  // Flat ordered list of previewable files
  const previewableFiles = useMemo<RemoteFile[]>(() => {
    if (isFeedMode) return isFiltering ? filteredFiles : files;
    if (isFiltering) return filteredFiles;
    const result: RemoteFile[] = [];
    function collect(node: TreeNode) {
      if (!node.isFolder && node.file) {
        result.push(node.file);
      } else {
        node.children.forEach(collect);
      }
    }
    if (sortedTree) sortedTree.children.forEach(collect);
    return result;
  }, [isFeedMode, isFiltering, filteredFiles, files, sortedTree]);

  // Fetch files from server
  const handleFetch = useCallback(async (opts?: { quiet?: boolean; ignoreOffline?: boolean; preserveSelection?: boolean }) => {
    if (fetchingRef.current || isDownloading) return;
    if (!opts?.ignoreOffline && isOffline) return;
    if (sourceMode === 'shared' && !selectedSourceId) {
      if (!opts?.quiet) Alert.alert('No Source', 'Please select a shared folder first.');
      return;
    }
    fetchingRef.current = true;
    setIsFetching(true);
    try {
      await loadServerConfig();
      if (sourceMode === 'shared' && sharedViewMode === 'feed') {
        const feedData = await getSharedFeed(selectedSourceId!);
        if (!restoreMountedRef.current) return;
        const feedFiles: RemoteFile[] = (feedData.items || []).map((f: any) => ({
          path: f.path,
          size: f.size,
          modified_time: f.modified_time,
          media_id: f.media_id,
          reaction_counts: f.reaction_counts,
          user_reactions: f.user_reactions,
          is_video: f.is_video,
        }));
        setFiles(feedFiles);
        setTree(null);
      } else {
        const data = sourceMode === 'shared'
          ? await browseSharedFiles(selectedSourceId!)
          : await browseFiles('');
        if (!restoreMountedRef.current) return;

        const rootFiles: RemoteFile[] = (data.files || []).map((f: any) => ({
          path: f.path,
          size: f.size,
          modified_time: f.modified_time,
          sha256: f.sha256,
          uploaded_time: f.uploaded_time,
          media_id: f.media_id,
          reaction_counts: f.reaction_counts,
          user_reactions: f.user_reactions,
          is_video: f.is_video,
        }));
        setFiles(rootFiles);
        setTree(buildRootFromBrowse(data));
      }

      if (opts?.preserveSelection) {
        setSelectedPaths(prev => {
          const next = new Set([...prev]);
          if (next.size === 0) setSelectionMode(false);
          return next;
        });
      } else {
        setExpandedKeys(new Set());
        setSelectedPaths(new Set());
        setSelectionMode(false);
      }
    } catch (error: any) {
      if (restoreMountedRef.current && !opts?.quiet) {
        Alert.alert('Fetch Failed', sanitizeErrorMessage(error, 'Could not fetch files from server.'));
      }
    } finally {
      fetchingRef.current = false;
      if (restoreMountedRef.current) setIsFetching(false);
    }
  }, [isOffline, isDownloading, sourceMode, selectedSourceId, sharedViewMode, loadServerConfig]);

  useEffect(() => {
    if (sourceMode !== 'shared' || !selectedSourceId) return;
    if (isOffline || isDownloading) return;
    queueMicrotask(() => {
      void handleFetch({ quiet: true, preserveSelection: true });
    });
  }, [sourceMode, selectedSourceId, sharedViewMode, isOffline, isDownloading, handleFetch]);

  useFocusEffect(useCallback(() => {
    if (sourceMode !== 'shared' || !selectedSourceId || isOffline || isDownloading) return;
    void handleFetch({ quiet: true, preserveSelection: true });
  }, [sourceMode, selectedSourceId, isOffline, isDownloading, handleFetch]));

  const onRefreshLibrary = useCallback(async () => {
    if (isDownloading) return;
    setRefreshing(true);
    try {
      await checkServer();
      await handleFetch({ quiet: true, ignoreOffline: true, preserveSelection: true });
    } finally {
      if (restoreMountedRef.current) setRefreshing(false);
    }
  }, [checkServer, handleFetch, isDownloading]);

  // Sort handler
  const handleSortChange = useCallback((field: SortField, dir: SortDir) => {
    setSortField(field);
    setSortDir(dir);
    void AsyncStorage.setItem(RESTORE_SORT_PREFERENCE_KEY, JSON.stringify({ field, dir }))
      .catch(() => {
        // Keep the in-memory choice when the device cannot persist it.
      });
  }, []);

  // Preview handlers
  const openPreview = useCallback((file: RemoteFile, index?: number) => {
    const idx = index !== undefined ? index : previewableFiles.findIndex(f => f.path === file.path);
    setPreviewIndex(idx >= 0 ? idx : 0);
    setPreviewFile(file);
  }, [previewableFiles]);

  const handlePreview = useCallback((file: RemoteFile) => {
    setWarmPreviewFile(file);
    openPreview(file);
  }, [openPreview]);

  const handleWarmPreview = useCallback((file: RemoteFile) => {
    if (getFileCategory(file.path) === 'video') {
      setWarmPreviewFile(file);
    }
  }, []);

  const handlePreviewNavigate = useCallback((newIndex: number) => {
    if (newIndex < 0 || newIndex >= previewableFiles.length) return;
    setPreviewIndex(newIndex);
    setPreviewFile(previewableFiles[newIndex]);
  }, [previewableFiles]);

  const closePreview = useCallback(() => {
    setPreviewFile(null);
  }, []);

  const handleToggleExpand = useCallback(async (nodeKey: string) => {
    const isExpanding = !expandedKeys.has(nodeKey);
    if (!isExpanding) {
      setExpandedKeys(prev => {
        const next = new Set(prev);
        next.delete(nodeKey);
        return next;
      });
      return;
    }

    let targetNode: TreeNode | null = null;
    function findNode(nodes: TreeNode[]): TreeNode | null {
      for (const n of nodes) {
        if (n.key === nodeKey) return n;
        const found = findNode(n.children);
        if (found) return found;
      }
      return null;
    }
    if (tree) targetNode = findNode(tree.children);

    if (targetNode && !targetNode.loaded && !targetNode.loading) {
      setTree(prev => prev ? markNodeLoading(prev, nodeKey, true) : prev);
      try {
        const data = sourceMode === 'shared'
          ? await browseSharedFiles(selectedSourceId!, nodeKey)
          : await browseFiles(nodeKey);
        const childNodes: TreeNode[] = [
          ...(data.folders || []).map(nodeFromBrowseFolder),
          ...(data.files || []).map((f: any) => nodeFromBrowseFile({
            path: f.path, size: f.size, modified_time: f.modified_time,
            sha256: f.sha256, uploaded_time: f.uploaded_time,
          })),
        ];
        setTree(prev => prev ? replaceNodeChildren(prev, nodeKey, childNodes) : prev);
        setFiles(prev => {
          const existing = new Set(prev.map(f => f.path));
          const additions = childNodes.filter(n => !n.isFolder && n.file && !existing.has(n.file.path)).map(n => n.file!);
          return additions.length ? [...prev, ...additions] : prev;
        });
      } catch (err: any) {
        setTree(prev => prev ? markNodeLoading(prev, nodeKey, false) : prev);
        Alert.alert('Load Failed', sanitizeErrorMessage(err, 'Could not load this folder.'));
        return;
      }
    }

    setExpandedKeys(prev => {
      const next = new Set(prev);
      next.add(nodeKey);
      return next;
    });
  }, [expandedKeys, tree, sourceMode, selectedSourceId]);

  // Loading state for folder selection fetching
  const [loadingNodeKeys, setLoadingNodeKeys] = useState<Set<string>>(new Set());

  const getOrFetchNodeFiles = useCallback(async (node: TreeNode): Promise<{ files: RemoteFile[]; paths: string[] }> => {
    if (!node.isFolder) {
      const f = node.file ?? { path: node.key, size: node.totalSize, modified_time: 0 };
      return { files: [f], paths: [node.key] };
    }

    if (isSubtreeFullyLoaded(node)) {
      const subtreeFiles = collectSubtreeFiles(node);
      const subtreePaths = collectSubtreePaths(node);
      if (subtreePaths.length > 0) {
        return { files: subtreeFiles, paths: subtreePaths };
      }
    }

    // Fetch all descendant files under this folder prefix from server
    try {
      let fetched: RemoteFile[] = [];
      if (sourceModeRef.current === 'shared' && selectedSourceId) {
        fetched = await listSharedFiles(selectedSourceId, node.key);
      } else {
        fetched = await listServerFiles(node.key);
      }
      if (fetched.length > 0) {
        setFiles(prev => {
          const existing = new Set(prev.map(f => f.path));
          const toAdd = fetched.filter(f => !existing.has(f.path));
          return toAdd.length ? [...prev, ...toAdd] : prev;
        });
        return { files: fetched, paths: fetched.map(f => f.path) };
      }
    } catch (e) {
      console.warn('Failed to fetch folder files for selection:', e);
    }

    const subtreeFiles = collectSubtreeFiles(node);
    const subtreePaths = collectSubtreePaths(node);
    return { files: subtreeFiles, paths: subtreePaths };
  }, [selectedSourceId]);

  // Selection mode handlers
  const handleEnterSelectionMode = useCallback(async (node: TreeNode) => {
    hapticLongPress();
    setSelectionMode(true);

    if (node.isFolder && !isSubtreeFullyLoaded(node)) {
      setLoadingNodeKeys(prev => new Set(prev).add(node.key));
    }

    try {
      const { paths } = await getOrFetchNodeFiles(node);
      if (paths.length === 0) return;

      setSelectedPaths(prev => {
        const next = new Set(prev);
        const allSelected = paths.every(p => next.has(p));
        if (allSelected) paths.forEach(p => next.delete(p));
        else paths.forEach(p => next.add(p));
        return next;
      });
    } finally {
      setLoadingNodeKeys(prev => {
        const next = new Set(prev);
        next.delete(node.key);
        return next;
      });
    }
  }, [getOrFetchNodeFiles]);

  const handleToggleNode = useCallback(async (node: TreeNode) => {
    hapticSelection();

    if (node.isFolder && !isSubtreeFullyLoaded(node)) {
      setLoadingNodeKeys(prev => new Set(prev).add(node.key));
    }

    try {
      const { paths } = await getOrFetchNodeFiles(node);
      if (paths.length === 0) return;

      setSelectedPaths(prev => {
        const next = new Set(prev);
        const allSelected = paths.every(p => next.has(p));
        if (allSelected) paths.forEach(p => next.delete(p));
        else paths.forEach(p => next.add(p));
        if (next.size === 0) setSelectionMode(false);
        return next;
      });
    } finally {
      setLoadingNodeKeys(prev => {
        const next = new Set(prev);
        next.delete(node.key);
        return next;
      });
    }
  }, [getOrFetchNodeFiles]);

  const selectAll = useCallback(async () => {
    if (isFiltering) {
      const target = filteredFiles;
      if (target.length === 0) return;
      const allVisibleSelected = target.every(f => selectedPaths.has(f.path));
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (allVisibleSelected) {
          target.forEach(f => next.delete(f.path));
        } else {
          target.forEach(f => next.add(f.path));
        }
        if (next.size === 0) setSelectionMode(false);
        else setSelectionMode(true);
        return next;
      });
      return;
    }

    try {
      let allFiles = files;
      if (sourceModeRef.current === 'shared' && selectedSourceId) {
        allFiles = await listSharedFiles(selectedSourceId);
      } else {
        allFiles = await listServerFiles('');
      }
      if (allFiles.length > 0) {
        setFiles(allFiles);
      }
      const target = allFiles.length > 0 ? allFiles : files;
      if (target.length === 0) return;

      const allSelected = target.every(f => selectedPaths.has(f.path));
      if (allSelected) {
        setSelectedPaths(new Set());
        setSelectionMode(false);
      } else {
        setSelectedPaths(new Set(target.map(f => f.path)));
        setSelectionMode(true);
      }
    } catch {
      if (files.length === 0) return;
      const allSelected = files.every(f => selectedPaths.has(f.path));
      if (allSelected) {
        setSelectedPaths(new Set());
        setSelectionMode(false);
      } else {
        setSelectedPaths(new Set(files.map(f => f.path)));
        setSelectionMode(true);
      }
    }
  }, [isFiltering, filteredFiles, selectedPaths, files, selectedSourceId]);

  // Download files
  const handleDownloadFiles = useCallback(async (pathSet: Set<string>) => {
    if (pathSet.size === 0 || downloadActiveRef.current) return;
    if (serverStatus === 'disconnected' || serverStatus === 'unknown') {
      Alert.alert('Offline', 'Connect to a server before downloading files.');
      return;
    }
    downloadActiveRef.current = true;
    const total = pathSet.size;
    // Set progress immediately so the banner mounts with isDownloading and
    // the layout never flips between "downloading chrome" and an empty gap.
    setDownloadProgress({
      current: 0,
      total,
      fileName: 'Preparing…',
      bytesWritten: 0,
      bytesTotal: 0,
    });
    setIsDownloading(true);

    let saved = 0;
    let skipped = 0;
    let failed = 0;

    const publishProgress = (
      current: number,
      fileName: string,
      bytesWritten: number,
      bytesTotal: number,
    ) => {
      if (!downloadActiveRef.current) return;
      setDownloadProgress({ current, total, fileName, bytesWritten, bytesTotal });
    };

    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (!downloadActiveRef.current) return;
      const canSaveToGallery = status === 'granted';

      let completed = 0;

      for (const path of pathSet) {
        if (!downloadActiveRef.current) return;

        const fileInfo = files.find(f => f.path === path);
        const displayName = path.split(/[/\\]/).pop() ?? path;
        const knownSize = fileInfo?.size || 0;
        publishProgress(completed, displayName, 0, knownSize);

        try {
          if (!FileSystem.cacheDirectory) {
            failed++;
            completed++;
            publishProgress(completed, displayName, 0, 0);
            continue;
          }

          const localPath = sanitizeRelativePath(path);
          const ext = localPath.split('.').pop()?.toLowerCase() ?? '';
          const isMedia = isMediaExtension(ext);

          const onFileProgress = (written: number, totalBytes: number) => {
            if (!downloadActiveRef.current) return;
            setDownloadProgress(prev =>
              prev
                ? {
                    ...prev,
                    bytesWritten: written,
                    bytesTotal: totalBytes > 0 ? totalBytes : prev.bytesTotal,
                  }
                : prev,
            );
          };

          if (isMedia && canSaveToGallery) {
            const tmpUri = FileSystem.cacheDirectory + 'restore_tmp_' + Date.now() + '_' + displayName;
            if (sourceMode === 'shared' && selectedSourceId) {
              await downloadSharedFile(selectedSourceId, path, tmpUri, onFileProgress);
            } else {
              await downloadFile(path, tmpUri, onFileProgress);
            }
            if (!downloadActiveRef.current) {
              await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => undefined);
              return;
            }
            try {
              await MediaLibrary.saveToLibraryAsync(tmpUri);
              saved++;
            } finally {
              await FileSystem.deleteAsync(tmpUri, { idempotent: true });
            }
            completed++;
            publishProgress(completed, displayName, 0, 0);
            continue;
          }

          if (!FileSystem.documentDirectory) {
            failed++;
            completed++;
            publishProgress(completed, displayName, 0, 0);
            continue;
          }
          const destUri = FileSystem.documentDirectory + localPath;
          const folderUri = destUri.substring(0, destUri.lastIndexOf('/'));
          const folderInfo = await FileSystem.getInfoAsync(folderUri);
          if (!folderInfo.exists) await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });

          const existingInfo = await FileSystem.getInfoAsync(destUri);
          if (existingInfo.exists && fileInfo?.size && (existingInfo as any).size === fileInfo.size) {
            skipped++;
            completed++;
            publishProgress(completed, displayName, 0, 0);
            continue;
          }

          if (sourceMode === 'shared' && selectedSourceId) {
            await downloadSharedFile(selectedSourceId, path, destUri, onFileProgress);
          } else {
            await downloadFile(path, destUri, onFileProgress);
          }
          if (!downloadActiveRef.current) return;
          saved++;
          completed++;
          publishProgress(completed, displayName, 0, 0);
        } catch (e) {
          console.warn(`Failed to restore ${path}:`, e);
          failed++;
          completed++;
          publishProgress(completed, displayName, 0, 0);
        }
      }

      if (!downloadActiveRef.current) return;

      const parts: string[] = [];
      if (saved > 0) parts.push(`${saved} saved to gallery / storage`);
      if (skipped > 0) parts.push(`${skipped} already present`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (saved > 0) hapticSuccess();
      else if (failed > 0) hapticError();
      Alert.alert('Restore Complete', parts.join('\n') || 'Nothing was downloaded.');
      setSelectedPaths(new Set());
      setSelectionMode(false);
    } catch (e) {
      if (!downloadActiveRef.current || !restoreMountedRef.current) return;
      console.warn('Restore download aborted:', e);
      hapticError();
      Alert.alert('Restore Failed', sanitizeErrorMessage(e, 'Could not complete the download.'));
    } finally {
      downloadActiveRef.current = false;
      if (restoreMountedRef.current) {
        setIsDownloading(false);
        setDownloadProgress(null);
      }
    }
  }, [files, sourceMode, selectedSourceId, serverStatus]);

  const handleDownloadSingle = useCallback(async (file: RemoteFile) => {
    closePreview();
    if (downloadSingleTimerRef.current) {
      clearTimeout(downloadSingleTimerRef.current);
    }
    downloadSingleTimerRef.current = setTimeout(() => {
      downloadSingleTimerRef.current = null;
      void handleDownloadFiles(new Set([file.path]));
    }, 300);
  }, [closePreview, handleDownloadFiles]);

  const handleDownload = useCallback(
    () => handleDownloadFiles(selectedPaths),
    [handleDownloadFiles, selectedPaths],
  );


  const warmPreviewUrl = useMemo(() => {
    if (!warmPreviewFile || !serverConfig || getFileCategory(warmPreviewFile.path) !== 'video') {
      return '';
    }
    return buildVideoPreviewUrl(serverConfig, warmPreviewFile.path, sourceMode, selectedSourceId);
  }, [warmPreviewFile, serverConfig, sourceMode, selectedSourceId]);

  const fetchDisabled = isFetching || isDownloading || isOffline ||
    (sourceMode === 'shared' && !selectedSourceId);

  // Single overall progress: finished files + current file byte fraction.
  const downloadPercent = useMemo(() => {
    if (!downloadProgress || downloadProgress.total <= 0) return 0;
    if (downloadProgress.fileName === 'Preparing…') return 0;
    const fileFraction =
      downloadProgress.bytesTotal > 0
        ? Math.min(downloadProgress.bytesWritten / downloadProgress.bytesTotal, 1)
        : 0;
    const overall = (downloadProgress.current + fileFraction) / downloadProgress.total;
    return Math.max(0, Math.min(Math.round(overall * 100), 100));
  }, [downloadProgress]);

  const isPreparingDownload = downloadProgress?.fileName === 'Preparing…';

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />

      {/* Download progress banner — replaces page header while restoring */}
      {isDownloading && downloadProgress ? (
        <View style={[styles.progressContainer, { paddingTop: insets.top + Spacing.two }]}>
          <Text style={styles.progressText}>
            {isPreparingDownload
              ? 'Preparing download…'
              : `Downloading ${Math.min(downloadProgress.current + 1, downloadProgress.total)} / ${downloadProgress.total}`}
          </Text>
          <Text style={styles.progressSubtext} numberOfLines={1}>
            {isPreparingDownload ? 'Waiting for permission…' : downloadProgress.fileName}
          </Text>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${downloadPercent}%` }]} />
          </View>
          <Text style={styles.progressPercentText}>{downloadPercent}%</Text>
        </View>
      ) : (
        /* Page Header — absolute+collapsible when browsing */
        <ReAnimated.View
          onLayout={onHeaderLayout}
          style={[
            styles.pageHeader,
            {
              paddingTop: Spacing.five,
              backgroundColor: colors.bg,
            },
            headerAnimatedStyle,
          ]}
        >
          <View style={styles.pageHeaderTopRow}>
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={styles.pageTitle}>Library</Text>
              <AnimatedPressable
                onPress={() => router.push('/memories')}
                style={styles.memoriesHeaderBtn}
                scaleDown={0.88}
                accessibilityLabel="Open Memories"
              >
                <AppIcon androidName="auto_awesome" iosName="sparkles" color={colors.primary} size={18} />
                {hasMemories && <View style={styles.memoriesBadgeDot} />}
              </AnimatedPressable>
            </View>
            <Text style={styles.pageSubtitle}>
              {files.length > 0
                ? isFiltering
                  ? `${filteredFiles.length.toLocaleString()} matching of ${files.length.toLocaleString()} files`
                  : `${files.length.toLocaleString()} files on server`
                : 'Download files from server'}
            </Text>
          </View>
          <View style={styles.headerButtons}>
            <AnimatedPressable
              onPress={handleFetch}
              style={[styles.actionBtn, fetchDisabled && styles.disabledBtn]}
              disabled={fetchDisabled}
              scaleDown={0.92}
              haptic
              accessibilityLabel="Fetch files from server"
            >
              {isFetching ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <>
                  <AppIcon androidName="sync" iosName="arrow.triangle.2.circlepath" color={fetchDisabled ? colors.textMuted : colors.primary} size={16} />
                  <Text style={[styles.actionBtnText, { color: fetchDisabled ? colors.textMuted : colors.primary }]}>Fetch</Text>
                </>
              )}
            </AnimatedPressable>
            {files.length > 0 && (
              <AnimatedPressable onPress={selectAll} style={[styles.actionBtn, isOffline && styles.disabledBtn]} disabled={isDownloading || isOffline} scaleDown={0.92} haptic>
                <AppIcon androidName="select_all" iosName="checkmark.circle" color={isOffline ? colors.textMuted : colors.primary} size={16} />
                <Text style={[styles.actionBtnText, { color: isOffline ? colors.textMuted : colors.primary }]}>
                  {isFiltering
                    ? (filteredFiles.length > 0 && filteredFiles.every(f => selectedPaths.has(f.path)) ? 'Deselect' : 'Select visible')
                    : (files.length > 0 && files.every(f => selectedPaths.has(f.path)) ? 'Deselect All' : 'Select All')}
                </Text>
              </AnimatedPressable>
            )}
          </View>
          </View>

          <SourceSelector
            mode={sourceMode}
            sharedSources={sharedSources}
            selectedSourceId={selectedSourceId}
            sharedViewMode={sharedViewMode}
            onSharedViewModeChange={handleSharedViewModeChange}
            isLoadingSources={isLoadingSources}
            isOffline={isOffline}
            sortEnabled={files.length > 0 && !isFeedMode}
            sortField={sortField}
            sortDir={sortDir}
            onModeChange={handleModeChange}
            onSourceSelect={handleSourceSelect}
            onSortChange={handleSortChange}
            colors={colors}
          />

          {files.length > 0 && (
            <LibraryFilterBar
              query={searchQuery}
              onQueryChange={(q) => { setSearchQuery(q); runSearch(q); }}
              matchCount={filteredFiles.length}
              totalCount={files.length}
              colors={colors}
            />
          )}
          {/* Hint Bar */}
          {files.length > 0 && selectedPaths.size === 0 && !selectionMode && !isDownloading && (
            <View style={[styles.hintBar, { borderColor: colors.surfaceBorder }]}>
              <AppIcon androidName="touch_app" iosName="hand.tap" color={colors.textMuted} size={13} />
              <Text style={[styles.hintText, { color: colors.textMuted }]}>
                {isFeedMode ? 'Tap to preview · tap emoji to react' : 'Tap to preview · long press to select'}
              </Text>
            </View>
          )}

          {/* Selection Info Bar */}
          {selectedPaths.size > 0 && !isDownloading && (
            <View style={[styles.selectionBar, { borderColor: colors.surfaceBorder }]}>
              <AppIcon androidName="check_circle" iosName="checkmark.circle" color={colors.primary} size={16} />
              <Text style={[styles.selectionBarText, { color: colors.primary }]}>
                {selectedPaths.size} {selectedPaths.size === 1 ? 'file' : 'files'} selected
              </Text>
              <TouchableOpacity
                onPress={() => { setSelectedPaths(new Set()); setSelectionMode(false); }}
                style={styles.clearSelBtn}
              >
                <Text style={[styles.clearSelText, { color: colors.textSecondary }]}>Clear</Text>
              </TouchableOpacity>
            </View>
          )}
        </ReAnimated.View>
      )}

      <View style={{ flex: 1 }}>
      {/* File Tree or Shared Feed List */}
      <FlatList
        style={{ flex: 1 }}
        data={isFeedMode ? (isFiltering ? filteredFiles : files) : (listRows as any)}
        keyExtractor={(item: any) => (isFeedMode ? item.path : item.node.key)}
        renderItem={({ item }: any) =>
          isFeedMode ? (
            <SharedFeedCard
              item={item}
              serverConfig={serverConfig}
              sourceId={selectedSourceId!}
              onPreview={handlePreview}
              onReact={handleToggleReaction}
              colors={colors}
            />
          ) : (
            <TreeNodeView
              node={item.node}
              depth={item.depth}
              isExpanded={expandedKeys.has(item.node.key)}
              selectedPaths={selectedPaths}
              selectionMode={selectionMode}
              isLoadingSelection={loadingNodeKeys.has(item.node.key)}
              onToggleNode={handleToggleNode}
              onEnterSelectionMode={handleEnterSelectionMode}
              onToggleExpand={handleToggleExpand}
              onPreview={handlePreview}
              onWarmPreview={handleWarmPreview}
              styles={styles}
              colors={colors}
            />
          )
        }
        contentContainerStyle={[
          styles.listContent,
          {
            paddingTop: isDownloading ? Spacing.two : containerPaddingTop + Spacing.two,
            paddingBottom: BottomTabInset + Spacing.eight,
          },
        ]}
        showsVerticalScrollIndicator={false}
        onScroll={isDownloading ? undefined : onListScroll}
        onScrollEndDrag={isDownloading ? undefined : onListScrollEndDrag}
        onMomentumScrollEnd={isDownloading ? undefined : onListMomentumScrollEnd}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        extraData={selectedPaths}
        refreshControl={
          isDownloading ? undefined : (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefreshLibrary}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressViewOffset={containerPaddingTop}
            />
          )
        }
        removeClippedSubviews
        initialNumToRender={24}
        maxToRenderPerBatch={24}
        updateCellsBatchingPeriod={50}
        windowSize={9}
        ListEmptyComponent={
          !isFetching && !(isFiltering && isSearching) ? (
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
                <AppIcon
                  androidName={isFiltering ? 'search' : 'cloud_download'}
                  iosName={isFiltering ? 'magnifyingglass' : 'icloud.and.arrow.down'}
                  color={colors.primary}
                  size={36}
                  fallback={isFiltering ? '?' : '⬇️'}
                />
              </View>
              <Text style={styles.emptyTitle}>{isFiltering ? 'No matching files' : 'No files fetched'}</Text>
              <Text style={styles.emptySubtitle}>
                {isFiltering
                  ? 'Try a different name.'
                  : sourceMode === 'shared' && !selectedSourceId
                    ? 'Select a shared folder above, then tap Fetch.'
                    : 'Tap Fetch to see files available on the server.'}
              </Text>
            </View>
          ) : null
        }
      />
      </View>

      {/* Download FAB */}
      {selectedPaths.size > 0 && !isDownloading && (
        <AnimatedPressable
          style={[styles.fab, { bottom: BottomTabInset + Spacing.four }, isOffline && styles.disabledBtn]}
          onPress={handleDownload}
          disabled={isOffline}
          scaleDown={0.94}
        >
          <AppIcon androidName="download" iosName="arrow.down.circle" color={colors.white} size={22} />
          <Text style={styles.fabText}>Download {selectedPaths.size} {selectedPaths.size === 1 ? 'File' : 'Files'}</Text>
        </AnimatedPressable>
      )}

      {/* Preview Modal */}
      <VideoPreviewPreloader uri={warmPreviewUrl} />
      {previewFile && (
        <PreviewModal
          file={previewFile}
          fileList={previewableFiles}
          currentIndex={previewIndex}
          sourceMode={sourceMode}
          selectedSourceId={selectedSourceId}
          serverConfig={serverConfig}
          onClose={closePreview}
          onNavigate={handlePreviewNavigate}
          onDownload={handleDownloadSingle}
          colors={colors}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    listContent: { paddingHorizontal: Spacing.four, paddingTop: Spacing.two, flexGrow: 1 },
    pageHeader: {
      paddingBottom: Spacing.three,
    },
    pageHeaderTopRow: {
      flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
      paddingHorizontal: Spacing.five,
    },
    pageTitle: { fontSize: TextScale.xl, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
    pageSubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '500', marginTop: 2 },
    memoriesHeaderBtn: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    memoriesBadgeDot: {
      position: 'absolute',
      top: 3,
      right: 3,
      width: 7,
      height: 7,
      borderRadius: 3.5,
      backgroundColor: colors.primary,
    },
    headerButtons: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    actionBtn: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.one,
      paddingHorizontal: Spacing.three, paddingVertical: Spacing.two,
      borderRadius: Radius.md, backgroundColor: colors.primarySoft,
    },
    actionBtnText: { fontSize: TextScale.xs, fontWeight: '700' },

    hintBar: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingHorizontal: Spacing.five, paddingVertical: 5,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    hintText: { fontSize: TextScale.xs },

    selectionBar: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: Spacing.five, paddingVertical: Spacing.two,
      borderBottomWidth: 1, gap: Spacing.two,
    },
    selectionBarText: { fontSize: TextScale.sm, fontWeight: '600', flex: 1 },
    clearSelBtn: { paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
    clearSelText: { fontSize: TextScale.sm, fontWeight: '500' },

    folderRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingRight: Spacing.three, paddingVertical: Spacing.two, gap: Spacing.two,
    },
    chevronBtn: { width: 28, alignItems: 'center', justifyContent: 'center' },
    folderLabelBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flex: 1 },
    folderName: { fontSize: TextScale.base, fontWeight: '600', color: colors.text, flex: 1 },
    folderBadge: { alignItems: 'flex-end' },
    folderBadgeText: { fontSize: TextScale.xs, color: colors.textSecondary },
    folderBadgeSize: { fontSize: TextScale.xs, color: colors.textMuted },

    fileRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingRight: Spacing.three, paddingVertical: Spacing.two + 2, gap: Spacing.two,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.surfaceBorder,
      borderRadius: Radius.sm,
    },
    fileRowSelected: {
      backgroundColor: colors.primarySoft,
    },
    fileIconWrap: {
      width: 32, height: 32, borderRadius: Radius.md,
      backgroundColor: colors.surfaceSoft,
      alignItems: 'center', justifyContent: 'center',
    },
    fileInfo: { flex: 1 },
    fileName: { fontSize: TextScale.sm, color: colors.text, fontWeight: '500' },
    fileMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    fileSize: { fontSize: TextScale.xs, color: colors.textMuted },
    fileDot: { fontSize: TextScale.xs, color: colors.textMuted },
    fileDate: { fontSize: TextScale.xs, color: colors.textMuted },

    checkbox: {
      width: 20, height: 20, borderRadius: 5, borderWidth: 2,
      borderColor: colors.textSecondary, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    checkboxSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
    checkboxPartial: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
    partialDot: { width: 8, height: 8, borderRadius: 2, backgroundColor: colors.primary },

    fab: {
      position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center',
      backgroundColor: colors.primary, paddingVertical: Spacing.three, paddingHorizontal: Spacing.six,
      borderRadius: Radius.full, gap: Spacing.two, ...Shadows.soft,
    },
    fabText: { color: colors.white, fontWeight: '700', fontSize: TextScale.md },
    disabledBtn: { opacity: 0.4 },

    emptyContainer: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: Spacing.seven, paddingTop: Spacing.nine, gap: Spacing.four,
    },
    emptyIconWrap: { width: 88, height: 88, borderRadius: Radius.xxl, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: { fontSize: TextScale.md, fontWeight: '800', color: colors.text, textAlign: 'center' },
    emptySubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, fontWeight: '500' },

    progressContainer: {
      backgroundColor: colors.surface, paddingHorizontal: Spacing.five,
      paddingBottom: Spacing.three, borderBottomWidth: 1, borderBottomColor: colors.surfaceBorder,
    },
    progressText: { fontSize: TextScale.sm, fontWeight: '700', color: colors.text, marginBottom: Spacing.one },
    progressSubtext: { fontSize: TextScale.xs, color: colors.textSecondary, marginBottom: Spacing.two },
    progressBarBg: { height: 6, backgroundColor: colors.surfaceBorder, borderRadius: Radius.full, overflow: 'hidden' },
    progressBarFill: { height: '100%', backgroundColor: colors.primary, borderRadius: Radius.full },
    progressPercentText: {
      fontSize: TextScale.xs, fontWeight: '600', color: colors.textSecondary,
      marginTop: Spacing.one, textAlign: 'right',
    },
  });

// ─────────────────────────────────────────────────────────────────────────────
// Preview Modal Styles
// ─────────────────────────────────────────────────────────────────────────────

const pvStyles = StyleSheet.create({
  root: { flex: 1, position: 'relative' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
    paddingHorizontal: Spacing.four, paddingBottom: Spacing.three, zIndex: 10,
  },
  topBarCenter: { flex: 1, alignItems: 'center' },
  topBarTitle: {
    color: '#fff', fontSize: TextScale.sm, fontWeight: '600',
    textAlign: 'center',
  },
  topBarCounter: {
    color: 'rgba(255,255,255,0.5)', fontSize: TextScale.xs, textAlign: 'center', marginTop: 1,
  },
  topBarRightActions: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.one,
  },
  topBarBtn: {
    padding: Spacing.two, borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  downloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: Spacing.three },
  downloadBtnText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '600' },

  zoomPill: {
    position: 'absolute', top: 90, alignSelf: 'center', zIndex: 15,
    backgroundColor: 'rgba(0,0,0,0.75)', paddingHorizontal: Spacing.four, paddingVertical: Spacing.two,
    borderRadius: Radius.full, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  zoomPillText: { color: '#fff', fontSize: TextScale.xs, fontWeight: '600' },

  contentArea: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center',
  },
  transitionLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomWrap: { justifyContent: 'center', alignItems: 'center' },
  imgLoadingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center',
    gap: Spacing.three,
  },

  navArrowLeft: {
    position: 'absolute',
    left: 8,
    top: '50%',
    marginTop: -24,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  navArrowRight: {
    position: 'absolute',
    right: 8,
    top: '50%',
    marginTop: -24,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  navArrowBtnInner: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  // For video: override vertical position to sit at ~35% from top (clear of the controls bar)
  // and force full opacity so arrows are always visible.
  navArrowVideoPosition: { top: '35%', marginTop: -22, opacity: 1 },

  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: Spacing.five, paddingTop: Spacing.two, gap: 6,
  },
  bottomSize: { color: 'rgba(255,255,255,0.7)', fontSize: TextScale.xs },
  bottomDot: { color: 'rgba(255,255,255,0.4)', fontSize: TextScale.xs },
  bottomDate: { color: 'rgba(255,255,255,0.7)', fontSize: TextScale.xs },

  centeredBox: { alignItems: 'center', gap: Spacing.three, padding: Spacing.six },
  loadingText: { fontSize: TextScale.sm, marginTop: Spacing.two },
  errorText: { fontSize: TextScale.base, fontWeight: '700' },
  errorSub: { fontSize: TextScale.sm, textAlign: 'center' },

  imageFull: { width: SCREEN_W, height: SCREEN_H },

  videoContainer: { width: SCREEN_W, height: SCREEN_H },
  videoFull: { width: '100%', height: '100%' },
  videoLoadingText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '600' },
  // Legacy single-row bar — kept so any remaining references compile
  videoControlsBar: {
    position: 'absolute',
    left: Spacing.six,
    right: Spacing.six,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  videoPlayBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  videoProgressBg: {
    flex: 1, height: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  videoProgressFill: { height: '100%', backgroundColor: '#fff', borderRadius: Radius.full },
  videoTimeText: { color: 'rgba(255,255,255,0.85)', fontSize: TextScale.xs, fontWeight: '600' },

  // ── Full-featured controls panel ──────────────────────────────────────────
  videoControlsPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    paddingTop: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.55)',
    gap: Spacing.two,
  },

  // Seekbar row
  videoSeekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: 2,
  },
  videoTimeLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: TextScale.xs,
    fontWeight: '600',
    minWidth: 36,
    textAlign: 'center',
  },
  videoSeekTrackWrap: {
    flex: 1,
    height: 28,          // tall hit area; visual bar is inset via padding
    justifyContent: 'center',
    position: 'relative',
  },
  videoSeekTrackBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 3,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.25)',
    top: '50%',
    marginTop: -1.5,
  },
  videoSeekTrackFill: {
    position: 'absolute',
    left: 0,
    height: 3,
    borderRadius: Radius.full,
    backgroundColor: '#fff',
    top: '50%',
    marginTop: -1.5,
  },
  videoSeekThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
    top: '50%',
    marginTop: -7,
    marginLeft: -7,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  videoSeekThumbActive: {
    width: 18,
    height: 18,
    borderRadius: 9,
    marginTop: -9,
    marginLeft: -9,
    backgroundColor: '#4CA8FF',
  },

  // Buttons row
  videoButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.one,
  },
  videoCtrlBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoPlayBtnLarge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  videoDurationText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: TextScale.xs,
    fontWeight: '600',
  },
  externalMediaPlayer: {
    width: SCREEN_W,
    alignItems: 'center',
    paddingHorizontal: Spacing.seven,
    gap: Spacing.three,
  },
  externalMediaIcon: {
    width: 88,
    height: 88,
    borderRadius: Radius.xxl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  externalMediaTitle: { color: '#fff', fontSize: TextScale.md, fontWeight: '800' },
  externalMediaBody: { color: 'rgba(255,255,255,0.7)', fontSize: TextScale.sm, textAlign: 'center' },
  externalMediaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.one,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.three,
    borderRadius: Radius.full,
    backgroundColor: '#2678E8',
  },
  externalMediaButtonText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '800' },

  audioPlayer: { alignItems: 'center', padding: Spacing.six, gap: Spacing.four, width: SCREEN_W },
  audioIconWrap: { width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center' },
  audioFileName: { color: '#fff', fontSize: TextScale.base, fontWeight: '600', textAlign: 'center', paddingHorizontal: Spacing.six },
  audioProgressBg: { width: SCREEN_W * 0.8, height: 4, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: Radius.full, overflow: 'hidden' },
  audioProgressFill: { height: '100%', borderRadius: Radius.full },
  audioTimings: { flexDirection: 'row', justifyContent: 'space-between', width: SCREEN_W * 0.8 },
  audioTime: { color: 'rgba(255,255,255,0.6)', fontSize: TextScale.xs },
  audioPlayBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.two },

  metaCard: { alignItems: 'center', padding: Spacing.six, gap: Spacing.four, width: SCREEN_W * 0.9 },
  metaIconWrap: { width: 96, height: 96, borderRadius: Radius.xxl, alignItems: 'center', justifyContent: 'center' },
  metaFileName: { fontSize: TextScale.base, fontWeight: '700', textAlign: 'center', color: '#fff' },
  metaTable: { width: '100%', borderRadius: Radius.lg, borderWidth: 1, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.07)' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.four, paddingVertical: Spacing.three },
  metaLabel: { fontSize: TextScale.sm, color: 'rgba(255,255,255,0.5)' },
  metaValue: { fontSize: TextScale.sm, fontWeight: '600', color: '#fff' },
  metaNote: { fontSize: TextScale.xs, textAlign: 'center', color: 'rgba(255,255,255,0.45)', lineHeight: 18 },
});