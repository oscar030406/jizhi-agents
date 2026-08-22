/**
 * 前置图的加载与降级。`selection.ts` 有消费侧、没有构造侧，这里是两者之间的接缝。
 *
 * 图由 `apps/agent-engine/scripts/build_prereq_graph.py` 一次性造出（LLM 造表 → 函数查表，
 * 设计稿 §7.2），同步进 `./data/prereq-graph.json`。运行时零 LLM 调用。
 *
 * ## 三档置信度（§7.6）
 *
 * 设计稿把硬约束的作用域缩小到高置信边，理由是所有能落地的前置抽取做法都是打分 + 阈值，
 * 不能假装每条 LLM 抽出来的边都是确定的：
 *
 * ```
 * 高置信 且 人工确认过  → 硬前置，未满足不进 outer fringe，任何 agent 不得否决
 * 其余                  → 软前置，进 fringe 但排序靠后，规格的理由里写「建议先学 A」
 * ```
 *
 * **当前造出来的边一律 `reviewed: false`**，所以现在**一条硬前置都没有**。这不是 bug，
 * 是 §7.6 写死的：只有人工签字的边才能拦人。`θ_hard` 没有可搬的文献值（Pal et al. 的阈值
 * 逐域不同：geometry 0.06 / physics 0.12 / precalculus 0.04，而且那是 tfidf 分数的阈值
 * 不是概率），标未验证。
 *
 * ## 降级路径（§7.7）
 *
 * 没有图 → `emptyGraph()`：所有概念无前置，fringe 退化成全集，选点回落到教材章节顺序。
 * **降级必须可见**：调用方拿 {@link prereqGraphStatus} 渲染「前置图未就绪，按教材顺序推荐」。
 * 静默降级是完成度审计点名的失分项。
 */

import type { PrereqGraph } from './selection';
import raw from './data/prereq-graph.json';

/** 造图脚本的产出形态。比 {@link PrereqGraph} 多两个字段，结构上是它的超集。 */
interface BuiltClause {
  all: string[];
  confidence?: number;
  because?: string;
  /** 人工确认过吗。false 时这条边只能当软前置。 */
  reviewed?: boolean;
}

interface BuiltDomain {
  items: string[];
  clauses?: Record<string, BuiltClause[]>;
  _meta?: {
    model?: string;
    pairs_judged?: number;
    edges_kept?: number;
    reviewed?: boolean;
    note?: string;
  };
}

const built = raw as unknown as Record<string, BuiltDomain>;

/** 已造出图的领域。 */
export function availableDomains(): string[] {
  return Object.keys(built).filter((k) => !k.startsWith('_'));
}

/** 空图：所有概念无前置。降级路径，不是错误状态。 */
export function emptyGraph(items: readonly string[] = []): PrereqGraph {
  return { items: [...items] };
}

/**
 * 取某个领域的前置图。领域没有图时返回空图——**调用方必须同时读
 * {@link prereqGraphStatus} 并把降级显示出来**，不能默默按空图跑。
 */
export function prereqGraphFor(domain: string): PrereqGraph {
  const d = built[domain];
  if (!d?.items?.length) return emptyGraph();
  return { items: d.items, ...(d.clauses ? { clauses: d.clauses } : {}) };
}

export interface PrereqGraphStatus {
  /** 有没有图。false 时选点已降级为教材章节顺序。 */
  ready: boolean;
  /** 概念数。 */
  concepts: number;
  /** 有前置的概念数。 */
  withPrereqs: number;
  /** 人工确认过的 clause 数。当前恒为 0——没有人工确认就没有硬前置。 */
  reviewed: number;
  /** 给用户看的一句话。降级时必须渲染出来（§7.7）。 */
  notice: string;
}

export function prereqGraphStatus(domain: string): PrereqGraphStatus {
  const d = built[domain];
  if (!d?.items?.length) {
    return {
      ready: false,
      concepts: 0,
      withPrereqs: 0,
      reviewed: 0,
      notice: '前置图未就绪，本次推荐按教材章节顺序排列',
    };
  }
  const clauses = Object.values(d.clauses ?? {});
  const reviewed = clauses.flat().filter((c) => c.reviewed).length;
  return {
    ready: true,
    concepts: d.items.length,
    withPrereqs: Object.keys(d.clauses ?? {}).length,
    reviewed,
    notice:
      reviewed > 0
        ? `前置图已就绪（${reviewed} 条经人工确认）`
        : '前置关系由模型抽取、尚未人工确认，仅作推荐排序，不拦学习顺序',
  };
}

export interface PrereqOrdering {
  /** 排好序的概念。用了图就是拓扑序，没用图就是原样返回。 */
  concepts: string[];
  /** 每个概念在**这批概念内部**的前置。图外的前置不列——列了也没法在这张图上指过去。 */
  prereqOf: Record<string, string[]>;
  /** 有没有真用上图。false 时调用方必须把降级显示出来（§7.7）。 */
  usedGraph: boolean;
  /** 这批概念里有几个在图的词表内。低了说明图与画像不同源，值得警觉。 */
  matched: number;
}

/**
 * 把一组待学概念按前置层级排序。
 *
 * 现状是按 `skill_gaps` 的 priority 排——那是「差距多大」的排序，不是「能不能学」的排序。
 * 一个前置没满足的概念排在最前，学习者点进去就撞墙。拓扑序至少保证**指过来的箭头
 * 都在自己左边**。
 *
 * 同层内保持调用方给的原始顺序（通常是 priority 序），所以这是在原排序上**加一层约束**，
 * 不是换一套排序——priority 的信息没有被丢掉。
 *
 * 图缺席或一个概念都对不上时原样返回并把 `usedGraph` 标 false。**不要静默降级**：
 * 拓扑序和优先级序看起来一样，用户分不出来，得由界面说。
 */
export function orderByPrereq(concepts: readonly string[], domain: string): PrereqOrdering {
  const g = prereqGraphFor(domain);
  const inGraph = new Set(g.items);
  const matched = concepts.filter((c) => inGraph.has(c)).length;
  const prereqOf: Record<string, string[]> = {};
  const present = new Set(concepts);

  for (const c of concepts) {
    const clauses = g.clauses?.[c] ?? [];
    // 只取落在这批概念内的前置。clause 之间是 OR，取并集当展示用——
    // 展示层不做「选哪条 clause」的决策，那是选点的事（§4.2）。
    const within = [...new Set(clauses.flatMap((cl) => cl.all).filter((p) => present.has(p)))];
    if (within.length) prereqOf[c] = within;
  }

  if (!matched || !g.items.length) {
    return { concepts: [...concepts], prereqOf, usedGraph: false, matched };
  }

  // Kahn 拓扑排序，同层按原顺序。图已去环（造图时删过环），这里再防一手：
  // 剩下的成环节点按原顺序附在末尾，不丢概念。
  const remaining = new Map(concepts.map((c) => [c, new Set(prereqOf[c] ?? [])]));
  const ordered: string[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([c]) => c);
    if (!ready.length) {
      ordered.push(...remaining.keys());
      break;
    }
    for (const c of ready) {
      ordered.push(c);
      remaining.delete(c);
    }
    for (const deps of remaining.values()) {
      for (const c of ready) deps.delete(c);
    }
  }
  return { concepts: ordered, prereqOf, usedGraph: true, matched };
}

/**
 * 一条 clause 现在算不算硬前置。
 *
 * 唯一的判据是**人工确认过没有**，不是置信度高低。这条不要改成阈值判断——
 * §7.6 的原话是「硬约束只覆盖高置信边」，而「高置信」在没有校准过的 θ_hard 之前
 * 无法认定；人工签字是当前唯一可信的信号。
 */
export function isHardPrereq(clause: BuiltClause): boolean {
  return clause.reviewed === true;
}
