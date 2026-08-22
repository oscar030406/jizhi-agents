/**
 * Adaptive decision proxy.
 *
 * Closes the analyse → generate → verify → **decide** loop: after a quiz scene
 * is graded, the multi-agent engine's feedback-decision agent turns the score
 * into one of four routes (降维解释 / 补充练习 / 进阶挑战 / 保持路线), each with
 * a because-chain naming the thresholds it crossed. Deterministic and fast.
 *
 * Degrades to 204 when the engine is unreachable — the classroom keeps working,
 * it just does not adapt.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiSuccess } from '@/lib/server/api-response';

const log = createLogger('Adaptive Decision');

export interface AdaptiveDecision extends Record<string, unknown> {
  feedback_type: string;
  decision: 'downgrade_explanation' | 'add_practice' | 'advance_challenge' | 'keep_route';
  updated_difficulty: string;
  next_action: string;
  explanation: string;
  because: string[];
  /**
   * 谁做的判定。引擎侧一直在回传（personalize_service.py:493「UI 按此如实展示」），
   * 之前前端没接，横幅无条件写「多智能体协同决策」——那是假话，默认
   * `AGENT_GENERATION_MODE=deterministic` 下跑的是确定性规则。
   *
   * 注意 `deterministic` **不是降级**：设计稿 §7.3 把反馈决策列为「按需 agent」，
   * 常规就该走确定性计算，只在信号冲突时唤起模型。写成「规则降级」同样是失真。
   */
  engine?: 'llm' | 'deterministic';
  /** Elo 评级。**参考信号，不参与裁决**——档位映射标定未校准，见 negotiation.reference.note。 */
  elo?: { rating: number; suggested_difficulty: string };
  /** 决策点的协商记录（设计稿 §7.4）。冲突时才有 `arbitration`。 */
  negotiation?: DecisionNegotiation;
}

export interface DecisionProposal {
  /** 哪一路信号提的 */
  source: string;
  signal: string;
  decision: string;
  difficulty: string;
  engine: string;
  /** 结构化依据，不是自由文本——仲裁要能比较（§7.5） */
  basis: string[];
}

export interface DecisionNegotiation {
  /** 两路信号是否指向不同动作。false 时不开会，也不调模型。 */
  conflict: boolean;
  proposals: DecisionProposal[];
  reference?: { source: string; rating: number; difficulty: string; basis: string[]; note: string };
  arbitration?: {
    decision: string;
    difficulty: string;
    next_action: string;
    rationale: string;
    engine: 'llm' | 'deterministic';
    /** 被推翻的那一路动作，留着可查 */
    overruled: string;
  };
  final_decision: string;
  final_difficulty: string;
}

export async function POST(req: NextRequest) {
  const base = process.env.GROUNDING_URL;
  if (!base) return new Response(null, { status: 204 });
  try {
    const body = (await req.json()) as {
      quizScore: number;
      currentDifficulty?: string;
      conceptScores?: Record<string, number>;
      learnerRating?: number;
      confidence?: number;
    };
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/quiz-decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({
        quiz_score: body.quizScore,
        current_difficulty: body.currentDifficulty ?? 'L2',
        concept_scores: body.conceptScores ?? {},
        learner_rating: body.learnerRating,
        // 学习者交卷时自报的把握程度（1-5）。未采集就不传——引擎侧 None=未采集
        // 是诚实口径（08-01 修的「信心 3/5」假默认），不许在这里补默认值。
        ...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {}),
      }),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!resp.ok) return new Response(null, { status: 204 });
    const payload = (await resp.json()) as { data?: AdaptiveDecision };
    if (!payload.data) return new Response(null, { status: 204 });
    log.info(
      `Decision for score ${body.quizScore.toFixed(2)}: ${payload.data.decision} → ${payload.data.updated_difficulty}`,
    );
    return apiSuccess(payload.data);
  } catch (err) {
    log.warn(`Decision unavailable: ${String(err)}`);
    return new Response(null, { status: 204 });
  }
}
