import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  Alert,
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppColors, Spacing, Radius, TextScale, Shadows } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import {
  listShareTargetDevices,
  DIRECT_POST_MAX_FILES,
  DIRECT_POST_MAX_FILE_BYTES,
} from '../../downloader';
import { useModalKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import type { ShareTargetDevice } from './ShareModal';

const { height: SCREEN_H } = Dimensions.get('window');

export type DeviceFileItem = {
  uri: string;
  name: string;
  size: number;
  modifiedTime: number;
  selected: boolean;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus']);

function isImageFile(name: string): boolean {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.has(ext);
}

function getFileIcon(name: string): { android: string; ios: string } {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { android: 'image', ios: 'photo' };
  if (VIDEO_EXTS.has(ext)) return { android: 'videocam', ios: 'video' };
  if (AUDIO_EXTS.has(ext)) return { android: 'audiotrack', ios: 'music.note' };
  return { android: 'insert_drive_file', ios: 'doc' };
}

export function DirectPostModal({
  visible,
  files,
  colors,
  onClose,
  onAddFiles,
  onSubmit,
}: {
  visible: boolean;
  files: DeviceFileItem[];
  colors: AppColors;
  onClose: () => void;
  onAddFiles: () => void;
  onSubmit: (selectedFiles: DeviceFileItem[], targetIds: string[], caption: string, onProgress?: (statusText: string) => void) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const { keyboardHeight } = useModalKeyboardHeight();
  const [fileList, setFileList] = useState<DeviceFileItem[]>([]);
  const [devices, setDevices] = useState<ShareTargetDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [devicesError, setDevicesError] = useState(false);
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [caption, setCaption] = useState('');
  const [posting, setPosting] = useState(false);
  const [postProgressText, setPostProgressText] = useState('');
  const wasVisibleRef = useRef(false);
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Initialize modal state only when opening (not when appending files).
  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false;
      return;
    }
    if (wasVisibleRef.current) return;
    wasVisibleRef.current = true;

    setFileList(filesRef.current);
    setCaption('');
    setPosting(false);
    setPostProgressText('');
    setDevicesError(false);

    let active = true;
    setLoadingDevices(true);
    listShareTargetDevices()
      .then((res) => {
        if (!active) return;
        const list = Array.isArray(res?.devices) ? res.devices : [];
        const filtered = list.filter((d) => d.device_id !== 'desktop-server');
        setDevices(filtered);
        setSelectedDevices(new Set(filtered.map((d) => d.device_id)));
      })
      .catch(() => {
        if (!active) return;
        setDevices([]);
        setDevicesError(true);
      })
      .finally(() => {
        if (active) setLoadingDevices(false);
      });

    return () => {
      active = false;
    };
  }, [visible]);

  // Merge newly picked files while the modal stays open.
  useEffect(() => {
    if (!visible || !wasVisibleRef.current) return;
    setFileList((prev) => {
      const seen = new Set(prev.map((f) => f.uri));
      const additions = files.filter((f) => !seen.has(f.uri));
      if (!additions.length) return prev;
      const merged = [...prev, ...additions];
      if (merged.length > DIRECT_POST_MAX_FILES) {
        Alert.alert(
          'Too many files',
          `You can post up to ${DIRECT_POST_MAX_FILES} files at once. Remove some files before adding more.`,
        );
        return prev;
      }
      return merged;
    });
  }, [files, visible]);

  const toggleFile = useCallback((uri: string) => {
    setFileList((prev) =>
      prev.map((f) => (f.uri === uri ? { ...f, selected: !f.selected } : f))
    );
  }, []);

  const selectedFiles = fileList.filter((f) => f.selected);
  const allFilesSelected = fileList.length > 0 && selectedFiles.length === fileList.length;
  const canPost = selectedFiles.length > 0
    && !posting
    && !loadingDevices
    && !devicesError
    && devices.length > 0
    && selectedDevices.size > 0;

  const toggleAllFiles = useCallback(() => {
    if (allFilesSelected) {
      setFileList((prev) => prev.map((f) => ({ ...f, selected: false })));
    } else {
      setFileList((prev) => prev.map((f) => ({ ...f, selected: true })));
    }
  }, [allFilesSelected]);

  const toggleDevice = useCallback((id: string) => {
    setSelectedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allDevicesSelected = devices.length > 0 && selectedDevices.size === devices.length;
  const toggleAllDevices = useCallback(() => {
    if (allDevicesSelected) {
      setSelectedDevices(new Set());
    } else {
      setSelectedDevices(new Set(devices.map((d) => d.device_id)));
    }
  }, [allDevicesSelected, devices]);

  const handleClose = useCallback(() => {
    if (posting) return;
    onClose();
  }, [posting, onClose]);

  const handlePost = useCallback(async () => {
    if (loadingDevices) {
      Alert.alert('Please wait', 'Still loading target devices…');
      return;
    }
    if (devicesError || devices.length === 0) {
      Alert.alert(
        'No target devices',
        'At least one other connected device is required to publish a feed post.',
      );
      return;
    }
    if (selectedFiles.length === 0) {
      Alert.alert('No files selected', 'Please select at least one file to post.');
      return;
    }
    if (selectedDevices.size === 0) {
      Alert.alert('No devices selected', 'Please select at least one target device to share with.');
      return;
    }
    if (selectedFiles.length > DIRECT_POST_MAX_FILES) {
      Alert.alert('Too many files', `You can post up to ${DIRECT_POST_MAX_FILES} files at once.`);
      return;
    }
    const oversized = selectedFiles.find((f) => (f.size || 0) > DIRECT_POST_MAX_FILE_BYTES);
    if (oversized) {
      Alert.alert('File too large', `${oversized.name} exceeds the 100 MB limit.`);
      return;
    }

    setPosting(true);
    setPostProgressText(`Uploading ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}…`);
    try {
      await onSubmit(
        selectedFiles,
        Array.from(selectedDevices),
        caption.trim(),
        (statusText) => setPostProgressText(statusText),
      );
      onClose();
    } catch (err: any) {
      Alert.alert('Post Failed', sanitizeErrorMessage(err, 'Could not upload and create post.'));
    } finally {
      setPosting(false);
    }
  }, [
    loadingDevices,
    devicesError,
    devices.length,
    selectedFiles,
    selectedDevices,
    caption,
    onSubmit,
    onClose,
  ]);

  const androidKeyboardOffset = Platform.OS === 'android' ? keyboardHeight : 0;
  const sheetMaxHeight = keyboardHeight > 0
    ? Math.min(SCREEN_H * 0.88, SCREEN_H - keyboardHeight - 20)
    : SCREEN_H * 0.88;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.avoider}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              paddingBottom: insets.bottom + Spacing.three,
              marginBottom: androidKeyboardOffset,
              maxHeight: sheetMaxHeight,
            },
          ]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <View>
              <Text style={[styles.title, { color: colors.text }]}>New Post from Phone</Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                Share files directly from device storage to feed
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} hitSlop={10} disabled={posting}>
              <AppIcon androidName="close" iosName="xmark" color={colors.textSecondary} size={20} />
            </TouchableOpacity>
          </View>

          <View style={[styles.folderBadge, { backgroundColor: colors.surfaceSoft, borderColor: colors.surfaceBorder }]}>
            <View style={styles.folderBadgeLeft}>
              <AppIcon androidName="attach_file" iosName="paperclip" color={colors.primary} size={18} />
              <Text style={[styles.folderBadgeText, { color: colors.text }]} numberOfLines={1}>
                {fileList.length === 1 ? '1 file selected' : `${fileList.length} files selected`}
                {fileList.length >= DIRECT_POST_MAX_FILES ? ` (max ${DIRECT_POST_MAX_FILES})` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onAddFiles}
              disabled={posting || fileList.length >= DIRECT_POST_MAX_FILES}
              style={styles.changeFolderBtn}
            >
              <Text style={[styles.changeFolderText, { color: colors.primary }]}>Add files</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scrollContent}
          >
            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="Write a caption for this post (optional)…"
              placeholderTextColor={colors.textMuted}
              style={[
                styles.captionInput,
                { backgroundColor: colors.surfaceSoft, color: colors.text, borderColor: colors.surfaceBorder },
              ]}
              multiline
              maxLength={2000}
              editable={!posting}
            />

            <View style={styles.sectionHeaderRow}>
              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                Files to post ({selectedFiles.length}/{fileList.length})
              </Text>
              {fileList.length > 1 && (
                <TouchableOpacity onPress={toggleAllFiles} hitSlop={6} disabled={posting}>
                  <Text style={[styles.toggleText, { color: colors.primary }]}>
                    {allFilesSelected ? 'Deselect all' : 'Select all'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <FlatList
              data={fileList}
              keyExtractor={(f) => f.uri}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filesListContent}
              style={[styles.filesList, keyboardHeight > 0 && { maxHeight: 110 }]}
              scrollEnabled={!posting}
              renderItem={({ item: file }) => {
                const isImg = isImageFile(file.name);
                const icon = getFileIcon(file.name);
                const tooLarge = (file.size || 0) > DIRECT_POST_MAX_FILE_BYTES;
                return (
                  <TouchableOpacity
                    onPress={() => toggleFile(file.uri)}
                    disabled={posting}
                    style={[
                      styles.fileCard,
                      {
                        borderColor: file.selected ? colors.primary : colors.surfaceBorder,
                        backgroundColor: file.selected ? colors.primarySoft : colors.surfaceSoft,
                      },
                    ]}
                    activeOpacity={0.8}
                  >
                    <View style={styles.filePreviewWrap}>
                      {isImg ? (
                        <Image source={{ uri: file.uri }} style={styles.fileThumbnail} contentFit="cover" />
                      ) : (
                        <View style={[styles.fileIconPlaceholder, { backgroundColor: colors.surface }]}>
                          <AppIcon androidName={icon.android} iosName={icon.ios} color={colors.primary} size={28} />
                        </View>
                      )}
                      <View style={styles.fileCheckBadge}>
                        <AppIcon
                          androidName={file.selected ? 'check_circle' : 'radio_button_unchecked'}
                          iosName={file.selected ? 'checkmark.circle.fill' : 'circle'}
                          color={file.selected ? colors.primary : colors.textMuted}
                          size={20}
                        />
                      </View>
                    </View>
                    <Text style={[styles.fileName, { color: colors.text }]} numberOfLines={1}>
                      {file.name}
                    </Text>
                    <Text style={[styles.fileSize, { color: tooLarge ? '#EF4444' : colors.textMuted }]}>
                      {formatFileSize(file.size)}{tooLarge ? ' · too large' : ''}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />

            <View style={[styles.sectionHeaderRow, { marginTop: Spacing.two }]}>
              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
                Share with devices ({selectedDevices.size}/{devices.length})
              </Text>
              {devices.length > 1 && (
                <TouchableOpacity onPress={toggleAllDevices} hitSlop={6} disabled={posting}>
                  <Text style={[styles.toggleText, { color: colors.primary }]}>
                    {allDevicesSelected ? 'Deselect all' : 'Select all'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {loadingDevices ? (
              <View style={styles.deviceLoading}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : devicesError ? (
              <Text style={[styles.emptyDevicesText, { color: '#EF4444' }]}>
                Could not load target devices. Check your connection and try again.
              </Text>
            ) : devices.length === 0 ? (
              <Text style={[styles.emptyDevicesText, { color: colors.textMuted }]}>
                No other connected devices found. Pair another device before posting to the feed.
              </Text>
            ) : (
              <View style={styles.devicesChipRow}>
                {devices.map((d) => {
                  const active = selectedDevices.has(d.device_id);
                  return (
                    <TouchableOpacity
                      key={d.device_id}
                      onPress={() => toggleDevice(d.device_id)}
                      disabled={posting}
                      style={[
                        styles.deviceChip,
                        {
                          backgroundColor: active ? colors.primarySoft : colors.surfaceSoft,
                          borderColor: active ? colors.primary : colors.surfaceBorder,
                        },
                      ]}
                    >
                      <AppIcon
                        androidName={active ? 'check' : 'phone_android'}
                        iosName={active ? 'checkmark' : 'iphone'}
                        color={active ? colors.primary : colors.textSecondary}
                        size={14}
                      />
                      <Text
                        style={[
                          styles.deviceChipText,
                          { color: active ? colors.primary : colors.text },
                        ]}
                        numberOfLines={1}
                      >
                        {d.display_name || d.device_name || d.device_id}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </ScrollView>

          <TouchableOpacity
            onPress={handlePost}
            disabled={!canPost}
            style={[
              styles.submitBtn,
              {
                backgroundColor: canPost ? colors.primary : colors.surfaceSoft,
              },
            ]}
            activeOpacity={0.85}
          >
            {posting ? (
              <View style={styles.postingRow}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.postingText}>{postProgressText || 'Uploading & Sharing…'}</Text>
              </View>
            ) : (
              <View style={styles.postingRow}>
                <AppIcon androidName="send" iosName="paperplane.fill" color="#fff" size={18} />
                <Text style={styles.submitBtnText}>
                  {canPost
                    ? `Post ${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} to Feed`
                    : loadingDevices
                      ? 'Loading devices…'
                      : devices.length === 0
                        ? 'No target devices available'
                        : 'Select files and devices to post'}
                </Text>
              </View>
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
    backgroundColor: 'rgba(0,0,0,0.55)',
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
    maxHeight: SCREEN_H * 0.88,
    ...Shadows.card,
  },
  scrollContent: {
    paddingBottom: Spacing.two,
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
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
  },
  title: {
    fontSize: TextScale.lg,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: TextScale.xs,
    fontWeight: '500',
    marginTop: 2,
  },
  folderBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.lg,
    borderWidth: 1,
    marginBottom: Spacing.two,
  },
  folderBadgeLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flex: 1,
    marginRight: Spacing.two,
  },
  folderBadgeText: {
    fontSize: TextScale.sm,
    fontWeight: '700',
    flexShrink: 1,
  },
  changeFolderBtn: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
  },
  changeFolderText: {
    fontSize: TextScale.xs,
    fontWeight: '800',
  },
  captionInput: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + 2,
    fontSize: TextScale.sm,
    minHeight: 44,
    maxHeight: 90,
    marginBottom: Spacing.two,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.two,
  },
  sectionLabel: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  toggleText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
  filesList: {
    maxHeight: 140,
    marginBottom: Spacing.two,
  },
  filesListContent: {
    gap: Spacing.two,
    paddingVertical: 2,
  },
  fileCard: {
    width: 100,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    padding: 6,
    alignItems: 'center',
    gap: 2,
  },
  filePreviewWrap: {
    width: 86,
    height: 72,
    borderRadius: Radius.md,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileThumbnail: {
    width: '100%',
    height: '100%',
  },
  fileIconPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileCheckBadge: {
    position: 'absolute',
    top: 3,
    right: 3,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: 10,
  },
  fileName: {
    fontSize: TextScale.xs,
    fontWeight: '700',
    width: '100%',
    textAlign: 'center',
  },
  fileSize: {
    fontSize: 10,
    fontWeight: '500',
  },
  deviceLoading: {
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  emptyDevicesText: {
    fontSize: TextScale.xs,
    fontStyle: 'italic',
    marginBottom: Spacing.two,
  },
  devicesChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  deviceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  deviceChipText: {
    fontSize: TextScale.xs,
    fontWeight: '700',
  },
  submitBtn: {
    borderRadius: Radius.full,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  postingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  submitBtnText: {
    color: '#fff',
    fontSize: TextScale.sm,
    fontWeight: '800',
  },
  postingText: {
    color: '#fff',
    fontSize: TextScale.sm,
    fontWeight: '700',
  },
});
