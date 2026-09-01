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
import { extractContentVerifiables, verifyContent } from '@/lib/generation/content-verify';
import { fetchEvidence, evidenceForJudge } from '@/lib/generation/evidence-grounding';
import { corpusOf } from '@/lib/generation/learner-profile';
import { isAuditGateEnabled } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildAuditPanel } from '@/lib/server/audit-panel';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
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
    const access = await requireCorpusVisible(corpus ?? 'ai');
    if (!access.ok) return access.response;
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

    // 消融开关：`AUDIT_GATE=0` 时逐屏路也跳过审核，与整课路同一口径。
    // 两条路都要挡——只挡一条的话消融跑出来的「关审核门」那一档，
    // 其实有一半的屏还在被审。
    if (!isAuditGateEnabled()) {
      log.warn(`[消融] AUDIT_GATE=0，"${outline.title}" 跳过事实审核，本屏不带判词`);
      return apiSuccess({ content, audit: null });
    }
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

    // 审核可能修订正文，因此验算必须针对修订后的最终版本，而不是 scene-content
    // 路由里的中间稿。桥不可达时返回 null，发布门禁会把有算式的场景保留为草稿。
    const { codeBlocks, texts } = extractContentVerifiables(auditedContent);
    const verification = await verifyContent(codeBlocks, texts, (message) =>
      log.warn(`Final-content verification unavailable for "${outline.title}": ${message}`),
    );

    return apiSuccess({ audit, content: auditedContent, verification });
  } catch (error) {
    log.error(`Scene audit failed [scene="${outlineTitle ?? 'unknown'}"]:`, error);
    return llmApiError(error);
  }
}
