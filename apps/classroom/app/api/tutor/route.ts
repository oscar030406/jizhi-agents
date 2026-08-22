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
      }),
      // 苏格拉底改写走 LLM，比确定性桥慢——给足 30s
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
    if (resp.status === 404) {
      return apiError('INVALID_REQUEST', 404, `该主题暂无导学题库：${body.concept}`);
    }
    if (!resp.ok) return new Response(null, { status: 204 });
    const payload = (await resp.json()) as { data?: TutorTurn | LectureTutorTurn };
    const data = payload.data;
    // 概念分支带 decision，讲义分支带 mode——两者都没有说明载荷坏了
    if (!data || (!('decision' in data && data.decision) && !('mode' in data && data.mode))) {
      return new Response(null, { status: 204 });
    }
    if ('mode' in data && data.mode) {
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
