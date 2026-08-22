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
import { fetchLearnerBlueprint, type LearnerProfileInput } from '@/lib/generation/learner-profile';

const log = createLogger('Adaptive Blueprint');

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      learningGoal?: string;
      profile?: LearnerProfileInput;
    };
    const goal = body.learningGoal?.trim();
    if (!goal) return new Response(null, { status: 204 });

    const blueprint = await fetchLearnerBlueprint(goal, body.profile ?? {});
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
