/**
 * 课程墙按学习路径分阶：把「已发布课程」挂到引擎排出来的阶次上。
 *
 * 阶次不是这里排的——拓扑分层由引擎 `/internal/v1/personalize/domain-path/{corpus}`
 * 算（与 /path 页同一个产物、同一批阶）。这条路由只做两件事：
 *   1. 把每门课的场景概念票汇总成一个主概念（口径同 `pickPrimaryConcept`）；
 *   2. 用概念 id 查它落在第几阶。
 *
 * 查不到概念、或概念不在本域路径里的课，一律进 `ungroupedCourseIds`——**不隐藏**。
 * 课程墙上少一门课比多一个错误的阶次更难解释：访客数不出来，只会以为课没了。
 *
 * 引擎不可达时整条返回 502，前端退回不分组的平铺墙（真实降级，不编阶次）。
 */

import type { NextRequest } from 'next/server';

import { corpusOwnership } from '@/lib/accounts/org-store';
import { pickPrimaryConcept } from '@/lib/evidence/scene-concepts';
import sceneConceptTable from '@/lib/evidence/data/scene-concepts.json';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { listClassrooms, readClassroom } from '@/lib/server/classroom-storage';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { canReadCourse, courseReaderForRequest } from '@/lib/server/course-access';
import { readCourseDomains } from '@/lib/server/course-domains';

const log = createLogger('CoursePath API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 15_000;

/** 事后反推表：新课在生成时就把概念写进场景，老课只有这张表。两条都用。 */
const DERIVED: Record<string, { votes?: Record<string, number> }> =
  (sceneConceptTable as { scenes?: Record<string, { votes?: Record<string, number> }> }).scenes ??
  {};

interface EngineStage {
  index: number;
  title: string;
  concepts?: Array<{ id?: string; name: string }>;
}

/** 一门课的主概念：全部场景的概念票相加取最高，并列按码点定序（同 pickPrimaryConcept）。 */
function primaryConcept(scenes: ReadonlyArray<Record<string, unknown>>): string | null {
  const votes: Record<string, number> = {};
  for (const scene of scenes) {
    const own = (scene.concepts as { votes?: Record<string, number> } | undefined)?.votes;
    const table = DERIVED[String(scene.id ?? '')]?.votes;
    for (const [name, n] of Object.entries(own ?? table ?? {})) {
      votes[name] = (votes[name] ?? 0) + n;
    }
  }
  return pickPrimaryConcept(votes);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;
  const access = await requireCorpusVisible(corpus);
  if (!access.ok) return access.response;

  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '学习路径服务尚未启用。');

  try {
    const resp = await fetch(
      `${base}/internal/v1/personalize/domain-path/${encodeURIComponent(corpus)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
        },
        // 课程墙对所有人是同一面墙：不带画像、不带掌握度，拿的就是知识库本身的阶次。
        body: JSON.stringify({ corpus, profile: { domain: corpus, corpus }, masteryVector: {} }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    if (!resp.ok) {
      log.warn(`domain path HTTP ${resp.status} for ${corpus}`);
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '学习路径服务返回错误。');
    }
    const envelope = (await resp.json()) as { data?: unknown } | null;
    const path = (envelope && typeof envelope === 'object' && 'data' in envelope
      ? envelope.data
      : envelope) as {
      source?: string;
      concept_count?: number;
      edge_count?: number;
      stages?: EngineStage[];
    } | null;
    const engineStages = path?.stages ?? [];
    if (!engineStages.length) {
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '该领域当前没有可用的阶次产物。');
    }

    const stageOfConcept = new Map<string, number>();
    for (const stage of engineStages) {
      for (const concept of stage.concepts ?? []) {
        stageOfConcept.set(concept.id ?? concept.name, stage.index);
      }
    }

    const [domains, summaries, ownership, reader] = await Promise.all([
      readCourseDomains(),
      listClassrooms({ learnerReleasedOnly: true }),
      corpusOwnership(),
      courseReaderForRequest(request),
    ]);

    const stageCourses = new Map<number, string[]>(engineStages.map((s) => [s.index, []]));
    const ungroupedCourseIds: string[] = [];
    /**
     * courseId → 主概念 id（null = 这门课的场景一条概念票都没有）+ 生成期画像摘要。
     * 画像那两项给首页的「画像改变了什么」用：同一个概念下两份画像出的课不一样，
     * 这是盘上真有的对照，不是举例。老课没有 `generation` 字段，两项都缺省。
     */
    const courses: Record<
      string,
      { concept: string | null; tier?: string; profileFields?: string[] }
    > = {};

    for (const summary of summaries) {
      if (domains[summary.id]?.domain !== corpus) continue;
      const classroom = await readClassroom(summary.id).catch(() => null);
      if (!classroom || !canReadCourse(summary.id, classroom, reader, ownership)) continue;
      const concept = primaryConcept(
        (classroom.scenes ?? []) as unknown as Array<Record<string, unknown>>,
      );
      const meta = classroom.generation;
      courses[summary.id] = {
        concept,
        ...(meta?.presentationTier ? { tier: meta.presentationTier } : {}),
        // domain/corpus 是取材范围不是画像自评，摘要里不算一项。
        ...(meta?.profile
          ? {
              profileFields: Object.entries(meta.profile)
                .filter(([k, v]) => k !== 'domain' && k !== 'corpus' && v !== undefined)
                .map(([k]) => k),
            }
          : {}),
      };
      const index = concept ? stageOfConcept.get(concept) : undefined;
      if (index === undefined) ungroupedCourseIds.push(summary.id);
      else stageCourses.get(index)!.push(summary.id);
    }

    return apiSuccess({
      corpus,
      source: path?.source ?? null,
      conceptCount: path?.concept_count ?? 0,
      edgeCount: path?.edge_count ?? 0,
      stages: engineStages.map((stage) => ({
        index: stage.index,
        title: stage.title,
        conceptIds: (stage.concepts ?? []).map((c) => c.id ?? c.name),
        courseIds: stageCourses.get(stage.index) ?? [],
      })),
      ungroupedCourseIds,
      courses,
    });
  } catch (error) {
    log.warn(`course path failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '学习路径服务暂时不可用。');
  }
}
