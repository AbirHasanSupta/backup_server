import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  FlatList,
  Modal,
  Alert,
  useWindowDimensions,
  BackHandler,
  RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';

import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedListItem } from '@/components/AnimatedListItem';
import { useAppTheme } from '@/hooks/use-app-theme';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import { hapticMedium, hapticLight } from '@/utils/haptics';
import { getPlaceName } from '@/utils/geocode';
import {
  getPlaceClusters,
  getPlaceItems,
  getConfig,
  buildPreviewUrl,
  buildVideoPreviewUrl,
  buildThumbnailUrl,
  downloadFile,
  downloadSharedFile,
} from '../../downloader';

type ExpoVideoModule = typeof import('expo-video');
type VideoSource = import('expo-video').VideoSource;
let expoVideoModule: ExpoVideoModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
  expoVideoModule = require('expo-video') as ExpoVideoModule;
} catch {
  console.warn('[Places] expo-video unavailable — videos will show as a static card.');
}

type PlaceCluster = {
  cluster_key: string;
  lat: number;
  lon: number;
  count: number;
  cover: { source_type: string; source_id: string; relative_path: string; is_video: boolean };
};

type PlaceItem = {
  source_type: string;
  source_id: string;
  source_label: string;
  relative_path: string;
  size: number;
  capture_time: number | null;
  is_video: boolean;
  year: number | null;
};

// Module-level in-memory cache to retain places data and thumbnails across visits
let _cachedPlaces: PlaceCluster[] | null = null;
let _cachedServerConfig: any | null = null;
const _cachedPlaceNames: Record<string, string | null> = {};
const _cachedClusterItems: Map<string, PlaceItem[]> = new Map();
const _prefetchedUrls = new Set<string>();
let _preloadPromise: Promise<void> | null = null;

export function preloadPlaceThumbnails(config: any, clusters: PlaceCluster[]): void {
  if (!config || !clusters || clusters.length === 0) return;
  const urls: string[] = [];
  for (const item of clusters) {
    if (!item?.cover?.relative_path) continue;
    const url = buildThumbnailUrl(config, item.cover.relative_path, item.cover.source_type, item.cover.source_id);
    if (url && !_prefetchedUrls.has(url)) {
      _prefetchedUrls.add(url);
      urls.push(url);
    }
  }
  if (urls.length > 0) {
    Image.prefetch(urls, 'memory-disk').catch(() => {});
  }
}

export function preloadClusterThumbnails(config: any, items: PlaceItem[]): void {
  if (!config || !items || items.length === 0) return;
  const urls: string[] = [];
  for (const item of items) {
    if (!item?.relative_path) continue;
    const url = buildThumbnailUrl(config, item.relative_path, item.source_type, item.source_id);
    if (url && !_prefetchedUrls.has(url)) {
      _prefetchedUrls.add(url);
      urls.push(url);
    }
  }
  if (urls.length > 0) {
    Image.prefetch(urls, 'memory-disk').catch(() => {});
  }
}

/**
 * Pre-warm places data and cover thumbnails into memory.
 * Can be called proactively from parent screens (e.g. Memories).
 */
export async function preloadPlacesCache(): Promise<void> {
  if (_preloadPromise) return _preloadPromise;
  _preloadPromise = (async () => {
    try {
      const [cfg, res] = await Promise.all([getConfig(), getPlaceClusters()]);
      _cachedServerConfig = cfg;
      const placesList = Array.isArray(res?.places) ? res.places : [];
      _cachedPlaces = placesList;
      preloadPlaceThumbnails(cfg, placesList);
    } catch {
      // Ignore preload failures in background
    } finally {
      _preloadPromise = null;
    }
  })();
  return _preloadPromise;
}

export function clearPlacesMemoryCache(): void {
  _cachedPlaces = null;
  _cachedServerConfig = null;
  _cachedClusterItems.clear();
  _prefetchedUrls.clear();
}

function safeCall(fn: () => void): void {
  try { fn(); } catch (e) { console.warn('[Places] player error:', e); }
}

function formatCoordinates(lat?: number, lon?: number): string {
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return '';
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${latDir}, ${Math.abs(lon).toFixed(2)}° ${lonDir}`;
}

export default function PlacesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const { width, height } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [serverConfig, setServerConfig] = useState<any>(_cachedServerConfig);
  const [places, setPlaces] = useState<PlaceCluster[]>(_cachedPlaces ?? []);
  const [loading, setLoading] = useState(_cachedPlaces === null);
  const [error, setError] = useState<string | null>(null);

  const [activeCluster, setActiveCluster] = useState<PlaceCluster | null>(null);
  const [clusterItems, setClusterItems] = useState<PlaceItem[]>([]);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const viewerListRef = useRef<FlatList<PlaceItem>>(null);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [placeNames, setPlaceNames] = useState<Record<string, string | null>>({ ..._cachedPlaceNames });
  const resolvedPlaceKeysRef = useRef<Set<string>>(new Set(Object.keys(_cachedPlaceNames)));

  const load = useCallback(async (isSilent = false) => {
    if (!isSilent && _cachedPlaces === null) {
      setLoading(true);
    }
    setError(null);
    try {
      const [cfg, res] = await Promise.all([getConfig(), getPlaceClusters()]);
      _cachedServerConfig = cfg;
      setServerConfig(cfg);
      const placesList = Array.isArray(res?.places) ? res.places : [];
      _cachedPlaces = placesList;
      setPlaces(placesList);
      preloadPlaceThumbnails(cfg, placesList);
    } catch (err: any) {
      if (_cachedPlaces === null) {
        setError(sanitizeErrorMessage(err, 'Could not load places.'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const hasCache = _cachedPlaces !== null;
      load(hasCache);
    }, [load])
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const place of places) {
        if (cancelled) return;
        if (_cachedPlaceNames[place.cluster_key] !== undefined) {
          if (!resolvedPlaceKeysRef.current.has(place.cluster_key)) {
            resolvedPlaceKeysRef.current.add(place.cluster_key);
            setPlaceNames(prev => ({ ...prev, [place.cluster_key]: _cachedPlaceNames[place.cluster_key] }));
          }
          continue;
        }
        if (resolvedPlaceKeysRef.current.has(place.cluster_key)) continue;
        const name = await getPlaceName(place.lat, place.lon);
        if (cancelled) return;
        _cachedPlaceNames[place.cluster_key] = name;
        resolvedPlaceKeysRef.current.add(place.cluster_key);
        setPlaceNames(prev => ({ ...prev, [place.cluster_key]: name }));
      }
    })();
    return () => { cancelled = true; };
  }, [places]);

  const openCluster = useCallback(async (cluster: PlaceCluster) => {
    hapticMedium();
    setActiveCluster(cluster);
    const cached = _cachedClusterItems.get(cluster.cluster_key);
    if (cached && cached.length > 0) {
      setClusterItems(cached);
      setClusterLoading(false);
      if (_cachedServerConfig) {
        preloadClusterThumbnails(_cachedServerConfig, cached);
      }
    } else {
      setClusterItems([]);
      setClusterLoading(true);
    }

    try {
      const res = await getPlaceItems(cluster.cluster_key);
      const items = Array.isArray(res?.items) ? res.items : [];
      _cachedClusterItems.set(cluster.cluster_key, items);
      setClusterItems(items);
      const cfg = _cachedServerConfig || (await getConfig());
      preloadClusterThumbnails(cfg, items);
    } catch (err: any) {
      if (!cached) {
        Alert.alert('Failed to Load', sanitizeErrorMessage(err, 'Could not load this place.'));
      }
    } finally {
      setClusterLoading(false);
    }
  }, []);

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const closeCluster = useCallback(() => {
    setActiveCluster(null);
    setClusterItems([]);
    setViewerIndex(null);
  }, []);

  const closeViewer = useCallback(() => setViewerIndex(null), []);

  // Back navigation handling: Keep latest modal state in refs
  const viewerIndexRef = useRef(viewerIndex);
  const activeClusterRef = useRef(activeCluster);
  const closeViewerRef = useRef(closeViewer);
  const closeClusterRef = useRef(closeCluster);

  useEffect(() => {
    viewerIndexRef.current = viewerIndex;
    activeClusterRef.current = activeCluster;
    closeViewerRef.current = closeViewer;
    closeClusterRef.current = closeCluster;
  }, [viewerIndex, activeCluster, closeViewer, closeCluster]);

  // Hardware/default back gesture:
  // - If full-screen viewer is open -> close viewer
  // - If cluster modal is open -> close cluster
  // - Otherwise -> always navigate back to memories tab
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (viewerIndexRef.current !== null) {
          closeViewerRef.current();
          return true;
        }
        if (activeClusterRef.current !== null) {
          closeClusterRef.current();
          return true;
        }
        router.replace('/memories');
        return true;
      };

      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => sub.remove();
    }, [router])
  );

  const activeViewerItem = viewerIndex != null && clusterItems[viewerIndex] ? clusterItems[viewerIndex] : null;

  const handleSaveViewerItem = async () => {
    if (!activeViewerItem || saving) return;
    setSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Needed', 'Media library permission is required to save photos and videos.');
        return;
      }
      const displayName = activeViewerItem.relative_path.split(/[/\\]/).pop() ?? `place_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}place_save_${Date.now()}_${displayName}`;
      if (activeViewerItem.source_type === 'shared') {
        await downloadSharedFile(activeViewerItem.source_id, activeViewerItem.relative_path, tmpUri);
      } else {
        await downloadFile(activeViewerItem.relative_path, tmpUri);
      }
      await MediaLibrary.saveToLibraryAsync(tmpUri);
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      Alert.alert('Saved', 'Saved to your gallery!');
    } catch (err: any) {
      Alert.alert('Save Failed', sanitizeErrorMessage(err, 'Could not save file to device.'));
    } finally {
      setSaving(false);
    }
  };

  const handleShareViewerItem = async () => {
    if (!activeViewerItem || sharing) return;
    setSharing(true);
    try {
      const displayName = activeViewerItem.relative_path.split(/[/\\]/).pop() ?? `place_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}place_share_${Date.now()}_${displayName}`;
      if (activeViewerItem.source_type === 'shared') {
        await downloadSharedFile(activeViewerItem.source_id, activeViewerItem.relative_path, tmpUri);
      } else {
        await downloadFile(activeViewerItem.relative_path, tmpUri);
      }
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Sharing Unavailable', 'Sharing is not available on this device.');
        return;
      }
      await Sharing.shareAsync(tmpUri);
      await FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
    } catch (err: any) {
      Alert.alert('Share Failed', sanitizeErrorMessage(err, 'Could not share this file.'));
    } finally {
      setSharing(false);
    }
  };

  const goToPrevious = () => {
    if (viewerIndex != null && viewerIndex > 0) {
      const nextIdx = viewerIndex - 1;
      setViewerIndex(nextIdx);
      viewerListRef.current?.scrollToIndex({ index: nextIdx, animated: true });
    }
  };

  const goToNext = () => {
    if (viewerIndex != null && viewerIndex < clusterItems.length - 1) {
      const nextIdx = viewerIndex + 1;
      setViewerIndex(nextIdx);
      viewerListRef.current?.scrollToIndex({ index: nextIdx, animated: true });
    }
  };

  const gridGap = Spacing.two;
  const cols = 3;
  const cellSize = (width - Spacing.four * 2 - gridGap * (cols - 1)) / cols;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.replace('/memories')} accessibilityLabel="Go back">
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Places</Text>
          <Text style={styles.headerSubtitle}>
            {loading ? 'Finding memories by location…' : places.length > 0 ? `${places.length} places` : 'No geotagged memories yet'}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <AppIcon androidName="cloud_off" iosName="wifi.slash" color={colors.textMuted} size={40} />
          <Text style={styles.emptySubtitle}>{error}</Text>
        </View>
      ) : places.length === 0 ? (
        <View style={styles.centered}>
          <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
            <AppIcon androidName="place" iosName="mappin.and.ellipse" color={colors.primary} size={36} />
          </View>
          <Text style={styles.emptyTitle}>No places yet</Text>
          <Text style={styles.emptySubtitle}>
            Photos with location data will show up here once they&apos;re backed up and indexed.
          </Text>
        </View>
      ) : (
        <FlatList
          data={places}
          keyExtractor={(item) => item.cluster_key}
          numColumns={3}
          contentContainerStyle={{ padding: Spacing.four, paddingBottom: insets.bottom + Spacing.six, gap: gridGap }}
          columnWrapperStyle={{ gap: gridGap }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item, index }) => {
            const thumbUrl = serverConfig
              ? buildThumbnailUrl(serverConfig, item.cover.relative_path, item.cover.source_type, item.cover.source_id)
              : undefined;

            const resolvedName = placeNames[item.cluster_key];
            const nameLabel = resolvedName === undefined ? 'Locating…' : (resolvedName || 'Unknown location');

            return (
              <AnimatedListItem index={index}>
                <TouchableOpacity
                  style={[styles.placeTile, { width: cellSize }]}
                  onPress={() => openCluster(item)}
                  activeOpacity={0.85}
                >
                  <View style={[styles.placeCell, { width: cellSize, height: cellSize }]}>
                    <Image
                      source={{ uri: thumbUrl }}
                      cachePolicy="memory-disk"
                      priority="high"
                      style={styles.placeCellImage}
                      contentFit="cover"
                      transition={100}
                    />
                    <View style={styles.placeCellOverlay}>
                      <Text style={styles.placeCellCount}>{item.count}</Text>
                    </View>
                  </View>
                  <View style={styles.placeTileLabel}>
                    <Text style={styles.placeTileName} numberOfLines={1}>{nameLabel}</Text>
                    <Text style={styles.placeTileCoords} numberOfLines={1}>
                      {formatCoordinates(item.lat, item.lon)}
                    </Text>
                  </View>
                </TouchableOpacity>
              </AnimatedListItem>
            );
          }}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Cluster Items Grid Modal */}
      <Modal visible={!!activeCluster} animationType="slide" onRequestClose={closeCluster}>
        <View style={[styles.root, { backgroundColor: colors.bg }]}>
          <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
          <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
            <TouchableOpacity style={styles.backBtn} onPress={closeCluster} accessibilityLabel="Close">
              <AppIcon androidName="close" iosName="xmark" color={colors.text} size={22} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {activeCluster
                  ? (placeNames[activeCluster.cluster_key] || formatCoordinates(activeCluster.lat, activeCluster.lon) || 'This Place')
                  : 'This Place'}
              </Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {activeCluster ? `${formatCoordinates(activeCluster.lat, activeCluster.lon)} · ` : ''}
                {clusterLoading ? 'Loading…' : `${clusterItems.length} ${clusterItems.length === 1 ? 'memory' : 'memories'}`}
              </Text>
            </View>
            <View style={{ width: 36 }} />
          </View>

          {clusterLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : (
            <FlatList
              data={clusterItems}
              keyExtractor={(item, idx) => `${item.source_type}:${item.source_id}:${item.relative_path}:${idx}`}
              numColumns={3}
              contentContainerStyle={{ padding: Spacing.four, paddingBottom: insets.bottom + Spacing.six, gap: gridGap }}
              columnWrapperStyle={{ gap: gridGap }}
              renderItem={({ item, index }) => {
                const itemThumbUrl = serverConfig
                  ? buildThumbnailUrl(serverConfig, item.relative_path, item.source_type, item.source_id)
                  : undefined;

                return (
                  <AnimatedListItem index={index}>
                    <TouchableOpacity
                      style={[styles.placeCell, { width: cellSize, height: cellSize }]}
                      onPress={() => { hapticLight(); setViewerIndex(index); }}
                      activeOpacity={0.85}
                    >
                      <Image
                        source={{ uri: itemThumbUrl }}
                        cachePolicy="memory-disk"
                        priority="high"
                        style={styles.placeCellImage}
                        contentFit="cover"
                        transition={100}
                      />
                      {item.is_video && (
                        <View style={styles.videoBadge}>
                          <AppIcon androidName="play_arrow" iosName="play.fill" color="#fff" size={14} />
                        </View>
                      )}
                    </TouchableOpacity>
                  </AnimatedListItem>
                );
              }}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </Modal>

      {/* Full-Screen Swipable Viewer Modal */}
      <Modal visible={viewerIndex !== null} transparent animationType="fade" onRequestClose={closeViewer}>
        <View style={styles.viewerOverlay}>
          {/* Top Bar with Title, Index & Close */}
          <View style={[styles.viewerTopBar, { top: insets.top + Spacing.two }]}>
            <View style={styles.viewerHeaderInfo}>
              <Text style={styles.viewerIndexText}>
                {viewerIndex !== null ? `${viewerIndex + 1} / ${clusterItems.length}` : ''}
              </Text>
              {activeViewerItem?.source_label ? (
                <Text style={styles.viewerSubText} numberOfLines={1}>
                  {activeViewerItem.source_label}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity style={styles.viewerCloseBtn} onPress={closeViewer} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
            </TouchableOpacity>
          </View>

          {/* Horizontal Swipable Paging FlatList */}
          {viewerIndex !== null && (
            <FlatList
              ref={viewerListRef}
              data={clusterItems}
              keyExtractor={(item, idx) => `viewer_${item.source_type}_${item.source_id}_${item.relative_path}_${idx}`}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={viewerIndex}
              getItemLayout={(_data, index) => ({ length: width, offset: width * index, index })}
              onScrollToIndexFailed={(info) => {
                setTimeout(() => {
                  viewerListRef.current?.scrollToOffset({ offset: info.index * width, animated: false });
                }, 100);
              }}
              onMomentumScrollEnd={(e) => {
                const idx = Math.round(e.nativeEvent.contentOffset.x / width);
                if (idx >= 0 && idx < clusterItems.length) {
                  setViewerIndex(idx);
                }
              }}
              renderItem={({ item, index }) => {
                const isCurrent = index === viewerIndex;
                const mediaUrl = serverConfig
                  ? (item.is_video
                    ? buildVideoPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id)
                    : buildPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id))
                  : '';

                return (
                  <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
                    {item.is_video ? (
                      isCurrent ? (
                        <PlacesVideoPlayer uri={mediaUrl} />
                      ) : (
                        <View style={fallbackStyles.wrap}>
                          <AppIcon androidName="videocam" iosName="video" color="#fff" size={40} />
                        </View>
                      )
                    ) : (
                      <Image
                        source={{ uri: mediaUrl }}
                        cachePolicy="memory-disk"
                        style={styles.viewerImage}
                        contentFit="contain"
                        transition={100}
                      />
                    )}
                  </View>
                );
              }}
            />
          )}

          {/* Left / Right Quick Navigation Chevrons */}
          {viewerIndex !== null && viewerIndex > 0 && (
            <TouchableOpacity style={[styles.navChevronBtn, styles.navChevronLeft]} onPress={goToPrevious}>
              <AppIcon androidName="chevron_left" iosName="chevron.left" color="#fff" size={28} />
            </TouchableOpacity>
          )}
          {viewerIndex !== null && viewerIndex < clusterItems.length - 1 && (
            <TouchableOpacity style={[styles.navChevronBtn, styles.navChevronRight]} onPress={goToNext}>
              <AppIcon androidName="chevron_right" iosName="chevron.right" color="#fff" size={28} />
            </TouchableOpacity>
          )}

          {/* Bottom Actions Bar */}
          <View style={[styles.viewerActions, { bottom: insets.bottom + Spacing.five }]}>
            <TouchableOpacity onPress={handleShareViewerItem} disabled={sharing} style={styles.viewerActionBtn}>
              {sharing ? <ActivityIndicator size="small" color="#fff" /> : <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={20} />}
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSaveViewerItem} disabled={saving} style={styles.viewerActionBtn}>
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <AppIcon androidName="download" iosName="arrow.down.circle" color="#fff" size={20} />}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function PlacesVideoPlayer({ uri }: { uri: string }) {
  if (!expoVideoModule || !uri) {
    return (
      <View style={fallbackStyles.wrap}>
        <AppIcon androidName="videocam" iosName="video" color="#fff" size={40} />
      </View>
    );
  }
  return <NativePlacesVideoPlayer uri={uri} videoModule={expoVideoModule} />;
}

function NativePlacesVideoPlayer({ uri, videoModule }: { uri: string; videoModule: ExpoVideoModule }) {
  const source = useMemo<VideoSource>(() => ({ uri, useCaching: true, contentType: 'progressive' }), [uri]);
  const player = videoModule.useVideoPlayer(source, p => {
    p.loop = true;
    safeCall(() => p.play());
  });
  useEffect(() => () => safeCall(() => player.pause()), [player]);
  return <videoModule.VideoView style={fallbackStyles.videoFull} player={player} nativeControls contentFit="contain" surfaceType="textureView" />;
}

const fallbackStyles = StyleSheet.create({
  wrap: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  videoFull: { width: '100%', height: '100%' },
});

const createStyles = (colors: AppColors) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.four, paddingBottom: Spacing.three,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surfaceBorder,
    gap: Spacing.two,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text },
  headerSubtitle: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '600', marginTop: 2, textAlign: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.six },
  emptyIconWrap: { width: 72, height: 72, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.four },
  emptyTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text, marginBottom: Spacing.two },
  emptySubtitle: { fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '500', textAlign: 'center', lineHeight: 22, maxWidth: 280 },
  placeTile: {},
  placeCell: { borderRadius: Radius.md, overflow: 'hidden', backgroundColor: colors.surfaceSoft },
  placeCellImage: { width: '100%', height: '100%' },
  placeCellOverlay: { position: 'absolute', bottom: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.full },
  placeCellCount: { color: '#fff', fontSize: TextScale.xs, fontWeight: '800' },
  placeTileLabel: { paddingTop: 4, paddingHorizontal: 2 },
  placeTileName: { fontSize: TextScale.xs, fontWeight: '700', color: colors.text },
  placeTileCoords: { fontSize: TextScale.xs, color: colors.textSecondary, marginTop: 1 },
  videoBadge: { position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: Radius.full, width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  viewerOverlay: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  viewerTopBar: {
    position: 'absolute', left: Spacing.four, right: Spacing.four, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  viewerHeaderInfo: { flexDirection: 'column' },
  viewerIndexText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '700' },
  viewerSubText: { color: 'rgba(255,255,255,0.7)', fontSize: TextScale.xs, fontWeight: '500', marginTop: 2 },
  viewerCloseBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 20 },
  viewerImage: { width: '100%', height: '100%' },
  navChevronBtn: {
    position: 'absolute', top: '50%', marginTop: -24, width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', zIndex: 15,
  },
  navChevronLeft: { left: Spacing.three },
  navChevronRight: { right: Spacing.three },
  viewerActions: { position: 'absolute', flexDirection: 'row', gap: Spacing.four, alignSelf: 'center', zIndex: 20 },
  viewerActionBtn: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
});