import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('PracticeScoutReleases API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;
  const access = await requireCorpusVisible(corpus, { manage: true });
  if (!access.ok) return access.response;
  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '实操项目服务暂不可用。');
  try {
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}/releases`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        resp.status === 409 ? 409 : 502,
        '发布历史无法读取。',
      );
    }
    return apiSuccess({ publication: body });
  } catch (error) {
    log.warn(`release history failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '实操项目服务暂不可用。');
  }
}
