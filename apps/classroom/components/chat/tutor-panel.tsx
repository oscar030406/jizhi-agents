'use client';

/**
 * 导学追问面板 — 动态追问与启发式交互导学的课堂入口（赛题第五(4)款②）。
 *
 * 反向问答：不是学生问 AI，而是导师主动提问定位盲区。每轮流程：
 * 探测提问 → 学生自由作答 → 裁决卡（判分 + because 链）→ 按目标正确率带决定
 * 降维追问 / 推进 / 进阶，接着出下一问。
 *
 * 导学相对课程是**外置的**：它只读「这一节讲了什么」（讲义正文）+ 学习者画像 +
 * 本轮对话历史，不读任何课程生成期预制的导学字段，所以任意一门没见过的课都能考。
 * 引擎无状态，多轮历史存在本组件的 React state 里，每轮全量重发。
 * 引擎不可达（/api/health 的 engineBridge ≠ ok）时入口禁用，不崩不藏。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  ArrowRightCircle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AGENT_ART, AGENT_PERSONAS } from '@/components/agents/agent-avatar';
import { useStageStore } from '@/lib/store';
import { sceneLectureText } from '@/lib/classroom/lecture-text';
import { stripSourceIds } from '@/lib/generation/tutor-prose';
import { createLogger } from '@/lib/logger';
import type { TutorTurn, LectureTutorTurn, LectureExchange } from '@/app/api/tutor/route';

const LECTURE_TEXT_CAP = 3000;

type Entry =
  | { kind: 'turn'; turn: TutorTurn }
  | { kind: 'answer'; text: string };

type Status = 'checking' | 'idle' | 'loading' | 'active' | 'offline' | 'done';

const DECISION_META: Record<string, { icon: typeof ArrowDownCircle; label: string; tone: string }> = {
  probe: { icon: HelpCircle, label: '探测提问', tone: 'text-blue-deep' },
  simplify: { icon: ArrowDownCircle, label: '降维追问', tone: 'text-yellow-deep' },
  advance: { icon: ArrowRightCircle, label: '推进', tone: 'text-blue-deep' },
  challenge: { icon: ArrowUpCircle, label: '进阶挑战', tone: 'text-green-deep' },
  complete: { icon: CheckCircle2, label: '完成', tone: 'text-green-deep' },
  // 讲义驱动判分的三档裁决（自由作答，无选择题式对错）
  correct: { icon: CheckCircle2, label: '答对了', tone: 'text-green-deep' },
  partial: { icon: ArrowDownCircle, label: '部分正确', tone: 'text-yellow-deep' },
  incorrect: { icon: XCircle, label: '还没到位', tone: 'text-red-deep' },
};

/** 讲义出题轮 → 复用 TurnCard 的 TutorTurn 形态（options 空 = 自由作答）。 */
function askToTurn(t: LectureTutorTurn, sceneTitle: string): TutorTurn {
  return {
    decision: {
      type: (t.decision_type || 'probe') as TutorTurn['decision']['type'],
      because: t.because ?? [],
    },
    question: {
      question_id: 'lecture',
      lesson_id: 'lecture',
      lesson_title: sceneTitle,
      probe: t.question,
      original_question: t.question,
      options: [],
      source_ids: [],
      engine: t.engine,
    },
    explanation: null,
    challenge: null,
    mastery_estimate: t.mastery_estimate ?? 0,
    asked: t.asked ?? 0,
    correct: t.correct ?? 0,
  };
}

/** 讲义判分轮 → TurnCard 形态：verdict 直接当决策类型，降维解释带讲义原句引用。 */
function verdictToTurn(t: LectureTutorTurn, sceneTitle: string): TutorTurn {
  const text = [t.explanation, t.quote ? `讲义原句：「${t.quote}」` : ''].filter(Boolean).join('\n');
  return {
    decision: { type: t.verdict || 'partial', because: t.because ?? [] },
    question: null,
    explanation: text
      ? { text, section_heading: sceneTitle, section_excerpt: t.quote, source_ids: [] }
      : null,
    challenge: null,
    mastery_estimate: t.mastery_estimate ?? 0,
    asked: t.asked ?? 0,
    correct: t.correct ?? 0,
  };
}

/** 画像读取：推荐难度 + 本节概念的历史掌握度（写回口径见下方判分分支）。 */
function readProfile(concept: string): { recommendedDifficulty?: string; priorMastery?: number } {
  try {
    const stored = JSON.parse(localStorage.getItem('learnerProfile') ?? 'null');
    const m = stored?.conceptMastery?.[concept];
    return {
      recommendedDifficulty:
        typeof stored?.currentDifficulty === 'string' ? stored.currentDifficulty : undefined,
      priorMastery: typeof m === 'number' ? m : undefined,
    };
  } catch {
    return {}; // 画像损坏不拦导学
  }
}

const log = createLogger('TutorPanel');

export function TutorPanel({ currentSceneId }: { currentSceneId?: string | null }) {
  const scenes = useStageStore((s) => s.scenes);
  const courseTitle = useStageStore((s) => s.stage?.name ?? '');
  const [status, setStatus] = useState<Status>('checking');
  const [entries, setEntries] = useState<Entry[]>([]);
  // 多轮状态：已判分交互（每轮全量回传给无状态引擎）、待答的问题与判分要点、作答草稿
  const historyRef = useRef<LectureExchange[]>([]);
  const [lectureQA, setLectureQA] = useState<{ question: string; expectedPoints: string[] } | null>(null);
  const [answerDraft, setAnswerDraft] = useState('');
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const currentScene = useMemo(
    () => scenes.find((s) => s.id === currentSceneId) ?? null,
    [scenes, currentSceneId],
  );
  // 考核语料 = 当前场景讲义正文。测验/交互场景本身没有正文（全课 22% 是这类），
  // 导学既然是外置的，就回读本节之前已经讲过的幻灯片，取最近的一段。
  const lectureText = useMemo(() => {
    const own = sceneLectureText(currentScene);
    if (own) return own;
    const idx = scenes.findIndex((s) => s.id === currentSceneId);
    return (idx > 0 ? scenes.slice(0, idx) : scenes)
      .map((s) => sceneLectureText(s))
      .filter(Boolean)
      .join('\n')
      .slice(-LECTURE_TEXT_CAP);
  }, [currentScene, scenes, currentSceneId]);
  const sceneTitle = currentScene?.title ?? '';

  // 入口探活：引擎桥不通就禁用，明说，不藏
  useEffect(() => {
    let cancelled = false;
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((payload: { engineBridge?: string }) => {
        if (!cancelled) setStatus(payload.engineBridge === 'ok' ? 'idle' : 'offline');
      })
      .catch(() => {
        if (!cancelled) setStatus('offline');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, lectureQA]);

  /**
   * 单轮请求。无 answer=出题轮，有 answer=判分轮（回传本轮问题与判分要点）。
   * 返回本轮落到哪个态，调用方据此决定要不要接着出下一问（多轮循环在调用点，不在这里递归）。
   */
  const requestTurn = useCallback(
    async (
      answer?: string,
      qa?: { question: string; expectedPoints: string[] },
    ): Promise<LectureTutorTurn['mode'] | 'error'> => {
      setStatus('loading');
      const profile = readProfile(sceneTitle);
      try {
        const res = await fetch('/api/tutor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lectureText,
            sceneTitle,
            courseTitle,
            lectureHistory: historyRef.current,
            recommendedDifficulty: profile.recommendedDifficulty,
            priorMastery: profile.priorMastery,
            ...(answer && qa
              ? { learnerAnswer: answer, question: qa.question, expectedPoints: qa.expectedPoints }
              : {}),
          }),
        });
        if (res.status === 204 || !res.ok) {
          setStatus('offline');
          return 'error';
        }
        // apiSuccess 把载荷平铺到根（{ success, mode, ... }），没有 data 包一层
        const turn = (await res.json()) as LectureTutorTurn;
        if (turn.mode === 'unavailable') {
          // 引擎诚实降级（LLM 未启用/输出不合法）：明说原因，不编题不猜分
          setUnavailable(turn.because?.[0] ?? '导学探问暂不可用');
          setStatus('done');
          return 'unavailable';
        }
        if (turn.mode === 'ask') {
          setLectureQA({ question: turn.question, expectedPoints: turn.expected_points ?? [] });
          setEntries((prev) => [...prev, { kind: 'turn', turn: askToTurn(turn, sceneTitle) }]);
          setStatus('active');
          return 'ask';
        }
        // verdict：落判分卡 → 记进历史 → 画像写回（下一问由调用方接着发起）
        setLectureQA(null);
        setEntries((prev) => [...prev, { kind: 'turn', turn: verdictToTurn(turn, sceneTitle) }]);
        historyRef.current = [
          ...historyRef.current,
          { question: qa?.question ?? '', answer: answer ?? '', verdict: turn.verdict },
        ];
        // 画像**不在这里改**。原来这段是按 `confidence×0.5` 权重的就地 EMA
        // （与 quiz 那段同族），2026-08-12 随 fold 上线一并撤掉：
        // 画像由 `refreshDerivedProfile()` 从全量履历重算，是导出量不是存储量。
        //
        // 导学证据的置信度没丢——它进了证据的判定与情境，由 `weight.ts` 统一计权，
        // 而不是在这里乘一个只有本调用点知道的系数。一份口径，一个地方算。

        // 履历落盘：导学这条比 quiz 那条强——测项是概念级的、判定就是对这个概念出的，
        // 落 per-kc 不是降级。
        void (async () => {
          try {
            const { appendEvidence, evidenceFor, readLedger, LEGACY_DOMAIN } = await import(
              '@/lib/evidence'
            );
            const { tutorEvidenceDraft } = await import('@/lib/evidence/from-tutor');
            const { getLearnerKey } = await import('@/lib/runtime/learner-key');
            const { learnerDomain, refreshDerivedProfile } = await import(
              '@/lib/evidence/profile-bridge'
            );
            const learnerKey = await getLearnerKey();
            const concept = (turn.profile_evidence?.concept || sceneTitle || '').trim();
            if (!concept) return;
            // 领域与 quiz 那条同源：画像里录的 domain。取不到时兜到 LEGACY_DOMAIN，
            // 和 2026-08-13 之前写死 'ai' 的旧证据归进同一个桶。
            const domain = learnerDomain();
            const measured = { kind: 'concept' as const, domain: domain ?? LEGACY_DOMAIN, concept };
            const ledger = await readLedger({ learnerKey });
            const prior = evidenceFor(ledger, measured);
            const lastAt = prior.at(-1)?.source.at;
            const draft = tutorEvidenceDraft({
              learnerKey,
              interactionId: `tutor:${currentSceneId ?? 'unknown'}:${historyRef.current.length}`,
              sceneId: currentSceneId ?? '',
              sceneTitle,
              ...(domain ? { domain } : {}),
              turn,
              at: new Date().toISOString(),
              priorEncounters: prior.length,
              ...(lastAt ? { sinceLastMs: Date.now() - new Date(lastAt).getTime() } : {}),
            });
            if (draft) await appendEvidence(draft, { learnerKey });
            // 画像 = fold(履历)：写完证据立刻重算。幂等，跑几次都一样。
            await refreshDerivedProfile({ learnerKey });
          } catch (error) {
            // 履历写失败不拦导学——这一轮的判分卡已经渲染了，只是少记一条轨迹。
            log.warn('Failed to append tutor evidence:', error);
          }
        })();
        return 'verdict';
      } catch {
        setStatus('offline');
        return 'error';
      }
    },
    [lectureText, sceneTitle, courseTitle],
  );

  const handleStart = useCallback(() => {
    historyRef.current = [];
    setEntries([]);
    setLectureQA(null);
    setAnswerDraft('');
    setUnavailable(null);
    void requestTurn();
  }, [requestTurn]);

  const handleAnswer = useCallback(async () => {
    const answer = answerDraft.trim();
    if (!answer || !lectureQA) return;
    setEntries((prev) => [...prev, { kind: 'answer', text: answer }]);
    setAnswerDraft('');
    // 判分完 → 立刻出下一问（降维/推进/进阶由引擎按目标正确率带裁决）
    if ((await requestTurn(answer, lectureQA)) === 'verdict') void requestTurn();
  }, [answerDraft, lectureQA, requestTurn]);

  if (status === 'checking') {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        检查导学服务…
      </div>
    );
  }

  if (status === 'offline' && entries.length === 0) {
    return (
      // 离线态原来是「整块 opacity-60 + 正文再叠 /80」，说明文字实测只剩 3.69:1，
      // 掉出 1.4.3 AA 的 4.5:1——恰恰是出问题时最需要读清楚的那句话。
      // 离线的语义交给灰度头像和禁用按钮表达，文字本身不再压暗。
      <div className="h-full flex flex-col items-center justify-center text-center p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={AGENT_ART.tutor.bust}
          alt={`${AGENT_PERSONAS.tutor.name}（${AGENT_PERSONAS.tutor.role}）`}
          className="mb-3 size-12 rounded-full object-cover grayscale opacity-60"
        />
        <p className="text-sm font-medium text-foreground">导学服务未连接</p>
        <p className="text-xs text-muted-foreground mt-1">
          需要多智能体引擎在线才能发起导师追问
        </p>
        <button
          type="button"
          disabled
          className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground cursor-not-allowed"
        >
          让导师考考我
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 scrollbar-hide">
      {/* 发起区 */}
      {entries.length === 0 ? (
        <div className="flex flex-col items-center text-center p-4 gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={AGENT_ART.tutor.full ?? AGENT_ART.tutor.bust}
            alt={`${AGENT_PERSONAS.tutor.name}（${AGENT_PERSONAS.tutor.role}）`}
            className="h-28 w-auto object-contain"
          />
          <p className="text-xs font-medium text-muted-foreground">
            {AGENT_PERSONAS.tutor.name} ·「{AGENT_PERSONAS.tutor.motto}」
          </p>
          <p className="text-sm text-muted-foreground">
            不是你问导师，是导师考你：主动提问定位盲区，答错降维追问，连对进阶挑战。
          </p>
          {unavailable && <p className="text-xs text-yellow-deep">导学探问不可用（{unavailable}）</p>}
          <p className="w-full rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground text-left">
            {lectureText
              ? `考核范围：当前讲义节「${sceneTitle || '未命名'}」——题目现场从讲义正文生成`
              : '当前场景没有可考的讲义正文，翻到讲解页再来'}
          </p>
          <button
            type="button"
            disabled={status === 'loading' || !lectureText}
            onClick={handleStart}
            className="w-full rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50 transition"
          >
            {status === 'loading' ? '导师出题中…' : '让导师考考我'}
          </button>
        </div>
      ) : (
        <>
          {entries.map((entry, i) =>
            entry.kind === 'answer' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-muted px-3 py-2 text-sm">
                  我的回答：{entry.text}
                </div>
              </div>
            ) : (
              <TurnCard key={i} turn={entry.turn} />
            ),
          )}

          {/* 自由作答，LLM 对照讲义正文判分 */}
          {lectureQA && status === 'active' && (
            <div className="space-y-1.5">
              <textarea
                value={answerDraft}
                onChange={(e) => setAnswerDraft(e.target.value)}
                rows={3}
                placeholder="用自己的话回答，导师会对照讲义原文判分…"
                className="w-full rounded-lg border border-border bg-transparent px-2.5 py-2 text-sm resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={!answerDraft.trim()}
                  onClick={handleAnswer}
                  className="flex-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50 transition"
                >
                  提交回答
                </button>
                <button
                  type="button"
                  onClick={() => setStatus('done')}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent transition"
                >
                  结束本轮
                </button>
              </div>
            </div>
          )}

          {status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              导师裁决中…
            </div>
          )}

          {status === 'offline' && (
            <p className="text-xs text-red-deep px-1">导学服务未连接，本轮中断——可稍后重试</p>
          )}

          {status === 'done' && unavailable && (
            <p className="text-xs text-yellow-deep px-1">导学探问中止（{unavailable}）</p>
          )}

          {(status === 'done' || status === 'offline') && (
            <button
              type="button"
              onClick={handleStart}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              重新开始一轮
            </button>
          )}
        </>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

/** 单轮裁决卡：决策标签 + because 链 + 降维解释 / 进阶挑战 / 下一问，engine 字段如实标注。 */
function TurnCard({ turn }: { turn: TutorTurn }) {
  const meta = DECISION_META[turn.decision.type] ?? DECISION_META.probe;
  const Icon = meta.icon;
  return (
    /* 导学裁决卡属 AI 生成内容：blue-soft 底标识（规格3.2.7⑦③） */
    <div className="rounded-xl border border-blue-deep/20 px-3 py-2.5 space-y-2 bg-blue-soft/60">
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={AGENT_ART.tutor.bust}
          alt={AGENT_PERSONAS.tutor.name}
          className="size-[18px] shrink-0 rounded-full object-cover"
          loading="lazy"
        />
        <Icon className={cn('w-4 h-4 shrink-0', meta.tone)} />
        <span className={cn('text-xs font-semibold', meta.tone)}>{meta.label}</span>
        {turn.asked > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            掌握度 {Math.round(turn.mastery_estimate * 100)}% · 已答 {turn.asked} 对 {turn.correct}
          </span>
        )}
      </div>

      {turn.decision.because.length > 0 && (
        <ul className="space-y-0.5 pl-1 text-[11px] text-muted-foreground">
          {turn.decision.because.map((b, i) => (
            <li key={i}>← {b}</li>
          ))}
        </ul>
      )}

      {turn.explanation && (
        <div className="rounded-lg bg-yellow-soft border border-yellow-deep/30 px-2.5 py-2 space-y-1">
          <p className="text-[11px] font-medium">
            锚定小节：{turn.explanation.section_heading || '（未标注）'}
          </p>
          {/* source_id 是知识库内部标记，在讲义角标里有用、在对话里没用。
              实测：「参考 [tu04#s2] 读到 query 函数时…」——零基础读者只会以为自己漏了什么。
              结构化引用走下面的 source_ids 字段，不靠正文里的方括号。 */}
          <p className="text-xs whitespace-pre-wrap">{stripSourceIds(turn.explanation.text)}</p>
          {turn.explanation.source_ids.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              来源：{turn.explanation.source_ids.join('、')}
            </p>
          )}
        </div>
      )}

      {turn.question && (
        <div className="space-y-1">
          <p className="text-xs font-medium whitespace-pre-wrap">
            {stripSourceIds(turn.question.probe)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {turn.question.lesson_title}
            {' · '}
            {turn.question.question_id === 'lecture'
              ? '讲义现生成'
              : turn.question.engine === 'llm'
                ? '苏格拉底改写'
                : '题库原文'}
            {turn.question.source_ids.length > 0 && ` · 来源：${turn.question.source_ids.join('、')}`}
          </p>
        </div>
      )}

      {turn.challenge && <p className="text-xs text-green-deep">{turn.challenge}</p>}
    </div>
  );
}
