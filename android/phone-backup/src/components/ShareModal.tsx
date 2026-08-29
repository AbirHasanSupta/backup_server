import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { listShareTargetDevices } from '../../downloader';

const { height: SCREEN_H } = Dimensions.get('window');

export type ShareTargetDevice = {
  device_id: string;
  device_name: string;
  device_model?: string;
  username?: string;
  display_name?: string;
};

export function ShareModal({
  visible,
  count,
  colors,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  count: number;
  colors: AppColors;
  onClose: () => void;
  onSubmit: (targetIds: string[], caption: string) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [devices, setDevices] = useState<ShareTargetDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setSelected(new Set());
    setCaption('');
    /* eslint-enable react-hooks/set-state-in-effect */
    listShareTargetDevices()
      .then((res) => { if (active) setDevices(Array.isArray(res?.devices) ? res.devices : []); })
      .catch(() => { if (active) setDevices([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [visible]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const allSelected = devices.length > 0 && selected.size === devices.length;
  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(devices.map((d) => d.device_id)));
    }
  }, [allSelected, devices]);

  const handleSend = useCallback(async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    try {
      await onSubmit(Array.from(selected), caption.trim());
    } finally {
      setSending(false);
    }
  }, [selected, sending, caption, onSubmit]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.avoider}
        pointerEvents="box-none"
      >
        <View style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + Spacing.three }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              Share {count} {count === 1 ? 'item' : 'items'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={20} />
            </TouchableOpacity>
          </View>

          <TextInput
            value={caption}
            onChangeText={setCaption}
            placeholder="Add a caption (optional)…"
            placeholderTextColor={colors.textMuted}
            style={[styles.captionInput, { backgroundColor: colors.surfaceSoft, color: colors.text, borderColor: colors.surfaceBorder }]}
            multiline
            maxLength={2000}
          />

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.two }}>
            <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginBottom: 0 }]}>
              Send to devices
            </Text>
            {devices.length > 1 && (
              <TouchableOpacity onPress={toggleSelectAll} hitSlop={6}>
                <Text style={{ fontSize: TextScale.xs, fontWeight: '700', color: colors.primary }}>
                  {allSelected ? 'Deselect all' : 'Select all'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {loading ? (
            <View style={styles.centerPad}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : devices.length === 0 ? (
            <View style={styles.centerPad}>
              <Text style={[styles.emptyText, { color: colors.textMuted }]}>
                No other devices are connected to share with.
              </Text>
            </View>
          ) : (
            <FlatList
              data={devices}
              keyExtractor={(d) => d.device_id}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: d }) => {
                const active = selected.has(d.device_id);
                return (
                  <TouchableOpacity
                    onPress={() => toggle(d.device_id)}
                    style={[
                      styles.deviceRow,
                      { borderColor: active ? colors.primary : colors.surfaceBorder, backgroundColor: active ? colors.primarySoft : colors.surfaceSoft },
                    ]}
                    activeOpacity={0.8}
                  >
                    <View style={styles.deviceInfo}>
                      <Text style={[styles.deviceName, { color: colors.text }]} numberOfLines={1}>
                        {d.display_name || d.device_name || 'Unknown device'}
                      </Text>
                      {!!d.device_model && (
                        <Text style={[styles.deviceModel, { color: colors.textMuted }]} numberOfLines={1}>
                          {d.device_model}
                        </Text>
                      )}
                    </View>
                    <AppIcon
                      androidName={active ? 'check_circle' : 'radio_button_unchecked'}
                      iosName={active ? 'checkmark.circle.fill' : 'circle'}
                      color={active ? colors.primary : colors.textMuted}
                      size={22}
                    />
                  </TouchableOpacity>
                );
              }}
            />
          )}

          <TouchableOpacity
            onPress={handleSend}
            disabled={selected.size === 0 || sending}
            style={[styles.primaryBtn, { backgroundColor: selected.size > 0 && !sending ? colors.primary : colors.surfaceSoft }]}
            activeOpacity={0.85}
          >
            {sending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={[styles.primaryBtnText, { color: selected.size > 0 ? '#fff' : colors.textMuted }]}>
                {selected.size > 0 ? `Share with ${selected.size} ${selected.size === 1 ? 'device' : 'devices'}` : 'Select devices'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  avoider: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    maxHeight: SCREEN_H * 0.85,
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
  centerPad: {
    paddingVertical: Spacing.six,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: TextScale.sm,
    textAlign: 'center',
  },
  list: {
    maxHeight: SCREEN_H * 0.45,
  },
  listContent: {
    paddingBottom: Spacing.two,
    gap: Spacing.two,
  },
  captionInput: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    fontSize: TextScale.sm,
    minHeight: 44,
    maxHeight: 120,
    marginBottom: Spacing.three,
  },
  sectionLabel: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.two,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: TextScale.base,
    fontWeight: '700',
  },
  deviceModel: {
    fontSize: TextScale.xs,
    marginTop: 1,
  },
  primaryBtn: {
    marginTop: Spacing.three,
    borderRadius: Radius.full,
    paddingVertical: Spacing.three + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    fontSize: TextScale.base,
    fontWeight: '800',
  },
});