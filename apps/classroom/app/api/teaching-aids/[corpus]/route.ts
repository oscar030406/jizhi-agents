/**
 * 外部可视化教具：学习端读「已发布」清单（公开只读）。
 *
 * 与 /api/practice-scout/[corpus] 同一口径：引擎的真源是追加式发布版本库，只有管理员
 * 审核发布过的教具才会从 `/published` 出来；这里不加角色闸——卡片内容全是公开仓库信息
 * 与公开演示站地址，无敏感数据。空清单必须区分两种原因：引擎明确返回空，是尚未发布；
 * 引擎不可达，是状态无法确认。两者都不兜底其它领域的教具。
 */

import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('TeachingAids API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;
  const access = await requireCorpusVisible(corpus);
  if (!access.ok) return access.response;
  const base = process.env.GROUNDING_URL;
  if (!base) {
    return apiSuccess({
      corpus,
      status: 'unavailable',
      aids: [],
      reason: '教具服务尚未配置，当前无法确认该领域是否已有可用教具',
    });
  }
  try {
    const resp = await fetch(
      `${base.replace(/\/$/, '')}/api/teaching-aids/${encodeURIComponent(corpus)}/published`,
      { signal: AbortSignal.timeout(8_000), cache: 'no-store' },
    );
    if (resp.status === 409) {
      const body = (await resp.json().catch(() => ({}))) as { detail?: string };
      return apiSuccess({
        corpus,
        status: 'missing',
        aids: [],
        reason: `已发布教具不符合当前门禁，请管理者重新生成并审核${body.detail ? `：${body.detail}` : ''}`,
      });
    }
    if (!resp.ok) {
      return apiSuccess({
        corpus,
        status: 'unavailable',
        aids: [],
        reason: `教具服务返回异常（状态码 ${resp.status}），当前无法确认发布状态`,
      });
    }
    const body = (await resp.json()) as { aids?: unknown[] };
    const aids = body.aids ?? [];
    return apiSuccess({
      corpus,
      status: aids.length > 0 ? 'ready' : 'missing',
      aids,
      ...(aids.length === 0 ? { reason: '所属机构尚未发布该领域的外部教具' } : {}),
    });
  } catch (error) {
    log.warn(`read published aids failed for ${corpus}: ${String(error)}`);
    return apiSuccess({
      corpus,
      status: 'unavailable',
      aids: [],
      reason: '教具服务暂时不可用，当前无法确认发布状态',
    });
  }
}
