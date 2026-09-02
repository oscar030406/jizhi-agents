/**
 * 知识库中心的服务端聚合：每个语料库现在建到哪一站，各站的产物文件是什么、什么时候更新的。
 *
 * 管线展示数据直接读取部署时挂载的只读产物目录；机构归属例外：它是权限数据，
 * 只能通过带 `x-internal-token` 的引擎接口读取或释放，Web 进程不碰私有标记文件。
 *
 * | 字段 | 真源 |
 * |---|---|
 * | 语料库名单 | 引擎 `domain_registry.json` 的实时注册项 ∪ `corpora/` 下的目录 ∪ `ai` |
 * | chunk 数 | 数 `knowledge_index.jsonl` 的行数（实测与引擎 `_corpus_status()` 的 chunk_count 三库全等：1704 / 3202 / 307） |
 * | 检索后端 | `knowledge_embeddings.npz` 在不在（在 = 向量，只有 jsonl = TF-IDF，都没有 = 未建库） |
 * | 就绪度 / 许可 / 概念数 | `<name>_intake/readiness.json` |
 * | 金标 | `data/eval/kc_gold_derived/<name>/` 下的 json 文件数 |
 * | 适配性灯 | `data/knowledge_base/fitness.json`（`scripts/corpus_fitness.py` 的产物，全库一份） |
 * | 各站更新时间 | 对应产物文件的 mtime |
 *
 * 为什么管线字段不走引擎 HTTP：这些全是静态产物文件，引擎自己也只是去读同一批文件；多一跳
 * 只多一个「引擎离线页面空白」的失败态。`lib/server/admin-overview.ts` 读同一个目录，
 * 沿用它的 `ENGINE_DATA_DIR` 约定。引擎停机时本页照常出全量数据（实测）。
 *
 * 纪律：任何字段读不到就是 `null`，页面不渲染该字段——不拿占位数顶。
 * 「建成」的判据一律是产物文件存在，不是任务状态：没有任务系统就没有进度条。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { domainLabel } from '@/lib/knowledge/domain-labels';

/** 引擎数据目录——唯一真源（admin-overview 也 import 这份；2026-08-28 清查 L5 前各抄一份）。 */
export function engineDataDir(): string {
  return process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data');
}

function engineOwnershipApi(pathname = ''): { url: string; token: string } {
  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  const token = process.env.GROUNDING_TOKEN;
  if (!base || !token) throw new Error('知识库归属服务未配置');
  return { url: `${base}/api/domain-intake/corpus-owners${pathname}`, token };
}

/** 成功入库链随语料产物写下的机构归属；没有标记的存量库仍是公共库。 */
export async function readCorpusOwnerMarkers(): Promise<Map<string, string>> {
  const endpoint = engineOwnershipApi();
  const response = await fetch(endpoint.url, {
    headers: { 'x-internal-token': endpoint.token },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`知识库归属服务返回 HTTP ${response.status}`);
  const body = (await response.json()) as { ownership?: Record<string, unknown> };
  if (!body.ownership || typeof body.ownership !== 'object' || Array.isArray(body.ownership)) {
    throw new Error('知识库归属服务响应格式错误');
  }
  const ownership = new Map<string, string>();
  for (const [corpus, owner] of Object.entries(body.ownership)) {
    if (!isValidCorpusName(corpus) || typeof owner !== 'string' || !owner.trim()) {
      throw new Error('知识库归属服务返回非法归属');
    }
    ownership.set(corpus, owner.trim());
  }
  return ownership;
}

/** 请求引擎进程释放归属；404 表示只有兼容归属行，没有引擎标记。 */
export async function releaseCorpusOwnerMarker(
  corpus: string,
  actorOrgId: string,
): Promise<boolean> {
  if (!isValidCorpusName(corpus) || !actorOrgId) return false;
  const endpoint = engineOwnershipApi(`/${encodeURIComponent(corpus)}`);
  const response = await fetch(endpoint.url, {
    method: 'DELETE',
    headers: {
      'x-internal-token': endpoint.token,
      'x-jizhi-owner-org': actorOrgId,
    },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (response.status === 404) return true;
  if (response.status === 403) return false;
  if (!response.ok) throw new Error(`知识库归属释放返回 HTTP ${response.status}`);
  return true;
}

/** 引擎相对路径（`data/...`）→ 本机绝对路径。展示时仍用引擎相对路径，便于复算。 */
export function enginePath(rel: string): string {
  return path.join(engineDataDir(), '..', rel);
}

/** 语料名进路径，字符集照引擎 `get_corpus_retriever` 的正则卡死（外部输入不可信）。 */
export function isValidCorpusName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** 文件 mtime 的 ISO 串；文件不存在返回 null。 */
async function mtime(file: string): Promise<string | null> {
  try {
    return (await fs.stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * jsonl 的行数 = chunk 数。
 *
 * ponytail: 整文件读进内存再数行（最大的 iotdb 索引 4.8 MB）。天花板是语料上到几百 MB
 * 时这一页会变慢，那时改成流式计数或让入库链把块数写进产物文件。
 */
async function countLines(file: string): Promise<number | null> {
  try {
    const text = await fs.readFile(file, 'utf-8');
    return text.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return null;
  }
}

/**
 * 目录里的 json 文件数与其中最新的 mtime。
 *
 * 取文件的 mtime 而不是目录的：`kc_gold_derived` 根目录被所有域共用，往里加一个
 * 子目录就会刷新它的 mtime，拿它当 ai 金标的更新时间是错的。
 */
async function jsonFilesIn(dir: string): Promise<{ count: number; newest: string | null } | null> {
  let names: string[];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  } catch {
    return null;
  }
  const stamps = (await Promise.all(names.map((n) => mtime(path.join(dir, n)))))
    .filter((s): s is string => Boolean(s))
    .sort();
  return { count: names.length, newest: stamps.length ? stamps[stamps.length - 1] : null };
}

/** 入库管线的一站。`built` 只由 `path` 指向的产物存不存在决定。 */
export interface PipelineStation {
  id: 'intake' | 'prereq' | 'index' | 'vector' | 'gold';
  label: string;
  /** 这一站做的事，一句话。 */
  what: string;
  built: boolean;
  /** 产物的引擎相对路径。没有产物（未建）时也给出**将来会落在哪**，方便对照磁盘。 */
  path: string;
  /** 产物 mtime = 这一站最后一次更新时间。 */
  updatedAt: string | null;
  /** 从产物里读出来的一句实数说明；读不到就是 null（页面不渲染）。 */
  detail: string | null;
}

/**
 * 语料适配性：这批素材**够不够撑起一门课**，与「建成没建成」是两回事。
 *
 * 五站灯亮满只说明产物文件都在盘上；这一格量的是素材本身。真源是引擎那边
 * `scripts/corpus_fitness.py` 跑出来的一份全库报告，页面只读不算。
 *
 * **只报警不拒绝**：这一格永远不参与任何拦截判断，红灯的库照样能选、能生成。
 * 判据写在产出脚本里，页面不重复一套。灯的判据只有块数够不够铺一门课；
 * `notes` 里那几条画像**没有**通过效果标定，是给人看的线索不是结论——
 * 两者在页面上必须分开呈现，混在一起等于给没验证过的东西背书。
 */
export interface CorpusFitness {
  light: 'red' | 'yellow' | 'green';
  /** 亮黄/红的每条理由一句人话；绿灯为空数组。 */
  why: string[];
  /** 画像里值得看一眼的地方。不判灯。 */
  notes: string[];
  charsMedian: number;
  /** 短于 50 字符的块占比。 */
  shortPct: number;
  titledPct: number;
  latinHeavyPct: number;
  /** 抽样打分的分布。没跑过打分那一闸就是 null。 */
  edu: { sampled: number; scored: number; mean: number | null; ge3Pct: number } | null;
  /** 分最低的块，给人看的清单（不删、不拦）。 */
  lowest: Array<{ title: string; score: number; reason: string; excerpt: string }>;
  /** 报告文件的 mtime。数字是什么时候量的，看的人要能知道。 */
  measuredAt: string | null;
}

export interface CorpusGates {
  /** 闸零：语料进没进可检索的库 */
  retrievable: boolean;
  /** 闸一：概念词表 */
  vocabulary: boolean;
  /** 闸二：前置图连通 */
  graph: boolean;
  /** 闸三：测项映射（全域未实现） */
  itemMapping: boolean;
  /** 人工签字确认过的前置边条数。0 = 全部只作软前置。 */
  reviewedEdges: number;
}

export interface CorpusOverview {
  corpus: string;
  /** 引擎加载这个语料时读的索引路径（与 `_corpus_status()` 的 index_path 同一套规则）。 */
  indexPath: string;
  /** 索引文件存在且非空 = 引擎能加载它。 */
  available: boolean;
  chunks: number | null;
  /** vector = 有 npz；tfidf = 只有 jsonl；none = 未建库。 */
  backend: 'vector' | 'tfidf' | 'none';
  /** 入库时声明的这个域要培养什么人（readiness.json 的 scope）。 */
  scope: string | null;
  license: { spdx: string; unknown: boolean } | null;
  concepts: number | null;
  /**
   * 节级前置边：`readiness.json` 的 `prereq_graph.clauses`（ai 域取共享 `prereq_graph.json`）。
   * 与 `admin-overview.ts` 的 `nodeEdges` 同一口径。没有就绪度报告的库为 null。
   */
  clauses: number | null;
  gates: CorpusGates | null;
  /** 语料适配性。没跑过这道闸的库为 null，页面不渲染这一格。 */
  fitness: CorpusFitness | null;
  /** 金标目录里的 json 文件数。目录不存在为 null，存在但空为 0。 */
  goldFiles: number | null;
  /** 五站产物里最新的那个 mtime。全未建时为 null。 */
  updatedAt: string | null;
  stations: PipelineStation[];
}

/** `readiness.json` 里本页读到的那几个字段（`scripts/ingest_domain.py` 的产物，全是可选）。 */
interface Readiness {
  scope?: string;
  license?: { spdx?: string; unknown?: boolean };
  intake?: { accepted_files?: number; sections?: number };
  concepts?: unknown[];
  prereq_graph?: { clauses?: Record<string, unknown> };
  readiness?: {
    gate1_vocabulary?: boolean;
    gate2_graph_connected?: boolean;
    gate3_item_mapping?: boolean;
    reviewed_edges?: number;
  };
}

/** `fitness.json` 里本页读到的字段。全库一份，键是库名。 */
interface FitnessFile {
  corpora?: Record<
    string,
    {
      light?: string;
      why?: string[];
      notes?: string[];
      gate_a?: {
        chars_median?: number;
        short_pct?: number;
        titled_pct?: number;
        latin_heavy_pct?: number;
      };
      gate_b?: {
        sampled?: number;
        scored?: number;
        mean?: number | null;
        ge3_pct?: number;
        lowest?: Array<{ title?: string; score?: number; reason?: string; excerpt?: string }>;
      };
    }
  >;
}

/**
 * 适配性报告是**一个文件装全部库**，而总览页要为每个库各读一次。按 mtime 记一次，
 * 免得同一次渲染把同一个文件解析七遍。mtime 变了立刻重读——这一格必须跟着磁盘走。
 */
let fitnessCache: { key: string; data: FitnessFile | null } | null = null;

async function readFitnessFile(): Promise<{ data: FitnessFile | null; at: string | null }> {
  const file = enginePath('data/knowledge_base/fitness.json');
  const at = await mtime(file);
  if (!at) return { data: null, at: null };
  if (fitnessCache?.key !== at) fitnessCache = { key: at, data: await readJson<FitnessFile>(file) };
  return { data: fitnessCache.data, at };
}

async function fitnessOf(corpus: string): Promise<CorpusFitness | null> {
  const { data, at } = await readFitnessFile();
  const row = data?.corpora?.[corpus];
  const light = row?.light;
  if (!row || (light !== 'red' && light !== 'yellow' && light !== 'green')) return null;
  const b = row.gate_b;
  return {
    light,
    why: (row.why ?? []).map(String),
    notes: (row.notes ?? []).map(String),
    charsMedian: Number(row.gate_a?.chars_median ?? 0),
    shortPct: Number(row.gate_a?.short_pct ?? 0),
    titledPct: Number(row.gate_a?.titled_pct ?? 0),
    latinHeavyPct: Number(row.gate_a?.latin_heavy_pct ?? 0),
    edu: b
      ? {
          sampled: Number(b.sampled ?? 0),
          scored: Number(b.scored ?? 0),
          mean: b.mean === null || b.mean === undefined ? null : Number(b.mean),
          ge3Pct: Number(b.ge3_pct ?? 0),
        }
      : null,
    lowest: (b?.lowest ?? [])
      .filter((s) => typeof s?.score === 'number')
      .map((s) => ({
        title: String(s.title ?? ''),
        score: Number(s.score),
        reason: String(s.reason ?? ''),
        excerpt: String(s.excerpt ?? ''),
      })),
    measuredAt: at,
  };
}

/** 引擎 `_corpus_status()` 里那条路径规则：默认语料是 ai，其余各自一个子目录。 */
export function indexPathOf(corpus: string): string {
  return corpus === 'ai'
    ? 'data/knowledge_base/knowledge_index.jsonl'
    : `data/knowledge_base/corpora/${corpus}/knowledge_index.jsonl`;
}

/** 语料库名单：实时域注册表为主，磁盘目录补齐尚未登记的管理端可见库。 */
async function corpusRoster(): Promise<string[]> {
  const names = new Set<string>(['ai']);
  const { readDomainRegistry } = await import('@/lib/server/domain-registry');
  const registry = await readDomainRegistry();
  for (const corpus of Object.keys(registry.entries)) {
    if (isValidCorpusName(corpus)) names.add(corpus);
  }
  try {
    const dirs = await fs.readdir(path.join(engineDataDir(), 'knowledge_base', 'corpora'), {
      withFileTypes: true,
    });
    for (const d of dirs) if (d.isDirectory() && isValidCorpusName(d.name)) names.add(d.name);
  } catch {
    /* 没有 corpora 目录：保留实时注册表中的名单 */
  }
  return [...names];
}

/**
 * 五站。站名与产物一一对应，**一站一个文件**——这是「亮灯」能被复核的前提。
 *
 * 与工单原列的五站（语料入库 → 切块 → 索引 → 向量 → 金标）有一处出入：切块没有独立产物，
 * 它的统计（accepted_files / sections）就写在 `readiness.json` 里，与「语料入库」同一个文件；
 * 而前置图有两个独立产物文件却没有站位。所以第二站改挂前置图，切块的数落在第一站的说明里。
 * 拿一个文件点亮两站等于把同一条证据数两遍。
 */
async function stationsOf(corpus: string): Promise<{
  stations: PipelineStation[];
  overview: Omit<CorpusOverview, 'stations' | 'corpus' | 'indexPath' | 'updatedAt'>;
}> {
  const intakeRel = `data/knowledge_base/${corpus}_intake`;
  const indexRel = indexPathOf(corpus);
  const vectorRel = `${path.posix.dirname(indexRel)}/knowledge_embeddings.npz`;
  // 金标：`derive_kc_gold.py --out` 给的是目录。iotdb / odoo 各自一个子目录；
  // ai 那批是直接落在 kc_gold_derived 根下的（当初 --out 就指到根），所以分开取。
  const goldRel =
    corpus === 'ai' ? 'data/eval/kc_gold_derived' : `data/eval/kc_gold_derived/${corpus}`;

  const readiness = await readJson<Readiness>(enginePath(`${intakeRel}/readiness.json`));

  const [intakeAt, indexAt, vectorAt, chunks, gold, fitness] = await Promise.all([
    mtime(enginePath(`${intakeRel}/readiness.json`)),
    mtime(enginePath(indexRel)),
    mtime(enginePath(vectorRel)),
    countLines(enginePath(indexRel)),
    jsonFilesIn(enginePath(goldRel)),
    fitnessOf(corpus),
  ]);

  // 前置图产物与边数。两级分开数，口径与 admin-overview.ts 的领域接入表一致
  // （章级由 `--structure-only` 单独补跑，不重写 readiness.json，所以必须读审计文件）：
  //   章级 = prereq_chapter_audit.json 里 passed 的边
  //   节级 = readiness.json 的 prereq_graph.clauses
  // ai 域没走入库链，它那一支在共享的 prereq_graph.json 里。
  let prereqRel =
    corpus === 'ai'
      ? 'data/knowledge_base/prereq_graph.json'
      : `${intakeRel}/prereq_chapter_audit.json`;
  let chapterEdges: number | null = null;
  let nodeEdges: number | null = null;
  if (corpus === 'ai') {
    const shared = await readJson<Record<string, { clauses?: Record<string, unknown[]> }>>(
      enginePath(prereqRel),
    );
    const sub = shared?.[corpus];
    if (sub) nodeEdges = Object.values(sub.clauses ?? {}).reduce((a, c) => a + (c?.length ?? 0), 0);
  } else {
    const chapterAudit = await readJson<{ edges?: Array<{ passed?: boolean }> }>(
      enginePath(prereqRel),
    );
    if (chapterAudit?.edges) chapterEdges = chapterAudit.edges.filter((e) => e?.passed).length;
    else prereqRel = `${intakeRel}/prereq_audit.json`; // 只跑过节级那一层的域
    if (readiness) nodeEdges = Object.keys(readiness.prereq_graph?.clauses ?? {}).length;
  }
  const prereqAt = await mtime(enginePath(prereqRel));
  const prereqDetail =
    chapterEdges === null
      ? nodeEdges === null
        ? null
        : `${nodeEdges} 条边`
      : `章级 ${chapterEdges} 条边 · 节级 ${nodeEdges ?? 0} 条边`;

  const acceptedFiles = readiness ? Number(readiness.intake?.accepted_files ?? 0) : null;
  const sections = readiness ? Number(readiness.intake?.sections ?? 0) : null;

  const stations: PipelineStation[] = [
    {
      id: 'intake',
      label: '语料入库',
      what: '分诊格式与许可、按标题路径切块，产出就绪度报告',
      built: Boolean(intakeAt),
      path: `${intakeRel}/readiness.json`,
      updatedAt: intakeAt,
      detail: acceptedFiles ? `收进 ${acceptedFiles} 个文件，切出 ${sections} 节` : null,
    },
    {
      id: 'prereq',
      label: '前置图',
      what: '从语料抽概念之间的先后依赖，用于给未掌握的教材块排序',
      built: Boolean(prereqAt),
      path: prereqRel,
      updatedAt: prereqAt,
      detail: prereqDetail,
    },
    {
      id: 'index',
      label: '检索索引',
      what: '证据块落成 jsonl，引擎按名加载这一个文件',
      built: Boolean(indexAt),
      path: indexRel,
      updatedAt: indexAt,
      detail: chunks === null ? null : `${chunks} 个证据块`,
    },
    {
      id: 'vector',
      label: '向量索引',
      what: 'bge-m3 语义检索；查询嵌入不可用时自动降级 TF-IDF',
      built: Boolean(vectorAt),
      path: vectorRel,
      updatedAt: vectorAt,
      detail: null,
    },
    {
      id: 'gold',
      label: '覆盖率金标',
      what: '按语料自身结构机械导出的主题清单，用于测覆盖率',
      // 判据是「目录里有金标文件」而不是「目录存在」：ai 那份的目录是所有域共用的
      // kc_gold_derived 根，它恒存在，拿存在性亮灯等于给 ai 白送一站。
      built: (gold?.count ?? 0) > 0,
      path: goldRel,
      updatedAt: (gold?.count ?? 0) > 0 ? (gold?.newest ?? null) : null,
      detail: gold ? `${gold.count} 个主题文件` : null,
    },
  ];

  return {
    stations,
    overview: {
      available: Boolean(chunks && chunks > 0),
      chunks,
      backend: vectorAt ? 'vector' : chunks && chunks > 0 ? 'tfidf' : 'none',
      scope: readiness ? String(readiness.scope ?? '') || null : null,
      license: readiness
        ? {
            spdx: String(readiness.license?.spdx ?? 'UNKNOWN'),
            unknown: Boolean(readiness.license?.unknown),
          }
        : null,
      concepts: readiness ? (readiness.concepts ?? []).length : null,
      clauses: nodeEdges,
      gates: readiness
        ? {
            retrievable: Boolean(chunks && chunks > 0),
            vocabulary: Boolean(readiness.readiness?.gate1_vocabulary),
            // 闸二按实际边数算，不照抄 readiness.json 里那个布尔值——章级那一层可以事后
            // 单独补跑且不重写报告，那个布尔值会停在补跑之前（iotdb 就是：章级 8 条边在手，
            // 报告里仍写着 false）。口径与 admin-overview.ts 的领域接入表保持一致。
            graph:
              (chapterEdges ?? 0) > 0 ||
              (nodeEdges ?? 0) > 0 ||
              Boolean(readiness.readiness?.gate2_graph_connected),
            itemMapping: Boolean(readiness.readiness?.gate3_item_mapping),
            reviewedEdges: Number(readiness.readiness?.reviewed_edges ?? 0),
          }
        : null,
      fitness,
      goldFiles: gold?.count ?? null,
    },
  };
}

export async function readCorpus(corpus: string): Promise<CorpusOverview | null> {
  if (!isValidCorpusName(corpus)) return null;
  const { stations, overview } = await stationsOf(corpus);
  const stamps = stations
    .map((s) => s.updatedAt)
    .filter((s): s is string => Boolean(s))
    .sort();
  return {
    corpus,
    indexPath: indexPathOf(corpus),
    ...overview,
    updatedAt: stamps.length ? stamps[stamps.length - 1] : null,
    stations,
  };
}

/**
 * 生成前的一道拦截：显式选了一个没建索引的知识库，当场说清楚，不许跑到一半空手而归。
 *
 * 只管**显式选的库**（`profile.corpus`）。没选、或只填了培训领域（`domain`）的照旧
 * 放行——那三个赛题领域至今没有语料，今天本来就是裸生成加「未接地」徽章，拦下来等于
 * 把一条能用的路砍掉。判据只用实时磁盘（`readCorpus`）。
 */
export async function corpusUnavailableReason(corpus?: string): Promise<string | null> {
  const name = corpus?.trim();
  if (!name) return null;
  if (!isValidCorpusName(name)) return `知识库名「${name}」不合法，请在知识库中心重新选择。`;
  const row = await readCorpus(name);
  if (row?.available) return null;
  return `知识库「${domainLabel(name)}」还没建好检索索引（${indexPathOf(name)} 不存在或为空），换库生成会全程无据可依。请到知识库中心确认建库状态，或改用已建好的库。`;
}

/** 总览：建好的排前面，同组按名字排。名单取不到时返回空数组，页面出空态。 */
export async function readCorpora(): Promise<CorpusOverview[]> {
  const names = await corpusRoster();
  const rows = await Promise.all(names.map((n) => readCorpus(n)));
  return rows
    .filter((r): r is CorpusOverview => r !== null)
    .sort((a, b) =>
      a.available === b.available ? a.corpus.localeCompare(b.corpus) : a.available ? -1 : 1,
    );
}
