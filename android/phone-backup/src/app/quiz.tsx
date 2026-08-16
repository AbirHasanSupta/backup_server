import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, StatusBar, BackHandler } from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppColors, Spacing, Radius, TextScale } from '@/constants/theme';
import { AppIcon } from '@/components/AppIcon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { sanitizeErrorMessage } from '@/utils/errorUtils';
import { getQuizRound, getConfig, buildPreviewUrl } from '../../downloader';

interface QuizItem {
  source_type: string;
  source_id: string;
  relative_path: string;
  correct_year: number;
  options: number[];
}

interface ServerConfig {
  ip: string;
  port: string;
  key: string;
  deviceId: string;
}

type AnswerState = 'unanswered' | 'correct' | 'wrong';

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
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [answerState, setAnswerState] = useState<AnswerState>('unanswered');
  const [finished, setFinished] = useState(false);

  const loadRound = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFinished(false);
    setRoundIdx(0);
    setScore(0);
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
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Fresh round every time this screen gains focus, not just on first mount.
      loadRound();
    }, [loadRound]),
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/memories');
      return true;
    });
    return () => sub.remove();
  }, [router]);

  const currentItem = items[roundIdx] ?? null;
  const imageUrl = currentItem && serverConfig
    ? buildPreviewUrl(serverConfig, currentItem.relative_path, currentItem.source_type, currentItem.source_id)
    : '';

  const handleSelect = (year: number) => {
    if (answerState !== 'unanswered' || !currentItem) return;
    setSelectedYear(year);
    const isCorrect = year === currentItem.correct_year;
    setAnswerState(isCorrect ? 'correct' : 'wrong');
    if (isCorrect) setScore(s => s + 1);
  };

  const handleNext = () => {
    if (roundIdx + 1 >= items.length) {
      setFinished(true);
      return;
    }
    setRoundIdx(i => i + 1);
    setSelectedYear(null);
    setAnswerState('unanswered');
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.replace('/memories')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
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
          <Text style={styles.finishedLabel}>
            {score === items.length ? 'Perfect memory!' : score >= items.length / 2 ? 'Nice work!' : 'Keep playing to sharpen those memories!'}
          </Text>
          <TouchableOpacity style={styles.playAgainBtn} onPress={loadRound}>
            <AppIcon androidName="replay" iosName="arrow.clockwise" color="#fff" size={18} />
            <Text style={styles.playAgainText}>Play Again</Text>
          </TouchableOpacity>
        </View>
      ) : currentItem ? (
        <View style={styles.gameArea}>
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
            {currentItem.options.map((year) => {
              const isSelected = selectedYear === year;
              const isCorrectOption = year === currentItem.correct_year;
              let optionStyle = styles.optionBtn;
              if (answerState !== 'unanswered') {
                if (isCorrectOption) optionStyle = { ...styles.optionBtn, ...styles.optionBtnCorrect };
                else if (isSelected) optionStyle = { ...styles.optionBtn, ...styles.optionBtnWrong };
              }
              return (
                <TouchableOpacity
                  key={year}
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

          {answerState !== 'unanswered' && (
            <View style={styles.feedbackRow}>
              <Text style={[styles.feedbackText, answerState === 'correct' ? styles.feedbackCorrect : styles.feedbackWrong]}>
                {answerState === 'correct' ? 'Correct!' : `It was ${currentItem.correct_year}`}
              </Text>
              <TouchableOpacity style={styles.nextBtn} onPress={handleNext}>
                <Text style={styles.nextBtnText}>{roundIdx + 1 >= items.length ? 'See Score' : 'Next'}</Text>
                <AppIcon androidName="arrow_forward" iosName="arrow.right" color="#000" size={16} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      ) : null}
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
    playAgainBtn: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.two,
      backgroundColor: colors.primary,
      paddingHorizontal: Spacing.six, paddingVertical: Spacing.three,
      borderRadius: Radius.full,
      marginTop: Spacing.six,
    },
    playAgainText: { color: '#fff', fontWeight: '700', fontSize: TextScale.sm },

    gameArea: { flex: 1, paddingHorizontal: Spacing.five, paddingBottom: insets.bottom + Spacing.two },
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
    nextBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: '#fff',
      paddingHorizontal: Spacing.six, paddingVertical: Spacing.three,
      borderRadius: Radius.full,
    },
    nextBtnText: { color: '#000', fontWeight: '800', fontSize: TextScale.sm },
  });