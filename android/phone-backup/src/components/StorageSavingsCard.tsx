import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { AppColors, Radius, Spacing, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { formatStorageBytes } from '../../storageSavingsPreview';

export type StorageSavingsPreview = {
  serverTotalBytes: number;
  serverTotalFiles: number;
  deletableCount: number;
  deletableBytes: number;
  localBackedUpCount?: number;
  serverVerified: boolean;
  scanned?: boolean;
  aborted?: boolean;
  noFolders?: boolean;
  noServer?: boolean;
};

type Props = {
  colors: AppColors;
  preview: StorageSavingsPreview | null;
  loading: boolean;
  syncing: boolean;
};

function formatServerHeadline(bytes: number, files: number): string {
  const sizeLabel = formatStorageBytes(bytes);
  if (!sizeLabel) return 'Nothing backed up yet';
  if (files > 0) return `${sizeLabel} on your server`;
  return `${sizeLabel} backed up`;
}

function formatDeletableLine(count: number, bytes: number): string {
  if (count <= 0) {
    return 'Sync more files to see what you could free from your phone.';
  }
  const sizeLabel = formatStorageBytes(bytes);
  const fileLabel = `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
  return sizeLabel
    ? `${fileLabel} · ${sizeLabel} could be freed from your phone`
    : `${fileLabel} could be freed from your phone`;
}

export function StorageSavingsCard({ colors, preview, loading, syncing }: Props) {
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (syncing) return null;
  if (!preview && !loading) return null;
  if (preview?.noFolders) return null;
  if (preview?.aborted && !preview.serverTotalBytes && !preview.deletableCount) return null;

  const hasServerData = (preview?.serverTotalBytes ?? 0) > 0;
  const hasDeletable = (preview?.deletableCount ?? 0) > 0;
  if (preview && !loading && !hasServerData && !hasDeletable) return null;
  const verifying = loading && !!preview && !preview.serverVerified;
  const serverVerified = !!preview?.serverVerified;

  const title = loading && !preview
    ? 'Checking storage…'
    : hasServerData
      ? formatServerHeadline(preview!.serverTotalBytes, preview!.serverTotalFiles)
      : 'Storage insight';

  const body = loading && !preview
    ? 'Estimating backed-up files and phone space you could reclaim.'
    : hasDeletable
      ? formatDeletableLine(preview!.deletableCount, preview!.deletableBytes)
      : hasServerData
        ? 'Your backed-up files are safe on your server.'
        : 'Run a sync to start building your backup and storage insight.';

  const footnote = verifying
    ? 'Verifying with your server…'
    : serverVerified && hasDeletable
      ? 'Confirmed on server — originals are safe to delete from your phone.'
      : !serverVerified && hasDeletable
        ? 'Local estimate — sync verifies against your server.'
        : serverVerified && hasServerData
          ? 'Totals confirmed on your server.'
          : null;

  return (
    <View style={styles.card}>
      <View style={[styles.iconWrap, hasDeletable ? styles.iconAction : styles.iconNeutral]}>
        {loading && !preview ? (
          <ActivityIndicator size="small" color={colors.info} />
        ) : (
          <AppIcon
            androidName={hasDeletable ? 'delete_sweep' : 'cloud_done'}
            iosName={hasDeletable ? 'trash.circle' : 'checkmark.icloud.fill'}
            color={hasDeletable ? colors.info : colors.success}
            size={20}
            fallback="GB"
          />
        )}
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        {footnote ? (
          <View style={styles.footnoteRow}>
            {verifying ? (
              <ActivityIndicator size="small" color={colors.textMuted} style={styles.footnoteSpinner} />
            ) : (
              <AppIcon
                androidName={serverVerified ? 'verified' : 'info_outline'}
                iosName={serverVerified ? 'checkmark.seal.fill' : 'info.circle'}
                color={serverVerified ? colors.success : colors.textMuted}
                size={12}
              />
            )}
            <Text style={styles.footnote}>{footnote}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: Spacing.three,
      backgroundColor: colors.surface,
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: colors.surfaceBorder,
      padding: Spacing.four,
    },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: Radius.full,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    iconNeutral: {
      backgroundColor: colors.successSoft,
    },
    iconAction: {
      backgroundColor: colors.infoSoft,
    },
    copy: {
      flex: 1,
      gap: 4,
    },
    title: {
      fontSize: TextScale.base,
      fontWeight: '800',
      color: colors.text,
    },
    body: {
      fontSize: TextScale.sm,
      color: colors.textSecondary,
      fontWeight: '600',
      lineHeight: 20,
    },
    footnoteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginTop: 2,
    },
    footnoteSpinner: {
      transform: [{ scale: 0.75 }],
    },
    footnote: {
      flex: 1,
      fontSize: TextScale.xs,
      color: colors.textMuted,
      fontWeight: '500',
      lineHeight: 16,
    },
  });
