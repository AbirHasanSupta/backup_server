import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, StatusBar, FlatList, Modal, Alert } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { AnimatedListItem } from '@/components/AnimatedListItem';
import { useAppTheme } from '@/hooks/use-app-theme';
import { hapticMedium, hapticLight, hapticSuccess } from '@/utils/haptics';
import { getGoals, addGoal, removeGoal, computeAllGoalsProgress, invalidateGoalsFileCache } from '../../goals';

type Goal = {
  id: string;
  year: number;
  createdAt: number;
  completedAt: number | null;
};

type GoalProgress = { total: number; backedUp: number; percent: number };
type GoalRow = { goal: Goal; progress: GoalProgress | null };

const MIN_GOAL_YEAR = 2000;

export default function GoalsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [rows, setRows] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerYear, setPickerYear] = useState(new Date().getFullYear());

  const abortRef = useRef(false);
  const genRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++genRef.current;
    abortRef.current = false;
    setLoading(true);
    try {
      const goals: Goal[] = await getGoals();
      if (gen !== genRef.current) return;
      if (!goals.length) {
        setRows([]);
        return;
      }
      setRows(goals.map((goal) => ({ goal, progress: null })));
      setComputing(true);
      const results = await computeAllGoalsProgress(() => abortRef.current || genRef.current !== gen);
      if (gen !== genRef.current) return;
      setRows(results as GoalRow[]);
    } catch {
      // Keep prior data visible on transient errors.
    } finally {
      if (gen === genRef.current) {
        setLoading(false);
        setComputing(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      abortRef.current = false;
      load();
      return () => {
        abortRef.current = true;
        genRef.current += 1;
      };
    }, [load])
  );

  const openPicker = useCallback(() => {
    hapticMedium();
    setPickerYear(new Date().getFullYear());
    setPickerVisible(true);
  }, []);

  const confirmAddGoal = useCallback(async () => {
    setPickerVisible(false);
    hapticSuccess();
    await addGoal(pickerYear);
    invalidateGoalsFileCache();
    load();
  }, [pickerYear, load]);

  const handleRemoveGoal = useCallback((goal: Goal) => {
    Alert.alert('Remove Goal', `Stop tracking ${goal.year}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          hapticLight();
          await removeGoal(goal.id);
          load();
        },
      },
    ]);
  }, [load]);

  const existingYears = useMemo(() => new Set(rows.map((r) => r.goal.year)), [rows]);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />

      <View style={[styles.header, { paddingTop: insets.top + Spacing.three }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="Go back">
          <AppIcon androidName="arrow_back" iosName="chevron.left" color={colors.text} size={22} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Backup Goals</Text>
          <Text style={styles.headerSubtitle}>
            {computing ? 'Checking progress…' : rows.length > 0 ? `${rows.length} tracked ${rows.length === 1 ? 'year' : 'years'}` : 'Track a year until fully backed up'}
          </Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={openPicker} accessibilityLabel="Add a backup goal">
          <AppIcon androidName="add" iosName="plus" color={colors.primary} size={22} />
        </TouchableOpacity>
      </View>

      {loading && rows.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading goals…</Text>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.emptyContainer}>
          <View style={[styles.emptyIconWrap, { backgroundColor: colors.primarySoft }]}>
            <AppIcon androidName="flag" iosName="flag.fill" color={colors.primary} size={36} />
          </View>
          <Text style={styles.emptyTitle}>No goals yet</Text>
          <Text style={styles.emptySubtitle}>
            Set a target year and we&apos;ll track how much of it is backed up.
          </Text>
          <AnimatedPressable style={[styles.emptyCta, { backgroundColor: colors.primary }]} onPress={openPicker} scaleDown={0.96}>
            <AppIcon androidName="add" iosName="plus" color={colors.white} size={18} />
            <Text style={styles.emptyCtaText}>Set a Goal</Text>
          </AnimatedPressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.goal.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + Spacing.six }]}
          renderItem={({ item, index }) => (
            <AnimatedListItem index={index}>
              <GoalCard row={item} colors={colors} styles={styles} onRemove={() => handleRemoveGoal(item.goal)} />
            </AnimatedListItem>
          )}
          showsVerticalScrollIndicator={false}
        />
      )}

      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
            <Text style={styles.modalTitle}>Track a year</Text>
            <View style={styles.yearPickerRow}>
              <TouchableOpacity
                style={styles.yearArrowBtn}
                onPress={() => setPickerYear((y) => Math.max(MIN_GOAL_YEAR, y - 1))}
                disabled={pickerYear <= MIN_GOAL_YEAR}
              >
                <AppIcon androidName="chevron_left" iosName="chevron.left" color={pickerYear <= MIN_GOAL_YEAR ? colors.textMuted : colors.text} size={22} />
              </TouchableOpacity>
              <Text style={styles.yearPickerText}>{pickerYear}</Text>
              <TouchableOpacity
                style={styles.yearArrowBtn}
                onPress={() => setPickerYear((y) => Math.min(new Date().getFullYear(), y + 1))}
                disabled={pickerYear >= new Date().getFullYear()}
              >
                <AppIcon androidName="chevron_right" iosName="chevron.right" color={pickerYear >= new Date().getFullYear() ? colors.textMuted : colors.text} size={22} />
              </TouchableOpacity>
            </View>
            {existingYears.has(pickerYear) && (
              <Text style={styles.modalWarning}>Already tracking {pickerYear}</Text>
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setPickerVisible(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalConfirmBtn, { backgroundColor: colors.primary }, existingYears.has(pickerYear) && styles.modalConfirmBtnDisabled]}
                onPress={confirmAddGoal}
                disabled={existingYears.has(pickerYear)}
              >
                <Text style={styles.modalConfirmText}>Add Goal</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function GoalCard({
  row, colors, styles, onRemove,
}: {
  row: GoalRow; colors: AppColors; styles: ReturnType<typeof createStyles>; onRemove: () => void;
}) {
  const { goal, progress } = row;
  const percent = progress?.percent ?? 0;
  const isComplete = !!goal.completedAt;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={[styles.yearBadge, { backgroundColor: isComplete ? colors.successSoft : colors.primarySoft }]}>
          <Text style={[styles.yearBadgeText, { color: isComplete ? colors.success : colors.primary }]}>{goal.year}</Text>
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardTitle}>
            {isComplete ? 'Fully backed up' : progress ? `${progress.backedUp.toLocaleString()} of ${progress.total.toLocaleString()} files` : 'Checking…'}
          </Text>
          {!isComplete && progress ? (
            <Text style={styles.cardSubtitle}>{percent}% complete</Text>
          ) : null}
        </View>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityLabel={`Remove ${goal.year} goal`}>
          <AppIcon androidName="close" iosName="xmark" color={colors.textMuted} size={18} />
        </TouchableOpacity>
      </View>
      <View style={[styles.progressTrack, { backgroundColor: colors.surfaceSoft }]}>
        <View
          style={[
            styles.progressFill,
            { width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: isComplete ? colors.success : colors.primary },
          ]}
        />
      </View>
      {isComplete && (
        <View style={styles.completeRow}>
          <AppIcon androidName="check_circle" iosName="checkmark.circle.fill" color={colors.success} size={14} />
          <Text style={[styles.completeText, { color: colors.success }]}>Goal complete</Text>
        </View>
      )}
    </View>
  );
}

const createStyles = (colors: AppColors) => StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceBorder,
    gap: Spacing.two,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text },
  headerSubtitle: { fontSize: TextScale.xs, color: colors.textSecondary, fontWeight: '600', marginTop: 2, textAlign: 'center' },
  addBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.five },
  loadingText: { marginTop: Spacing.three, fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '600' },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.six },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: Radius.full,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.four,
  },
  emptyTitle: { fontSize: TextScale.lg, fontWeight: '800', color: colors.text, marginBottom: Spacing.two },
  emptySubtitle: {
    fontSize: TextScale.sm, color: colors.textSecondary, fontWeight: '500',
    textAlign: 'center', lineHeight: 22, maxWidth: 280,
  },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
    marginTop: Spacing.five, paddingHorizontal: Spacing.five, paddingVertical: Spacing.three,
    borderRadius: Radius.full, ...Shadows.soft,
  },
  emptyCtaText: { fontSize: TextScale.sm, fontWeight: '800', color: colors.white },
  listContent: { padding: Spacing.four, gap: Spacing.three },
  card: {
    backgroundColor: colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    padding: Spacing.four,
    marginBottom: Spacing.three,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, marginBottom: Spacing.three },
  yearBadge: { paddingHorizontal: Spacing.three, paddingVertical: 6, borderRadius: Radius.md },
  yearBadgeText: { fontSize: TextScale.sm, fontWeight: '800' },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: TextScale.sm, fontWeight: '700', color: colors.text },
  cardSubtitle: { fontSize: TextScale.xs, color: colors.textMuted, fontWeight: '500', marginTop: 2 },
  progressTrack: { height: 8, borderRadius: Radius.full, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: Radius.full },
  completeRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: Spacing.two },
  completeText: { fontSize: TextScale.xs, fontWeight: '700' },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: Spacing.five,
  },
  modalCard: { width: '100%', maxWidth: 340, borderRadius: Radius.xl, padding: Spacing.five, ...Shadows.card },
  modalTitle: { fontSize: TextScale.md, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: Spacing.four },
  yearPickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.five, marginBottom: Spacing.two },
  yearArrowBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  yearPickerText: { fontSize: 32, fontWeight: '800', color: colors.text, minWidth: 90, textAlign: 'center' },
  modalWarning: { fontSize: TextScale.xs, color: colors.warning, fontWeight: '600', textAlign: 'center', marginBottom: Spacing.two },
  modalActions: { flexDirection: 'row', gap: Spacing.three, marginTop: Spacing.four },
  modalCancelBtn: { flex: 1, paddingVertical: Spacing.three, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.md },
  modalCancelText: { fontSize: TextScale.sm, fontWeight: '700', color: colors.textSecondary },
  modalConfirmBtn: { flex: 1, paddingVertical: Spacing.three, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.md },
  modalConfirmBtnDisabled: { opacity: 0.5 },
  modalConfirmText: { fontSize: TextScale.sm, fontWeight: '800', color: '#fff' },
});