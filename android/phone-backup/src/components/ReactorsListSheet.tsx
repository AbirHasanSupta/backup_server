import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { getMediaReactions } from '../../downloader';

const { height: SCREEN_H } = Dimensions.get('window');

type Reactor = {
  id: number;
  media_id: number;
  source_id: string;
  emoji: string;
  created_at: number;
  display_name: string;
  is_own: boolean;
};

function formatTimeAgo(ts: number | undefined): string {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ReactorsListSheet({
  visible,
  mediaId,
  colors,
  onClose,
}: {
  visible: boolean;
  mediaId?: number | null;
  colors: AppColors;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [reactions, setReactions] = useState<Reactor[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    if (!visible || mediaId == null) return;
    let active = true;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setFilter('all');
    /* eslint-enable react-hooks/set-state-in-effect */
    getMediaReactions(mediaId)
      .then((res) => {
        if (!active) return;
        setReactions(Array.isArray(res?.reactions) ? res.reactions : []);
        setCounts(res?.counts && typeof res.counts === 'object' ? res.counts : {});
      })
      .catch(() => { if (active) { setReactions([]); setCounts({}); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible, mediaId]);

  const emojiTabs = useMemo(() => Object.keys(counts).filter((e) => counts[e] > 0), [counts]);
  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);
  const filtered = filter === 'all' ? reactions : reactions.filter((r) => r.emoji === filter);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + Spacing.three }]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>
            {total} {total === 1 ? 'Reaction' : 'Reactions'}
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={20} />
          </TouchableOpacity>
        </View>

        {emojiTabs.length > 1 && (
          <FlatList
            data={['all', ...emojiTabs]}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(e) => e}
            contentContainerStyle={styles.tabRow}
            renderItem={({ item: e }) => {
              const active = filter === e;
              return (
                <TouchableOpacity
                  onPress={() => setFilter(e)}
                  style={[
                    styles.tab,
                    { borderColor: active ? colors.primary : colors.surfaceBorder, backgroundColor: active ? colors.primarySoft : colors.surfaceSoft },
                  ]}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.tabText, { color: active ? colors.primary : colors.textSecondary }]}>
                    {e === 'all' ? `All ${total}` : `${e} ${counts[e]}`}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        )}

        {loading ? (
          <View style={styles.centerPad}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.centerPad}>
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>No reactions yet.</Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(r) => String(r.id)}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item: r }) => (
              <View style={styles.row}>
                <Text style={styles.rowEmoji}>{r.emoji}</Text>
                <View style={styles.rowInfo}>
                  <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                    {r.display_name || r.source_id}{r.is_own ? ' (You)' : ''}
                  </Text>
                  <Text style={[styles.rowTime, { color: colors.textMuted }]}>{formatTimeAgo(r.created_at)}</Text>
                </View>
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    maxHeight: SCREEN_H * 0.7,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.4)',
    marginBottom: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
  },
  title: {
    fontSize: TextScale.lg,
    fontWeight: '800',
  },
  tabRow: {
    gap: Spacing.two,
    paddingBottom: Spacing.three,
  },
  tab: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two - 2,
    borderRadius: Radius.full,
    borderWidth: 1.5,
  },
  tabText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
  },
  centerPad: {
    paddingVertical: Spacing.six,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: TextScale.sm,
    textAlign: 'center',
  },
  list: {
    maxHeight: SCREEN_H * 0.5,
  },
  listContent: {
    paddingBottom: Spacing.three,
    gap: Spacing.three,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  rowEmoji: {
    fontSize: 22,
  },
  rowInfo: {
    flex: 1,
  },
  rowName: {
    fontSize: TextScale.base,
    fontWeight: '700',
  },
  rowTime: {
    fontSize: TextScale.xs,
    marginTop: 1,
  },
});