import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, StatusBar, FlatList, Modal, Alert, useWindowDimensions } from 'react-native';
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
  const { width } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [serverConfig, setServerConfig] = useState<any>(null);
  const [places, setPlaces] = useState<PlaceCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeCluster, setActiveCluster] = useState<PlaceCluster | null>(null);
  const [clusterItems, setClusterItems] = useState<PlaceItem[]>([]);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [viewerItem, setViewerItem] = useState<PlaceItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, res] = await Promise.all([getConfig(), getPlaceClusters()]);
      setServerConfig(cfg);
      setPlaces(Array.isArray(res?.places) ? res.places : []);
    } catch (err: any) {
      setError(sanitizeErrorMessage(err, 'Could not load places.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openCluster = useCallback(async (cluster: PlaceCluster) => {
    hapticMedium();
    setActiveCluster(cluster);
    setClusterItems([]);
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
  }, []);

  const closeViewer = useCallback(() => setViewerItem(null), []);

  const handleSaveViewerItem = async () => {
    if (!viewerItem || saving) return;
    setSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Needed', 'Media library permission is required to save photos and videos.');
        return;
      }
      const displayName = viewerItem.relative_path.split(/[/\\]/).pop() ?? `place_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}place_save_${Date.now()}_${displayName}`;
      if (viewerItem.source_type === 'shared') {
        await downloadSharedFile(viewerItem.source_id, viewerItem.relative_path, tmpUri);
      } else {
        await downloadFile(viewerItem.relative_path, tmpUri);
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
    if (!viewerItem || sharing) return;
    setSharing(true);
    try {
      const displayName = viewerItem.relative_path.split(/[/\\]/).pop() ?? `place_${Date.now()}`;
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tmpUri = `${cacheDir}place_share_${Date.now()}_${displayName}`;
      if (viewerItem.source_type === 'shared') {
        await downloadSharedFile(viewerItem.source_id, viewerItem.relative_path, tmpUri);
      } else {
        await downloadFile(viewerItem.relative_path, tmpUri);
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

  const gridGap = Spacing.two;
  const cols = 3;
  const cellSize = (width - Spacing.four * 2 - gridGap * (cols - 1)) / cols;

  const viewerUrl = viewerItem && serverConfig
    ? (viewerItem.is_video
      ? buildVideoPreviewUrl(serverConfig, viewerItem.relative_path, viewerItem.source_type, viewerItem.source_id)
      : buildPreviewUrl(serverConfig, viewerItem.relative_path, viewerItem.source_type, viewerItem.source_id))
    : '';

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="Go back">
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
          renderItem={({ item, index }) => (
            <AnimatedListItem index={index}>
              <TouchableOpacity
                style={[styles.placeCell, { width: cellSize, height: cellSize }]}
                onPress={() => openCluster(item)}
                activeOpacity={0.85}
              >
                <Image
                  source={{ uri: serverConfig ? buildThumbnailUrl(serverConfig, item.cover.relative_path, item.cover.source_type, item.cover.source_id) : undefined }}
                  style={styles.placeCellImage}
                  contentFit="cover"
                  transition={150}
                />
                <View style={styles.placeCellOverlay}>
                  <Text style={styles.placeCellCount}>{item.count}</Text>
                </View>
              </TouchableOpacity>
            </AnimatedListItem>
          )}
          showsVerticalScrollIndicator={false}
        />
      )}

      <Modal visible={!!activeCluster} animationType="slide" onRequestClose={closeCluster}>
        <View style={[styles.root, { backgroundColor: colors.bg }]}>
          <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
          <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
            <TouchableOpacity style={styles.backBtn} onPress={closeCluster} accessibilityLabel="Close">
              <AppIcon androidName="close" iosName="xmark" color={colors.text} size={22} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>
                {activeCluster ? formatCoordinates(activeCluster.lat, activeCluster.lon) || 'This Place' : 'This Place'}
              </Text>
              <Text style={styles.headerSubtitle}>
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
              renderItem={({ item, index }) => (
                <AnimatedListItem index={index}>
                  <TouchableOpacity
                    style={[styles.placeCell, { width: cellSize, height: cellSize }]}
                    onPress={() => { hapticLight(); setViewerItem(item); }}
                    activeOpacity={0.85}
                  >
                    <Image
                      source={{ uri: serverConfig ? buildThumbnailUrl(serverConfig, item.relative_path, item.source_type, item.source_id) : undefined }}
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
              )}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </Modal>

      <Modal visible={!!viewerItem} transparent animationType="fade" onRequestClose={closeViewer}>
        <View style={styles.viewerOverlay}>
          <TouchableOpacity style={[styles.viewerCloseBtn, { top: insets.top + Spacing.three }]} onPress={closeViewer} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <AppIcon androidName="close" iosName="xmark" color="#fff" size={24} />
          </TouchableOpacity>
          {viewerItem && (
            viewerItem.is_video ? (
              <PlacesVideoPlayer uri={viewerUrl} />
            ) : (
              <Image source={{ uri: viewerUrl }} style={styles.viewerImage} contentFit="contain" transition={150} />
            )
          )}
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
  placeCell: { borderRadius: Radius.md, overflow: 'hidden', backgroundColor: colors.surfaceSoft },
  placeCellImage: { width: '100%', height: '100%' },
  placeCellOverlay: { position: 'absolute', bottom: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.full },
  placeCellCount: { color: '#fff', fontSize: TextScale.xs, fontWeight: '800' },
  videoBadge: { position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: Radius.full, width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  viewerOverlay: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  viewerCloseBtn: { position: 'absolute', right: Spacing.four, zIndex: 20, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerActions: { position: 'absolute', flexDirection: 'row', gap: Spacing.four, alignSelf: 'center' },
  viewerActionBtn: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
});