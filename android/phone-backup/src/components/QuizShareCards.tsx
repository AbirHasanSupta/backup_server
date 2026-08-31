import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import ViewShot, { captureRef } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system';

import { AppIcon } from '@/components/AppIcon';
import { Radius, Spacing, TextScale } from '@/constants/theme';

export const QUIZ_CARD_WIDTH = 360;
export const QUIZ_CARD_HEIGHT = 640;

export class QuizCaptureCancelledError extends Error {
  constructor() {
    super('Quiz capture cancelled.');
    this.name = 'QuizCaptureCancelledError';
  }
}

export function isQuizCaptureCancelled(err: unknown): boolean {
  return err instanceof QuizCaptureCancelledError
    || (err instanceof Error && err.message === 'Quiz capture cancelled.');
}

export interface QuizShareItem {
  source_type: string;
  source_id: string;
  relative_path: string;
  correct_year: number;
  capture_time?: number | null;
  options: number[];
}

export interface QuizCaptureSpec {
  kind: 'score' | 'question';
  questionIndex?: number;
  item?: QuizShareItem;
  chosenYear?: number | null;
  imageUrl?: string;
}

interface QuizShareCardsProps {
  score: number;
  total: number;
  scoreMessage: string;
  primaryColor: string;
  spec: QuizCaptureSpec | null;
  shotRef: React.RefObject<React.ElementRef<typeof ViewShot> | null>;
  onQuestionImageLoad?: () => void;
}

function formatCaptureDate(captureTime: number | null | undefined): string {
  if (!captureTime) return '';
  try {
    const d = new Date(captureTime * 1000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

function QuizScoreShareCard({
  score,
  total,
  scoreMessage,
  primaryColor,
}: {
  score: number;
  total: number;
  scoreMessage: string;
  primaryColor: string;
}) {
  return (
    <View style={cardStyles.root} collapsable={false}>
      <View style={cardStyles.header}>
        <Text style={cardStyles.headerTitle}>Guess the Year</Text>
      </View>
      <View style={cardStyles.scoreBody}>
        <AppIcon androidName="emoji_events" iosName="trophy.fill" color={primaryColor} size={56} />
        <Text style={cardStyles.scoreValue}>{score} / {total}</Text>
        <Text style={cardStyles.scoreMessage}>{scoreMessage}</Text>
      </View>
    </View>
  );
}

function QuizQuestionShareCard({
  questionIndex,
  item,
  chosenYear,
  imageUrl,
  onImageLoad,
  onImageError,
}: {
  questionIndex: number;
  item: QuizShareItem;
  chosenYear: number | null | undefined;
  imageUrl: string;
  onImageLoad?: () => void;
  onImageError?: () => void;
}) {
  const captureDate = formatCaptureDate(item.capture_time);
  const wasCorrect = chosenYear === item.correct_year;

  return (
    <View style={cardStyles.root} collapsable={false}>
      <View style={cardStyles.header}>
        <Text style={cardStyles.headerTitle}>Question {questionIndex + 1}</Text>
      </View>
      <View style={cardStyles.imageWrap}>
        <Image
          key={imageUrl}
          source={{ uri: imageUrl }}
          style={cardStyles.image}
          contentFit="cover"
          onLoad={onImageLoad}
          onError={onImageError}
        />
      </View>
      <Text style={cardStyles.prompt}>What year was this taken?</Text>
      <View style={cardStyles.optionsGrid}>
        {item.options.map((year, optionIndex) => {
          const isChosen = chosenYear === year;
          const isCorrect = year === item.correct_year;
          let optionStyle = cardStyles.optionBtn;
          if (isCorrect) optionStyle = { ...cardStyles.optionBtn, ...cardStyles.optionBtnCorrect };
          else if (isChosen) optionStyle = { ...cardStyles.optionBtn, ...cardStyles.optionBtnWrong };
          return (
            <View key={`${year}-${optionIndex}`} style={optionStyle}>
              <Text style={cardStyles.optionText}>{year}</Text>
            </View>
          );
        })}
      </View>
      <View style={cardStyles.feedbackRow}>
        <Text style={[cardStyles.feedbackText, wasCorrect ? cardStyles.feedbackCorrect : cardStyles.feedbackWrong]}>
          {wasCorrect ? 'Correct!' : `It was ${item.correct_year}`}
        </Text>
        {captureDate ? <Text style={cardStyles.feedbackDate}>{captureDate}</Text> : null}
      </View>
    </View>
  );
}

export function QuizShareCaptureView({
  score,
  total,
  scoreMessage,
  primaryColor,
  spec,
  shotRef,
  onQuestionImageLoad,
}: QuizShareCardsProps) {
  return (
    <View style={captureStyles.offscreen} pointerEvents="none" collapsable={false}>
      <ViewShot ref={shotRef} options={{ format: 'png', quality: 0.92 }} style={captureStyles.shot}>
        {spec?.kind === 'score' ? (
          <QuizScoreShareCard score={score} total={total} scoreMessage={scoreMessage} primaryColor={primaryColor} />
        ) : null}
        {spec?.kind === 'question' && spec.item && spec.imageUrl ? (
          <QuizQuestionShareCard
            key={`${spec.questionIndex ?? 0}-${spec.imageUrl}`}
            questionIndex={spec.questionIndex ?? 0}
            item={spec.item}
            chosenYear={spec.chosenYear}
            imageUrl={spec.imageUrl}
            onImageLoad={onQuestionImageLoad}
            onImageError={onQuestionImageLoad}
          />
        ) : null}
      </ViewShot>
    </View>
  );
}

async function cleanupCaptureUris(uris: string[]) {
  for (const uri of uris) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}

export function useQuizCardCapture() {
  const shotRef = useRef<React.ElementRef<typeof ViewShot>>(null);
  const [spec, setSpec] = useState<QuizCaptureSpec | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const pendingRef = useRef<{
    specs: QuizCaptureSpec[];
    index: number;
    results: string[];
    resolve: (uris: string[]) => void;
    reject: (err: Error) => void;
    generation: number;
  } | null>(null);
  const generationRef = useRef(0);

  const rejectPending = useCallback(async (err: Error) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    generationRef.current += 1;
    setSpec(null);
    setImageReady(false);
    if (pending) {
      await cleanupCaptureUris(pending.results);
      pending.reject(err);
    }
  }, []);

  const onQuestionImageLoad = useCallback(() => {
    setImageReady(true);
  }, []);

  useEffect(() => {
    if (!spec || spec.kind !== 'question' || imageReady) return;
    const timeout = setTimeout(() => {
      setImageReady(true);
    }, 8000);
    return () => clearTimeout(timeout);
  }, [spec, imageReady]);

  useEffect(() => {
    if (!spec || !pendingRef.current || !imageReady) return;

    const generation = pendingRef.current.generation;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        if (!shotRef.current) throw new Error('Capture view not ready');
        const uri = await captureRef(shotRef, { format: 'png', quality: 0.92 });
        if (cancelled || generation !== generationRef.current) {
          await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          return;
        }

        const pending = pendingRef.current;
        if (!pending || pending.generation !== generation) {
          await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          return;
        }

        const nextResults = [...pending.results, uri];
        const nextIndex = pending.index + 1;
        if (nextIndex < pending.specs.length) {
          const nextSpec = pending.specs[nextIndex];
          pendingRef.current = { ...pending, index: nextIndex, results: nextResults };
          setImageReady(nextSpec.kind === 'score');
          setSpec(nextSpec);
        } else {
          pending.resolve(nextResults);
          pendingRef.current = null;
          setSpec(null);
          setImageReady(false);
        }
      } catch (err: unknown) {
        if (!cancelled && generation === generationRef.current) {
          await rejectPending(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }, spec.kind === 'score' ? 120 : 80);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spec, imageReady, rejectPending]);

  const captureCards = useMemo(
    () => (specs: QuizCaptureSpec[]) =>
      new Promise<string[]>((resolve, reject) => {
        if (!specs.length) {
          resolve([]);
          return;
        }
        if (pendingRef.current) {
          reject(new Error('A quiz capture is already in progress.'));
          return;
        }
        const generation = generationRef.current;
        pendingRef.current = { specs, index: 0, results: [], resolve, reject, generation };
        const firstSpec = specs[0];
        setImageReady(firstSpec.kind === 'score');
        setSpec(firstSpec);
      }),
    [],
  );

  const cancelCapture = useCallback(() => {
    void rejectPending(new QuizCaptureCancelledError());
  }, [rejectPending]);

  return { shotRef, spec, captureCards, cancelCapture, onQuestionImageLoad };
}

const captureStyles = StyleSheet.create({
  offscreen: {
    position: 'absolute',
    left: -10000,
    top: 0,
    width: QUIZ_CARD_WIDTH,
    height: QUIZ_CARD_HEIGHT,
    opacity: 0.01,
  },
  shot: {
    width: QUIZ_CARD_WIDTH,
    height: QUIZ_CARD_HEIGHT,
    backgroundColor: '#000',
  },
});

const cardStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    paddingHorizontal: Spacing.five,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.four,
  },
  header: {
    alignItems: 'center',
    marginBottom: Spacing.four,
  },
  headerTitle: {
    color: '#fff',
    fontSize: TextScale.lg,
    fontWeight: '800',
  },
  scoreBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  scoreValue: {
    fontSize: 48,
    fontWeight: '900',
    color: '#fff',
  },
  scoreMessage: {
    fontSize: TextScale.base,
    color: 'rgba(255,255,255,0.75)',
    textAlign: 'center',
    paddingHorizontal: Spacing.four,
  },
  imageWrap: {
    flex: 1,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    backgroundColor: '#111',
    marginBottom: Spacing.four,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  prompt: {
    color: '#fff',
    fontSize: TextScale.base,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: Spacing.three,
  },
  optionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
    justifyContent: 'center',
  },
  optionBtn: {
    width: '46%',
    paddingVertical: Spacing.three,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
  },
  optionBtnCorrect: {
    backgroundColor: 'rgba(34,197,94,0.35)',
    borderColor: '#22c55e',
  },
  optionBtnWrong: {
    backgroundColor: 'rgba(239,68,68,0.35)',
    borderColor: '#ef4444',
  },
  optionText: {
    color: '#fff',
    fontSize: TextScale.lg,
    fontWeight: '800',
  },
  feedbackRow: {
    marginTop: Spacing.four,
    alignItems: 'center',
    gap: Spacing.two,
  },
  feedbackText: {
    fontSize: TextScale.base,
    fontWeight: '700',
  },
  feedbackCorrect: {
    color: '#4ade80',
  },
  feedbackWrong: {
    color: '#f87171',
  },
  feedbackDate: {
    fontSize: TextScale.xs,
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '500',
  },
});
