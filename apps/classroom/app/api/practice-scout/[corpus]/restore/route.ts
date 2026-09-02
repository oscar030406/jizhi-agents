import type { NextRequest } from 'next/server';

import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { createLogger } from '@/lib/logger';
import { currentPracticeCourses } from '@/lib/server/practice-scout-courses';

const log = createLogger('PracticeScoutRestore API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;
  const access = await requireCorpusVisible(corpus, { manage: true });
  if (!access.ok) return access.response;
  const body = (await req.json().catch(() => null)) as { version?: unknown } | null;
  if (!body || !Number.isInteger(body.version) || Number(body.version) < 1) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'version 必须是正整数。');
  }
  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '实操项目服务暂不可用。');
  try {
    const courses = await currentPracticeCourses(corpus, {
      accountId: access.account!.id,
      orgId: access.org!.id,
    });
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}/restore`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({ version: body.version, courses }),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    const publication = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        resp.status === 409 ? 409 : 502,
        resp.status === 409
          ? '该历史版本引用的课程或岗位已变化，不能恢复。'
          : '实操项目服务未能完成恢复。',
      );
    }
    return apiSuccess({ publication });
  } catch (error) {
    log.warn(`restore failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '实操项目服务暂不可用，恢复未生效。');
  }
}
