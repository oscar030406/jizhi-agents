/**
 * 选点 —— `(下一步 学习者 目标)` 的候选集与排序。
 *
 * 设计基准是 `docs/03-design/blackbox-architecture-20260811.md` §6.1，但**这里实现的是
 * 被 2026-08-11 学习科学对照调研纠正过的版本**，与设计稿的原文有出入。对照文档：
 * `docs/03-design/blackbox-architecture-grounding-20260811.md`（综合判定，条目号 D-nn / R-nn）
 * 与 `docs/04-research/knowledge-space-grounding-20260811.md`（下称 KS 分册）。
 *
 * 与设计稿 §6.1 的四处差异，每处都在下面的代码里带依据注释：
 *
 * | 设计稿 §6.1 | 这里 | 依据 |
 * |---|---|---|
 * | 排序规则一：前置度优先 | 降为**最末位**排序键，可关掉 | D-46：文献无对应、无实证 |
 * | 排序规则二：复杂度单调（绝对难度标注） | {@link layers}：**距当前状态的图距离** | D-47：ALEKS 的 layer，实测正确率随层单调 |
 * | 排序规则三：横切关注点后置 | **删除**，见下面的墓碑注释 | D-48：被证伪 |
 * | （设计稿没有） | {@link rankNext} 的**首**排序键：目标成功率 0.75–0.85 | D-49：Math Garden 0.75 / Wilson 2019 的 85% 规则 |
 *
 * 术语一律用 KST 的标准名（outer fringe / inner fringe / surmise clause / layer），不自造。
 * 评委认得出这些词；自造词在答辩上是净亏损。
 *
 * **本模块不接线**：scene-generator / route / 引擎那条 Python 路径一个调用点都没改。
 * 特别是 `apps/agent-engine/backend/integration/personalize_service.py` 里那个
 * `MASTERY_THRESHOLD = 0.7` 的跳段判据仍是老口径，改它是接线那一批的事。
 *
 * ---
 *
 * ## 被删掉的第三条规则：「横切关注点后置」——不要加回来
 *
 * 设计稿 §6.1 原来的第三条规则是「横切关注点后置」（评估、安全、成本这类贯穿多章的东西
 * 放到后面讲），归纳自 d2l 把优化算法排在第 11 章。学习科学对照把它**证伪**了（KS §2.3、
 * 综合判定 D-48），三条独立的教学设计文献都主张反过来：
 *
 * 1. Bruner 的螺旋课程：核心概念**反复出现、每次深一层**，不是推迟到前置全掌握之后。
 * 2. Reigeluth & Stein 1983 精细化理论：第一课就要给出 epitome——整个领域最简单的**完整**
 *    版本，然后逐层填细节。整合性的东西恰恰要**最早**出现。
 * 3. Meyer & Land 2003 门槛概念：定义里就含「整合性（integrative）」这一条，主张显式识别
 *    并在整个课程中反复搭支架，不是延后处理。
 *
 * 还有一条结构性理由：前置多的节点在前置 DAG 的拓扑序里**本来就靠后**。所以这条规则
 * 要么与前置约束冗余，要么在冗余之外的部分是有害的。
 *
 * 从 d2l / happy-llm 的目录再归纳一次会很容易又推出这条——教材作者确实这么排。但教材是
 * 给所有人排的一条固定路线，横切内容后置是因为**书没法反复回来**；我们按个人状态选点，
 * 能回来。看到这段就说明有人已经查过并删过一次，别再加回来。
 *
 * ## 顺序不如集合重要
 *
 * KST 只定义可行集，不定义顺序（KS §2.1：learning path 是知识结构上的极大链，理论不给
 * 优先级）。ALEKS 的做法是把顺序交给学习者：系统保证 outer fringe 是安全的，学哪个由人挑，
 * 在这个前提下拿到 0.81–0.94 的学习成功率（C21 Table 4，尝试数千万级）。所以
 * {@link rankNext} 的返回值是**默认排序 + 就地可见的理由**，不是不可推翻的安排。
 */

// ---------------------------------------------------------------------------
// 前置图 schema：KST 的 surmise system，AND / OR 显式区分
// ---------------------------------------------------------------------------

/**
 * 一条 surmise clause（FD15 Def 17）：**clause 内是 AND，clause 之间是 OR**。
 *
 * 为什么必须区分（D-08b / KS §1.2）：Birkhoff 对应（前置图 ⟺ 拟序 ⟺ 状态=下集）只在
 * 「所有前置都必须满足」时成立。LLM 从教材抽前置时，「学 RAG 之前要会 Python **或**
 * TypeScript」这种关系一定会出现；按 AND 处理会凭空多算一整段前置链，学习者体验就是
 * 「我明明会 Python，它非要我先学 TS」。判定式因此从 `所有前置 ⊆ K` 变成
 * `∃C ∈ σ(q), C ⊆ K`——见 {@link prereqSatisfied}。
 *
 * 与 FD15 的写法差一项：FD15 约定每个 clause 含 q 自己，这里的 `all` **不含** q，
 * 只列前置。
 */
export interface PrereqClause {
  /** 这条路径要求全部掌握的知识点（AND）。空数组 = 无前置。 */
  all: readonly string[];
  /**
   * 这条边的置信度 0–1。**本模块不消费它**——硬前置 / 软前置 / 仅排序偏好的三分
   * （综合判定 4.4：`≥θ_hard` 才是不可协商的硬约束）落在管理者那条路上。
   * 之所以现在就写进 schema，是因为 4.4 明说「clause 分组与每边置信度一起改，别分两次动 schema」。
   */
  confidence?: number;
  /** 依据：支撑这条前置关系的原文片段或来源 id。K12-KGraph 式的引用，用来压幻觉。 */
  because?: string;
}

/**
 * 前置图。`items` 是 Q（全部知识点），`clauses[q]` 是 σ(q)。
 *
 * **本轮不实现图的构造**：图由管理者那条路一次性造出来（LLM 造表 → 函数查表，D-63）。
 * 这里只有消费侧。图的质量是整套冷启动方案里最大的未验证依赖（综合判定 8.3），
 * 在成对分类的精确率/召回率跑出来之前，对外材料不要出现依赖前置图质量的效果承诺。
 */
export interface PrereqGraph {
  /** 全部知识点。没有 clause 的项就是无前置项。 */
  items: readonly string[];
  /** σ(q)。缺省或空数组 = 无前置。 */
  clauses?: Readonly<Record<string, readonly PrereqClause[]>>;
}

/** `∃C ∈ σ(q), C ⊆ K`。无 clause 视为无前置。 */
export function prereqSatisfied(
  graph: PrereqGraph,
  kc: string,
  known: ReadonlySet<string>,
): boolean {
  const clauses = graph.clauses?.[kc];
  if (!clauses || clauses.length === 0) return true;
  return clauses.some((c) => c.all.every((p) => known.has(p)));
}

/**
 * `kc` 还差哪些前置。前置已满足或本来就没有前置时返回空数组。
 *
 * clause 之间是 OR，这里取**缺得最少**的那一条——「最便宜的补法」。不是唯一合理的选法
 * （缺 1 个难点可能比缺 2 个易点更贵），但代价模型我们没有，编一个出来不如用条数。
 * 与 {@link prereqSatisfied} 是同一个判定的两种投影：那个回答「行不行」，这个回答「差什么」。
 */
export function unmetPrereqs(
  graph: PrereqGraph,
  kc: string,
  known: ReadonlySet<string>,
): string[] {
  const clauses = graph.clauses?.[kc];
  if (!clauses || clauses.length === 0) return [];
  let best: string[] | null = null;
  for (const c of clauses) {
    const missing = c.all.filter((p) => !known.has(p));
    if (missing.length === 0) return [];
    if (!best || missing.length < best.length) best = missing;
  }
  return best ?? [];
}

/**
 * 一组目标沿最便宜路径展开后的**全部必经点**（含目标自身），已掌握的不计。
 *
 * 用来回答「这份缺口清单自足吗」：引擎的 `skill_gaps` 是按目标反推的差距清单，
 * 前置图是从教材抽的依赖关系，两者不同源——闭包里冒出来的、不在清单内的点，
 * 就是学习者照清单学一定会撞上的墙。
 *
 * 图上有环时靠 `need` 去重收敛，不会转圈。
 */
export function prereqClosure(
  graph: PrereqGraph,
  targets: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  const need = new Set<string>();
  const queue = targets.filter((q) => !known.has(q));
  while (queue.length) {
    const q = queue.shift()!;
    if (need.has(q)) continue;
    need.add(q);
    for (const p of unmetPrereqs(graph, q, known)) if (!need.has(p)) queue.push(p);
  }
  return [...need].sort(byName);
}

/**
 * 拿掉 `q` 之后，`known` 里原本前置成立的项是不是仍然成立。
 *
 * `K` 合法（是下集）时这与 KST 的 `K\{q} ∈ 𝒦` 完全等价：合法状态里每一项的前置本来
 * 就都成立，条件就退化成「K\{q} 的每一项前置仍成立」。
 *
 * 之所以不直接写 `isState(K\{q})`：我们的 `K` 来自 {@link knowledgeState}，它按掌握度
 * 三分带挑元素，**不做前置闭包检查**，所以 `K` 经常不是合法状态（学习者在 tool_calling
 * 上估计值 0.9、在它的前置 prompt 上只有 0.5，是常态而不是异常）。此时
 * `isState(K\{q})` 对每个 q 都返回 false，inner fringe 整个空掉，复习队列一条都出不来。
 * 改成「不许把原本成立的弄坏」之后，K 不合法时已经坏掉的那些项不再连坐，
 * 最外层那些没人依赖的项照样进复习队列。
 */
function removable(graph: PrereqGraph, known: ReadonlySet<string>, q: string): boolean {
  const without = new Set(known);
  without.delete(q);
  for (const r of without) {
    if (prereqSatisfied(graph, r, known) && !prereqSatisfied(graph, r, without)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 两个 fringe（FD15 Def 20）
// ---------------------------------------------------------------------------

/**
 * outer fringe `K^O = {q ∈ Q\K : K ∪ {q} ∈ 𝒦}`——**可学的下一个**。
 *
 * 设计稿写的 `fringe = 缺口 ∩ 前置已满足` 与这个定义在拟序空间下逐字相等（D-44 / KS §1.1），
 * 不是相似，是同一个集合。我们不枚举状态：状态 = 前置闭包封闭的下集，判定只需在图上查
 * 「某个 clause 是否已满足」，复杂度 O(边数) 而不是 O(状态数)。代价是失去了 ALEKS 那种
 * 「一道题更新整个状态分布」的信息效率，这个取舍要在对外材料里写明（KS §6）。
 */
export function outerFringe(graph: PrereqGraph, known: ReadonlySet<string>): string[] {
  return graph.items.filter((q) => !known.has(q) && prereqSatisfied(graph, q, known)).sort(byName);
}

/**
 * inner fringe `K^I = {q ∈ K : K\{q} ∈ 𝒦}`——**刚学会的、最该复习的**。
 *
 * 设计稿整份漏了它（D-44 / KS §1.3）。它是复习候选集的正确形式，比「按置信缺口排序」
 * 这种自造判据有文献背书，而且算 outer fringe 时顺带就有：
 *
 * - Fringe Theorem（FD15 Thm 21）：learning space 里任一状态由 (inner, outer) 这一对集合
 *   **唯一确定**。所以学情主视图只画两个集合是**无损表示**，不是简化展示。
 * - C21 §3.2 的遗忘曲线（670 万学习者 / 835 万道复核题）按「距状态多少层」分组：
 *   **inner layer 1 掉得最陡**，几天内降到约 0.60 并趋平；越靠内层曲线越平。
 *   即「刚学会的最容易忘」，而「刚学会」在形式上就是 inner fringe。
 * - 复习项与新学项进**同一条队列**（Duolingo 把复习注入同一课时；Anki 新学:复习 ≈ 1:10），
 *   不做独立复习模块——设计稿 §九 的结论，现在有工业先例可引。
 *
 * 只给最外一层。要更深的层就把这一层剥掉再算一次，等复习队列真的一层不够用了再写。
 *
 * `K` 不是合法状态时的退化行为见 {@link removable}——掌握度向量不做闭包，这是常态。
 *
 * ponytail: O(|K|² × clause 数) 的朴素实现——每个 q 都把 K 里的项重验一遍。
 * 几百个知识点上无所谓；上千个再改成「按 q 的直接依赖者反查」。
 */
export function innerFringe(graph: PrereqGraph, known: ReadonlySet<string>): string[] {
  return [...known].filter((q) => removable(graph, known, q)).sort(byName);
}

/**
 * ALEKS 的 layer：**距当前状态的图距离**。0 = 已在状态内，1 = outer fringe，2 = 再往外一层。
 * 不可达的项不出现在返回值里（前置里有环，或前置项不在 `items` 里）。
 *
 * 这是设计稿 §6.1「复杂度单调递增」的正确形式（D-47 / KS §2.3(b)）。原来的写法是给资源打
 * **绝对**难度标注再要求单调；ALEKS 的复杂度是**相对**量，好处三条：随学习者变化（同一个
 * 概念对不同人不在同一层）、不需要额外标注（算 fringe 时顺带得到，也就不用信任 LLM 标的
 * 绝对难度）、有实测支撑（C21 Fig. 3a：复核题正确率随层数单调，跨过 0.3 的幅度）。
 */
export function layers(graph: PrereqGraph, known: ReadonlySet<string>): Map<string, number> {
  const depth = new Map<string, number>();
  for (const q of graph.items) {
    if (known.has(q)) depth.set(q, 0);
  }
  let reached = new Set(known);
  // 每轮至少吃掉一个未达项，最多 |items| 轮。
  for (let n = 1; ; n += 1) {
    const next = outerFringe(graph, reached);
    if (next.length === 0) return depth;
    for (const q of next) depth.set(q, n);
    reached = new Set([...reached, ...next]);
  }
}

/**
 * 直接依赖 `kc` 的知识点个数——「前置度优先」这条排序键的量。
 *
 * OR 前置下这是**上界**：`rag` 的两条 clause 分别要 Python 和 TypeScript，两个都记 +1，
 * 但学完其中一个就够解锁 rag。这条键本来就无实证（见 {@link RankOptions.prereqPriority}），
 * 不值得为它把计数做精确。
 */
export function unlockCount(graph: PrereqGraph, kc: string): number {
  return graph.items.filter((q) => (graph.clauses?.[q] ?? []).some((c) => c.all.includes(kc)))
    .length;
}

// ---------------------------------------------------------------------------
// 状态判定：三分带，不是二分阈值
// ---------------------------------------------------------------------------

/**
 * 掌握度二元组（设计稿 §5.2）。领域标准形式是 Glicko 的 `(r, RD)` / IRT 的 `(θ, SE(θ))`。
 *
 * 两个分量是**两个量，不共用门槛**：
 * - `estimate` 是「他会的概率」，对应 BKT 的后验 `P(L)`。三分带和成功率预测吃它。
 * - `confidence` 是 epistemic uncertainty——我们对估计值本身的把握。它**不是**猜/失误率
 *   （那是 aleatoric，进似然、压估计值涨幅，见 {@link predictedCorrect} 的 `guess`/`slip`）。
 *
 * 载体（logit 空间的 `(m, v)`、Glicko 式方差扩散）不在本模块，也还没实现。
 */
export interface Mastery {
  estimate: number;
  confidence?: number;
}

/** 裸数字 = 只有估计值（老引擎的 `mastery_vector` 就是这种）。 */
export type MasteryInput = number | Mastery;

export function estimateOf(m: MasteryInput | undefined): number {
  const raw = typeof m === 'number' ? m : (m?.estimate ?? 0);
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

/** 状态判定的三分带。 */
export type StateBand = 'in' | 'uncertain' | 'out';

/**
 * 判「会」的下界，**严格大于**。C21 §1.3 原文是 "above 80%"。
 *
 * 这个数替换掉了原来那个 0.7（D-31 / R-02）。0.7 在任何成熟系统里都不是掌握线，
 * 而且我们原来用同一个 0.7 同时充当估计值门槛和置信门槛——那正是设计稿 §5.2 花整节
 * 论证要避免的事。
 */
export const IN_STATE_MIN = 0.8;

/** 判「不会」的上界，**严格小于**。C21 §1.3："less than 20%"。 */
export const OUT_OF_STATE_MAX = 0.2;

/**
 * 讲深一点 / 浅一点的估计值门槛。猜错代价小（读者自己会跳），0.7 留着（综合判定 4.1）。
 * 这是「0.7 拆成两个数」里估计值那一半的下沿，不是掌握线。
 */
export const ESTIMATE_TEACH_DEPTH = 0.7;

/**
 * 停止练习 / 跳过这一节的估计值门槛：**0.95**，Corbett & Anderson 1995 的 `P(L) > 0.95`，
 * Cognitive Tutor 二十年的默认设定，不是某篇论文的孤例。
 *
 * 配套的另一半是**结构判据不是数字**（综合判定 4.1 的裁决）：跳过还要求该 KC 至少有一道
 * **单点题**证据（Q 完备性 / 可识别性）；断言「你已掌握 X」还要求至少两种形态的证据。
 * 把置信门槛照抄 CAT 的 `SE ≤ 0.32` 需要 29–65 道四选一题，我们一次也达不到——
 * 正确反应是**把措辞降级**（「看起来掌握了，我换个方式再确认一次」），不是临场编一个
 * 宽松刻度然后宣布自己达标。结构判据要 Q 矩阵那条线的数据，不在本模块。
 */
export const ESTIMATE_MASTERED = 0.95;

/** 估计值 → 三分带。 */
export function bandOf(estimate: number): StateBand {
  if (estimate > IN_STATE_MIN) return 'in';
  if (estimate < OUT_OF_STATE_MAX) return 'out';
  return 'uncertain';
}

/**
 * 掌握度表 → 知识状态 K。**只收 `in`**。
 *
 * 三分带是工业界的做法，二分不是（D-31 / KS §3.2）。uncertain 的项不计入状态——宁可当他
 * 不会，与「跳过要高置信」同向；C21 明说这会低估学习者的真实状态，这是有意的。
 * ALEKS 初评实测：uncertain 占 10.7%–16.8%，其中答对率 0.42–0.45（扣掉粗心失误后接近 0.5，
 * C21 把这一点当作校准良好的标志）。
 *
 * 代价由 {@link targetScore} 的快速通道补偿，不是让他从头再学一遍。
 */
export function knowledgeState(masteries: Readonly<Record<string, MasteryInput>>): Set<string> {
  const known = new Set<string>();
  for (const [kc, m] of Object.entries(masteries)) {
    if (bandOf(estimateOf(m)) === 'in') known.add(kc);
  }
  return known;
}

/** 正常掌握一个知识点要累计的目标分（C21 §1.3）。 */
export const TARGET_SCORE = 5;
/** 快速通道的目标分：正常的 3/5。 */
export const FAST_TRACK_TARGET_SCORE = 3;

/**
 * 该给这个知识点多少练习预算。
 *
 * uncertain 不计入状态**但走快速通道**：C21 §1.3——初评判为 uncertain 的项、以及学过但在
 * 阶段测评中掉出状态的项，目标分只要 3 而不是 5。这就是设计稿 §5.3 那句「能教人的系统会说
 * 『看起来会了，我换个方式再确认一次』」的工业实现，而且给了成本：复核成本 = 正常的 3/5，
 * 覆盖 10%–17% 的项。
 */
export function targetScore(band: StateBand): number {
  return band === 'uncertain' ? FAST_TRACK_TARGET_SCORE : TARGET_SCORE;
}

// ---------------------------------------------------------------------------
// 首排序键：目标成功率 0.75–0.85
// ---------------------------------------------------------------------------

/** 目标成功率带下沿。Math Garden 的工程取值（3648 名儿童 / 350 万道题）。 */
export const TARGET_SUCCESS_MIN = 0.75;
/** 上沿。Wilson et al. 2019 (Nat. Commun. 10:4646) 的 85% 规则，最优错误率 15.87%。 */
export const TARGET_SUCCESS_MAX = 0.85;

/** DINA 的 slip 参数：会却答错。惯例上界 0.1。 */
export const SLIP = 0.1;
/** DINA 的 guess 参数：不会却蒙对。钉死为 1/选项数——小样本下 3PL 的 `c` 不可识别。 */
export const guessByOptions = (options: number): number => (options > 0 ? 1 / options : 0);

/**
 * 预测正确率：`P(对) = p·(1−s) + (1−p)·g`（DINA 的观测通道）。
 *
 * `g`/`s` 是 **aleatoric** 噪声，挂在**题**上不挂在知识点上（D-20b：一道挂 3 KC 的四选一
 * 答对，若每条证据各涨一次会把 1.28 的 log-odds 算成 3.84）。它与二元组里的 `confidence`
 * 是两码事，别混。
 *
 * 一个必须知道的性质：`g=0.25` 时 `p=0` 的预测正确率就是 0.25，离带下沿 0.75 很远，而且
 * **所有没学过的知识点在这条键上完全并列**。冷启动时这条键不区分候选，实际排序由 layer
 * 决定。这不是 bug——目标成功率是「别把人推进挫败区」的判据，冷启动时他对哪个点都一样陌生。
 */
export function predictedCorrect(
  estimate: number,
  options: { guess?: number; slip?: number } = {},
): number {
  const g = options.guess ?? guessByOptions(4);
  const s = options.slip ?? SLIP;
  const p = Math.min(1, Math.max(0, estimate));
  return p * (1 - s) + (1 - p) * g;
}

/** 距目标成功率带的距离，带内为 0。越小越该先学。 */
export function bandDistance(predicted: number): number {
  if (predicted < TARGET_SUCCESS_MIN) return TARGET_SUCCESS_MIN - predicted;
  if (predicted > TARGET_SUCCESS_MAX) return predicted - TARGET_SUCCESS_MAX;
  return 0;
}

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

/** 一个候选点，连同它凭什么排在这个位置。四个字段就是 because 链的四项事实。 */
export interface Pick {
  kc: string;
  /** 现在直接考他的预测正确率。 */
  predicted: number;
  /** 距 0.75–0.85 带的距离，带内 0。首排序键。 */
  bandDistance: number;
  /** 距当前状态几步。次排序键；从图上到不了的记 {@link UNREACHABLE_LAYER}。 */
  layer: number;
  /** 直接解锁几个后续知识点。末位排序键，可关。 */
  unlocks: number;
}

export interface RankOptions {
  /** 猜测参数，缺省按四选一 0.25。开放题传 0.05。 */
  guess?: number;
  slip?: number;
  /**
   * 候选集。**缺省 = outer fringe**，即只排「现在就能学的」——前置没满足的根本不进候选，
   * 这是硬约束不是排序偏好（设计稿 §7.6）。
   *
   * 传别的集合（典型是终点闭包里还没掌握的全部知识点）就是排**一整段路径**，`layer`
   * 那条键只有这时才真正起作用：outer fringe 内部所有项的 layer 恒等于 1。已在状态内的项
   * 会被剔掉——已经会了不是「下一步」。
   */
  candidates?: readonly string[];
  /**
   * 前置度优先——**默认开，但排在最后，而且第一个该被消融掉**（D-46 / KS §2.3(a)）。
   *
   * 文献里找不到「优先学解锁后续最多的知识点」的实证研究。最接近的 ZPDES 按经验学习进展
   * 选活动，根本不看图结构；Knewton 白皮书做前置传播但没给选点判据。这条是我们自己的启发式，
   * 所以：不写进创新点、不默认它比随机排序好、评测里留对照组（fringe 内随机 vs 本排序）。
   * 如果没差别就诚实写「未观察到增益，保留是为了决策可解释」。
   */
  prereqPriority?: boolean;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 图上到不了的项（前置有环，或前置项不在 `items` 里）的 layer，排最后。 */
export const UNREACHABLE_LAYER = Number.MAX_SAFE_INTEGER;

/** 浮点比较留一点余量，免得 1e-16 的差把后面的排序键整个盖掉。 */
function cmp(a: number, b: number): number {
  return Math.abs(a - b) < 1e-9 ? 0 : a - b;
}

/**
 * 从 outer fringe 里排出「下一步学什么」。纯函数，排序键按下面的顺序应用：
 *
 * 1. **目标成功率**：预测正确率落在 0.75–0.85 带内的优先，其次按距带的距离（D-49）。
 *    这是这次调研给的、比设计稿原来三条都硬的判据，三个独立来源指向同一量级
 *    （Math Garden 0.75 / Wilson 2019 的 85% 规则 / Duolingo 的 Goldilocks difficulty）。
 *    它同时解决两件事：不浪费时间在已经会的，也不把人推进挫败区。证据等级 B。
 * 2. **layer**：距当前状态的图距离，近的先（D-47）。
 * 3. **unlocks**：前置度优先，多的先——**可关，且无实证**（D-46）。
 * 4. 名字，只为让结果稳定可测。
 *
 * 适用场合是**学习环节**。测评环节（冷启动初评、置信度不够时的复核）该按 CAT 的最大信息
 * 选题，不走这条键。综合判定 4.5 的旁证：`a=1, c=0.25` 时信息峰值在 `P=0.683`，与带下沿
 * 0.75 只差一点，所以四选一场景下两者近似，但这是近似不是等价，别写成两个目标一回事。
 */
export function rankNext(
  graph: PrereqGraph,
  masteries: Readonly<Record<string, MasteryInput>>,
  options: RankOptions = {},
): Pick[] {
  const known = knowledgeState(masteries);
  const depth = layers(graph, known);
  const prereqPriority = options.prereqPriority ?? true;
  const candidates = (options.candidates ?? outerFringe(graph, known)).filter(
    (kc) => !known.has(kc),
  );

  return candidates
    .map((kc) => {
      const predicted = predictedCorrect(estimateOf(masteries[kc]), options);
      return {
        kc,
        predicted,
        bandDistance: bandDistance(predicted),
        layer: depth.get(kc) ?? UNREACHABLE_LAYER,
        unlocks: unlockCount(graph, kc),
      };
    })
    .sort(
      (a, b) =>
        cmp(a.bandDistance, b.bandDistance) ||
        cmp(a.layer, b.layer) ||
        (prereqPriority ? cmp(b.unlocks, a.unlocks) : 0) ||
        byName(a.kc, b.kc),
    );
}

/**
 * 复习候选：inner fringe，浅的在前。
 *
 * 与 {@link rankNext} 的结果进**同一条队列**（Duolingo / Anki 的做法，KS §5.2），
 * 不做独立复习模块。ALEKS 的 progress assessment 给了三条现成理由：确认状态、制造提取
 * 练习效应、强制交错练习（C21 §1.2）——比「用户感觉不到额外负担」这种体验层辩护硬。
 *
 * ponytail: 只按 inner fringe 出候选，没排序。真正的排序键是「距上次通过的时间 / 稳定性
 * 估计」（FSRS 默认参数或 SM-2，禁止拟合——每人几百上千条复习记录我们没有），要证据的
 * 时间戳才算得出，等接线时从履历取。
 */
export function reviewCandidates(graph: PrereqGraph, known: ReadonlySet<string>): string[] {
  return innerFringe(graph, known);
}
