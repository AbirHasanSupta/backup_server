import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  FlatList,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { discoverPeers } from '../../p2pDiscovery';
import { requestPairing, confirmPairing } from '../../p2pClient';

export type DiscoveredPeerItem = {
  peerId: string;
  deviceName: string;
  username: string;
  ip: string;
  port: number;
  isPaired: boolean;
};

export function P2PDiscoverySheet({
  visible,
  colors,
  onClose,
}: {
  visible: boolean;
  colors: AppColors;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [peers, setPeers] = useState<DiscoveredPeerItem[]>([]);
  const [pairingPeerId, setPairingPeerId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startScan = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setScanning(true);
    setProgress(0);
    setPeers([]);

    try {
      const results = await discoverPeers(
        (pct, found) => {
          setProgress(pct);
          setPeers(found as DiscoveredPeerItem[]);
        },
        { signal: controller.signal }
      );
      setPeers(results as DiscoveredPeerItem[]);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        Alert.alert('Scan Failed', err?.message || 'Could not scan local network.');
      }
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      startScan();
    } else {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    }
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [visible, startScan]);

  const handlePair = async (peer: DiscoveredPeerItem) => {
    setPairingPeerId(peer.peerId);
    try {
      const req = await requestPairing(peer.ip, peer.port);
      const pin = req.pin;

      Alert.alert(
        'Confirm Pairing',
        `Pair with "${peer.deviceName || peer.username}"?\n\nVerification PIN: ${pin}`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => setPairingPeerId(null),
          },
          {
            text: 'Pair Now',
            onPress: async () => {
              try {
                const conf = await confirmPairing(peer.ip, peer.port, peer.peerId, pin);
                if (conf?.status === 'accepted') {
                  Alert.alert('Paired!', `Successfully paired with ${peer.deviceName || peer.username}.`);
                  // Refresh paired status
                  setPeers((prev) =>
                    prev.map((p) => (p.peerId === peer.peerId ? { ...p, isPaired: true } : p))
                  );
                } else {
                  Alert.alert('Pairing Pending', 'Waiting for confirmation on the other device.');
                }
              } catch (err: any) {
                Alert.alert('Pairing Error', err?.message || 'Could not complete pairing.');
              } finally {
                setPairingPeerId(null);
              }
            },
          },
        ]
      );
    } catch (err: any) {
      Alert.alert('Pairing Request Failed', err?.message || 'Could not reach peer device.');
      setPairingPeerId(null);
    }
  };

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: Radius.xl,
      borderTopRightRadius: Radius.xl,
      paddingHorizontal: Spacing.four,
      paddingTop: Spacing.three,
      paddingBottom: insets.bottom + Spacing.four,
      maxHeight: '80%',
      ...Shadows.card,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: Spacing.three,
    },
    title: {
      fontSize: TextScale.lg,
      fontWeight: '700',
      color: colors.text,
    },
    sub: {
      fontSize: TextScale.xs,
      color: colors.textSecondary,
      marginTop: 2,
    },
    progressWrap: {
      height: 4,
      backgroundColor: colors.surfaceBorder,
      borderRadius: 2,
      overflow: 'hidden',
      marginBottom: Spacing.three,
    },
    progressBar: {
      height: 4,
      backgroundColor: colors.primary,
    },
    peerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: Spacing.three,
      paddingHorizontal: Spacing.three,
      borderRadius: Radius.lg,
      backgroundColor: colors.surfaceSoft,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      marginBottom: Spacing.two,
    },
    peerInfo: {
      flex: 1,
      marginRight: Spacing.two,
    },
    peerName: {
      fontSize: TextScale.sm,
      fontWeight: '600',
      color: colors.text,
    },
    peerSub: {
      fontSize: TextScale.xs,
      color: colors.textMuted,
      marginTop: 2,
    },
    pairBtn: {
      paddingHorizontal: Spacing.three,
      paddingVertical: Spacing.one,
      borderRadius: Radius.md,
      backgroundColor: colors.primary,
    },
    pairBtnText: {
      fontSize: TextScale.xs,
      fontWeight: '700',
      color: colors.white,
    },
    pairedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: Spacing.two,
      paddingVertical: 2,
      borderRadius: Radius.md,
      backgroundColor: colors.primarySoft,
    },
    pairedText: {
      fontSize: TextScale.xs,
      fontWeight: '600',
      color: colors.primary,
    },
    emptyWrap: {
      paddingVertical: Spacing.six,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: TextScale.sm,
      color: colors.textMuted,
      textAlign: 'center',
      marginTop: Spacing.two,
    },
    footerActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: Spacing.three,
    },
    rescanBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.one,
      paddingHorizontal: Spacing.three,
      paddingVertical: Spacing.two,
      borderRadius: Radius.md,
      backgroundColor: colors.surfaceBorder,
    },
    rescanBtnText: {
      fontSize: TextScale.xs,
      fontWeight: '600',
      color: colors.text,
    },
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Nearby Wi-Fi Phones</Text>
              <Text style={styles.sub}>
                {scanning ? `Scanning local network (${progress}%)…` : `${peers.length} phone(s) discovered`}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={20} />
            </TouchableOpacity>
          </View>

          {scanning && (
            <View style={styles.progressWrap}>
              <View style={[styles.progressBar, { width: `${progress}%` }]} />
            </View>
          )}

          <FlatList
            data={peers}
            keyExtractor={(item) => item.peerId}
            ListEmptyComponent={
              !scanning ? (
                <View style={styles.emptyWrap}>
                  <AppIcon androidName="wifi_off" iosName="wifi.slash" color={colors.textMuted} size={36} />
                  <Text style={styles.emptyText}>
                    No other phones detected on this Wi-Fi network.{'\n'}Make sure both devices have Phone Backup open.
                  </Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => {
              const isPairing = pairingPeerId === item.peerId;
              return (
                <View style={styles.peerItem}>
                  <View style={styles.peerInfo}>
                    <Text style={styles.peerName}>
                      {item.username ? `${item.username} (${item.deviceName})` : item.deviceName}
                    </Text>
                    <Text style={styles.peerSub}>
                      {item.ip}:{item.port}
                    </Text>
                  </View>

                  {item.isPaired ? (
                    <View style={styles.pairedBadge}>
                      <AppIcon androidName="check" iosName="checkmark" color={colors.primary} size={14} />
                      <Text style={styles.pairedText}>Paired</Text>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={styles.pairBtn}
                      disabled={isPairing}
                      onPress={() => handlePair(item)}
                    >
                      {isPairing ? (
                        <ActivityIndicator size="small" color={colors.white} />
                      ) : (
                        <Text style={styles.pairBtnText}>Pair</Text>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              );
            }}
          />

          <View style={styles.footerActions}>
            <TouchableOpacity
              style={styles.rescanBtn}
              disabled={scanning}
              onPress={startScan}
            >
              <AppIcon androidName="refresh" iosName="arrow.clockwise" color={colors.text} size={16} />
              <Text style={styles.rescanBtnText}>{scanning ? 'Scanning…' : 'Scan Again'}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
