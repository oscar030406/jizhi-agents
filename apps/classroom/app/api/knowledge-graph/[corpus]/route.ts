/**
 * 知识宇宙的取数口：把引擎那张「概念 / 教材 / 章节 / 证据块」结构图透给学习端。
 *
 * **要过机构可见性闸**。图里带着章节标题和切片标题——私有教材的目录本身就是
 * 不愿外传的东西，取数口一个都不能漏（/api/domains、/api/skills、/api/domain-path
 * 都做了过滤，这是第四个）。
 *
 * 课程节点与掌握度**不在这里合**：/path 那一页已经各拉过一次
 * （/api/course-domains 拿标题、/api/course-path 拿课程主概念、/api/domain-path
 * 拿掌握度），合并放在组件里的纯函数 mergeKnowledgeUniverse 做。桥再拉一遍
 * 等于把 fetchLearnerBlueprint 那次诊断调用打两次，页面加载时间翻倍，换来的是
 * 同一份数据。
 */

import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';

const log = createLogger('KnowledgeGraph API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 首次构建要读一遍全量索引（AI 库 3456 行），之后是引擎盘上缓存。 */
const TIMEOUT_MS = 15_000;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;

  const access = await requireCorpusVisible(corpus);
  if (!access.ok) return access.response;

  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '知识库图谱服务尚未启用。');
  }

  try {
    const resp = await fetch(`${base}/api/knowledge-graph/${encodeURIComponent(corpus)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!resp.ok) {
      log.warn(`knowledge graph HTTP ${resp.status} for ${corpus}`);
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        502,
        '知识库图谱服务返回错误，暂时取不到这个领域的结构。',
      );
    }
    const graph = (await resp.json()) as { nodes?: unknown } | null;
    if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) {
      log.warn(`knowledge graph malformed payload for ${corpus}`);
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '知识库图谱服务没有给出图数据。');
    }
    return apiSuccess({ graph: graph as Record<string, unknown> });
  } catch (error) {
    log.warn(`knowledge graph failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '知识库图谱服务暂时不可用。');
  }
}
