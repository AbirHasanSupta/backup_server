import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Colors, Spacing, Radius, TextScale } from '@/constants/theme';
import { FILE_TYPE_LABELS } from '../../settings';

const FILE_TYPE_ICONS: Record<string, string> = {
  all: '🗂️',
  photos: '📷',
  videos: '🎬',
  pdfs: '📄',
  docs: '📝',
  others: '📦',
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

    // Remove 'all' from selection when a specific type is tapped
    const without = selected.filter((t) => t !== 'all');

    if (without.includes(type)) {
      const next = without.filter((t) => t !== type);
      onChange(next.length === 0 ? ['all'] : next);
    } else {
      const next = [...without, type];
      // If all specific types are selected, switch to 'all'
      const specificTypes = ALL_TYPES.filter((t) => t !== 'all');
      if (specificTypes.every((t) => next.includes(t))) {
        onChange(['all']);
      } else {
        onChange(next);
      }
    }
  };

  return (
    <View>
      <Text style={styles.label}>File Types</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {ALL_TYPES.map((type) => {
          const active = type === 'all' ? isAll : (!isAll && selected.includes(type));
          return (
            <TouchableOpacity
              key={type}
              style={[styles.pill, active && styles.pillActive]}
              onPress={() => toggle(type)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: active }}
              accessibilityLabel={FILE_TYPE_LABELS[type]}
            >
              <Text style={styles.pillIcon}>{FILE_TYPE_ICONS[type]}</Text>
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
  label: {
    fontSize: TextScale.xs,
    fontWeight: '600',
    color: Colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingBottom: Spacing.one,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.surfaceElevated,
  },
  pillActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryDim,
  },
  pillIcon: {
    fontSize: 14,
  },
  pillText: {
    fontSize: TextScale.sm,
    fontWeight: '500',
    color: Colors.textSecondary,
  },
  pillTextActive: {
    color: Colors.primaryLight,
    fontWeight: '600',
  },
});
