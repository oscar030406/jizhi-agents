/**
 * 管理端的知识图谱视图：把前置图排成分层 DAG，供「学习路径规划图」渲染。
 *
 * 赛题五(3)① 点名三张图：知识盲区定位、资源难度匹配曲线、学习路径规划图。
 * 个人维度在 `/report`；这里是机构维度。**三张里只有两张有真数据**：
 *
 * - 学习路径规划图 ✅ 前置图 + 概念难度，都在盘上
 * - 覆盖缺口 ✅ 有 kc_coverage 实测的主题给数，没测的如实标「未测」
 * - 资源难度匹配曲线 ❌ 机构版画不出来。匹配曲线要把**学习者分布**与资源难度对起来，
 *   而设计稿第八节写死了我们没有跨人数据。这里只出「资源供给按难度档的分布」，
 *   并在页面上说清它不是匹配曲线。编一条曲线比不画更糟。
 *
 * 布局用拓扑分层：层号 = 1 + max(前置的层号)。概念数量是十几个的量级，
 * 不需要力导向，也不引任何图布局依赖。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

function engineDataDir(): string {
  return process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data');
}

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

export interface ConceptNode {
  id: string;
  title: string;
  difficulty: string;
  layer: number;
  /** 该层内的序号，用于排版 */
  slot: number;
}

export interface ConceptEdge {
  from: string;
  to: string;
  confidence: number;
  /** 人工签字过的边才是硬前置（设计稿 §7.6）；模型抽的一律软前置 */
  reviewed: boolean;
}

export interface DomainMap {
  domain: string;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  layerCount: number;
  layerWidth: number;
  /**
   * 没有任何前置也不是任何概念前置的孤立点——它们是图里最可疑的部分。
   * 存**显示名**（与节点标签同一口径：图谱里查得到就用中文标题），不存 id：
   * 同一个概念在图上叫「服务化与工程化部署」、在下面的说明里叫 `deployment`，
   * 读的人对不上号。图谱里没有条目的（`embodied_ros2` 这些）两处都回落成 id。
   */
  isolated: string[];
}

interface PrereqClause {
  all?: string[];
  confidence?: number;
  reviewed?: boolean;
}

/**
 * 拓扑分层。图里有环时（造图脚本已做去环，但数据可能来自别处）不死循环：
 * 迭代到不再变化为止，仍未定层的一律放最后一层并当孤立点报出来。
 */
function assignLayers(items: string[], prereqOf: Map<string, string[]>): Map<string, number> {
  const layer = new Map<string, number>(items.map((i) => [i, 0]));
  for (let pass = 0; pass < items.length; pass += 1) {
    let changed = false;
    for (const item of items) {
      const deps = prereqOf.get(item) ?? [];
      if (deps.length === 0) continue;
      const want = 1 + Math.max(...deps.map((d) => layer.get(d) ?? 0));
      if (want > (layer.get(item) ?? 0)) {
        layer.set(item, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

export async function readDomainMaps(): Promise<DomainMap[]> {
  const dir = engineDataDir();
  const [prereq, concepts] = await Promise.all([
    readJson<Record<string, { items?: string[]; clauses?: Record<string, PrereqClause[]> }>>(
      path.join(dir, 'knowledge_base', 'prereq_graph.json'),
    ),
    readJson<Record<string, { title?: string; difficulty?: string }>>(
      path.join(dir, 'knowledge_base', 'concept_graph.json'),
    ),
  ]);
  if (!prereq) return [];

  const maps: DomainMap[] = [];
  for (const [domain, sub] of Object.entries(prereq)) {
    if (!sub || typeof sub !== 'object' || !Array.isArray(sub.items)) continue;
    const items = sub.items;
    const prereqOf = new Map<string, string[]>();
    const edges: ConceptEdge[] = [];
    for (const [target, clauses] of Object.entries(sub.clauses ?? {})) {
      const deps: string[] = [];
      for (const clause of clauses ?? []) {
        for (const from of clause.all ?? []) {
          if (!items.includes(from) || !items.includes(target)) continue;
          deps.push(from);
          edges.push({
            from,
            to: target,
            confidence: Number(clause.confidence ?? 0),
            reviewed: Boolean(clause.reviewed),
          });
        }
      }
      if (deps.length) prereqOf.set(target, deps);
    }

    const layer = assignLayers(items, prereqOf);
    const slots = new Map<number, number>();
    const nodes: ConceptNode[] = items
      .slice()
      .sort((a, b) => (layer.get(a) ?? 0) - (layer.get(b) ?? 0) || a.localeCompare(b))
      .map((id) => {
        const l = layer.get(id) ?? 0;
        const slot = slots.get(l) ?? 0;
        slots.set(l, slot + 1);
        return {
          id,
          title: concepts?.[id]?.title || id,
          difficulty: concepts?.[id]?.difficulty || '—',
          layer: l,
          slot,
        };
      });

    const touched = new Set(edges.flatMap((e) => [e.from, e.to]));
    maps.push({
      domain,
      nodes,
      edges,
      layerCount: Math.max(...nodes.map((n) => n.layer), 0) + 1,
      layerWidth: Math.max(...slots.values(), 1),
      isolated: items.filter((i) => !touched.has(i)).map((i) => concepts?.[i]?.title || i),
    });
  }
  return maps;
}

/** 概念难度的分布。**这不是匹配曲线**，是资源供给侧的分布，页面上要写清楚。 */
export async function readDifficultySupply(): Promise<{ tier: string; concepts: string[] }[]> {
  const concepts = await readJson<Record<string, { title?: string; difficulty?: string }>>(
    path.join(engineDataDir(), 'knowledge_base', 'concept_graph.json'),
  );
  if (!concepts) return [];
  const byTier = new Map<string, string[]>();
  for (const [id, c] of Object.entries(concepts)) {
    if (id.startsWith('_')) continue; // _meta
    const tier = c?.difficulty || '未标';
    byTier.set(tier, [...(byTier.get(tier) ?? []), c?.title || id]);
  }
  return [...byTier.entries()]
    .map(([tier, list]) => ({ tier, concepts: list.sort() }))
    .sort((a, b) => a.tier.localeCompare(b.tier));
}

export interface CoverageRow {
  topic: string;
  courseName: string;
  total: number;
  coverage: number;
  missing: string[];
  status: string;
  /**
   * 这条 run 当时测的那门课，现在还在课程墙上吗。
   *
   * 2026-08-13 发现的对不上账：管理端这张表给 KV 缓存显示 6/7，而
   * `metrics.json` 的台账写 7/7。两个都没错——台账引的是**注入金标概念清单后的
   * 重生成版**（`data/eval/kc_coverage/l1/kv-cache-regen.misses.json`，misses 为空），
   * 而 `runs/` 里只归档了重生成**之前**那次，它测的课程 `xU4gq4z2LM` 早已被
   * 重生成版 `ygmJ2PpCKb` 取代、不在库里了。
   *
   * 重生成那几次只留了 misses 文件、没归档成 runs/summary.json，所以这张表
   * 结构上看不见它们。**不补造 summary**（那等于写没跑过的数），改成把这条事实
   * 显示出来：读者看到 6/7 的同时看到它测的是一门已被取代的课。
   */
  courseStillOnWall: boolean;
  /** run 里记的课程 id，用于对账 */
  courseId: string;
}

/** 已实测的知识点覆盖率。没跑过的主题不出现在这里——不测就是不测，不补 0 也不补估计值。 */
export async function readCoverageRuns(): Promise<CoverageRow[]> {
  const runsDir = path.join(engineDataDir(), 'eval', 'kc_coverage', 'runs');
  let dirs: string[];
  try {
    dirs = (await fs.readdir(runsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // 目录名带时间戳，字典序即时间序
  } catch {
    return [];
  }
  // 现在课程墙上有哪些课——用来判断某条 run 测的那门课是不是已经被取代
  let onWall = new Set<string>();
  try {
    const files = await fs.readdir(path.join(process.cwd(), 'data', 'classrooms'));
    onWall = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
  } catch {
    // 读不到就当全部还在：宁可不标，也不要把还在的课误标成已取代
    onWall = new Set();
  }

  const latest = new Map<string, CoverageRow>();
  for (const d of dirs) {
    const s = await readJson<unknown>(path.join(runsDir, d, 'summary.json'));
    if (!isRecord(s) || !s.gold_topic) continue;
    // run 里记的是相对路径（../classroom/data/classrooms/xxx.json），取文件名当 id
    const courseId = (
      String(s.course ?? '')
        .split(/[\\/]/)
        .pop() ?? ''
    ).replace(/\.json$/, '');
    // 同主题多次重跑：后面的覆盖前面的（目录已按时间排序）
    latest.set(String(s.gold_topic), {
      topic: String(s.gold_topic),
      courseName: String(s.course_name ?? ''),
      total: Number(s.total ?? 0),
      coverage: Number(s.coverage ?? 0),
      missing: Array.isArray(s.missing_kcs) ? s.missing_kcs.map(String) : [],
      status: String(s.gold_status ?? ''),
      courseId,
      // onWall 为空 = 读不到目录，这时一律当「还在」，不误标
      courseStillOnWall: onWall.size === 0 || onWall.has(courseId),
    });
  }
  return [...latest.values()].sort((a, b) => a.coverage - b.coverage);
}
