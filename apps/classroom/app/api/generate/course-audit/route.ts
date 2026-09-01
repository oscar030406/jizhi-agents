import { NextRequest } from 'next/server';
import { auditCourseContent } from '@/lib/generation/hallucination-audit';
import { evidenceForJudge, fetchEvidence } from '@/lib/generation/evidence-grounding';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { buildAuditPanel } from '@/lib/server/audit-panel';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('Course Audit API');
const MAX_SCENES = 64;
const MAX_INPUT_CHARS = 2_000_000;

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      courseTitle?: string;
      corpus?: string;
      scenes?: Scene[];
    };
    const courseTitle = body.courseTitle?.trim();
    if (!courseTitle || !Array.isArray(body.scenes) || body.scenes.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'courseTitle and scenes are required');
    }

    const corpus = body.corpus?.trim() || 'ai';
    const access = await requireCorpusVisible(corpus);
    if (!access.ok) return access.response;
    if (!access.account) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '登录后才能发起全课程终审。');
    }
    if (body.scenes.length > MAX_SCENES) {
      return apiError('INVALID_REQUEST', 413, `scenes must not exceed ${MAX_SCENES}`);
    }
    const inputChars = courseTitle.length + corpus.length + JSON.stringify(body.scenes).length;
    if (inputChars > MAX_INPUT_CHARS) {
      return apiError('INVALID_REQUEST', 413, 'course audit input is too large');
    }

    const generator = await resolveModelFromRequest(req, body, 'scene-content');
    const panel = await buildAuditPanel(generator);
    const bundles = await Promise.all(
      body.scenes.map((scene) => fetchEvidence(`${courseTitle} ${scene.title}`.trim(), corpus)),
    );
    const chunks = new Map(
      bundles.flatMap((bundle) => bundle?.chunks ?? []).map((chunk) => [chunk.source_id, chunk]),
    );
    const approved = [...chunks.values()];
    const audit = await auditCourseContent({
      courseTitle,
      scenes: body.scenes,
      judgeCalls: panel.judgeCalls,
      ...(panel.arbiterCall ? { arbiterCall: panel.arbiterCall } : {}),
      defendCall: panel.defendCall,
      judgeModel: panel.judgeModel,
      judgeModels: panel.judgeModels,
      ...(panel.arbiterModel ? { arbiterModel: panel.arbiterModel } : {}),
      corpus,
      ...(approved.length
        ? {
            evidence: evidenceForJudge({ chunks: approved, matchedConcepts: [], summary: '' }),
            evidenceCount: approved.length,
            sources: approved.map((chunk) => ({
              source_id: chunk.source_id,
              title: chunk.title,
            })),
            retrieveForClaim: async (claimText: string) => {
              const hit = await fetchEvidence(claimText, corpus);
              return hit
                ? {
                    evidence: evidenceForJudge(hit),
                    count: hit.chunks.length,
                    sources: hit.chunks.map((chunk) => ({
                      source_id: chunk.source_id,
                      title: chunk.title,
                    })),
                  }
                : null;
            },
          }
        : { evidenceCount: 0 }),
    });

    log.info(
      `Course audit "${courseTitle}": ${audit.verdict}/${audit.decision} [${panel.describe}]`,
    );
    return apiSuccess({ audit });
  } catch (error) {
    log.error('Course audit failed:', error);
    return llmApiError(error);
  }
}
