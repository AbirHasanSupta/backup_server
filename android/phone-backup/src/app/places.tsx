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
  Linking,
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
  getTrips,
  getTripMedia,
  reclusterTrips,
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
  photo_count?: number;
  video_count?: number;
  cover: { source_type: string; source_id: string; relative_path: string; is_video: boolean };
};

type Trip = {
  id: number;
  source_id: string;
  title: string;
  start_time: number;
  end_time: number;
  center_lat: number;
  center_lon: number;
  media_count: number;
  photo_count?: number;
  video_count?: number;
  cover_media_id: number | null;
  cover?: { source_type: string; source_id: string; relative_path: string; is_video: boolean } | null;
};

type PlaceItem = {
  id?: number;
  source_type: string;
  source_id: string;
  source_label: string;
  relative_path: string;
  size: number;
  capture_time: number | null;
  is_video: boolean;
  year?: number | null;
  cap_lat?: number | null;
  cap_lon?: number | null;
};

function safeCall(fn: () => void): void {
  try { fn(); } catch (e) { console.warn('[Places] player error:', e); }
}

function formatCoordinates(lat?: number, lon?: number): string {
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return '';
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${latDir}, ${Math.abs(lon).toFixed(2)}° ${lonDir}`;
}

function formatTripDateRange(startTime: number, endTime: number): string {
  const d1 = new Date(startTime * 1000);
  const d2 = new Date(endTime * 1000);
  const m1 = d1.toLocaleDateString('en-US', { month: 'short' });
  const m2 = d2.toLocaleDateString('en-US', { month: 'short' });
  const day1 = d1.getDate();
  const day2 = d2.getDate();
  const yr1 = d1.getFullYear();
  const yr2 = d2.getFullYear();

  if (yr1 === yr2) {
    if (m1 === m2) {
      if (day1 === day2) {
        return `${m1} ${day1}, ${yr1}`;
      }
      return `${m1} ${day1} – ${day2}, ${yr1}`;
    }
    return `${m1} ${day1} – ${m2} ${day2}, ${yr1}`;
  }
  return `${m1} ${day1}, ${yr1} – ${m2} ${day2}, ${yr2}`;
}

export default function PlacesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const { width, height } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [activeTab, setActiveTab] = useState<'places' | 'trips'>('places');
  const [serverConfig, setServerConfig] = useState<any>(null);

  // Places state
  const [places, setPlaces] = useState<PlaceCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCluster, setActiveCluster] = useState<PlaceCluster | null>(null);
  const [clusterItems, setClusterItems] = useState<PlaceItem[]>([]);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [placeNames, setPlaceNames] = useState<Record<string, string | null>>({});
  const resolvedPlaceKeysRef = useRef<Set<string>>(new Set());
  const [placeMediaFilter, setPlaceMediaFilter] = useState<'all' | 'photos' | 'videos'>('all');

  // Trips state
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [tripItems, setTripItems] = useState<PlaceItem[]>([]);
  const [tripLoading, setTripLoading] = useState(false);
  const [tripMediaFilter, setTripMediaFilter] = useState<'all' | 'photos' | 'videos'>('all');

  // Full-Screen Viewer state (shared)
  const [viewerItems, setViewerItems] = useState<PlaceItem[]>([]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const viewerListRef = useRef<FlatList<PlaceItem>>(null);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const clusterPhotoCount = useMemo(() => clusterItems.filter(it => !it.is_video).length, [clusterItems]);
  const clusterVideoCount = useMemo(() => clusterItems.filter(it => it.is_video).length, [clusterItems]);
  const filteredClusterItems = useMemo(() => {
    if (placeMediaFilter === 'photos') return clusterItems.filter(it => !it.is_video);
    if (placeMediaFilter === 'videos') return clusterItems.filter(it => it.is_video);
    return clusterItems;
  }, [clusterItems, placeMediaFilter]);

  const tripPhotoCount = useMemo(() => tripItems.filter(it => !it.is_video).length, [tripItems]);
  const tripVideoCount = useMemo(() => tripItems.filter(it => it.is_video).length, [tripItems]);
  const filteredTripItems = useMemo(() => {
    if (tripMediaFilter === 'photos') return tripItems.filter(it => !it.is_video);
    if (tripMediaFilter === 'videos') return tripItems.filter(it => it.is_video);
    return tripItems;
  }, [tripItems, tripMediaFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, placesRes, tripsRes] = await Promise.all([
        getConfig(),
        getPlaceClusters().catch(() => ({ places: [] })),
        getTrips().catch(() => ({ trips: [] })),
      ]);
      setServerConfig(cfg);
      setPlaces(Array.isArray(placesRes?.places) ? placesRes.places : []);
      setTrips(Array.isArray(tripsRes?.trips) ? tripsRes.trips : []);
    } catch (err: any) {
      setError(sanitizeErrorMessage(err, 'Could not load places and trips.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const refreshTrips = useCallback(async () => {
    setTripsLoading(true);
    try {
      await reclusterTrips().catch(() => null);
      const tripsRes = await getTrips();
      setTrips(Array.isArray(tripsRes?.trips) ? tripsRes.trips : []);
    } catch (err: any) {
      Alert.alert('Refresh Failed', sanitizeErrorMessage(err, 'Could not refresh trips.'));
    } finally {
      setTripsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const place of places) {
        if (cancelled) return;
        if (resolvedPlaceKeysRef.current.has(place.cluster_key)) continue;
        const name = await getPlaceName(place.lat, place.lon);
        if (cancelled) return;
        resolvedPlaceKeysRef.current.add(place.cluster_key);
        setPlaceNames(prev => ({ ...prev, [place.cluster_key]: name }));
      }
    })();
    return () => { cancelled = true; };
  }, [places]);

  const openCluster = useCallback(async (cluster: PlaceCluster) => {
    hapticMedium();
    setActiveCluster(cluster);
    setClusterItems([]);
    setPlaceMediaFilter('all');
    setClusterLoading(true);
    try {
      const res = await getPlaceItems(cluster.cluster_key);
      setClusterItems(Array.isArray(res?.items) ? res.items : []);
    } catch (err: any) {
      Alert.alert('Failed to Load', sanitizeErrorMessage(err, 'Could not load this place.'));
    } finally {
      setClusterLoading(false);
    }
  }, []);

  const closeCluster = useCallback(() => {
    setActiveCluster(null);
    setClusterItems([]);
    setPlaceMediaFilter('all');
  }, []);

  const openTrip = useCallback(async (trip: Trip) => {
    hapticMedium();
    setActiveTrip(trip);
    setTripItems([]);
    setTripMediaFilter('all');
    setTripLoading(true);
    try {
      const res = await getTripMedia(trip.id);
      setTripItems(Array.isArray(res?.media) ? res.media : []);
    } catch (err: any) {
      Alert.alert('Failed to Load', sanitizeErrorMessage(err, 'Could not load trip media.'));
    } finally {
      setTripLoading(false);
    }
  }, []);

  const closeTrip = useCallback(() => {
    setActiveTrip(null);
    setTripItems([]);
    setTripMediaFilter('all');
  }, []);

  const openViewerForCluster = useCallback((index: number) => {
    hapticLight();
    setViewerItems(filteredClusterItems);
    setViewerIndex(index);
  }, [filteredClusterItems]);

  const openViewerForTrip = useCallback((index: number) => {
    hapticLight();
    setViewerItems(filteredTripItems);
    setViewerIndex(index);
  }, [filteredTripItems]);

  const closeViewer = useCallback(() => {
    setViewerIndex(null);
  }, []);

  const viewerIndexRef = useRef(viewerIndex);
  const activeClusterRef = useRef(activeCluster);
  const activeTripRef = useRef(activeTrip);
  const closeViewerRef = useRef(closeViewer);
  const closeClusterRef = useRef(closeCluster);
  const closeTripRef = useRef(closeTrip);

  useEffect(() => {
    viewerIndexRef.current = viewerIndex;
    activeClusterRef.current = activeCluster;
    activeTripRef.current = activeTrip;
    closeViewerRef.current = closeViewer;
    closeClusterRef.current = closeCluster;
    closeTripRef.current = closeTrip;
  }, [viewerIndex, activeCluster, activeTrip, closeViewer, closeCluster, closeTrip]);

  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (viewerIndexRef.current !== null) {
          closeViewerRef.current();
          return true;
        }
        if (activeTripRef.current !== null) {
          closeTripRef.current();
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

  const activeViewerItem = viewerIndex != null && viewerItems[viewerIndex] ? viewerItems[viewerIndex] : null;

  const handleSaveViewerItem = async () => {
    if (!activeViewerItem || saving) return;
    setSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Needed', 'Media library permission is required to save photos and videos.');
        return;
      }
      const displayName = activeViewerItem.relative_path.split(/[/\\]/).pop() ?? `media_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}media_save_${Date.now()}_${displayName}`;
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
      const displayName = activeViewerItem.relative_path.split(/[/\\]/).pop() ?? `media_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}media_share_${Date.now()}_${displayName}`;
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
    if (viewerIndex != null && viewerIndex < viewerItems.length - 1) {
      const nextIdx = viewerIndex + 1;
      setViewerIndex(nextIdx);
      viewerListRef.current?.scrollToIndex({ index: nextIdx, animated: true });
    }
  };

  const openInExternalMaps = (lat: number, lon: number) => {
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
    Linking.openURL(url).catch(() => {
      Alert.alert('Could Not Open Map', `Coordinates: ${formatCoordinates(lat, lon)}`);
    });
  };

  const gridGap = Spacing.two;
  const cols = 3;
  const cellSize = (width - Spacing.four * 2 - gridGap * (cols - 1)) / cols;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.replace('/memories')} accessibilityLabel="Go back">
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{activeTab === 'places' ? 'Places' : 'Trips'}</Text>
          <Text style={styles.headerSubtitle}>
            {loading
              ? 'Loading…'
              : activeTab === 'places'
              ? (places.length > 0 ? `${places.length} places discovered` : 'No geotagged photos or videos yet')
              : (trips.length > 0 ? `${trips.length} auto-generated trip${trips.length !== 1 ? 's' : ''}` : 'No trips generated yet')}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {/* Tab Switcher */}
      <View style={[styles.tabBarWrap, { backgroundColor: colors.bg }]}>
        <View style={[styles.tabBar, { backgroundColor: colors.surfaceSoft }]}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'places' && [styles.tabBtnActive, { backgroundColor: colors.primary }]]}
            onPress={() => { hapticLight(); setActiveTab('places'); }}
            activeOpacity={0.8}
          >
            <AppIcon
              androidName="place"
              iosName="mappin.and.ellipse"
              color={activeTab === 'places' ? '#fff' : colors.textSecondary}
              size={16}
            />
            <Text style={[styles.tabBtnText, { color: activeTab === 'places' ? '#fff' : colors.textSecondary }]}>
              Places ({places.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'trips' && [styles.tabBtnActive, { backgroundColor: colors.primary }]]}
            onPress={() => { hapticLight(); setActiveTab('trips'); }}
            activeOpacity={0.8}
          >
            <AppIcon
              androidName="flight_takeoff"
              iosName="airplane"
              color={activeTab === 'trips' ? '#fff' : colors.textSecondary}
              size={16}
            />
            <Text style={[styles.tabBtnText, { color: activeTab === 'trips' ? '#fff' : colors.textSecondary }]}>
              Trips ({trips.length})
            </Text>
          </TouchableOpacity>
        </View>
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
      ) : activeTab === 'places' ? (
        // ─── PLACES TAB ───────────────────────────────────────────────────────
        places.length === 0 ? (
          <View style={styles.centered}>
            <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
              <AppIcon androidName="place" iosName="mappin.and.ellipse" color={colors.primary} size={36} />
            </View>
            <Text style={styles.emptyTitle}>No places yet</Text>
            <Text style={styles.emptySubtitle}>
              Photos and videos with GPS location data will appear here once they&apos;re backed up and indexed.
            </Text>
          </View>
        ) : (
          <FlatList
            key="places-grid-3"
            data={places}
            keyExtractor={(item) => item.cluster_key}
            numColumns={3}
            contentContainerStyle={{ padding: Spacing.four, paddingBottom: insets.bottom + Spacing.six, gap: gridGap }}
            columnWrapperStyle={{ gap: gridGap }}
            renderItem={({ item, index }) => {
              const thumbUrl = serverConfig && item.cover?.relative_path
                ? (item.cover.is_video
                  ? buildThumbnailUrl(serverConfig, item.cover.relative_path, item.cover.source_type, item.cover.source_id)
                  : buildPreviewUrl(serverConfig, item.cover.relative_path, item.cover.source_type, item.cover.source_id))
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
                        style={styles.placeCellImage}
                        contentFit="cover"
                        transition={150}
                      />
                      {item.cover?.is_video && (
                        <View style={styles.videoBadge}>
                          <AppIcon androidName="play_arrow" iosName="play.fill" color="#fff" size={14} />
                        </View>
                      )}
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
        )
      ) : (
        // ─── TRIPS TAB ────────────────────────────────────────────────────────
        trips.length === 0 ? (
          <FlatList
            key="trips-list-1"
            data={trips}
            keyExtractor={(item) => `trip_${item.id}`}
            renderItem={null}
            refreshControl={
              <RefreshControl refreshing={tripsLoading} onRefresh={refreshTrips} tintColor={colors.primary} colors={[colors.primary]} />
            }
            contentContainerStyle={styles.centered}
            ListEmptyComponent={
              <>
                <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
                  <AppIcon androidName="flight_takeoff" iosName="airplane" color={colors.primary} size={36} />
                </View>
                <Text style={styles.emptyTitle}>No trip albums yet</Text>
                <Text style={styles.emptySubtitle}>
                  Trips are automatically curated when 5+ photos and videos are taken in the same region over a day, weekend, or vacation.
                </Text>
              </>
            }
          />
        ) : (
          <FlatList
            key="trips-list-1"
            data={trips}
            keyExtractor={(item) => `trip_${item.id}`}
            refreshControl={
              <RefreshControl refreshing={tripsLoading} onRefresh={refreshTrips} tintColor={colors.primary} colors={[colors.primary]} />
            }
            contentContainerStyle={{ padding: Spacing.four, paddingBottom: insets.bottom + Spacing.six, gap: Spacing.three }}
            renderItem={({ item, index }) => {
              const coverUrl = serverConfig && item.cover
                ? (item.cover.is_video
                  ? buildThumbnailUrl(serverConfig, item.cover.relative_path, item.cover.source_type, item.cover.source_id)
                  : buildPreviewUrl(serverConfig, item.cover.relative_path, item.cover.source_type, item.cover.source_id))
                : undefined;

              return (
                <AnimatedListItem index={index}>
                  <TouchableOpacity
                    style={[styles.tripCard, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}
                    onPress={() => openTrip(item)}
                    activeOpacity={0.85}
                  >
                    <View style={styles.tripCardCover}>
                      {coverUrl ? (
                        <Image source={{ uri: coverUrl }} style={styles.tripCoverImage} contentFit="cover" transition={150} />
                      ) : (
                        <View style={[styles.tripCoverFallback, { backgroundColor: colors.surfaceSoft }]}>
                          <AppIcon androidName="photo" iosName="photo" color={colors.textMuted} size={32} />
                        </View>
                      )}
                      {item.cover?.is_video && (
                        <View style={styles.videoBadge}>
                          <AppIcon androidName="play_arrow" iosName="play.fill" color="#fff" size={12} />
                        </View>
                      )}
                      <View style={styles.tripCountBadge}>
                        <AppIcon androidName="perm_media" iosName="photo.on.rectangle" color="#fff" size={12} />
                        <Text style={styles.tripCountText}>{item.media_count}</Text>
                      </View>
                    </View>
                    <View style={styles.tripCardBody}>
                      <Text style={[styles.tripCardTitle, { color: colors.text }]} numberOfLines={1}>{item.title}</Text>
                      <View style={styles.tripCardMetaRow}>
                        <AppIcon androidName="calendar_today" iosName="calendar" color={colors.primary} size={13} />
                        <Text style={[styles.tripCardDate, { color: colors.textSecondary }]}>
                          {formatTripDateRange(item.start_time, item.end_time)}
                        </Text>
                      </View>
                      <View style={styles.tripCardMetaRow}>
                        <AppIcon androidName="place" iosName="mappin" color={colors.textMuted} size={13} />
                        <Text style={[styles.tripCardCoords, { color: colors.textMuted }]}>
                          {formatCoordinates(item.center_lat, item.center_lon)}
                        </Text>
                      </View>
                      {item.photo_count != null && item.video_count != null && item.photo_count > 0 && item.video_count > 0 ? (
                        <View style={styles.tripCardMetaRow}>
                          <AppIcon androidName="perm_media" iosName="photo.stack" color={colors.primary} size={13} />
                          <Text style={[styles.tripCardCoords, { color: colors.textSecondary }]}>
                            {item.photo_count} photo{item.photo_count !== 1 ? 's' : ''}, {item.video_count} video{item.video_count !== 1 ? 's' : ''}
                          </Text>
                        </View>
                      ) : item.video_count != null && item.video_count > 0 ? (
                        <View style={styles.tripCardMetaRow}>
                          <AppIcon androidName="videocam" iosName="video" color={colors.primary} size={13} />
                          <Text style={[styles.tripCardCoords, { color: colors.textSecondary }]}>
                            {item.video_count} video{item.video_count !== 1 ? 's' : ''}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.tripChevron}>
                      <AppIcon androidName="chevron_right" iosName="chevron.right" color={colors.textMuted} size={20} />
                    </View>
                  </TouchableOpacity>
                </AnimatedListItem>
              );
            }}
            showsVerticalScrollIndicator={false}
          />
        )
      )}

      {/* Place Cluster Detail Modal */}
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
                {clusterLoading
                  ? 'Loading…'
                  : clusterItems.length === 0
                  ? '0 items'
                  : clusterVideoCount > 0 && clusterPhotoCount > 0
                  ? `${clusterPhotoCount} photo${clusterPhotoCount !== 1 ? 's' : ''}, ${clusterVideoCount} video${clusterVideoCount !== 1 ? 's' : ''}`
                  : clusterVideoCount > 0
                  ? `${clusterVideoCount} video${clusterVideoCount !== 1 ? 's' : ''}`
                  : `${clusterPhotoCount} photo${clusterPhotoCount !== 1 ? 's' : ''}`}
              </Text>
            </View>
            <View style={{ width: 36 }} />
          </View>

          {/* Place Media Filter Tabs */}
          {clusterItems.length > 0 && !clusterLoading && (
            <View style={[styles.filterBarWrap, { backgroundColor: colors.bg }]}>
              <View style={[styles.filterBar, { backgroundColor: colors.surfaceSoft }]}>
                <TouchableOpacity
                  style={[styles.filterBtn, placeMediaFilter === 'all' && [styles.filterBtnActive, { backgroundColor: colors.primary }]]}
                  onPress={() => { hapticLight(); setPlaceMediaFilter('all'); }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.filterBtnText, { color: placeMediaFilter === 'all' ? '#fff' : colors.textSecondary }]}>
                    All ({clusterItems.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.filterBtn, placeMediaFilter === 'photos' && [styles.filterBtnActive, { backgroundColor: colors.primary }]]}
                  onPress={() => { hapticLight(); setPlaceMediaFilter('photos'); }}
                  activeOpacity={0.8}
                >
                  <AppIcon androidName="photo" iosName="photo" color={placeMediaFilter === 'photos' ? '#fff' : colors.textSecondary} size={13} />
                  <Text style={[styles.filterBtnText, { color: placeMediaFilter === 'photos' ? '#fff' : colors.textSecondary }]}>
                    Photos ({clusterPhotoCount})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.filterBtn, placeMediaFilter === 'videos' && [styles.filterBtnActive, { backgroundColor: colors.primary }]]}
                  onPress={() => { hapticLight(); setPlaceMediaFilter('videos'); }}
                  activeOpacity={0.8}
                >
                  <AppIcon androidName="videocam" iosName="video" color={placeMediaFilter === 'videos' ? '#fff' : colors.textSecondary} size={13} />
                  <Text style={[styles.filterBtnText, { color: placeMediaFilter === 'videos' ? '#fff' : colors.textSecondary }]}>
                    Videos ({clusterVideoCount})
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {clusterLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : (
            <FlatList
              data={filteredClusterItems}
              keyExtractor={(item, idx) => `cluster_${item.source_type}:${item.source_id}:${item.relative_path}:${idx}`}
              numColumns={3}
              contentContainerStyle={{ padding: Spacing.four, paddingBottom: insets.bottom + Spacing.six, gap: gridGap }}
              columnWrapperStyle={{ gap: gridGap }}
              ListEmptyComponent={
                <View style={styles.centeredEmptyModal}>
                  <AppIcon androidName="perm_media" iosName="photo.on.rectangle" color={colors.textMuted} size={32} />
                  <Text style={[styles.emptySubtitle, { marginTop: Spacing.two }]}>
                    {placeMediaFilter === 'videos' ? 'No videos found in this place.' : 'No photos found in this place.'}
                  </Text>
                </View>
              }
              renderItem={({ item, index }) => {
                const itemThumbUrl = serverConfig
                  ? (item.is_video
                    ? buildThumbnailUrl(serverConfig, item.relative_path, item.source_type, item.source_id)
                    : buildPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id))
                  : undefined;

                return (
                  <AnimatedListItem index={index}>
                    <TouchableOpacity
                      style={[styles.placeCell, { width: cellSize, height: cellSize }]}
                      onPress={() => openViewerForCluster(index)}
                      activeOpacity={0.85}
                    >
                      <Image
                        source={{ uri: itemThumbUrl }}
                        style={styles.placeCellImage}
                        contentFit="cover"
                        transition={150}
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

      {/* Trip Detail Modal with Map Card & Media Grid */}
      <Modal visible={!!activeTrip} animationType="slide" onRequestClose={closeTrip}>
        <View style={[styles.root, { backgroundColor: colors.bg }]}>
          <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
          <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
            <TouchableOpacity style={styles.backBtn} onPress={closeTrip} accessibilityLabel="Close">
              <AppIcon androidName="close" iosName="xmark" color={colors.text} size={22} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {activeTrip?.title || 'Trip Details'}
              </Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {activeTrip ? `${formatTripDateRange(activeTrip.start_time, activeTrip.end_time)} · ` : ''}
                {tripLoading
                  ? 'Loading…'
                  : tripItems.length === 0
                  ? '0 items'
                  : tripVideoCount > 0 && tripPhotoCount > 0
                  ? `${tripPhotoCount} photo${tripPhotoCount !== 1 ? 's' : ''}, ${tripVideoCount} video${tripVideoCount !== 1 ? 's' : ''}`
                  : tripVideoCount > 0
                  ? `${tripVideoCount} video${tripVideoCount !== 1 ? 's' : ''}`
                  : `${tripPhotoCount} photo${tripPhotoCount !== 1 ? 's' : ''}`}
              </Text>
            </View>
            <View style={{ width: 36 }} />
          </View>

          {/* Trip Media Filter Tabs */}
          {tripItems.length > 0 && !tripLoading && (
            <View style={[styles.filterBarWrap, { backgroundColor: colors.bg }]}>
              <View style={[styles.filterBar, { backgroundColor: colors.surfaceSoft }]}>
                <TouchableOpacity
                  style={[styles.filterBtn, tripMediaFilter === 'all' && [styles.filterBtnActive, { backgroundColor: colors.primary }]]}
                  onPress={() => { hapticLight(); setTripMediaFilter('all'); }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.filterBtnText, { color: tripMediaFilter === 'all' ? '#fff' : colors.textSecondary }]}>
                    All ({tripItems.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.filterBtn, tripMediaFilter === 'photos' && [styles.filterBtnActive, { backgroundColor: colors.primary }]]}
                  onPress={() => { hapticLight(); setTripMediaFilter('photos'); }}
                  activeOpacity={0.8}
                >
                  <AppIcon androidName="photo" iosName="photo" color={tripMediaFilter === 'photos' ? '#fff' : colors.textSecondary} size={13} />
                  <Text style={[styles.filterBtnText, { color: tripMediaFilter === 'photos' ? '#fff' : colors.textSecondary }]}>
                    Photos ({tripPhotoCount})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.filterBtn, tripMediaFilter === 'videos' && [styles.filterBtnActive, { backgroundColor: colors.primary }]]}
                  onPress={() => { hapticLight(); setTripMediaFilter('videos'); }}
                  activeOpacity={0.8}
                >
                  <AppIcon androidName="videocam" iosName="video" color={tripMediaFilter === 'videos' ? '#fff' : colors.textSecondary} size={13} />
                  <Text style={[styles.filterBtnText, { color: tripMediaFilter === 'videos' ? '#fff' : colors.textSecondary }]}>
                    Videos ({tripVideoCount})
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {tripLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : (
            <FlatList
              data={filteredTripItems}
              keyExtractor={(item, idx) => `trip_media_${item.id || idx}_${item.relative_path}`}
              numColumns={3}
              contentContainerStyle={{ padding: Spacing.four, paddingBottom: insets.bottom + Spacing.six, gap: gridGap }}
              columnWrapperStyle={{ gap: gridGap }}
              ListEmptyComponent={
                <View style={styles.centeredEmptyModal}>
                  <AppIcon androidName="perm_media" iosName="photo.on.rectangle" color={colors.textMuted} size={32} />
                  <Text style={[styles.emptySubtitle, { marginTop: Spacing.two }]}>
                    {tripMediaFilter === 'videos' ? 'No videos found in this trip.' : 'No photos found in this trip.'}
                  </Text>
                </View>
              }
              ListHeaderComponent={
                activeTrip ? (
                  <View style={[styles.tripMapCard, { backgroundColor: colors.surface, borderColor: colors.surfaceBorder }]}>
                    <View style={styles.tripMapHeader}>
                      <View style={styles.tripMapHeaderInfo}>
                        <Text style={[styles.tripMapTitle, { color: colors.text }]}>{activeTrip.title}</Text>
                        <Text style={[styles.tripMapCoords, { color: colors.textSecondary }]}>
                          {formatCoordinates(activeTrip.center_lat, activeTrip.center_lon)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={[styles.openMapBtn, { backgroundColor: colors.primarySoft }]}
                        onPress={() => openInExternalMaps(activeTrip.center_lat, activeTrip.center_lon)}
                        activeOpacity={0.8}
                      >
                        <AppIcon androidName="map" iosName="map" color={colors.primary} size={15} />
                        <Text style={[styles.openMapBtnText, { color: colors.primary }]}>Open Map</Text>
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity
                      style={styles.tripMapVisualWrap}
                      onPress={() => openInExternalMaps(activeTrip.center_lat, activeTrip.center_lon)}
                      activeOpacity={0.9}
                    >
                      <Image
                        source={{
                          uri: `https://staticmap.openstreetmap.de/staticmap.php?center=${activeTrip.center_lat},${activeTrip.center_lon}&zoom=11&size=600x260&markers=${activeTrip.center_lat},${activeTrip.center_lon},ol-marker`,
                        }}
                        style={styles.tripMapImage}
                        contentFit="cover"
                        transition={200}
                      />
                      <View style={styles.mapPinOverlay}>
                        <AppIcon androidName="place" iosName="mappin.circle.fill" color="#EF4444" size={28} />
                      </View>
                    </TouchableOpacity>
                  </View>
                ) : null
              }
              renderItem={({ item, index }) => {
                const itemThumbUrl = serverConfig
                  ? (item.is_video
                    ? buildThumbnailUrl(serverConfig, item.relative_path, item.source_type, item.source_id)
                    : buildPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id))
                  : undefined;

                return (
                  <AnimatedListItem index={index}>
                    <TouchableOpacity
                      style={[styles.placeCell, { width: cellSize, height: cellSize }]}
                      onPress={() => openViewerForTrip(index)}
                      activeOpacity={0.85}
                    >
                      <Image
                        source={{ uri: itemThumbUrl }}
                        style={styles.placeCellImage}
                        contentFit="cover"
                        transition={150}
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
          {/* Top Bar with Title, Index, Media Type & Close */}
          <View style={[styles.viewerTopBar, { top: insets.top + Spacing.two }]}>
            <View style={styles.viewerHeaderInfo}>
              <View style={styles.viewerBadgeRow}>
                <Text style={styles.viewerIndexText}>
                  {viewerIndex !== null ? `${viewerIndex + 1} / ${viewerItems.length}` : ''}
                </Text>
                {activeViewerItem && (
                  <View style={[styles.viewerTypeTag, { backgroundColor: activeViewerItem.is_video ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.4)' }]}>
                    <Text style={styles.viewerTypeTagText}>
                      {activeViewerItem.is_video ? 'VIDEO' : 'PHOTO'}
                    </Text>
                  </View>
                )}
              </View>
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
              data={viewerItems}
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
                if (idx >= 0 && idx < viewerItems.length) {
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
                        style={styles.viewerImage}
                        contentFit="contain"
                        transition={150}
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
          {viewerIndex !== null && viewerIndex < viewerItems.length - 1 && (
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
    paddingHorizontal: Spacing.four, paddingBottom: Spacing.two,
    backgroundColor: colors.bg,
    gap: Spacing.two,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text },
  headerSubtitle: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '600', marginTop: 2, textAlign: 'center' },
  tabBarWrap: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceBorder,
  },
  tabBar: {
    flexDirection: 'row',
    borderRadius: Radius.full,
    padding: 3,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    borderRadius: Radius.full,
    gap: 6,
  },
  tabBtnActive: {
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  tabBtnText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
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
  
  // Trips Card Styles
  tripCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    padding: Spacing.two + 2,
    gap: Spacing.three,
  },
  tripCardCover: {
    width: 80,
    height: 80,
    borderRadius: Radius.md,
    overflow: 'hidden',
    position: 'relative',
  },
  tripCoverImage: {
    width: '100%',
    height: '100%',
  },
  tripCoverFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tripCountBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: Radius.full,
    paddingHorizontal: 6,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tripCountText: {
    color: '#fff',
    fontSize: TextScale.xs - 2,
    fontWeight: '800',
  },
  tripCardBody: {
    flex: 1,
    gap: 3,
  },
  tripCardTitle: {
    fontSize: TextScale.base,
    fontWeight: '800',
  },
  tripCardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  tripCardDate: {
    fontSize: TextScale.xs,
    fontWeight: '600',
  },
  tripCardCoords: {
    fontSize: TextScale.xs - 1,
  },
  tripChevron: {
    paddingRight: Spacing.one,
  },

  // Trip Map Card in Detail Modal
  tripMapCard: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: Spacing.three,
  },
  tripMapHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.three,
  },
  tripMapHeaderInfo: {
    flex: 1,
    gap: 2,
  },
  tripMapTitle: {
    fontSize: TextScale.sm,
    fontWeight: '800',
  },
  tripMapCoords: {
    fontSize: TextScale.xs,
    fontWeight: '500',
  },
  openMapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
    borderRadius: Radius.full,
  },
  openMapBtnText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
  tripMapVisualWrap: {
    width: '100%',
    height: 140,
    backgroundColor: '#E2E8F0',
    position: 'relative',
  },
  tripMapImage: {
    width: '100%',
    height: '100%',
  },
  mapPinOverlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -14,
    marginLeft: -14,
  },

  // Filter bar in Modals
  filterBarWrap: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceBorder,
  },
  filterBar: {
    flexDirection: 'row',
    borderRadius: Radius.full,
    padding: 3,
  },
  filterBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: Radius.full,
    gap: 5,
  },
  filterBtnActive: {
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  filterBtnText: {
    fontSize: TextScale.xs - 1,
    fontWeight: '700',
  },
  centeredEmptyModal: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.eight,
    paddingHorizontal: Spacing.six,
  },

  // Viewer Styles
  viewerOverlay: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  viewerTopBar: {
    position: 'absolute', left: Spacing.four, right: Spacing.four, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  viewerHeaderInfo: { flexDirection: 'column' },
  viewerBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  viewerIndexText: { color: '#fff', fontSize: TextScale.sm, fontWeight: '700' },
  viewerTypeTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  viewerTypeTagText: {
    color: '#fff',
    fontSize: TextScale.xs - 3,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
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