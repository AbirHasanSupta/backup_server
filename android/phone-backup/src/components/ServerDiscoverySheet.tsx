import React, { useState, useCallback, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { AppColors, Radius, Shadows, Spacing, TextScale } from '@/constants/theme';
import { discoverServers } from '../../serverDiscovery';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

interface Server {
  ip: string;
  port: number;
  name: string;
  version: string;
}

interface Props {
  visible: boolean;
  onSelect: (server: Server) => void;
  onClose: () => void;
}

export function ServerDiscoverySheet({ visible, onSelect, onClose }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState<string | null>(null);

  const startScan = useCallback(async () => {
    setScanning(true);
    setServers([]);
    setError(null);
    setProgress(0);

    try {
      const found = await discoverServers((pct: number, current: Server[]) => {
        setProgress(pct);
        setServers([...current]);
      });
      setServers(found);
      if (found.length === 0) {
        setError('No backup servers were found on this network.');
      }
    } catch (err: any) {
      setError(err?.message || 'Scan failed. Check your Wi-Fi connection.');
    } finally {
      setScanning(false);
      setProgress(100);
    }
  }, []);

  const handleSelect = (server: Server) => {
    onSelect(server);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Find your server</Text>
            <Text style={styles.subtitle}>Scan your local network for Phone Backup Server.</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close discovery">
            <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={18} fallback="X" />
          </TouchableOpacity>
        </View>

        {scanning && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        )}

        <TouchableOpacity
          style={[styles.scanBtn, scanning && styles.scanBtnDisabled]}
          onPress={startScan}
          disabled={scanning}
          accessibilityLabel="Scan for servers"
          accessibilityRole="button"
        >
          {scanning ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <>
              <AppIcon androidName="search" iosName="magnifyingglass" color={colors.white} size={18} fallback="S" />
              <Text style={styles.scanBtnText}>{servers.length > 0 ? 'Scan again' : 'Start scan'}</Text>
            </>
          )}
        </TouchableOpacity>

        {error && !scanning && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {servers.length > 0 && (
          <FlatList
            data={servers}
            keyExtractor={(item) => item.ip}
            style={styles.list}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.serverItem}
                onPress={() => handleSelect(item)}
                accessibilityLabel={`Connect to ${item.name} at ${item.ip}`}
              >
                <View style={styles.serverIcon}>
                  <AppIcon androidName="desktop_windows" iosName="desktopcomputer" color={colors.primary} size={24} fallback="PC" />
                </View>
                <View style={styles.serverInfo}>
                  <Text style={styles.serverName}>{item.name}</Text>
                  <Text style={styles.serverMeta}>
                    {item.ip}:{item.port} - v{item.version}
                  </Text>
                </View>
                <AppIcon androidName="arrow_forward" iosName="arrow.right" color={colors.primary} size={20} fallback=">" />
              </TouchableOpacity>
            )}
          />
        )}

        <Text style={styles.hint}>If it does not appear, enter the IP address manually in Settings.</Text>
      </View>
    </Modal>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(16, 32, 51, 0.42)',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    padding: Spacing.six,
    paddingBottom: Spacing.seven,
    minHeight: 390,
    maxHeight: '82%',
    borderTopWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  handle: {
    width: 42,
    height: 5,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceBorder,
    alignSelf: 'center',
    marginBottom: Spacing.five,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: Spacing.four,
    marginBottom: Spacing.five,
  },
  title: {
    fontSize: TextScale.lg,
    fontWeight: '800',
    color: colors.text,
  },
  subtitle: {
    fontSize: TextScale.sm,
    color: colors.textSecondary,
    marginTop: Spacing.one,
    lineHeight: 19,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    height: 5,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceBorder,
    marginBottom: Spacing.four,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.full,
    backgroundColor: colors.primary,
  },
  scanBtn: {
    minHeight: 48,
    backgroundColor: colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: Spacing.four,
    ...Shadows.soft,
  },
  scanBtnDisabled: {
    opacity: 0.72,
  },
  scanBtnText: {
    color: colors.white,
    fontSize: TextScale.base,
    fontWeight: '800',
  },
  errorBox: {
    backgroundColor: colors.errorSoft,
    borderRadius: Radius.md,
    padding: Spacing.three,
    marginBottom: Spacing.four,
  },
  errorText: {
    color: colors.error,
    fontSize: TextScale.sm,
    fontWeight: '600',
  },
  list: {
    maxHeight: 220,
  },
  serverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    padding: Spacing.four,
    marginBottom: Spacing.two,
    ...Shadows.card,
  },
  serverIcon: {
    width: 46,
    height: 46,
    borderRadius: Radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverInfo: {
    flex: 1,
    gap: 3,
  },
  serverName: {
    fontSize: TextScale.base,
    fontWeight: '800',
    color: colors.text,
  },
  serverMeta: {
    fontSize: TextScale.xs,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  hint: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: Spacing.four,
    lineHeight: 17,
  },
});
