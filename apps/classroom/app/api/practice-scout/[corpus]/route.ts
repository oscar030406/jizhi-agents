/**
 * 域级实操项目：学习端读「已发布」清单（公开只读）。
 *
 * 引擎真源是追加式发布版本库；草稿与学习端读取完全分离，只有管理员审核发布过的条目才会
 * 从 `/published` 端点出来——这里不加角色闸：内容全是公开仓库的推荐卡，无敏感数据，
 * 与 /api/skills 等只读端点同一口径。空清单必须区分两种原因：引擎明确返回空，
 * 是尚未生成/发布；引擎不可达，是状态无法确认。两者都不兜底其它领域项目。
 */

import type { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('PracticeScout API');

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
      projects: [],
      reason: '实操项目引擎尚未配置，当前无法确认该领域是否已有生成结果',
    });
  }
  try {
    const resp = await fetch(
      `${base.replace(/\/$/, '')}/api/practice-scout/${encodeURIComponent(corpus)}/published`,
      { signal: AbortSignal.timeout(8_000), cache: 'no-store' },
    );
    if (resp.status === 409) {
      const body = (await resp.json().catch(() => ({}))) as { detail?: string };
      return apiSuccess({
        corpus,
        status: 'missing',
        projects: [],
        reason: `旧发布项目不符合当前门禁，请管理者重新生成并审核${body.detail ? `：${body.detail}` : ''}`,
      });
    }
    if (!resp.ok) {
      return apiSuccess({
        corpus,
        status: 'unavailable',
        projects: [],
        reason: `实操项目服务返回异常（状态码 ${resp.status}），当前无法确认生成状态`,
      });
    }
    const body = (await resp.json()) as { projects?: unknown[] };
    const projects = body.projects ?? [];
    return apiSuccess({
      corpus,
      status: projects.length > 0 ? 'ready' : 'missing',
      projects,
      ...(projects.length === 0 ? { reason: '所属机构尚未提供该领域的实操项目' } : {}),
    });
  } catch (error) {
    log.warn(`read published failed for ${corpus}: ${String(error)}`);
    return apiSuccess({
      corpus,
      status: 'unavailable',
      projects: [],
      reason: '实操项目引擎暂时不可用，当前无法确认生成状态',
    });
  }
}
