/**
 * 管理端总览的服务端聚合。
 *
 * 纪律（`docs/03-design/admin-dashboard-spec-20260810.md` §5，**2026-08-14 按实现修正条文**）：
 * 页面上的每个数字都必须来自**可复算的真源文件**，硬编码即造假——
 * `check_metrics.py` 管不到这一页，更要自律。读不到就返回 null，页面显示「—」，不拿旧值顶。
 *
 * 条文原来写的是「只有 metrics.json 与课程墙实时计算两个来源，禁止第三种」。
 * 那条已经被实现越过去了：这一页还读 `concept_graph.json`、`prereq_graph.json`、
 * `eval/kc_coverage/runs/`、`knowledge_base/*_intake/readiness.json`、
 * `data/classroom-jobs/`。**它们都是真源、都能复算，不是造假**，但条文与实现不一致时
 * 下一个人不知道该信哪个，所以改条文而不是改实现。
 * **新增来源要在这里登记**，登记表就是上面这一串。全账
 * `docs/05-evidence/admin-spec-audit-20260814.md` H6。
 *
 * 引擎数据目录是跨应用读取：dev 下 cwd = apps/classroom，引擎在 ../agent-engine。
 * 部署形态可能不同，故 `ENGINE_DATA_DIR` 可覆盖，读不到一律降级不报错。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  CLASSROOM_JOBS_DIR,
  collectSourceIds,
  listClassrooms,
  readClassroom,
} from '@/lib/server/classroom-storage';

// 真源在 knowledge-center.ts（L5 收编）
import { engineDataDir } from '@/lib/server/knowledge-center';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** metrics.json 的一条：值 + 口径 + 复算命令。口径原文必须随数字一起展示。 */
export interface MetricEntry {
  id: string;
  value: string;
  caliber: string;
  source: string;
}

/** 大屏顶栏要的那几条。写死 id 而不是全量铺开——铺全量等于把台账搬过来，读者抓不到重点。 */
const HEADLINE_IDS = [
  'api_hallucination_v2',
  'adaptation_accuracy_2a',
  'kc_coverage_v1',
  'api_interception_v2',
] as const;

/**
 * metrics.json 的 value 有两种形态：带口径说明的整句字符串
 * （`81.5%（44/54，run 20260811-010557）…`），和裸小数（`0.021`）。
 * 裸小数直接印出来是「0.021」，读者得自己心算——按比率渲染成百分数，
 * **不改数值本身**，口径原文照旧随数字展示。
 */
function formatMetricValue(raw: unknown): string {
  if (typeof raw === 'number') {
    return raw >= 0 && raw <= 1 ? `${(raw * 100).toFixed(1)}%` : String(raw);
  }
  return String(raw ?? '');
}

export async function readHeadlineMetrics(): Promise<MetricEntry[]> {
  const data = await readJson<{ metrics: Record<string, Record<string, unknown>> }>(
    path.join(engineDataDir(), 'metrics.json'),
  );
  if (!data?.metrics) return [];
  return HEADLINE_IDS.flatMap((id) => {
    const m = data.metrics[id];
    if (!m) return [];
    return [
      {
        id,
        value: formatMetricValue(m.value),
        caliber: String(m.caliber ?? ''),
        source: String(m.source ?? ''),
      },
    ];
  });
}

/** 一门课的审核账单汇总。incorrect 与 uncertain 分列，不合并成一个「抓错数」——口径不同。 */
export interface CourseAudit {
  id: string;
  title: string;
  sceneCount: number;
  createdAt: string;
  claims: number;
  incorrect: number;
  uncertain: number;
  grounded: number;
  sources: number;
  /**
   * 这门课引用过的教材片段 id。**全局「引用源去重数」要跨课去重，光有逐课的
   * `sources` 计数加不出来**——两门课引同一段教材，加起来会算成两个源。
   * 设计稿 §2 区 A 点名要这个数，之前一直缺。
   *
   * 口径归 `classroom-storage.ts` 的 `collectSourceIds`（课程卡与 /agents 页的老口径），
   * 这里不再自己数。
   */
  sourceIds: string[];
  verdicts: { pass: number; caveat: number; revised: number; flagged: number };
  auditedScenes: number;
  /** 审核链耗时（逐场景 `audit.durationMs` 累加）。**不是整课生成时长**。 */
  durationMs: number;
  /**
   * 整课生成的墙钟时长（`classroom-jobs` 的 `completedAt - startedAt`）。
   * 设计稿 §2 区 B 点名要这一列，数据一直在盘上没接。
   */
  generatedMs?: number;
  /**
   * 这个 job 运行期间有几个别的 job 在同时跑。
   *
   * **必须与 generatedMs 一起展示。** 实测 32 个 job 里只有 5 个是独占运行的，
   * 其余与最多 5 个 job 时间区间重叠——墙钟时长被并发严重抬高。
   * 只给「76 分」会被读成「一门课要 76 分钟」，那是错的。
   */
  concurrentJobs?: number;
}

/** 一次生成任务的墙钟区间。只取跑成功、且能关联到课程 id 的。 */
interface JobSpan {
  classroomId: string;
  start: number;
  end: number;
}

/**
 * 读生成任务的时间账。
 *
 * 并发数由**时间区间重叠**算，不看 job 的创建批次——同一批创建的 job 可能串行执行，
 * 不同批创建的也可能碰上。重叠才是「这段时间机器上还有别的活」的真判据。
 */
async function readJobSpans(): Promise<Map<string, { ms: number; concurrent: number }>> {
  const dir = CLASSROOM_JOBS_DIR;
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return new Map();
  }
  const spans: JobSpan[] = [];
  for (const f of files) {
    const j = await readJson<unknown>(path.join(dir, f));
    if (!isRecord(j)) continue;
    const classroomId = asRecord(j.result).classroomId;
    const start = Date.parse(String(j.startedAt ?? ''));
    const end = Date.parse(String(j.completedAt ?? ''));
    if (!classroomId || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    spans.push({ classroomId: String(classroomId), start, end });
  }
  const out = new Map<string, { ms: number; concurrent: number }>();
  for (const s of spans) {
    const concurrent = spans.filter((o) => o !== s && o.start < s.end && o.end > s.start).length;
    // 同一门课重跑过多次时保留最近一次（文件遍历顺序不保证，按结束时间比）
    const prev = out.get(s.classroomId);
    if (!prev || s.end - s.start !== prev.ms)
      out.set(s.classroomId, { ms: s.end - s.start, concurrent });
  }
  return out;
}

const EMPTY_VERDICTS = { pass: 0, caveat: 0, revised: 0, flagged: 0 };

function isVerdict(v: unknown): v is keyof typeof EMPTY_VERDICTS {
  return typeof v === 'string' && v in EMPTY_VERDICTS;
}

export async function readCourseAudit(id: string): Promise<CourseAudit | null> {
  const course = await readClassroom(id);
  if (!course) return null;
  const verdicts = { ...EMPTY_VERDICTS };
  const sourceIds = collectSourceIds(course.scenes ?? []);
  let claims = 0;
  let incorrect = 0;
  let uncertain = 0;
  let grounded = 0;
  let auditedScenes = 0;
  let durationMs = 0;

  for (const scene of course.scenes ?? []) {
    const audit = (scene as { audit?: Record<string, unknown> }).audit;
    if (!audit) continue;
    auditedScenes += 1;
    if (isVerdict(audit.verdict)) verdicts[audit.verdict] += 1;
    claims += Number(audit.totalClaims ?? 0);
    incorrect += Number(audit.incorrectCount ?? 0);
    uncertain += Number(audit.uncertainCount ?? 0);
    if (audit.grounded) grounded += 1;
    durationMs += Number(audit.durationMs ?? 0);
  }

  return {
    id,
    title: course.stage?.name ?? id,
    sceneCount: course.scenes?.length ?? 0,
    createdAt: course.createdAt ?? '',
    claims,
    incorrect,
    uncertain,
    grounded,
    sources: sourceIds.size,
    sourceIds: [...sourceIds],
    verdicts,
    auditedScenes,
    durationMs,
  };
}

export async function readAllCourseAudits(): Promise<CourseAudit[]> {
  const list = await listClassrooms();
  const [rows, spans] = await Promise.all([
    Promise.all(list.map((c) => readCourseAudit(c.id))),
    readJobSpans(),
  ]);
  // 默认按判错数降序：管理者第一眼要看到判官在哪门课抓得最狠，不是按时间倒序看新课
  return rows
    .filter((r): r is CourseAudit => r !== null)
    .map((r) => {
      const span = spans.get(r.id);
      return span ? { ...r, generatedMs: span.ms, concurrentJobs: span.concurrent } : r;
    })
    .sort((a, b) => b.incorrect - a.incorrect);
}

/**
 * 下钻页要摊开哪些判词。
 *
 * 判为 `supported` 的一般不看——2231 条断言里绝大多数是它，全铺开就没人读了。
 * **但带改文（`fix`）的必须收进来**：判官认了这条断言、却仍给出改写，那同样是一次
 * 真实的干预，滤掉等于少报了干预量。全库这种 13 条。
 *
 * 2026-08-14 逐条对设计稿复审时发现的：`fix` 字段全库 138 条（56 条判错里 55 条有），
 * 下钻页此前一条都没渲染，而设计稿 §2 区 C 与演示台本要的正是
 * 「原句 claim / 判词 reason / 改文 fix」三栏。数据一直在盘上，只是没接出来。
 */
export function notableClaims<T extends { verdict?: string; fix?: string }>(
  claims: readonly T[] | undefined,
): T[] {
  return (claims ?? []).filter((c) => c.verdict !== 'supported' || Boolean(c.fix));
}

/** 领域接入的就绪度报告：`scripts/ingest_domain.py` 的产物。 */
export interface DomainIntake {
  domain: string;
  scope: string;
  sourceDir: string;
  license: { spdx: string; unknown: boolean };
  acceptedFiles: number;
  rejectedFiles: number;
  sections: number;
  conceptCount: number;
  chapterCount: number;
  chapterEdges: number;
  candidateEdges: number;
  nodeEdges: number;
  gates: { retrievable: boolean; vocabulary: boolean; graph: boolean; itemMapping: boolean };
  /** 入库并可检索的 chunk 数。0 = 这个域生成课程时没有素材可取。 */
  chunks: number;
  tierRange: string;
}

export async function readDomainIntakes(): Promise<DomainIntake[]> {
  const kb = path.join(engineDataDir(), 'knowledge_base');
  let dirs: string[];
  try {
    dirs = (await fs.readdir(kb, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.endsWith('_intake'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const rows = await Promise.all(
    dirs.map(async (dir) => {
      const raw = await readJson<unknown>(path.join(kb, dir, 'readiness.json'));
      if (!isRecord(raw) || !isRecord(raw.corpus_index)) return null;
      const r = raw;
      const corpusIndex = raw.corpus_index;
      const prereqGraphChapter = asRecord(r.prereq_graph_chapter);
      const chapterClauses = asRecord(prereqGraphChapter.clauses);
      const structureSignals = asRecord(r.structure_signals);
      const prereqGraph = asRecord(r.prereq_graph);
      const nodeClauses = asRecord(prereqGraph.clauses);
      const license = asRecord(r.license);
      const intake = asRecord(r.intake);
      const readiness = asRecord(r.readiness);
      const difficulty = asRecord(r.difficulty);
      // `corpus_index` 为空 = 这次接入没落成检索索引（盘上只剩一份就绪度报告）。
      // 这种半成品卡片在管理端看着像「已接入的第七个库」，实际引擎的库名单里根本没有它
      // （现存例子：`iotdb2_intake`）。不显示，也不给它编中文名——真接入了再说。
      let chapterEdges = Object.keys(chapterClauses).length;
      let chapterCount = Number(structureSignals.chapters ?? 0);
      let candidateEdges = Number(structureSignals.candidate_edges ?? 0);
      // 章级那一层可以由 `ingest_domain.py --structure-only` 单独跑出来（它比全链便宜
      // 一个数量级：词表抽取才是贵的那一步）。那条路径只落审计文件，不重写 readiness.json，
      // 所以这里补读一次——否则跑过结构层的域在总览上仍显示「—」，看着像没做。
      if (!chapterEdges) {
        const audit = asRecord(
          await readJson<unknown>(path.join(kb, dir, 'prereq_chapter_audit.json')),
        );
        if (Array.isArray(audit.edges)) {
          candidateEdges = candidateEdges || audit.edges.length;
          chapterEdges = audit.edges.filter((edge) => Boolean(asRecord(edge).passed)).length;
          chapterCount = chapterCount || Object.keys(asRecord(audit.names)).length;
        }
      }
      return {
        domain: String(r.domain ?? dir.replace(/_intake$/, '')),
        scope: String(r.scope ?? ''),
        sourceDir: String(r.source_dir ?? ''),
        license: {
          spdx: String(license.spdx ?? 'UNKNOWN'),
          unknown: Boolean(license.unknown),
        },
        acceptedFiles: Number(intake.accepted_files ?? 0),
        rejectedFiles: Array.isArray(intake.rejected) ? intake.rejected.length : 0,
        sections: Number(intake.sections ?? 0),
        conceptCount: Array.isArray(r.concepts) ? r.concepts.length : 0,
        chapterCount,
        chapterEdges,
        candidateEdges,
        nodeEdges: Object.keys(nodeClauses).length,
        chunks: Number(corpusIndex.chunks ?? 0),
        gates: {
          // 闸零：语料进没进可检索的库。这一步在 08-13 之前是缺的——接入链产出了
          // 就绪度报告，语料却检索不到，换领域生成课程无素材可取。
          retrievable: Number(corpusIndex.chunks ?? 0) > 0,
          vocabulary: Boolean(readiness.gate1_vocabulary),
          // 闸二按**实际边数**算，不照抄 readiness.json 里那个布尔值：
          // 章级那一层可以由 `--structure-only` 事后单独补跑，它不重写 readiness.json，
          // 于是那个布尔值会停在补跑之前的状态（实测 iotdb：章级 8 条边在手，
          // readiness 仍写着 gate2=false）。陈旧的闸位比没有闸位更误导。
          graph:
            chapterEdges > 0 ||
            Object.keys(nodeClauses).length > 0 ||
            Boolean(readiness.gate2_graph_connected),
          itemMapping: Boolean(readiness.gate3_item_mapping),
        },
        tierRange: String(difficulty.tier_range ?? ''),
      } satisfies DomainIntake;
    }),
  );
  return rows
    .filter((r): r is DomainIntake => r !== null)
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/** 课程墙的实时汇总。所有数字当场从课程文件算，不读缓存也不硬编码。 */
export function rollup(courses: CourseAudit[]) {
  const acc = courses.reduce(
    (a, c) => ({
      courses: a.courses + 1,
      scenes: a.scenes + c.sceneCount,
      audited: a.audited + c.auditedScenes,
      claims: a.claims + c.claims,
      incorrect: a.incorrect + c.incorrect,
      uncertain: a.uncertain + c.uncertain,
      grounded: a.grounded + c.grounded,
    }),
    { courses: 0, scenes: 0, audited: 0, claims: 0, incorrect: 0, uncertain: 0, grounded: 0 },
  );
  // 跨课去重：两门课引同一段教材只算一个源。逐课 sources 相加会重复计数。
  const distinctSources = new Set(courses.flatMap((c) => c.sourceIds)).size;
  return {
    ...acc,
    distinctSources,
    // 这个占比是**课程审核链**的口径，与 metrics.json 的 api_hallucination_v2（评测链）
    // 不可混比。同屏出现时必须各标各的口径，见 spec §5。
    incorrectRate: acc.claims ? acc.incorrect / acc.claims : null,
    groundedRate: acc.audited ? acc.grounded / acc.audited : null,
  };
}
