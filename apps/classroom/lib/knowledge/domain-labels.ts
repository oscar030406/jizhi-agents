/**
 * 领域与语料库中文显示名的**单一真源**。
 *
 * 建这个文件之前，同一张映射表在三处各抄了一份（`lib/generation/learner-profile.ts`、
 * `app/report/page.tsx`、`components/generation/learner-profile-popover.tsx`），
 * 且三份都只有四个培训领域、没有任何一个实际接入的语料库——于是 iotdb/odoo 这些
 * 库在界面上一律裸英文 id 上屏。加库时改一处漏两处是迟早的事，所以合并到这里。
 *
 * 两类 id 共用一张表，因为它们在 UI 上占同一个位置（「这门课取材自哪里」）：
 * - **培训领域**（`profile.domain`）：生成入口让学习者选的方向，四个固定值。
 * - **语料库**（`profile.corpus` / 引擎 `_corpus_status()` 的 corpus 名）：开放集，
 *   接入流水线随时会造出新的。表里只登记盘上真实存在的，其余走兜底。
 *
 * 2026-08-21 起这里不再是唯一真源：新建的库由引擎写进**域注册清单**
 * （`lib/knowledge/domain-registry.ts`），查表顺序是「清单 → 下面这张表 → 原值」。
 * 表保留为历史库的兜底，新加库不用回来改它。
 */

import { domainRegistryEntry } from '@/lib/knowledge/domain-registry';

/** 培训领域 id → 中文名。生成入口的固定选项，不随语料接入变化。 */
export const TRAINING_DOMAINS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'ai', label: '人工智能应用开发' },
  { id: 'manufacturing', label: '智能制造' },
  { id: 'industrial-internet', label: '工业互联网' },
  { id: 'software', label: '特定软件开发' },
];

/**
 * 语料库 id → 中文名。
 *
 * 名字取自各库 `readiness.json` 的 `scope` 字段（接入时人工填的领域范围），
 * 截短成一行能上屏的短语；`ai` 是主库（`data/knowledge_base/knowledge_index.jsonl`），
 * 没有 intake 记录，沿用培训领域的名字。
 * 加新库时这里补一行——**只登记盘上真有 `corpora/<id>/` 或主索引的库**，
 * 不预置将来可能有的。
 */
export const CORPUS_LABELS: Readonly<Record<string, string>> = {
  ai: '人工智能应用开发',
  iotdb: '时序数据库 IoTDB',
  odoo: '企业管理系统 Odoo',
  'cold-chain-ops': '冷链仓储运维',
  'pv-ops': '光伏电站运维',
  vecdb: '向量数据库与语义检索',
  'rag-adv': 'RAG 进阶检索技术',
  // 不是 `corpora/` 下的独立库：具身智能语料以 `embodied_docs/` 形式并进了主索引
  // （主库 1704 块里有 752 块是它）。登记它是因为 `prereq_graph.json` 的顶层键就是
  // `ai` / `embodied`，管理端的概念前置图拿这个键当标题上屏，不登记就裸英文。
  embodied: '具身智能（主库内子域）',
};
// 不登记 `iotdb2`：盘上只有 `iotdb2_intake/`（corpus_index 为 null），
// `corpora/` 下没有它，引擎的库名单里也不会出现——给一个不存在的库配中文名，
// 等于替将来某个同名库先下了结论。真要接入时再加这一行。

const LABELS: Record<string, string> = {
  ...Object.fromEntries(TRAINING_DOMAINS.map((d) => [d.id, d.label])),
  ...CORPUS_LABELS,
};

/**
 * 域注册清单里的中文名。新库建成时由引擎写进
 * `data/knowledge_base/domain_registry.json`，服务端读盘后灌进内存视图。
 * 清单优先于下面这张硬编码表：表是**历史库的兜底**，不是新库的登记处——新建一个库
 * 不该再回来改这个文件（那正是「工程师替系统干活」的那一段）。
 */
function registryLabel(domain: string): string | undefined {
  const entry = domainRegistryEntry(domain);
  const label = entry?.label?.trim();
  // label 与目录名相同是引擎的退化写法（label_source: corpus_name，老库没有中文名）
  // ——那不是名字，是占位。放行它会盖掉下面兜底表里的真中文名（ai 实测中招）。
  if (!label || label === entry?.corpus) return undefined;
  return label;
}

/**
 * 领域/语料的显示名。
 *
 * 查不到时返回**传进来的那个值本身**，不是兜底成「人工智能应用开发」——这个函数也给
 * `/skills` 的语料卡用，而语料 id 是开放集（接入 Agent 新造的库不在表里）。兜底到 ai
 * 的写法把每张非 ai 语料卡都贴成了「人工智能应用开发」。真没传值才用 ai——
 * 那是老调用点的既有默认。**这条约定不随清单改变**：清单里也查不到时照样返回原值。
 */
export function domainLabel(domain?: string): string {
  return (domain && (registryLabel(domain) || LABELS[domain])) || domain || LABELS.ai;
}

/** 登记过没有（用来判断「这个 id 上屏会不会裸英文」）。清单登记的也算。 */
export function hasDomainLabel(domain?: string): boolean {
  return Boolean(domain && (registryLabel(domain) !== undefined || domain in LABELS));
}
