/**
 * 域注册清单的**运行时视图**（客户端可安全导入，这里不碰文件系统）。
 *
 * 真源是引擎产物 `apps/agent-engine/data/knowledge_base/domain_registry.json`：新库建成时
 * 由入库链写出，里面记着这个域叫什么中文名、语料范围、块数、够不够格出货、示例提示词等。
 * 读盘那一半在 `lib/server/domain-registry.ts`（服务端）；本文件只存**读完之后的那份内存视图**，
 * 因为 `domainLabel()` 这类函数在客户端组件里也要调（生成入口的知识库下拉是 `'use client'` 的，
 * 它的库名单是运行时 `fetch('/api/skills')` 拿的），而客户端拿不到磁盘。
 *
 * 所以流程是：服务端读盘 → `applyDomainRegistry()` 灌进来 → 查表函数照常同步返回。
 * 没灌过（引擎还没跑过 ⑧ 站、或本地刚 clone）就是一份空视图，所有查表函数返回
 * `undefined`，调用方各自走原有兜底。**这里任何一条路径都不抛错。**
 */

/** 清单里一个域的记录。字段全可选——引擎那边逐步补齐，缺一项不该让整份清单作废。 */
/** 一条示例提示词。`anchor` 是它出自语料的哪一章——出处丢了就再也找不回来。 */
export type DomainExample = { prompt: string; anchor?: string };

export interface DomainRegistryEntry {
  corpus: string;
  /** 域中文显示名。`domain-labels.ts` 优先用它。 */
  label?: string;
  /** 入库时声明的领域范围（readiness.json 的 scope）。 */
  scope?: string;
  chunks?: number;
  /** 三指标复测过没过线：false = 降级/试运行，学习端要能看出来。 */
  eligible?: boolean;
  /** 卡在哪一道闸（eligible 为 false 时才有意义）。 */
  gate?: string;
  /** 与哪些域有跨域关联。 */
  cross_domain?: string[];
  /** 造课卡示例提示词。空/缺 = 没有域专属示例，调用方回退。
   *
   *  **形状必须与引擎产物一致**：引擎写的是 `{prompt, anchor}` 对象数组。
   *  早先声明成 `string[]`，解析时按字符串过滤，三条示例被静默丢光——
   *  清单条数正常、没有报错、就是 examples 永远为空，查表全部回退硬编码。 */
  examples?: DomainExample[];
  /** 管理者可选上传的岗位/技能要求文件的提炼结果。没给就没有这一项，不编造。 */
  job_requirements?: unknown;
  /** C21：这个域教不教动手操作（带电/机械/化学/高温）。由投料方在接入时声明，
   *  不从语料里猜——关键词判据实测全是误报（「性价比接地气」「高温度 Temperature」）。 */
  hands_on_safety?: boolean;
}

export interface DomainRegistry {
  entries: Record<string, DomainRegistryEntry>;
  generatedAt: string | null;
  sourceRunId: string | null;
}

const EMPTY: DomainRegistry = { entries: {}, generatedAt: null, sourceRunId: null };

let current: DomainRegistry = EMPTY;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toEntry(corpus: string, row: Record<string, unknown>): DomainRegistryEntry {
  const str = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : undefined);
  const strArray = (k: string) =>
    Array.isArray(row[k])
      ? (row[k] as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : undefined;
  /** 示例可能是 `{prompt, anchor}`（引擎产出）或裸字符串（手工改过的清单）。
   *  两种都收——只认一种就等于让另一半数据静默消失，那正是这条被修的原因。 */
  const exampleArray = (k: string): DomainExample[] | undefined => {
    if (!Array.isArray(row[k])) return undefined;
    const out: DomainExample[] = [];
    for (const item of row[k] as unknown[]) {
      if (typeof item === 'string' && item.trim()) {
        out.push({ prompt: item.trim() });
        continue;
      }
      if (item && typeof item === 'object') {
        const prompt = (item as Record<string, unknown>).prompt;
        const anchor = (item as Record<string, unknown>).anchor;
        if (typeof prompt === 'string' && prompt.trim()) {
          out.push({
            prompt: prompt.trim(),
            ...(typeof anchor === 'string' && anchor.trim() ? { anchor: anchor.trim() } : {}),
          });
        }
      }
    }
    return out;
  };
  return {
    corpus,
    label: str('label'),
    scope: str('scope'),
    chunks: typeof row.chunks === 'number' ? row.chunks : undefined,
    eligible: typeof row.eligible === 'boolean' ? row.eligible : undefined,
    gate: str('gate'),
    cross_domain: strArray('cross_domain'),
    examples: exampleArray('examples'),
    ...(row.job_requirements === undefined ? {} : { job_requirements: row.job_requirements }),
    ...(typeof row.hands_on_safety === 'boolean' ? { hands_on_safety: row.hands_on_safety } : {}),
  };
}

/**
 * 原始 JSON → 内存视图。**容错优先**：清单的外层形状（`domains` 是数组还是以库名为键的
 * 对象）由引擎那一路定，两种都收；单条记录解析不出库名就跳过这一条，不整份作废。
 * 传进来不是对象（文件损坏、读到 null）就返回空视图。
 */
export function parseDomainRegistry(raw: unknown): DomainRegistry {
  const top = isObject(raw) ? raw : {};
  // `entries` 摆在最前：**解析器必须吃得下自己的输出**。
  // `/api/domains` 返回的就是已解析形态 `{entries: {...}}`，而这里原本只认
  // 引擎产物的 `corpora` 数组——于是浏览器灌注拿到满血数据却解析出空清单，
  // 所有查表静默回退兜底（2026-08-23 线上实锤，同族第九例）。
  const list: unknown = Array.isArray(raw)
    ? raw
    : (top.entries ?? top.domains ?? top.corpora ?? raw);

  const entries: Record<string, DomainRegistryEntry> = {};
  if (Array.isArray(list)) {
    for (const row of list) {
      if (!isObject(row)) continue;
      const corpus = typeof row.corpus === 'string' ? row.corpus.trim() : '';
      if (corpus) entries[corpus] = toEntry(corpus, row);
    }
  } else if (isObject(list)) {
    // 以库名为键的对象形态。值不是对象的键（generated_at 这类顶层元数据）自然被跳过。
    for (const [corpus, row] of Object.entries(list)) {
      if (isObject(row) && corpus.trim()) entries[corpus.trim()] = toEntry(corpus.trim(), row);
    }
  }

  return {
    entries,
    generatedAt: typeof top.generated_at === 'string' ? top.generated_at : null,
    sourceRunId: typeof top.source_run_id === 'string' ? top.source_run_id : null,
  };
}

/**
 * 订阅视图变更。灌注是**异步**的：页面首帧渲染常常发生在 /api/domains 返回之前，
 * 消费组件如果只在渲染时读一次，灌注完成后没人通知 React 重读——示例词、
 * 中文名就停在兜底值上（第八例：接了线、灌了水，龙头没人再拧）。
 * 组件用 `useDomainRegistryVersion()`（lib/knowledge/use-domain-registry.ts）
 * 把版本号进依赖即可；这里保持零 React 依赖，服务端照常可导入。
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

export function subscribeDomainRegistry(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function domainRegistryVersion(): number {
  return version;
}

/** 灌入（或用 `null` 清空）当前视图。服务端读完盘调它。 */
export function applyDomainRegistry(registry: DomainRegistry | null): void {
  current = registry ?? EMPTY;
  version += 1;
  for (const cb of listeners) cb();
}

/** 当前视图。没灌过就是空视图（`entries` 为空对象，不是 null）。 */
export function domainRegistry(): DomainRegistry {
  return current;
}

/** 查一个域的记录。清单里没有（或还没灌）返回 `undefined`，调用方走自己的兜底。 */
export function domainRegistryEntry(corpus?: string): DomainRegistryEntry | undefined {
  const name = corpus?.trim();
  return name ? current.entries[name] : undefined;
}

/**
 * 这个域要不要挂安全提示层（C21）。
 *
 * 判据只有一个：接入时投料方勾没勾「涉及实操」。清单里没有这个库、或者没勾，
 * 一律返回 false——**宁可不挂也不乱挂**：每门 AI 课顶着「注意触电」会让这层
 * 提示彻底失去意义，看两次就没人看了（和注入扫描那条误报规则同一个道理）。
 *
 * 反过来，漏挂是安全责任，所以勾选项在管理端要显眼、文案要说清后果。
 */
export function needsSafetyLayer(corpus?: string, _registryVersion?: number): boolean {
  // `_registryVersion` 只为让 React 组件把「清单灌注完成」当成依赖重算一次——
  // 清单是异步灌进来的，首帧读到空清单会永远判 false，安全提示就再也不出现。
  // 与 `examplePromptsFor` 同一个约定。
  return domainRegistryEntry(corpus)?.hands_on_safety === true;
}

/**
 * 一次性验证库的命名约定（与引擎 `is_scratch_corpus()` 同一份口径）：
 * 全链自测建的 `*-probe` / `*-test` 这类库，引擎侧已在 `eligible` 里判掉；
 * 前端再判一层是**双保险**——上一次它漏进学习者下拉，正是因为唯一一道闸
 * 换了判据。两处口径必须一起改，改一处漏一处就是那次事故重演。
 */
const SCRATCH_PATTERNS = [/-probe$/, /-test$/, /-tmp$/, /-scratch$/, /^probe-/, /^test-/, /^tmp-/, /^scratch-/];

export function isScratchCorpus(corpus: string): boolean {
  const name = corpus.trim().toLowerCase();
  return SCRATCH_PATTERNS.some((p) => p.test(name));
}

/**
 * 这个域该不该对学习者露面：过了质量与指标闸（eligible）且不是一次性验证库。
 * 清单里没有的库返回 false——没登记过的东西不推给学习者，管理端照常可见。
 */
export function isLearnerVisible(corpus?: string): boolean {
  const entry = domainRegistryEntry(corpus);
  if (!entry) return false;
  if (entry.eligible !== true) return false;
  return !isScratchCorpus(entry.corpus);
}

/**
 * 展示名截断（CJK 按 1 全角计）。引擎存的是管理者填的完整 scope，
 * 截多长是**展示决策**：下拉 12 字、卡片 16 字、详情页用 full 不截。
 * 截断只在读取器做，引擎不预截——不同位置要不同长度，预截会把长的那种毁掉。
 */
export function truncateLabel(label: string, max: number): string {
  let width = 0;
  let out = '';
  for (const ch of label) {
    width += /[\u2E80-\uFFFD]/.test(ch) ? 1 : 0.5;
    if (width > max) return `${out}…`;
    out += ch;
  }
  return label;
}
