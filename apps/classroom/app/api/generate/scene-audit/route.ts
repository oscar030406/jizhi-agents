/**
 * Scene Hallucination Audit API
 *
 * Sits between scene-content and scene-actions: an independent judge model
 * extracts and verifies every factual claim in the generated content, the
 * generator model gets one revision pass for flagged claims, and the verdict
 * trail is returned for the classroom UI to display.
 *
 * Judge model resolution: MODEL_ROUTES['scene-audit'] > AUDIT_MODEL env >
 * request model (self-audit fallback — weaker, but the stage never blocks).
 */

import { NextRequest } from 'next/server';
import { auditSceneContent } from '@/lib/generation/hallucination-audit';
import { fetchEvidence, evidenceForJudge } from '@/lib/generation/evidence-grounding';
import { corpusOf } from '@/lib/generation/learner-profile';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildAuditPanel } from '@/lib/server/audit-panel';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { SceneOutline } from '@/lib/types/generation';

const log = createLogger('Scene Audit API');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let outlineTitle: string | undefined;
  try {
    const body = await req.json();
    const { outline, content, courseTitle, learnerProfile } = body as {
      outline: SceneOutline;
      content: unknown;
      courseTitle?: string;
      // 判官必须读**正文所用的那本书**。缺了这个字段，判官一律读默认（ai）语料，
      // 换库生成的课就会被别的领域的资料判成幻觉——幻觉率口径的地基。
      learnerProfile?: { domain?: string; corpus?: string };
    };
    const corpus = corpusOf(learnerProfile);
    if (!outline || content == null) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline and content are required');
    }
    outlineTitle = outline.title;

    // Generator model (request-resolved) — used for the revision pass so the
    // rewrite keeps the original voice.
    const generator = await resolveModelFromRequest(req, body, 'scene-content');

    // 判官团（异族三方）与修订调用统一由 lib/server/audit-panel 组装，
    // 服务端批量生成路径共用同一套口径。
    const panel = await buildAuditPanel(generator);

    log.info(`Auditing scene "${outline.title}" [${panel.describe}] corpus=${corpus ?? 'default'}`);

    // Same retrieval as the content stage — the judge sees the same fact fence.
    const bundle = await fetchEvidence(
      `${courseTitle ?? ''} ${outline.title} ${outline.description ?? ''}`.trim(),
      corpus,
    );

    const { audit, content: auditedContent } = await auditSceneContent({
      sceneTitle: outline.title,
      content,
      judgeCalls: panel.judgeCalls,
      ...(panel.arbiterCall ? { arbiterCall: panel.arbiterCall } : {}),
      reviseCall: panel.reviseCall,
      judgeModel: panel.judgeModel,
      judgeModels: panel.judgeModels,
      ...(panel.arbiterModel ? { arbiterModel: panel.arbiterModel } : {}),
      sceneType: outline.type,
      ...(bundle
        ? {
            evidence: evidenceForJudge(bundle),
            evidenceCount: bundle.chunks.length,
            // 取材来源随审核结论入库，审核弹层据此标注——换了库要看得见换了。
            ...(corpus ? { corpus } : {}),
            sources: bundle.chunks.map((c) => ({ source_id: c.source_id, title: c.title })),
            // Claim-level retrieval for uncertain verdicts. Only offered when the
            // scene was grounded at all — with no corpus reachable there is
            // nothing to re-query, and pretending otherwise would just burn calls.
            retrieveForClaim: async (claimText: string) => {
              const hit = await fetchEvidence(claimText, corpus);
              return hit
                ? {
                    evidence: evidenceForJudge(hit),
                    count: hit.chunks.length,
                    sources: hit.chunks.map((c) => ({
                      source_id: c.source_id,
                      title: c.title,
                    })),
                  }
                : null;
            },
          }
        : {}),
    });

    log.info(
      `Audit done "${outline.title}": verdict=${audit.verdict} claims=${audit.totalClaims} flagged=${audit.flaggedCount} rounds=${audit.rounds} disputes=${audit.debate?.length ?? '-'} in ${audit.durationMs}ms`,
    );

    return apiSuccess({ audit, content: auditedContent });
  } catch (error) {
    log.error(`Scene audit failed [scene="${outlineTitle ?? 'unknown'}"]:`, error);
    return llmApiError(error);
  }
}
