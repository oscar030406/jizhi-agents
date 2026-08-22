'use client';

import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { annotate } from 'rough-notation';
import {
  PieChart,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ChevronRight,
  Check,
  BookOpenText,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { createLogger } from '@/lib/logger';

const log = createLogger('QuizView');
import type { QuizQuestion } from '@/lib/types/stage';
import { SpeechButton } from '@/components/audio/speech-button';
import { AdaptiveDecisionBanner } from '@/components/scene-renderers/adaptive-decision-banner';
import type { AdaptiveDecision } from '@/app/api/adaptive/quiz-decision/route';
import { useStageStore } from '@/lib/store/stage';
import { useInteractionProgress } from '@/lib/store/interaction-progress';
import {
  generateRemediationScene,
  type RemediationPhase,
} from '@/lib/hooks/use-scene-generator';
import { gradeChoiceQuestions, isShortAnswer, type QuestionResult } from '@/lib/quiz/grading';
import { renderQuizMathText } from '@/lib/quiz/math-text';
import { writeDraftRecovery } from '@/lib/quiz/persistence';
import {
  createQuizAttemptWriter,
  loadQuizAttemptState,
  QuizRetryProgressedError,
  type QuizAttemptWriter,
} from '@/lib/quiz/runtime';
import {
  createQuizViewLifetime,
  isQuizRuntimeReady,
  persistQuizReview,
  persistQuizRetry,
  persistQuizSubmission,
  quizViewStateFromAttempt,
  runQuizPersistenceTransition,
  type QuizRuntimeGate,
  type QuizViewLifetime,
} from '@/lib/quiz/view-state';

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = 'not_started' | 'answering' | 'submitting' | 'grading' | 'reviewing';

interface QuizViewProps {
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
  readonly stageId: string;
  /** 场景标题当概念键用：一个 quiz 场景一个主题，低分场景=薄弱主题。 */
  readonly sceneTitle?: string;
  /**
   * 场景切换闸门（PlaybackChromeRoot 的 gatedSceneSwitch，经 CanvasArea → SceneRenderer 传下来）。
   * 「跳转过去」必须走它：直连 store 会绕开 endActiveSession，讨论会话还开着就翻页。
   */
  readonly onRequestSceneSwitch?: (sceneId: string) => Promise<boolean>;
}

const QuizMathText = memo(function QuizMathText({
  text,
  className,
  allowDisplayMode = false,
}: {
  text: string;
  className?: string;
  allowDisplayMode?: boolean;
}) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{segments[0].value}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              allowDisplayMode && segment.displayMode
                ? 'block my-1 overflow-x-auto [&_.katex-display]:!my-0'
                : 'inline-block align-baseline [&_.katex-display]:!my-0',
            )}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </span>
  );
});

/** Call /api/quiz-grade for a single short-answer question. */
async function gradeShortAnswerQuestion(
  q: QuizQuestion,
  userAnswer: string,
  language: string,
): Promise<QuestionResult> {
  const pts = q.points ?? 1;
  try {
    const modelConfig = getCurrentModelConfig();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
    };
    if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
    if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;

    const res = await fetch('/api/quiz-grade', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        question: q.question,
        userAnswer,
        points: pts,
        commentPrompt: q.commentPrompt,
        language,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { score: number; comment: string };
    const earned = Math.max(0, Math.min(pts, data.score));
    return {
      questionId: q.id,
      correct: earned >= pts * 0.8,
      status: earned >= pts * 0.8 ? 'correct' : 'incorrect',
      earned,
      aiComment: data.comment,
    };
  } catch (err) {
    log.error('[quiz-view] AI grading failed for', q.id, err);
    // Fallback: give half credit
    return {
      questionId: q.id,
      correct: null,
      status: 'incorrect',
      earned: Math.round(pts * 0.5),
      aiComment:
        language === 'zh-CN'
          ? '评分服务暂时不可用，已给予基础分。'
          : 'Grading service unavailable. Base score given.',
    };
  }
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function QuizCover({
  questionCount,
  totalPoints,
  onStart,
}: {
  questionCount: number;
  totalPoints: number;
  onStart: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-6 opacity-[0.03]">
        <PieChart className="w-52 h-52 text-violet-500" />
      </div>
      <div className="absolute bottom-0 left-0 p-6 opacity-[0.02]">
        <BookOpenText className="w-40 h-40 text-violet-500 rotate-12" />
      </div>

      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        className="w-16 h-16 bg-purple-soft rounded-2xl flex items-center justify-center shadow-card ring-1 ring-purple-deep/20"
      >
        <PieChart className="w-8 h-8 text-violet-500" />
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="text-center z-10"
      >
        <h3 className="text-xl font-bold text-foreground">{t('quiz.title')}</h3>
        <p className="text-sm text-muted-foreground mt-1">{t('quiz.subtitle')}</p>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="flex gap-5 text-sm z-10"
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <BookOpenText className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {questionCount} {t('quiz.questionsCount')}
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <PieChart className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {t('quiz.totalPrefix')} {totalPoints} {t('quiz.pointsSuffix')}
          </span>
        </div>
      </motion.div>

      <motion.button
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        whileTap={{ scale: 0.97 }}
        onClick={onStart}
        className="mt-1 px-8 py-2.5 bg-primary text-primary-foreground rounded-full font-medium shadow-card hover:bg-primary/90 transition-colors z-10 flex items-center gap-2"
      >
        {t('quiz.startQuiz')}
        <ChevronRight className="w-4 h-4" />
      </motion.button>
    </div>
  );
}

function SingleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;

  return (
    <QuestionCard question={question} index={index} result={result}>
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const selected = value === opt.value;
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong = isReview && selected && result?.status === 'incorrect';

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                // Default state
                !isReview &&
                  !selected &&
                  'border-border hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  selected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                // Review states — 答错去红（规格3.2.3⑤⑧）：错选项走中性 muted，不弹红
                isReview && isCorrectOpt && 'border-green-solid/40 bg-green-soft',
                isReview && isWrong && !isCorrectOpt && 'border-border bg-muted',
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  'border-border-subtle opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !selected &&
                    'bg-muted text-muted-foreground',
                  !isReview && selected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-green-solid text-white',
                  isReview && isWrong && !isCorrectOpt && 'bg-muted-foreground/60 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    'bg-muted text-muted-foreground/70',
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !selected && 'text-muted-foreground/70',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-green-solid shrink-0 animate-[check-pop_250ms_var(--ease-out-quad)]" />
              )}
              {isReview && isWrong && !isCorrectOpt && (
                <XCircle className="w-5 h-5 text-muted-foreground/70 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MultipleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const selected = value ?? [];

  const toggle = (optValue: string) => {
    if (disabled) return;
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue));
    } else {
      onChange([...selected, optValue]);
    }
  };

  const { t } = useI18n();

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview && (
        <p className="text-xs text-muted-foreground mb-2">
          {t('quiz.multipleChoiceHint')}
        </p>
      )}
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const isSelected = selected.includes(opt.value);
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong = isReview && isSelected && !isCorrectOpt;

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                !isReview &&
                  !isSelected &&
                  'border-border hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  isSelected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                isReview && isCorrectOpt && 'border-green-solid/40 bg-green-soft',
                isReview && isWrong && 'border-border bg-muted',
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  'border-border-subtle opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !isSelected &&
                    'bg-muted text-muted-foreground',
                  !isReview && isSelected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-green-solid text-white',
                  isReview && isWrong && 'bg-muted-foreground/60 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    'bg-muted text-muted-foreground/70',
                )}
              >
                {!isReview && isSelected ? <Check className="w-3.5 h-3.5" /> : opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !isSelected && 'text-muted-foreground/70',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-green-solid shrink-0 animate-[check-pop_250ms_var(--ease-out-quad)]" />
              )}
              {isReview && isWrong && (
                <XCircle className="w-5 h-5 text-muted-foreground/70 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function ShortAnswerQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const { t } = useI18n();
  // Ref to track latest value for voice transcription append
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview ? (
        <div className="relative">
          <textarea
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={t('quiz.inputPlaceholder')}
            className="w-full min-h-[100px] p-3 pb-10 rounded-xl border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-all disabled:bg-muted disabled:text-muted-foreground dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
          />
          <SpeechButton
            size="sm"
            disabled={disabled}
            className="absolute bottom-3 left-3"
            onTranscription={(text) => {
              const cur = valueRef.current ?? '';
              onChange(cur + (cur ? ' ' : '') + text);
            }}
          />
          <span className="absolute bottom-3 right-3 text-xs text-muted-foreground/60">
            {(value ?? '').length} {t('quiz.charCount')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-muted border border-border-subtle text-sm text-foreground">
            <p className="text-xs text-muted-foreground mb-1">{t('quiz.yourAnswer')}</p>
            {value ? (
              <QuizMathText text={value} />
            ) : (
              <span className="text-muted-foreground italic">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          {result.aiComment && (
            /* AI 生成内容统一 blue-soft 标识（规格3.2.7⑦③） */
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-soft border border-blue-deep/20">
              <Sparkles className="w-4 h-4 text-blue-deep shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-blue-deep mb-0.5">
                  {t('quiz.aiComment')}
                </p>
                <p className="text-xs text-blue-deep/80">
                  <QuizMathText text={result.aiComment} />
                </p>
              </div>
              <span className="ml-auto text-xs font-bold text-blue-deep shrink-0">
                {result.earned}/{question.points ?? 1}
                {t('quiz.pointsSuffix')}
              </span>
            </div>
          )}
        </div>
      )}
    </QuestionCard>
  );
}

function QuestionCard({
  question,
  index,
  result,
  children,
}: {
  question: QuizQuestion;
  index: number;
  result?: QuestionResult;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const pts = question.points ?? 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        'bg-card rounded-2xl border p-5 relative overflow-hidden shadow-card',
        !isReview && 'border-border-subtle',
        // 答错反馈中性化（规格3.2.3⑤⑧）：不弹红，muted 语气
        isReview && result.status === 'correct' && 'border-green-solid/30',
        isReview && result.status === 'incorrect' && 'border-border',
      )}
    >
      {/* Left accent */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl',
          !isReview && 'bg-violet-400',
          isReview && result.status === 'correct' && 'bg-green-solid',
          isReview && result.status === 'incorrect' && 'bg-muted-foreground/30',
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0',
              !isReview &&
                'bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400',
              isReview && result.status === 'correct' && 'bg-green-soft text-green-deep',
              isReview && result.status === 'incorrect' && 'bg-muted text-muted-foreground',
            )}
          >
            {index + 1}
          </span>
          <div>
            <div className="text-sm font-medium text-foreground leading-relaxed">
              <QuizMathText text={question.question} allowDisplayMode />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {question.type === 'single'
                ? t('quiz.singleChoice')
                : question.type === 'multiple'
                  ? t('quiz.multipleChoice')
                  : t('quiz.shortAnswer')}
              {' · '}
              {pts} {t('quiz.pointsSuffix')}
            </p>
          </div>
        </div>
        {isReview && (
          <div className="shrink-0 ml-2">
            {/* L1 庆祝：答对绿勾微弹跳 <300ms 纯 CSS（规格3.2.5②） */}
            {result.status === 'correct' && (
              <CheckCircle2 className="w-6 h-6 text-green-solid animate-[check-pop_250ms_var(--ease-out-quad)]" />
            )}
            {/* 答错：「再想想」150ms slide-up，中性徽章（规格3.2.3⑤） */}
            {result.status === 'incorrect' && (
              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground animate-[slide-up-fade_150ms_var(--ease-out-quad)]">
                {t('quiz.thinkAgain')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {children}

      {/* Analysis (review only) */}
      {isReview && question.analysis && (
        <div className="mt-3 p-3 rounded-lg bg-blue-soft border border-blue-deep/20 text-sm text-blue-deep leading-relaxed">
          <span className="font-medium">{t('quiz.analysis')}</span>
          <QuizMathText text={question.analysis} allowDisplayMode />
        </div>
      )}
    </motion.div>
  );
}

function ScoreBanner({
  score,
  total,
  results,
}: {
  score: number;
  total: number;
  results: QuestionResult[];
}) {
  const { t } = useI18n();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const correctCount = results.filter((r) => r.status === 'correct').length;
  const incorrectCount = results.filter((r) => r.status === 'incorrect').length;

  // 饱和色只做小面积信号，卡片底走 soft 粉彩（规格③⑲）；
  // 低分档不弹红——薄弱是待办不是罪状（规格⑧），走 yellow-soft。
  const tier =
    pct >= 80
      ? {
          card: 'bg-green-soft border-green-deep/20',
          heading: 'text-green-deep',
          stroke: 'var(--green-solid)',
          text: t('quiz.excellent'),
        }
      : pct >= 60
        ? {
            card: 'bg-yellow-soft border-yellow-deep/20',
            heading: 'text-yellow-deep',
            stroke: 'var(--yellow-deep)',
            text: t('quiz.keepGoing'),
          }
        : {
            card: 'bg-yellow-soft border-yellow-deep/20',
            heading: 'text-yellow-deep',
            stroke: 'var(--yellow-deep)',
            text: t('quiz.needsReview'),
          };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn('rounded-2xl p-6 border shadow-card', tier.card)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-start gap-3">
          {/* 阿问答对/答错两态（E5）：≥60% 竖拇指，低于走「再想想」愁容。
              情绪帧不是装饰——判分反馈的第一眼是表情不是数字（参照灵伴 happy/sorry）。 */}
          <img
            src={pct >= 60 ? '/agents/awen-glad.png' : '/agents/awen-sorry.png'}
            alt={pct >= 60 ? '阿问：答得不错' : '阿问：再想想'}
            className="mt-0.5 hidden size-16 shrink-0 select-none sm:block"
            draggable={false}
          />
          <div>
          <p className={cn('text-sm font-medium', tier.heading)}>{tier.text}</p>
          <div className="flex items-baseline gap-1 mt-1 text-foreground">
            <span className="text-4xl font-black">{score}</span>
            <span className="text-muted-foreground text-lg">/ {total}</span>
          </div>
          <div className="flex gap-3 mt-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-solid" /> {correctCount}{' '}
              {t('quiz.correct')}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {incorrectCount} {t('quiz.incorrect')}
            </span>
          </div>
          </div>
        </div>

        {/* Percentage ring */}
        <div className="relative w-20 h-20">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="var(--border)"
              strokeWidth="6"
            />
            <motion.circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke={tier.stroke}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - pct / 100) }}
              transition={{ duration: 0.3, ease: 'easeOut', delay: 0.2 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-black text-foreground">{pct}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * 鼓励卡（规格3.2.4⑧⑫）：一次提交错 ≥2 题时出现。yellow-soft 底 +
 * rough-notation 手绘圈注关键提示词，降阶提示文案，不给答案。
 */
function EncouragementCard() {
  const { t } = useI18n();
  const keyPhraseRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = keyPhraseRef.current;
    if (!el) return;
    const annotation = annotate(el, {
      type: 'circle',
      color: 'var(--yellow-deep)',
      strokeWidth: 2,
      padding: 4,
      animationDuration: 600,
    });
    annotation.show();
    return () => annotation.remove();
  }, []);

  return (
    <div className="rounded-2xl border border-yellow-deep/20 bg-yellow-soft p-5 animate-[slide-up-fade_150ms_var(--ease-out-quad)]">
      <p className="text-base leading-relaxed text-foreground">
        {t('quiz.encourage.prefix')}
        <span ref={keyPhraseRef} className="mx-1 font-medium text-yellow-deep">
          {t('quiz.encourage.keyPhrase')}
        </span>
        {t('quiz.encourage.suffix')}
      </p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {t('quiz.encourage.note')}
      </p>
    </div>
  );
}

/** L2 小节完成庆祝（规格3.2.5②）：20 个 CSS 粒子粉彩纸屑，~1s，纯 CSS 动画。 */
const CONFETTI_PASTELS = [
  'var(--purple-deep)',
  'var(--blue-deep)',
  'var(--green-solid)',
  'var(--yellow-deep)',
  'var(--purple-soft)',
];

function PastelConfetti() {
  const particles = useMemo(
    () =>
      Array.from({ length: 20 }, (_, i) => ({
        id: i,
        left: 8 + Math.random() * 84,
        x: (Math.random() - 0.5) * 120,
        y: 120 + Math.random() * 160,
        r: (Math.random() - 0.5) * 720,
        size: 5 + Math.random() * 5,
        delay: Math.random() * 0.15,
        color: CONFETTI_PASTELS[i % CONFETTI_PASTELS.length],
        round: Math.random() > 0.7,
      })),
    [],
  );

  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0 z-10">
      {particles.map((p) => (
        <span
          key={p.id}
          className="absolute block animate-[confetti-drop_1s_var(--ease-out-quad)_forwards]"
          style={
            {
              left: `${p.left}%`,
              top: 0,
              width: p.size,
              height: p.round ? p.size : p.size * 0.45,
              backgroundColor: p.color,
              borderRadius: p.round ? '50%' : 2,
              animationDelay: `${p.delay}s`,
              opacity: 0,
              '--cf-x': `${p.x}px`,
              '--cf-y': `${p.y}px`,
              '--cf-r': `${p.r}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function QuizView({
  questions,
  sceneId,
  stageId,
  sceneTitle,
  onRequestSceneSwitch,
}: QuizViewProps) {
  const { t, locale } = useI18n();

  const [phase, setPhase] = useState<Phase>('not_started');
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [results, setResults] = useState<QuestionResult[]>([]);
  /** Routing decision from the feedback-decision agent; null until graded / when engine is offline. */
  const [adaptiveDecision, setAdaptiveDecision] = useState<AdaptiveDecision | null>(null);
  // 交卷时自报把握度（1-5）；null=未采集，原样不传给决策引擎
  const [confidence, setConfidence] = useState<number | null>(null);
  // 决策桥失联标记：204/网络错时置真，reviewing 面板如实提示（不再静默）
  const [decisionFailed, setDecisionFailed] = useState(false);
  /** Remediation execution state — the decision only counts if acting on it changes the deck. */
  const [acting, setActing] = useState(false);
  const [remediationError, setRemediationError] = useState<string | null>(null);
  /** 补救链当前跑到哪一步（规划→正文→审核→讲稿→插入）。null=没在跑。 */
  const [remediationPhase, setRemediationPhase] = useState<RemediationPhase | null>(null);
  const [insertedSceneId, setInsertedSceneId] = useState<string | null>(null);
  const [runtimeGate, setRuntimeGate] = useState<QuizRuntimeGate>({ status: 'loading' });
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const viewLifetimeRef = useRef<QuizViewLifetime | null>(null);
  viewLifetimeRef.current ??= createQuizViewLifetime();
  const viewLifetime = viewLifetimeRef.current;
  // 答题耗时信号（SAINT+ 实证 elapsed time 对掌握度预测有增益，arXiv 2010.12042）：
  // 挂载即计时，交卷时用于「答对但吃力」的掌握度降权。只影响 EMA 不影响判分展示。
  const quizStartedAtRef = useRef(Date.now());
  const runtimeWriterRef = useRef<QuizAttemptWriter | null>(null);
  runtimeWriterRef.current ??= createQuizAttemptWriter({
    onError: (error) => log.warn('Failed to persist quiz runtime:', error),
  });
  const runtimeWriter = runtimeWriterRef.current;

  useEffect(() => {
    return () => {
      void runtimeWriter.flushDraft();
    };
  }, [runtimeWriter]);

  useEffect(() => {
    let cancelled = false;
    setRuntimeGate({ status: 'loading' });
    setRetrying(false);
    void loadQuizAttemptState({ stageId, sceneId })
      .then(({ attemptId: nextAttemptId, state }) => {
        if (cancelled) return;
        const next = quizViewStateFromAttempt(state);
        setPhase(next.phase);
        setAnswers(next.answers);
        setResults(next.results);
        setRuntimeGate({ status: 'ready', attemptId: nextAttemptId });
      })
      .catch((error) => {
        log.warn('Failed to hydrate quiz runtime:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
      });
    return () => {
      cancelled = true;
      viewLifetime.invalidate();
      void runtimeWriter.flushDraft();
    };
  }, [hydrationVersion, runtimeWriter, sceneId, stageId, viewLifetime]);

  const attemptId = isQuizRuntimeReady(runtimeGate) ? runtimeGate.attemptId : null;

  // 分段进度（规格3.2.2⑤）：一交卷（对错都算）该互动段就点亮，永不回退。
  // 水合到 reviewing 的历史 attempt 也会补标，保证刷新后计数不丢。
  useEffect(() => {
    if (phase === 'reviewing') {
      useInteractionProgress.getState().markDone(sceneId);
    }
  }, [phase, sceneId]);

  // L2 小节完成庆祝的一次性触发：进入 reviewing 时燃放 ~1s 后清场。
  const [celebrationBurst, setCelebrationBurst] = useState(false);
  useEffect(() => {
    if (!celebrationBurst) return;
    const timer = setTimeout(() => setCelebrationBurst(false), 1300);
    return () => clearTimeout(timer);
  }, [celebrationBurst]);

  const totalPoints = useMemo(
    () => questions.reduce((sum, q) => sum + (q.points ?? 1), 0),
    [questions],
  );

  const allAnswered = useMemo(() => {
    // `every` on an empty list is true: a 0 题的测验场景会让交卷按钮直接可点，
    // 交出去就是一条 answers 为空的 reviewed —— 和 2026-08-11 那个「没答过却看到
    // 0/N 答题报告」是同一条坏事实，只是另一个产地。没有题就不许交卷。
    if (questions.length === 0) return false;
    return questions.every((q) => {
      const a = answers[q.id];
      if (!a) return false;
      if (Array.isArray(a)) return a.length > 0;
      return (a as string).trim().length > 0;
    });
  }, [questions, answers]);

  const handleSetAnswer = useCallback(
    (questionId: string, value: string | string[]) => {
      setAnswers((prev) => {
        const next = { ...prev, [questionId]: value };
        if (attemptId) {
          writeDraftRecovery(sceneId, attemptId, next);
          runtimeWriter.scheduleDraft({
            stageId,
            sceneId,
            attemptId,
            answers: next,
          });
        }
        return next;
      });
    },
    [attemptId, runtimeWriter, sceneId, stageId],
  );

  const handleSubmit = useCallback(async () => {
    if (!attemptId) return;
    setPhase('submitting');
    await runQuizPersistenceTransition(
      () => persistQuizSubmission({ stageId, sceneId, attemptId, answers }, runtimeWriter),
      viewLifetime,
      () => setPhase('grading'),
      (error) => {
        log.warn('Failed to persist quiz submission:', error);
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, answers, runtimeWriter, sceneId, stageId, viewLifetime]);

  // When entering grading phase, grade choice questions locally + call API for short-answer
  useEffect(() => {
    if (phase !== 'grading') return;
    let cancelled = false;

    (async () => {
      // 1. Grade choice questions locally (instant)
      const choiceResults = gradeChoiceQuestions(questions, answers);

      // 2. Grade short-answer questions via AI API (parallel)
      const shortAnswerQs = questions.filter(isShortAnswer);
      const aiResults = await Promise.all(
        shortAnswerQs.map((q) =>
          gradeShortAnswerQuestion(q, (answers[q.id] as string) ?? '', locale),
        ),
      );

      if (cancelled) return;

      // 3. Merge results in original question order
      const allResultsMap = new Map<string, QuestionResult>();
      for (const r of [...choiceResults, ...aiResults]) {
        allResultsMap.set(r.questionId, r);
      }
      const ordered = questions.map((q) => allResultsMap.get(q.id)!).filter(Boolean);

      if (!attemptId) {
        setRuntimeGate({ status: 'error' });
        return;
      }
      try {
        await persistQuizReview(
          { stageId, sceneId, attemptId, answers, results: ordered },
          runtimeWriter,
        );
      } catch (error) {
        log.warn('Failed to persist quiz review:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
        return;
      }
      if (cancelled) return;
      setResults(ordered);
      setPhase('reviewing');
      // L2 庆祝：小节（quiz 场景）完成 → 20 粒 CSS 粉彩纸屑 ~1s（规格3.2.5②）
      setCelebrationBurst(true);

      // 履历落盘，然后由履历重算画像。
      //
      // ⚠️ 2026-08-13 改写这段注释：原文写的是「只写证据流，不碰画像——画像仍走
      // conceptMastery 那条旧路，两轨并行，等 fold 就位再切」。那是接 fold 之前的状态，
      // 现在下面第 1015 行就调 refreshDerivedProfile 重算并写回 conceptMastery，
      // 注释和代码打架，照注释理解会以为画像还是就地 EMA 改写的。
      // 现状是设计稿 §4.1 的口径：**画像 = fold(履历)**，纯函数、幂等、可重放。
      //
      // 为什么现在就接：履历只能从开始记的那天起攒。等题目粒度的知识点标注就位
      // （要词表，管理者那条路的产物）再接，中间这段的轨迹就永远是空的。
      // 现在写进去的是场景级 item-level 证据，细粒度就位后新证据自然变 per-kc，
      // 旧的留在账本里不用迁移——「证据只追加、永不丢弃」的用处正在这里。
      void (async () => {
        try {
          const { appendEvidence, evidenceFor, readLedger, LEGACY_DOMAIN } = await import(
            '@/lib/evidence'
          );
          const { quizEvidenceDraft } = await import('@/lib/evidence/from-quiz');
          const { getLearnerKey } = await import('@/lib/runtime/learner-key');
          const { learnerDomain, refreshDerivedProfile } = await import(
            '@/lib/evidence/profile-bridge'
          );
          const learnerKey = await getLearnerKey();
          // 领域取画像里录的那个（ai / manufacturing / industrial-internet / software），
          // 掌握度才分得开域。课程本身不带领域字段，画像是唯一拿得到的来源。
          // 取不到时 quizEvidenceDraft 兜到 LEGACY_DOMAIN，与旧证据归同一个桶。
          const domain = learnerDomain();
          const measured = {
            kind: 'concept' as const,
            domain: domain ?? LEGACY_DOMAIN,
            concept: (sceneTitle ?? '').trim(),
          };
          const ledger = await readLedger({ learnerKey });
          const prior = evidenceFor(ledger, measured);
          const lastAt = prior.at(-1)?.source.at;
          const draft = quizEvidenceDraft({
            learnerKey,
            interactionId: attemptId,
            sceneId,
            sceneTitle: sceneTitle ?? '',
            ...(domain ? { domain } : {}),
            questions: questions.map((q) => ({
              id: q.id,
              prompt: q.question ?? q.id,
              points: q.points,
            })),
            results: ordered,
            at: new Date().toISOString(),
            priorEncounters: prior.length,
            // **逐题**耗时（整卷/题数）。权重层按它做「答对但吃力」降权
            // （`SLOW_RESPONSE_MS`），所以这个数必须是逐题的，不是整卷的。
            elapsedMs: Math.round(
              (Date.now() - quizStartedAtRef.current) / Math.max(1, questions.length),
            ),
            ...(lastAt ? { sinceLastMs: Date.now() - new Date(lastAt).getTime() } : {}),
          });
          if (draft) await appendEvidence(draft, { learnerKey });
          // 画像 = fold(履历)：写完证据立刻重算。**幂等**，跑几次都一样。
          await refreshDerivedProfile({ learnerKey });

          // 错题进错题本（DeepTutor Question Bank 提炼）：answer/analysis 作答时
          // 不展示，答错后连同学习者答案存进去，学情报告错题本块回放。
          // 存失败不拦流程——上面的证据已落，这里只是少一条回放记录。
          try {
            const { appendMistakes } = await import('@/lib/evidence/mistake-bank');
            const at = new Date().toISOString();
            const byId = new Map(questions.map((q) => [q.id, q]));
            appendMistakes(
              ordered
                .filter((r) => r.status !== 'correct')
                .flatMap((r) => {
                  const q = byId.get(r.questionId);
                  if (!q) return [];
                  const ua = answers[q.id];
                  return [
                    {
                      at,
                      sceneId,
                      sceneTitle: sceneTitle ?? '',
                      // 与证据同一个域来源——换库后错题本才分得开桶（联动清单 C2）
                      ...(domain ? { domain } : {}),
                      questionId: q.id,
                      prompt: q.question ?? q.id,
                      analysis: q.analysis ?? '',
                      userAnswer: Array.isArray(ua) ? ua.join('、') : (ua ?? ''),
                      correctAnswer: (q.answer ?? []).join('、'),
                      answered: r.answered ?? Boolean(Array.isArray(ua) ? ua.length : ua),
                    },
                  ];
                }),
            );
          } catch (error) {
            log.warn('Failed to record mistakes:', error);
          }
        } catch (error) {
          // 履历写失败不能拦交卷——成绩已经落盘了，这里只是少记一条轨迹。
          log.warn('Failed to append quiz evidence:', error);
        }
      })();

      // Decision agent: score → 降维解释 / 补充练习 / 进阶挑战 / 保持路线.
      // Fire-and-forget; a 204 (engine offline) simply leaves the banner hidden.
      // Same denominator the score banner shows (`points ?? 1` — an unscored
      // question is worth 1, not 0). Summing with `?? 0` made every point-less
      // quiz report a score of 0 and the agent always answered 降维解释, next to
      // a banner reading 正确率 100%.
      // ⚠️ 这里**不能**用上面那个 `cancelled`。本 effect 的依赖里有 `phase`，而三行前
      // 刚 `setPhase('reviewing')`——React 会立刻跑本 effect 的 cleanup 把 `cancelled`
      // 置真。决策请求十几秒后才回来，那时 `!cancelled` 已经不成立，成功与失败两条分支
      // 一起被吞：接口 200 带完整决策，横幅却永不出现（2026-08-15 摸底 §2.4，2/2 复现）。
      // 改用 viewLifetime：它只在换场景/重新水合/卸载时 invalidate，正是「这次交卷的结果
      // 还该不该落到界面上」的正确寿命。
      const decisionToken = viewLifetime.capture();
      const decisionLive = () => viewLifetime.isCurrent(decisionToken);
      const earned = ordered.reduce((sum, r) => sum + r.earned, 0);
      const quizScore = totalPoints > 0 ? earned / totalPoints : 0;
      // 画像里的当前难度（上一次决策写回的）；没有就让引擎用默认 L2。
      // conceptScores 用场景标题当键——一个 quiz 场景一个主题，题目粒度的概念标签
      // 生成端还不产出，场景粒度是当前诚实能给的最细粒度。
      let currentDifficulty: string | undefined;
      try {
        const stored = JSON.parse(localStorage.getItem('learnerProfile') ?? 'null');
        if (stored && typeof stored.currentDifficulty === 'string') {
          currentDifficulty = stored.currentDifficulty;
        }
      } catch {
        /* 画像损坏不拦交卷 */
      }
      void fetch('/api/adaptive/quiz-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quizScore,
          currentDifficulty,
          conceptScores: sceneTitle ? { [sceneTitle]: quizScore } : {},
          ...(confidence != null ? { confidence } : {}),
        }),
      })
        // `apiSuccess` spreads the payload onto the root ({ success, decision, ... }),
        // so the fields live one level up — there is no `data` wrapper to unwrap.
        .then((res) => {
          if (res.status === 204 || !res.ok) {
            if (decisionLive()) setDecisionFailed(true);
            return null;
          }
          return res.json();
        })
        .then((payload) => {
          if (decisionLive() && payload?.decision) {
            setAdaptiveDecision(payload as AdaptiveDecision);
            // 决策出的新难度写回画像——下一次交卷读到的就是它，
            // 「答错→降维」不再是一次性横幅，而是持续状态。
            const next = (payload as AdaptiveDecision).updated_difficulty;
            try {
              const stored = JSON.parse(localStorage.getItem('learnerProfile') ?? 'null') ?? {};
              let dirty = false;
              if (typeof next === 'string' && /^L[1-4]$/.test(next) && stored.currentDifficulty !== next) {
                stored.currentDifficulty = next;
                dirty = true;
              }
              // 掌握度不在这里改了。**画像已切成导出量**：值由 `refreshDerivedProfile()`
              // 从全量履历重跑 fold 算出来（见本函数末尾），这里只留难度与 Elo 这类
              // 不是从证据导出的状态。
              //
              // 原来这儿是 `mastery[c] = prev*0.5 + score*0.5` 的就地 EMA —— 一个自己
              // 迭代自己的存储量，说不清 0.62 由哪几条证据算出、改规则就废掉历史。
              // 那段里的「耗时降权」已挪进 `weight.ts` 的 `SLOW_RESPONSE_MS`：
              // 耗时是情境，而权重 = f(情境, 判定)，它本来就该在那一层。
              // Elo 评级写回：难度行走的连续状态（决策 agent 的 L 档仍是权威）
              const elo = (payload as { elo?: { rating?: number } }).elo;
              if (elo && typeof elo.rating === 'number') {
                stored.eloRating = elo.rating;
                dirty = true;
              }
              if (dirty) localStorage.setItem('learnerProfile', JSON.stringify(stored));
            } catch {
              /* 写不进也不影响本次展示 */
            }
          }
        })
        .catch(() => {
          /* adaptation is optional — never block the review screen */
          if (decisionLive()) setDecisionFailed(true);
        });
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, questions, answers, locale, sceneId, stageId, sceneTitle, attemptId, runtimeWriter, totalPoints, confidence, viewLifetime]);

  const handleRetry = useCallback(async () => {
    if (!attemptId || retrying) return;
    setRetrying(true);
    runtimeWriter.cancelDraft();
    await runQuizPersistenceTransition(
      () => persistQuizRetry({ stageId, sceneId, attemptId }, runtimeWriter),
      viewLifetime,
      () => {
        setPhase('not_started');
        setAnswers({});
        setResults([]);
        // 上一次交卷的决策属于上一次的成绩，重答就作废。不清的话下次交卷会先闪
        // 一下旧横幅再被新决策顶掉（决策请求的守门改成 viewLifetime 之后，
        // 在途结果不再被 phase 变化误杀，这个陈旧态才浮出来）。
        setAdaptiveDecision(null);
        setDecisionFailed(false);
        // 决策的**执行结果**同理作废。漏了这两个的后果不是闪一下：横幅只在
        // 有新决策时才渲染，所以陈旧值会安静地待到下一次交卷才现形——
        // 上一轮插过场景的话，新横幅一出来就写着「已插入新场景」并把「执行」
        // 按钮藏了（`insertedLabel` 一有值就不渲染按钮），这一轮的补救根本点不了，
        // 「跳转过去」还跳回上一轮那个场景；上一轮失败的话，新一轮开局就顶着
        // 一条与本次无关的「执行失败：…」。
        setInsertedSceneId(null);
        setRemediationError(null);
        setRetrying(false);
      },
      (error) => {
        log.warn('Failed to persist quiz retry:', error);
        setRetrying(false);
        if (error instanceof QuizRetryProgressedError) {
          setHydrationVersion((version) => version + 1);
          return;
        }
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, retrying, runtimeWriter, sceneId, stageId, viewLifetime]);

  /**
   * Execute the routing decision: generate a remediation scene through the full
   * grounding → audit → actions pipeline and splice it in after this quiz.
   * Failures surface on the banner; nothing here fails silently.
   */
  const handleActOnDecision = useCallback(async () => {
    if (!adaptiveDecision || acting) return;
    const kind = adaptiveDecision.decision;
    if (kind === 'keep_route') return;
    setActing(true);
    setRemediationError(null);
    setRemediationPhase(null);
    // Real data only: the stems of the questions this learner actually missed.
    const missedPoints = results
      .filter((r) => r.status === 'incorrect')
      .map((r) => questions.find((q) => q.id === r.questionId)?.question)
      .filter((s): s is string => !!s);
    try {
      const { scene, error } = await generateRemediationScene({
        decision: kind,
        anchorSceneId: sceneId,
        missedPoints,
        onPhase: setRemediationPhase,
      });
      if (scene) setInsertedSceneId(scene.id);
      else setRemediationError(error ?? '补救生成失败');
    } catch (err) {
      log.error('[quiz-view] remediation failed', err);
      setRemediationError(err instanceof Error ? err.message : '补救生成失败');
    } finally {
      setActing(false);
      setRemediationPhase(null);
    }
  }, [adaptiveDecision, acting, questions, results, sceneId]);

  const earnedScore = useMemo(() => results.reduce((sum, r) => sum + r.earned, 0), [results]);

  const resultMap = useMemo(() => {
    const map: Record<string, QuestionResult> = {};
    results.forEach((r) => {
      map[r.questionId] = r;
    });
    return map;
  }, [results]);

  if (runtimeGate.status === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <button
          type="button"
          onClick={() => setHydrationVersion((version) => version + 1)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <RotateCcw className="h-4 w-4" />
          {t('quiz.retry')}
        </button>
      </div>
    );
  }

  if (!isQuizRuntimeReady(runtimeGate)) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-background overflow-hidden flex flex-col">
      <AnimatePresence mode="wait">
        {phase === 'not_started' && (
          <motion.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1"
          >
            <QuizCover
              questionCount={questions.length}
              totalPoints={totalPoints}
              onStart={() => setPhase('answering')}
            />
          </motion.div>
        )}

        {phase === 'answering' && (
          <motion.div
            key="answering"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-card shrink-0">
              <div className="flex items-center gap-2">
                <PieChart className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-foreground">
                  {t('quiz.answering')}
                </span>
                <span className="text-sm text-muted-foreground ml-1">
                  {
                    Object.keys(answers).filter((k) => {
                      const a = answers[k];
                      if (Array.isArray(a)) return a.length > 0;
                      return typeof a === 'string' && a.trim().length > 0;
                    }).length
                  }{' '}
                  / {questions.length}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {/* 把握度自报（1-5，可跳过）：反馈决策的 confidence 输入。
                    不采集就不传，引擎侧 None=未采集是诚实口径——绝不补默认 3。 */}
                {allAnswered && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{t('quiz.confidenceAsk')}</span>
                    {[1, 2, 3, 4, 5].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setConfidence((prev) => (prev === v ? null : v))}
                        aria-pressed={confidence === v}
                        className={cn(
                          'w-6 h-6 rounded-md text-xs font-medium transition-colors',
                          confidence === v
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/70',
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!allAnswered}
                  className={cn(
                    'px-4 py-1.5 rounded-lg text-sm font-medium transition-all',
                    allAnswered
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.97]'
                      : 'bg-muted text-muted-foreground cursor-not-allowed',
                  )}
                >
                  {t('quiz.submitAnswers')}
                </button>
              </div>
            </div>

            {/* Questions */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {questions.map((q, i) => {
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={(v) => handleSetAnswer(q.id, v)}
                  />
                );
              })}
            </div>
          </motion.div>
        )}

        {(phase === 'submitting' || phase === 'grading') && (
          <motion.div
            key="grading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center gap-5"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            >
              <Loader2 className="w-10 h-10 text-violet-500" />
            </motion.div>
            <div className="text-center">
              <p className="text-base font-semibold text-foreground">
                {t('quiz.aiGrading')}
              </p>
              <p className="text-sm text-muted-foreground mt-1">{t('quiz.aiGradingWait')}</p>
            </div>
            <div className="flex gap-1 mt-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-2 h-2 rounded-full bg-violet-400"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{
                    repeat: Infinity,
                    duration: 1.2,
                    delay: i * 0.2,
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {phase === 'reviewing' && (
          <motion.div
            key="reviewing"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-card shrink-0">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-solid" />
                <span className="text-sm font-semibold text-foreground">
                  {t('quiz.quizReport')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={retrying}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('quiz.retry')}
              </button>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 relative">
              {celebrationBurst && <PastelConfetti />}
              <ScoreBanner score={earnedScore} total={totalPoints} results={results} />

              {/* 连错≥2 触发鼓励卡（规格3.2.4⑧⑫），不给答案 */}
              {results.filter((r) => r.status === 'incorrect').length >= 2 && (
                <EncouragementCard />
              )}

              {/* 决策桥失联时如实告知，不再静默无横幅（四桥显式告警之一） */}
              {decisionFailed && !adaptiveDecision && (
                <p className="text-xs text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2">
                  ⚠️ 反馈决策引擎未响应——本次交卷不做路线调整，成绩已正常记录。
                </p>
              )}

              {/* Multi-agent routing decision (analyse → generate → verify → decide) */}
              {adaptiveDecision && (
                <AdaptiveDecisionBanner
                  decision={adaptiveDecision}
                  scorePercent={totalPoints > 0 ? Math.round((earnedScore / totalPoints) * 100) : 0}
                  onAct={() => void handleActOnDecision()}
                  acting={acting}
                  error={remediationError ?? undefined}
                  insertedLabel={insertedSceneId ? '已插入新场景（带审核徽标）' : undefined}
                  onJump={
                    insertedSceneId
                      ? () => {
                          // 有闸门就走闸门：它会先 endActiveSession（讨论开着时先收会话/弹确认），
                          // 再落 currentSceneId。没有闸门的是 Pro 编辑器那条路（无会话），直连 store。
                          if (onRequestSceneSwitch) {
                            void onRequestSceneSwitch(insertedSceneId);
                            return;
                          }
                          useStageStore.getState().setCurrentSceneId(insertedSceneId);
                        }
                      : undefined
                  }
                />
              )}

              {/* 生成中的阶段反馈：整条链 2.5–10 分钟，横幅按钮上只有「生成中…」，
                  等的人看不出卡在哪一步。这里报真实阶段名 + 一句耗时预期
                  （3–10 分钟出自 F1 实测的 155/164/593 秒三次）。
                  不做百分比——四段耗时没有可靠分母，编一个进度条就是编数字。 */}
              {acting && (
                <p
                  data-testid="remediation-phase"
                  className="text-xs text-muted-foreground border border-dashed border-border rounded-lg px-3 py-2"
                >
                  {remediationPhase ? `当前阶段：${remediationPhase}` : '正在启动'}
                  <span className="ml-2 opacity-70">通常 3–10 分钟，审核严格时更久</span>
                </p>
              )}

              {questions.map((q, i) => {
                const r = resultMap[q.id];
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={() => {}}
                    disabled
                    result={r}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
