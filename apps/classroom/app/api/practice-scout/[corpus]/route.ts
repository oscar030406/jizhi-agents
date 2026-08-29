/**
 * 域级实操项目：学习端读「已发布」清单（公开只读）。
 *
 * 引擎真源 `data/practice_drafts/<corpus>.json`，只有管理员审核发布过的条目才会
 * 从 `/published` 端点出来——这里不加角色闸：内容全是公开仓库的推荐卡，无敏感数据，
 * 与 /api/skills 等只读端点同一口径。引擎不在线就回空清单，学习端按「暂无」渲染，
 * 不报错不兜底编造。
 */

import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('PracticeScout API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ corpus: string }> },
) {
  const { corpus } = await params;
  const base = process.env.GROUNDING_URL;
  if (!base) return apiSuccess({ corpus, projects: [] });
  try {
    const resp = await fetch(
      `${base.replace(/\/$/, '')}/api/practice-scout/${encodeURIComponent(corpus)}/published`,
      { signal: AbortSignal.timeout(8_000), cache: 'no-store' },
    );
    if (!resp.ok) return apiSuccess({ corpus, projects: [] });
    const body = (await resp.json()) as { projects?: unknown[] };
    return apiSuccess({ corpus, projects: body.projects ?? [] });
  } catch (error) {
    log.warn(`read published failed for ${corpus}: ${String(error)}`);
    return apiSuccess({ corpus, projects: [] });
  }
}
