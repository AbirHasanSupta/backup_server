import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderHandlers, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, StatusBar, BackHandler, PanResponder, Alert } from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system';

import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { ShareModal } from '@/components/ShareModal';
import {
  QuizShareCaptureView,
  QuizCaptureSpec,
  useQuizCardCapture,
  isQuizCaptureCancelled,
} from '@/components/QuizShareCards';
import { useAppTheme } from '@/hooks/use-app-theme';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import { getQuizRound, getConfig, buildPreviewUrl, createQuizShare } from '../../downloader';

interface QuizItem {
  source_type: string;
  source_id: string;
  relative_path: string;
  correct_year: number;
  capture_time?: number | null;
  options: number[];
}

interface ServerConfig {
  ip: string;
  port: string;
  key: string;
  deviceId: string;
}

type AnswerState = 'unanswered' | 'correct' | 'wrong';

function formatCaptureDate(captureTime: number | null | undefined): string {
  if (!captureTime) return '';
  try {
    const d = new Date(captureTime * 1000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function getScoreMessage(score: number, total: number): string {
  if (score === total) return 'Perfect memory!';
  if (score >= total / 2) return 'Nice work!';
  return 'Keep playing to sharpen those memories!';
}

export default function QuizScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<QuizItem[]>([]);
  const [roundIdx, setRoundIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [answerState, setAnswerState] = useState<AnswerState>('unanswered');
  const [finished, setFinished] = useState(false);
  const [feedShareVisible, setFeedShareVisible] = useState(false);
  const [sharing, setSharing] = useState(false);

  const { shotRef, spec: captureSpec, captureCards, cancelCapture, onQuestionImageLoad } = useQuizCardCapture();
  const skipNextFocusLoadRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadRound = useCallback(async () => {
    cancelCapture();
    setLoading(true);
    setError(null);
    setFinished(false);
    setRoundIdx(0);
    setScore(0);
    setAnswers([]);
    setSelectedYear(null);
    setAnswerState('unanswered');
    try {
      const cfg = await getConfig();
      setServerConfig(cfg);
      const res = await getQuizRound(10);
      if (!res?.items || res.items.length === 0) {
        setError('Not enough dated photos yet to play — keep backing up!');
        setItems([]);
      } else {
        setItems(res.items);
      }
    } catch (err: any) {
      setError(sanitizeErrorMessage(err, 'Could not load a quiz round.'));
    } finally {
      setLoading(false);
    }
  }, [cancelCapture]);

  const startNewRound = useCallback(() => {
    skipNextFocusLoadRef.current = true;
    void loadRound();
  }, [loadRound]);

  useFocusEffect(
    useCallback(() => {
      // Keep a completed round intact so the user can share after switching tabs.
      if (finished || sharing) return undefined;
      if (skipNextFocusLoadRef.current) {
        skipNextFocusLoadRef.current = false;
        return undefined;
      }
      void loadRound();
      return undefined;
    }, [loadRound, finished, sharing]),
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sharing) return true;
      router.replace('/memories');
      return true;
    });
    return () => sub.remove();
  }, [router, sharing]);

  const currentItem = items[roundIdx] ?? null;
  const imageUrl = currentItem && serverConfig
    ? buildPreviewUrl(serverConfig, currentItem.relative_path, currentItem.source_type, currentItem.source_id)
    : '';
  const scoreMessage = getScoreMessage(score, items.length);

  const handleSelect = (year: number) => {
    if (answerState !== 'unanswered' || !currentItem) return;
    setSelectedYear(year);
    const isCorrect = year === currentItem.correct_year;
    setAnswerState(isCorrect ? 'correct' : 'wrong');
    if (isCorrect) setScore(s => s + 1);
    setAnswers(prev => {
      const next = [...prev];
      next[roundIdx] = year;
      return next;
    });
  };

  const handleNext = useCallback(() => {
    if (roundIdx + 1 >= items.length) {
      setFinished(true);
      return;
    }
    setRoundIdx(i => i + 1);
    setSelectedYear(null);
    setAnswerState('unanswered');
  }, [roundIdx, items.length]);

  // Keep latest values in refs so the PanResponder callbacks (created once)
  // always see up-to-date state without needing to recreate the responder.
  const answerStateRef = useRef(answerState);
  const handleNextRef = useRef(handleNext);
  useEffect(() => {
    answerStateRef.current = answerState;
    handleNextRef.current = handleNext;
  }, [answerState, handleNext]);

  // PanResponder is created once after mount (inside useEffect) so that
  // .current is never accessed during render — satisfies react-hooks/refs.
  // panHandlers is stored in state so it can safely be spread in JSX.
  const [swipePanHandlers, setSwipePanHandlers] = useState<GestureResponderHandlers | null>(null);
  useEffect(() => {
    const responder = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        answerStateRef.current !== 'unanswered' && Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderRelease: (_, g) => {
        if (answerStateRef.current !== 'unanswered' && Math.abs(g.dx) > 50) {
          handleNextRef.current();
        }
      },
    });
    setSwipePanHandlers(responder.panHandlers);
  }, []);

  const buildCaptureSpecs = useCallback((): QuizCaptureSpec[] => {
    if (!serverConfig) return [];
    const specs: QuizCaptureSpec[] = [{ kind: 'score' }];
    items.forEach((item, index) => {
      specs.push({
        kind: 'question',
        questionIndex: index,
        item,
        chosenYear: answers[index] ?? null,
        imageUrl: buildPreviewUrl(serverConfig, item.relative_path, item.source_type, item.source_id),
      });
    });
    return specs;
  }, [answers, items, serverConfig]);

  const handleFeedShareSubmit = async (targetIds: string[], caption: string) => {
    if (!serverConfig || sharing || !items.length) return;
    setSharing(true);
    const capturedUris: string[] = [];
    try {
      const specs = buildCaptureSpecs();
      const expectedCards = items.length + 1;
      if (specs.length !== expectedCards) {
        throw new Error('Quiz result is incomplete — please play the round again.');
      }
      const unanswered = items.findIndex((_, index) => answers[index] == null);
      if (unanswered !== -1) {
        throw new Error('Please answer every question before sharing.');
      }
      const computedScore = items.reduce(
        (acc, item, index) => acc + (answers[index] === item.correct_year ? 1 : 0),
        0,
      );
      if (computedScore !== score) {
        throw new Error('Score mismatch — please play the round again.');
      }
      const uris = await captureCards(specs);
      if (uris.length !== expectedCards) {
        throw new Error('Could not render all result cards.');
      }
      capturedUris.push(...uris);
      const quizData = {
        items: items.map((item, index) => ({
          source_type: item.source_type,
          source_id: item.source_id,
          relative_path: item.relative_path,
          options: item.options,
          correct_year: item.correct_year,
          chosen_year: answers[index] ?? null,
          capture_time: item.capture_time ?? null,
        })),
      };
      await createQuizShare(targetIds, caption, score, items.length, quizData, uris);
      if (!mountedRef.current) return;
      setFeedShareVisible(false);
      Alert.alert('Shared!', 'Your Guess the Year result was posted to the feed.');
    } catch (err: any) {
      if (!mountedRef.current || isQuizCaptureCancelled(err)) return;
      Alert.alert('Share Failed', sanitizeErrorMessage(err, 'Could not share your quiz result.'));
    } finally {
      for (const uri of capturedUris) {
        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
      if (mountedRef.current) {
        setSharing(false);
      }
    }
  };

  useEffect(() => () => {
    cancelCapture();
  }, [cancelCapture]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      <QuizShareCaptureView
        shotRef={shotRef}
        spec={captureSpec}
        score={score}
        total={items.length}
        scoreMessage={scoreMessage}
        primaryColor={colors.primary}
        onQuestionImageLoad={onQuestionImageLoad}
      />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={() => { if (!sharing) router.replace('/memories'); }}
          disabled={sharing}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <AppIcon androidName="close" iosName="xmark" color="#fff" size={22} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Guess the Year</Text>
        {!finished && items.length > 0 ? (
          <Text style={styles.scorePill}>{score} / {items.length}</Text>
        ) : (
          <View style={{ width: 40 }} />
        )}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.loadingText}>Picking photos…</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <AppIcon androidName="image_not_supported" iosName="exclamationmark.triangle" color="#fff" size={44} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.playAgainBtn} onPress={loadRound}>
            <AppIcon androidName="replay" iosName="arrow.clockwise" color="#fff" size={18} />
            <Text style={styles.playAgainText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : finished ? (
        <View style={styles.centered}>
          <AppIcon androidName="emoji_events" iosName="trophy.fill" color={colors.primary} size={56} />
          <Text style={styles.finishedScore}>{score} / {items.length}</Text>
          <Text style={styles.finishedLabel}>{scoreMessage}</Text>
          <TouchableOpacity
            style={styles.shareFeedBtn}
            onPress={() => setFeedShareVisible(true)}
            disabled={sharing}
            activeOpacity={0.85}
          >
            {sharing ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <AppIcon androidName="share" iosName="square.and.arrow.up" color="#fff" size={18} />
                <Text style={styles.playAgainText}>Share to Feed</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.playAgainBtn} onPress={startNewRound} disabled={sharing}>
            <AppIcon androidName="replay" iosName="arrow.clockwise" color="#fff" size={18} />
            <Text style={styles.playAgainText}>Play Again</Text>
          </TouchableOpacity>
        </View>
      ) : currentItem ? (
        <View style={styles.gameArea} {...(swipePanHandlers ?? {})}>
          <View style={styles.progressRow}>
            {items.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.progressDot,
                  i < roundIdx && styles.progressDotDone,
                  i === roundIdx && styles.progressDotActive,
                ]}
              />
            ))}
          </View>

          <View style={styles.imageWrap}>
            <Image source={{ uri: imageUrl }} style={styles.quizImage} contentFit="cover" transition={150} />
          </View>

          <Text style={styles.prompt}>What year was this taken?</Text>

          <View style={styles.optionsGrid}>
            {currentItem.options.map((year, optionIndex) => {
              const isSelected = selectedYear === year;
              const isCorrectOption = year === currentItem.correct_year;
              let optionStyle = styles.optionBtn;
              if (answerState !== 'unanswered') {
                if (isCorrectOption) optionStyle = { ...styles.optionBtn, ...styles.optionBtnCorrect };
                else if (isSelected) optionStyle = { ...styles.optionBtn, ...styles.optionBtnWrong };
              }
              return (
                <TouchableOpacity
                  key={`${year}-${optionIndex}`}
                  style={optionStyle}
                  onPress={() => handleSelect(year)}
                  disabled={answerState !== 'unanswered'}
                  activeOpacity={0.85}
                >
                  <Text style={styles.optionText}>{year}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {answerState !== 'unanswered' && (() => {
            const captureDate = formatCaptureDate(currentItem.capture_time);
            return (
              <View style={styles.feedbackRow}>
                <Text style={[styles.feedbackText, answerState === 'correct' ? styles.feedbackCorrect : styles.feedbackWrong]}>
                  {answerState === 'correct' ? 'Correct!' : `It was ${currentItem.correct_year}`}
                </Text>
                {captureDate ? (
                  <Text style={styles.feedbackDate}>{captureDate}</Text>
                ) : null}
                <TouchableOpacity style={styles.nextBtn} onPress={handleNext}>
                  <Text style={styles.nextBtnText}>{roundIdx + 1 >= items.length ? 'See Score' : 'Next'}</Text>
                  <AppIcon androidName="arrow_forward" iosName="arrow.right" color="#000" size={16} />
                </TouchableOpacity>
              </View>
            );
          })()}
        </View>
      ) : null}

      {sharing ? (
        <View style={styles.sharingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.sharingText}>Preparing your result cards…</Text>
        </View>
      ) : null}

      <ShareModal
        visible={feedShareVisible}
        count={items.length + 1}
        colors={colors}
        onClose={() => { if (!sharing) setFeedShareVisible(false); }}
        onSubmit={handleFeedShareSubmit}
      />
    </View>
  );
}

const createStyles = (colors: AppColors, insets: any) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: Math.max(insets.top, 16),
      paddingHorizontal: Spacing.five,
      paddingBottom: Spacing.three,
    },
    closeBtn: {
      width: 36, height: 36, borderRadius: 18,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.12)',
    },
    headerTitle: { color: '#fff', fontSize: TextScale.lg, fontWeight: '800' },
    scorePill: {
      color: '#fff', fontSize: TextScale.sm, fontWeight: '800',
      backgroundColor: 'rgba(255,255,255,0.12)',
      paddingHorizontal: Spacing.three, paddingVertical: 6,
      borderRadius: Radius.full,
      overflow: 'hidden',
    },

    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.six },
    loadingText: { marginTop: Spacing.three, color: 'rgba(255,255,255,0.8)', fontSize: TextScale.sm, fontWeight: '600' },
    errorText: { marginTop: Spacing.three, color: 'rgba(255,255,255,0.85)', fontSize: TextScale.sm, textAlign: 'center', maxWidth: 280, lineHeight: 20 },

    finishedScore: { fontSize: 48, fontWeight: '900', color: '#fff', marginTop: Spacing.four },
    finishedLabel: { fontSize: TextScale.base, color: 'rgba(255,255,255,0.75)', marginTop: Spacing.two, textAlign: 'center' },
    shareFeedBtn: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.25)',
      paddingHorizontal: Spacing.six, paddingVertical: Spacing.three,
      borderRadius: Radius.full,
      marginTop: Spacing.six,
      minWidth: 180,
      justifyContent: 'center',
    },
    playAgainBtn: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
      backgroundColor: colors.primary,
      paddingHorizontal: Spacing.six, paddingVertical: Spacing.three,
      borderRadius: Radius.full,
      marginTop: Spacing.three,
    },
    playAgainText: { color: '#fff', fontWeight: '700', fontSize: TextScale.sm },

    sharingOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: 'rgba(0,0,0,0.72)',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.three,
    },
    sharingText: {
      color: 'rgba(255,255,255,0.9)',
      fontSize: TextScale.sm,
      fontWeight: '600',
    },

    gameArea: { flex: 1, paddingHorizontal: Spacing.five, paddingBottom: Math.max(insets.bottom, 20) + Spacing.two },
    progressRow: { flexDirection: 'row', gap: 6, marginBottom: Spacing.four },
    progressDot: { flex: 1, height: 4, borderRadius: Radius.full, backgroundColor: 'rgba(255,255,255,0.15)' },
    progressDotDone: { backgroundColor: colors.primary },
    progressDotActive: { backgroundColor: 'rgba(255,255,255,0.55)' },

    imageWrap: {
      flex: 1,
      borderRadius: Radius.xl,
      overflow: 'hidden',
      backgroundColor: '#111',
      marginBottom: Spacing.five,
    },
    quizImage: { width: '100%', height: '100%' },

    prompt: { color: '#fff', fontSize: TextScale.base, fontWeight: '700', textAlign: 'center', marginBottom: Spacing.four },

    optionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.three, justifyContent: 'center' },
    optionBtn: {
      width: '46%',
      paddingVertical: Spacing.four,
      borderRadius: Radius.lg,
      backgroundColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.2)',
      alignItems: 'center',
    },
    optionBtnCorrect: { backgroundColor: 'rgba(34,197,94,0.35)', borderColor: '#22c55e' },
    optionBtnWrong: { backgroundColor: 'rgba(239,68,68,0.35)', borderColor: '#ef4444' },
    optionText: { color: '#fff', fontSize: TextScale.lg, fontWeight: '800' },

    feedbackRow: {
      marginTop: Spacing.five,
      alignItems: 'center',
      gap: Spacing.three,
      paddingBottom: insets.bottom + Spacing.four,
    },
    feedbackText: { fontSize: TextScale.base, fontWeight: '700' },
    feedbackCorrect: { color: '#4ade80' },
    feedbackWrong: { color: '#f87171' },
    feedbackDate: { fontSize: TextScale.xs, color: 'rgba(255,255,255,0.6)', fontWeight: '500' },
    nextBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: '#fff',
      paddingHorizontal: Spacing.six, paddingVertical: Spacing.three,
      borderRadius: Radius.full,
    },
    nextBtnText: { color: '#000', fontWeight: '800', fontSize: TextScale.sm },
  });
