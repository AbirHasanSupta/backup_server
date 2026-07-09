import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Colors, Radius, Spacing, TextScale } from '@/constants/theme';
import { FILE_TYPE_LABELS } from '../../settings';
import { AppIcon } from '@/components/AppIcon';

const FILE_TYPE_ICONS: Record<string, { android: string; ios: string; fallback: string }> = {
  all: { android: 'select_all', ios: 'square.grid.2x2', fallback: 'A' },
  photos: { android: 'photo_camera', ios: 'photo', fallback: 'P' },
  videos: { android: 'movie', ios: 'play.rectangle', fallback: 'V' },
  pdfs: { android: 'picture_as_pdf', ios: 'doc.richtext', fallback: 'PDF' },
  docs: { android: 'description', ios: 'doc.text', fallback: 'D' },
  others: { android: 'inventory_2', ios: 'archivebox', fallback: 'O' },
};

const ALL_TYPES = ['all', 'photos', 'videos', 'pdfs', 'docs', 'others'] as const;
type FileType = typeof ALL_TYPES[number];

interface Props {
  selected: string[];
  onChange: (types: string[]) => void;
}

export function FileTypeSelector({ selected, onChange }: Props) {
  const isAll = selected.includes('all');

  const toggle = (type: FileType) => {
    if (type === 'all') {
      onChange(['all']);
      return;
    }

    const withoutAll = selected.filter((t) => t !== 'all');

    if (withoutAll.includes(type)) {
      const next = withoutAll.filter((t) => t !== type);
      onChange(next.length === 0 ? ['all'] : next);
      return;
    }

    const next = [...withoutAll, type];
    const specificTypes = ALL_TYPES.filter((t) => t !== 'all');
    onChange(specificTypes.every((t) => next.includes(t)) ? ['all'] : next);
  };

  return (
    <View>
      <View style={styles.headingRow}>
        <Text style={styles.label}>File types</Text>
        <Text style={styles.selection}>{isAll ? 'Everything' : `${selected.length} selected`}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {ALL_TYPES.map((type) => {
          const active = type === 'all' ? isAll : !isAll && selected.includes(type);
          const icon = FILE_TYPE_ICONS[type];
          return (
            <TouchableOpacity
              key={type}
              style={[styles.pill, active && styles.pillActive]}
              onPress={() => toggle(type)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: active }}
              accessibilityLabel={FILE_TYPE_LABELS[type]}
            >
              <AppIcon
                androidName={icon.android}
                iosName={icon.ios}
                color={active ? Colors.primary : Colors.textSecondary}
                size={16}
                fallback={icon.fallback}
              />
              <Text style={[styles.pillText, active && styles.pillTextActive]}>
                {FILE_TYPE_LABELS[type]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.two,
  },
  label: {
    fontSize: TextScale.xs,
    fontWeight: '800',
    color: Colors.textSecondary,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  selection: {
    fontSize: TextScale.xs,
    color: Colors.textMuted,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingBottom: Spacing.one,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 38,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.surface,
  },
  pillActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  pillText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    color: Colors.textSecondary,
  },
  pillTextActive: {
    color: Colors.primary,
  },
});
