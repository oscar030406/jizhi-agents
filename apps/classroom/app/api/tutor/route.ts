/**
 * Tutor proxy — 动态追问导学（赛题第五(4)款②：打破静态资源的单向输入）.
 *
 * The engine's tutor agent asks the *learner* questions: probe → grade →
 * decide (降维解释 / 推进 / 进阶挑战), each turn with a because-chain. The
 * engine is stateless — the client resends the full answer history each turn.
 *
 * Degrades to 204 when the engine is unreachable; 404 passes through so the
 * UI can distinguish "engine down" from "no curriculum for this concept".
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiSuccess, apiError } from '@/lib/server/api-response';

const log = createLogger('Tutor');

export interface TutorQuestion {
  question_id: string;
  lesson_id: string;
  lesson_title: string;
  /** 呈现给学习者的问句（可能是苏格拉底改写） */
  probe: string;
  /** 题库原文（防伪：改写不改考点） */
  original_question: string;
  options: string[];
  source_ids: string[];
  /** llm=苏格拉底改写成功 / deterministic=题库原文 —— 如实标注 */
  engine: 'llm' | 'deterministic' | string;
}

export interface TutorTurn extends Record<string, unknown> {
  decision: {
    // correct/partial/incorrect 是讲义驱动判分在面板侧映射出的裁决类型
    type:
      | 'probe'
      | 'simplify'
      | 'advance'
      | 'challenge'
      | 'complete'
      | 'correct'
      | 'partial'
      | 'incorrect';
    because: string[];
  };
  question: TutorQuestion | null;
  explanation: {
    text: string;
    section_heading: string;
    section_excerpt: string;
    source_ids: string[];
  } | null;
  challenge: string | null;
  mastery_estimate: number;
  asked: number;
  correct: number;
}

/** 讲义驱动导学单轮（lectureText 非空时引擎走该分支，出题/判分锚定讲义正文）。 */
export interface LectureTutorTurn extends Record<string, unknown> {
  /** ask=出题 / verdict=判分 / unavailable=LLM 不可用（引擎诚实降级，不编题） */
  mode: 'ask' | 'verdict' | 'unavailable';
  question: string;
  expected_points: string[];
  verdict: '' | 'correct' | 'partial' | 'incorrect';
  because: string[];
  explanation: string;
  /** 讲义原句引用；引擎侧校验过是正文原文，引不出为空 */
  quote: string;
  engine: string;
  /** 可见决策：这轮出什么题 / 判完分下一步走哪 */
  decision_type: 'probe' | 'simplify' | 'advance' | 'challenge' | string;
  mastery_estimate: number;
  asked: number;
  correct: number;
  profile_evidence?: { concept: string; verdict: string; confidence: number } | null;
}

/** 讲义导学的一轮已判分交互——引擎无状态，客户端每轮全量回传。 */
export interface LectureExchange {
  question: string;
  answer: string;
  verdict: string;
  /**
   * 这一轮用到第几级提示。引擎按它逐轮压档（`cap_verdict_by_hints`）——
   * 不回传的话历史里每一轮都按「没要过提示」算，看了答案的那些轮会被
   * 重新算成真会了。可选：老会话没有这一格，缺省 0。
   */
  hints_used?: number;
}

/**
 * 提示阶梯的一级。**未解锁时 `content` 是空串**——解锁判定在引擎做，
 * 前端改个 flag 露不出答案，这里也不要试图从别处凑内容。
 */
export interface HintStep {
  level: number;
  /** hint=指方向 / scaffold=拆小步子题 / bottom_out=兜底答案 */
  kind: 'hint' | 'scaffold' | 'bottom_out' | string;
  title: string;
  content: string;
  unlocked: boolean;
  /** 开或不开的依据。界面上置灰按钮的提示文案直接用它，不要自己另写一套说法。 */
  reason: string;
  /** 用了这一级之后，本题最高只能记到的判分档。 */
  verdict_cap: string;
}

/**
 * 一道题的三级提示阶梯（引擎 `hint_ladder_turn` 的响应，`agent` 为 `tutor:hint`）。
 *
 * 引擎无状态：`hints_used` 是这道题**累计**用到的最高级，客户端存着、下一轮回传。
 * 不回传等于阶梯从头走一遍，拿不到答案——状态丢了只会更严，不会更松。
 */
export interface HintLadder extends Record<string, unknown> {
  requested_level: number;
  /** 本轮实际放行到第几级；0 = 没放行（跳级或越界）。 */
  granted_level: number;
  hints_used: number;
  steps: HintStep[];
  because: string[];
}

export async function POST(req: NextRequest) {
  const base = process.env.GROUNDING_URL;
  if (!base) return new Response(null, { status: 204 });
  try {
    const body = (await req.json()) as {
      concept?: string;
      history?: { question_id: string; selected_index: number }[];
      recommendedDifficulty?: string;
      // 讲义驱动路径：lectureText 非空即走（判分轮回传出题轮的 question/expectedPoints）
      lectureText?: string;
      sceneTitle?: string;
      courseTitle?: string;
      learnerAnswer?: string;
      question?: string;
      expectedPoints?: string[];
      lectureHistory?: LectureExchange[];
      priorMastery?: number | null;
      /**
       * 三级提示阶梯。`hintRequest>0` 时引擎走提示分支（不出新题）。
       * 这三格此前被这层白名单静默丢掉——引擎那边接口早就有了，界面拿不到，
       * 交答案也不回传 hints_used，于是「看了答案照样记成会了」。
       */
      hintRequest?: number;
      hintsUsed?: number;
      hintQuestionId?: string;
    };
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/tutor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({
        concept: body.concept ?? '',
        history: body.history ?? [],
        recommended_difficulty: body.recommendedDifficulty ?? 'L2',
        lecture_text: body.lectureText ?? '',
        scene_title: body.sceneTitle ?? '',
        course_title: body.courseTitle ?? '',
        learner_answer: body.learnerAnswer ?? '',
        question: body.question ?? '',
        expected_points: body.expectedPoints ?? [],
        lecture_history: body.lectureHistory ?? [],
        prior_mastery: body.priorMastery ?? null,
        hint_request: body.hintRequest ?? 0,
        hints_used: body.hintsUsed ?? 0,
        hint_question_id: body.hintQuestionId ?? '',
      }),
      // 苏格拉底改写走 LLM，比确定性桥慢——给足 30s
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
    if (resp.status === 404) {
      return apiError('INVALID_REQUEST', 404, `该主题暂无导学题库：${body.concept}`);
    }
    if (!resp.ok) return new Response(null, { status: 204 });
    const payload = (await resp.json()) as { data?: TutorTurn | LectureTutorTurn | HintLadder };
    const data = payload.data;
    // 三个分支的判据各不相同：概念分支带 decision，讲义分支带 mode，
    // 提示分支两个都没有、只有 steps。**这一条不补上，提示轮会被当成坏载荷退 204**——
    // 引擎正常返回、界面却什么都收不到，正是最难查的那种静默失败。
    const isLadder = !!data && 'steps' in data && Array.isArray((data as HintLadder).steps);
    if (
      !data ||
      (!('decision' in data && data.decision) && !('mode' in data && data.mode) && !isLadder)
    ) {
      return new Response(null, { status: 204 });
    }
    if (isLadder) {
      const ladder = data as HintLadder;
      log.info(
        `Hint ladder for "${body.sceneTitle ?? body.concept ?? ''}": ` +
          `请求第 ${ladder.requested_level} 级 → 放行 ${ladder.granted_level}，累计 ${ladder.hints_used}`,
      );
    } else if ('mode' in data && data.mode) {
      log.info(`Lecture turn for "${body.sceneTitle ?? ''}": ${data.mode}`);
    } else {
      const turn = data as TutorTurn;
      log.info(
        `Turn for ${body.concept}: ${turn.decision.type} (asked=${turn.asked} correct=${turn.correct})`,
      );
    }
    return apiSuccess(data);
  } catch (err) {
    log.warn(`Tutor unavailable: ${String(err)}`);
    return new Response(null, { status: 204 });
  }
}
