import React, { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, LayoutAnimation, UIManager, Platform } from 'react-native';
import { AppColors, Radius, Shadows, Spacing, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export type SyncOutcome = 'completed' | 'stopped' | 'force_stopped' | 'failed';

export interface SyncSession {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  outcome: SyncOutcome;
  trigger: 'manual' | 'auto';
  scanned: number;
  checked: number;
  uploaded: number;
  skipped: number;
  errors: number;
  totalFiles: number;
  totalSize: number;
  uploadedFiles: string[];
  errorDetails: string[];
  folders: string[];
}

interface Props {
  session: SyncSession;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem  = secs % 60;
  if (mins < 60) return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  const hrs  = Math.floor(mins / 60);
  const mrem = mins % 60;
  return mrem > 0 ? `${hrs}h ${mrem}m` : `${hrs}h`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    '  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const OUTCOME_CONFIG: Record<SyncOutcome, { label: string; emoji: string; androidIcon: string; iosIcon: string }> = {
  completed:    { label: 'Completed',    emoji: '✅', androidIcon: 'check_circle', iosIcon: 'checkmark.circle.fill' },
  stopped:      { label: 'Stopped',      emoji: '⏹',  androidIcon: 'stop_circle',  iosIcon: 'stop.circle.fill'      },
  force_stopped:{ label: 'Force stopped',emoji: '⚡', androidIcon: 'flash_off',    iosIcon: 'bolt.slash.fill'       },
  failed:       { label: 'Failed',       emoji: '❌', androidIcon: 'error',         iosIcon: 'xmark.circle.fill'     },
};

export function HistorySessionCard({ session }: Props) {
  const { colors } = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  const styles = useMemo(() => createStyles(colors), [colors]);

  const outcomeKey = (session.outcome ?? 'completed') as SyncOutcome;
  const cfg = OUTCOME_CONFIG[outcomeKey] ?? OUTCOME_CONFIG.completed;

  const outcomeColor: Record<SyncOutcome, string> = {
    completed:    colors.success,
    stopped:      colors.warning,
    force_stopped:colors.error,
    failed:       colors.error,
  };
  const outcomeBg: Record<SyncOutcome, string> = {
    completed:    colors.successSoft  ?? '#e4f8ef',
    stopped:      colors.warningSoft  ?? '#fff4de',
    force_stopped:colors.errorSoft,
    failed:       colors.errorSoft,
  };

  const color = outcomeColor[outcomeKey];
  const bg    = outcomeBg[outcomeKey];

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((v) => !v);
  };

  const hasDetail = session.uploadedFiles?.length > 0 || session.errorDetails?.length > 0;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={`Sync session ${cfg.label} at ${formatTime(session.startedAt)}`}
    >
      <View style={[styles.card, { borderLeftColor: color }]}>

        {/* ── Header row ── */}
        <View style={styles.headerRow}>
          <View style={[styles.badge, { backgroundColor: bg }]}>
            <AppIcon
              androidName={cfg.androidIcon}
              iosName={cfg.iosIcon}
              color={color}
              size={13}
              fallback={cfg.emoji}
            />
            <Text style={[styles.badgeText, { color }]}>{cfg.label}</Text>
          </View>

          <View style={styles.headerRight}>
            {session.trigger === 'auto' && (
              <View style={styles.autoChip}>
                <Text style={[styles.autoChipText, { color: colors.textMuted }]}>Auto</Text>
              </View>
            )}
            <Text style={styles.timeText}>{formatTime(session.startedAt)}</Text>
            <AppIcon
              androidName={expanded ? 'expand_less' : 'expand_more'}
              iosName={expanded ? 'chevron.up' : 'chevron.down'}
              color={colors.textMuted}
              size={16}
              fallback={expanded ? '▲' : '▼'}
            />
          </View>
        </View>

        {/* ── Stat chips row ── */}
        <View style={styles.statsRow}>
          <StatChip icon="cloud_upload" iosIcon="arrow.up.to.line" value={String(session.uploaded ?? 0)} label="uploaded" color={colors.primary} colors={colors} />
          <StatChip icon="check" iosIcon="checkmark" value={String(session.skipped ?? 0)} label="already saved" color={colors.success} colors={colors} />
          {(session.errors ?? 0) > 0 && (
            <StatChip icon="error_outline" iosIcon="exclamationmark.circle" value={String(session.errors)} label="errors" color={colors.error} colors={colors} />
          )}
          <StatChip icon="timer" iosIcon="timer" value={formatDuration(session.durationMs ?? 0)} label="duration" color={colors.textSecondary} colors={colors} />
        </View>

        {/* ── Scanned / size summary ── */}
        <View style={styles.summaryRow}>
          <Text style={styles.summaryText}>
            {(session.scanned ?? 0).toLocaleString()} files scanned
            {session.totalSize > 0 ? `  ·  ${formatBytes(session.totalSize)} total` : ''}
          </Text>
          {session.folders?.length > 0 && (
            <Text style={styles.summaryText} numberOfLines={1}>
              {session.folders.join(', ')}
            </Text>
          )}
        </View>

        {/* ── Expandable detail ── */}
        {expanded && hasDetail && (
          <View style={styles.expandSection}>
            <View style={styles.expandDivider} />

            {session.uploadedFiles?.length > 0 && (
              <>
                <Text style={styles.expandTitle}>
                  Files uploaded ({session.uploadedFiles.length}{session.uploaded > session.uploadedFiles.length ? '+' : ''})
                </Text>
                {session.uploadedFiles.map((name, i) => (
                  <View key={i} style={styles.fileRow}>
                    <AppIcon androidName="insert_drive_file" iosName="doc" color={colors.primary} size={12} fallback="•" />
                    <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
                  </View>
                ))}
              </>
            )}

            {session.errorDetails?.length > 0 && (
              <>
                <Text style={[styles.expandTitle, { color: colors.error, marginTop: session.uploadedFiles?.length > 0 ? Spacing.three : 0 }]}>
                  Errors ({session.errorDetails.length})
                </Text>
                {session.errorDetails.map((msg, i) => (
                  <View key={i} style={styles.errorRow}>
                    <AppIcon androidName="error_outline" iosName="exclamationmark.circle" color={colors.error} size={12} fallback="!" />
                    <Text style={styles.errorText} numberOfLines={2}>{msg}</Text>
                  </View>
                ))}
              </>
            )}
          </View>
        )}

        {!expanded && hasDetail && (
          <Text style={styles.tapHint}>Tap to see details</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── Small inline chip ──────────────────────────────────────────────────────────
function StatChip({
  icon, iosIcon, value, label, color, colors,
}: {
  icon: string; iosIcon: string; value: string;
  label: string; color: string; colors: AppColors;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginRight: 10 }}>
      <AppIcon androidName={icon} iosName={iosIcon} color={color} size={12} fallback="·" />
      <Text style={{ fontSize: TextScale.xs, fontWeight: '800', color }}>
        {value}
      </Text>
      <Text style={{ fontSize: TextScale.xs, fontWeight: '500', color: colors.textMuted }}>
        {label}
      </Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const createStyles = (colors: AppColors) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    borderLeftWidth: 3,
    padding: Spacing.four,
    marginBottom: Spacing.three,
    gap: Spacing.two,
    ...Shadows.card,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: 3,
    borderRadius: Radius.full,
  },
  badgeText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  autoChip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.full,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
  },
  autoChipText: {
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  timeText: {
    fontSize: TextScale.xs,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  summaryRow: {
    gap: 2,
  },
  summaryText: {
    fontSize: TextScale.xs,
    color: colors.textMuted,
    fontWeight: '500',
  },
  expandSection: {
    gap: Spacing.two,
  },
  expandDivider: {
    height: 1,
    backgroundColor: colors.surfaceBorder,
    marginVertical: Spacing.one,
  },
  expandTitle: {
    fontSize: TextScale.xs,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.one,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: 2,
  },
  fileName: {
    flex: 1,
    fontSize: TextScale.xs,
    color: colors.text,
    fontWeight: '500',
    fontFamily: 'monospace',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingVertical: 2,
  },
  errorText: {
    flex: 1,
    fontSize: TextScale.xs,
    color: colors.error,
    fontWeight: '500',
  },
  tapHint: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: '500',
    textAlign: 'center',
    paddingTop: 2,
  },
});
