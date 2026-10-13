/**
 * Learner-blueprint proxy.
 *
 * `fetchLearnerBlueprint` is server-only (it reads GROUNDING_URL /
 * GROUNDING_TOKEN from process.env), so the report page cannot call it
 * directly. This route is the thin client-facing seam: same call, same
 * degradation contract as the other adaptive route — 204 when the engine is
 * unreachable, which the page renders as an explicit "engine offline" empty
 * state rather than filling the charts with invented numbers.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiSuccess } from '@/lib/server/api-response';
import {
  corpusOf,
  fetchLearnerBlueprint,
  type LearnerProfileInput,
} from '@/lib/generation/learner-profile';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { dispatch } from '@/lib/server/classroom-dispatch';

/** 这一类的执行上限：与 fetchLearnerBlueprint 自己的 25 秒超时同值 */
const BLUEPRINT_LIMIT_MS = 25_000;

const log = createLogger('Adaptive Blueprint');

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      learningGoal?: string;
      profile?: LearnerProfileInput;
    };
    const goal = body.learningGoal?.trim();
    if (!goal) return new Response(null, { status: 204 });
    const access = await requireCorpusVisible(corpusOf(body.profile) ?? 'ai');
    if (!access.ok) return access.response;

    const blueprint = await dispatch(
      {
        jobClass: 'blueprint',
        // 这一类的代价主项是引擎那句模型摘要；同类中位数 8 秒（线上日志 n=492），
        // 目标串越长提示越长，给一个很小的线性项。系数没有标定，只用来排序。
        predictedCostS: 8 + Math.min(goal.length, 200) / 50,
        limitMs: BLUEPRINT_LIMIT_MS,
        meta: {
          corpus: corpusOf(body.profile) ?? 'ai',
          goalChars: goal.length,
          conceptMasteryKeys: Object.keys(body.profile?.conceptMastery ?? {}).length,
        },
      },
      () => fetchLearnerBlueprint(goal, body.profile ?? {}),
      (value) => ({ blueprintReturned: value !== null }),
    );
    if (!blueprint) return new Response(null, { status: 204 });

    log.info(
      `Blueprint for "${goal.slice(0, 24)}": ${blueprint.recommended_difficulty}, ` +
        `${blueprint.weak_concepts.length} weak concepts`,
    );
    return apiSuccess({ blueprint });
  } catch (err) {
    log.warn(`Blueprint unavailable: ${String(err)}`);
    return new Response(null, { status: 204 });
  }
}
