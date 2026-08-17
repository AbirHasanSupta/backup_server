import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { AppColors, Radius, Spacing, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { formatPendingBytes } from '../../pendingPreview';

export type PendingPreview = {
  newCount: number;
  changedCount: number;
  pendingBytes: number;
  snapshotFiles?: number;
  scanned?: boolean;
  aborted?: boolean;
  noFolders?: boolean;
};

type Props = {
  colors: AppColors;
  preview: PendingPreview | null;
  loading: boolean;
  syncing: boolean;
  onPress?: () => void;
};

function formatCounts(preview: PendingPreview): string {
  const parts: string[] = [];
  if (preview.newCount > 0) {
    parts.push(`${preview.newCount.toLocaleString()} new`);
  }
  if (preview.changedCount > 0) {
    parts.push(`${preview.changedCount.toLocaleString()} changed`);
  }
  return parts.join(' · ');
}

export function PendingSyncCard({ colors, preview, loading, syncing, onPress }: Props) {
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (syncing) return null;
  if (!preview && !loading) return null;
  if (preview?.noFolders) return null;
  if (preview?.aborted && !preview.newCount && !preview.changedCount) return null;

  const pending = Math.max(0, (preview?.newCount || 0) + (preview?.changedCount || 0));
  const upToDate = !!preview && !loading && pending === 0 && !preview.aborted;
  const sizeLabel = formatPendingBytes(preview?.pendingBytes);

  const title = upToDate
    ? 'Nothing waiting'
    : pending > 0
      ? formatCounts(preview as PendingPreview)
      : 'Checking folders';

  const body = upToDate
    ? 'Everything in your selected folders is already backed up.'
    : pending > 0
      ? `${sizeLabel ? `${sizeLabel} ready · ` : ''}Tap Sync Now to back these up.`
      : 'Counting new and changed files before you sync.';

  const content = (
    <>
      <View style={[styles.iconWrap, upToDate ? styles.iconOk : styles.iconPending]}>
        {loading && pending === 0 ? (
          <ActivityIndicator size="small" color={upToDate ? colors.success : colors.primary} />
        ) : (
          <AppIcon
            androidName={upToDate ? 'check_circle' : 'cloud_sync'}
            iosName={upToDate ? 'checkmark.circle.fill' : 'arrow.triangle.2.circlepath'}
            color={upToDate ? colors.success : colors.primary}
            size={20}
            fallback={upToDate ? 'OK' : '+/-'}
          />
        )}
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, upToDate && { color: colors.success }]}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
    </>
  );

  if (onPress && pending > 0) {
    return (
      <AnimatedPressable
        style={styles.card}
        onPress={onPress}
        scaleDown={0.98}
        accessibilityLabel="Sync pending files now"
      >
        {content}
      </AnimatedPressable>
    );
  }

  return <View style={styles.card}>{content}</View>;
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
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
    },
    iconPending: {
      backgroundColor: colors.primarySoft,
    },
    iconOk: {
      backgroundColor: colors.successSoft,
    },
    copy: {
      flex: 1,
      gap: 2,
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
  });
