/**
 * 同题异人对比：引擎返回结构 + 页面用的纯逻辑。
 *
 * 从 page.tsx 拆出来是为了能直接测——差异归因的措辞、审核行的取值、耗时估算
 * 都是「跑一次要十几分钟」才验得到的东西，放在组件里只能靠肉眼看。
 *
 * 结构与 `apps/agent-engine/backend/services/compare_service.py` 的
 * ComparisonReport 同源，字段只加不减（旧的 public/compare-showcase.json 仍要能解析）。
 */

// ── 引擎返回结构 ─────────────────────────────────────────────────────────────

export interface ResourceMix {
  scaffold_level?: string;
  analogy_domain?: string;
  visual_widget_count?: number;
  diagram_count?: number;
  code_example_count?: number;
  section_length_band?: string;
  quiz_difficulty_band?: string[];
  rationale?: string[];
}

export interface ProfileSnapshot {
  profile_id: string;
  name: string;
  background: string;
  levels?: Record<string, number>;
  recommended_difficulty: string;
  weak_concepts: string[];
  learner_type?: string;
  skill_gaps?: string[];
  content_strategy?: string[];
  resource_mix: ResourceMix | null;
}

export interface ResourceSnapshot {
  lecture_title: string;
  section_headings: string[];
  section_count: number;
  task_title: string;
  task_difficulty: string;
  task_steps: number;
  quiz_count: number;
  quiz_difficulties: string[];
}

/** `full_run.audit` 的最小切片：审核 Agent 对本次生成的核验结果。 */
export interface AuditSnapshot {
  factuality_score?: number;
  claims_total?: number;
  claims_supported?: number;
}

export interface CompareEntry {
  profile: ProfileSnapshot;
  resources: ResourceSnapshot;
  cost?: { duration_ms?: number } | null;
  full_run?: { audit?: AuditSnapshot | null } | null;
}

export interface AttributedDifference {
  dimension: string;
  observation: string;
  because: string[];
}

export interface CompareReport {
  learning_goal: string;
  /** 预生成对照才有（public/compare-showcase.json 的落盘时间） */
  generated_at?: string;
  entries: CompareEntry[];
  differences: AttributedDifference[];
  fact_invariance?: { checked_claims: number; passed: boolean } | null;
}

// ── 计时与耗时估算 ───────────────────────────────────────────────────────────

/** 已耗时展示：`3 分 07 秒` / `45 秒` */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`;
}

/**
 * 现场跑一次要多久：**从预生成对照里每个画像的实测 `cost.duration_ms` 算**，
 * 不写死数字。引擎是一个画像跑完再跑下一个（compare_service.py 的 for 循环），
 * 所以两个画像的耗时是相加关系；取最快的两个与最慢的两个给出区间。
 *
 * 拿不到至少两个实测值就返回 null——宁可不标，也不编一个「约 X 分钟」。
 */
export function serialRunEstimate(entries: CompareEntry[]): { minMs: number; maxMs: number } | null {
  const durations = entries
    .map((e) => e.cost?.duration_ms)
    .filter((d): d is number => typeof d === 'number' && d > 0)
    .sort((a, b) => a - b);
  if (durations.length < 2) return null;
  return {
    minMs: durations[0] + durations[1],
    maxMs: durations[durations.length - 2] + durations[durations.length - 1],
  };
}

/** `约 14–18 分钟` / `约 14 分钟` */
export function formatMinutesRange(minMs: number, maxMs: number): string {
  const lo = Math.round(minMs / 60000);
  const hi = Math.round(maxMs / 60000);
  return lo === hi ? `约 ${lo} 分钟` : `约 ${lo}–${hi} 分钟`;
}

// ── 审核行 ───────────────────────────────────────────────────────────────────

/**
 * 每列挂一条审核结果。数据在返回体的 `entries[i].full_run.audit` 里，
 * 界面此前整个丢掉了——生成完还被核过一遍是这套系统的主要卖点之一。
 *
 * 缺字段就返回 null（不补 0，也不写「未返回」占位）。
 */
export function auditLine(audit: AuditSnapshot | null | undefined): string | null {
  if (!audit) return null;
  const { factuality_score: score, claims_total: total, claims_supported: supported } = audit;
  if (typeof score !== 'number' || typeof total !== 'number') return null;
  const tail =
    typeof supported === 'number' ? `，${supported} 条对得上引用的教材片段` : '';
  return `事实性 ${score.toFixed(2)}/1 · 断言 ${total} 条${tail}`;
}

// ── 小节标题去内部枚举 ───────────────────────────────────────────────────────

/**
 * 引擎给小节标题带的目标概念前缀，前缀里是内部英文枚举 id（`agent_basics` 这种），
 * 不给访客看。预生成对照里三种写法都出现过：
 *   `【目标概念：rag】RAG如何工作？…` / `目标概念：rag - RAG如何…` / `rag：作为工具集成的…`
 *
 * 只剥「纯 ascii 概念 id + 分隔符」这一段。中文标注（`【综合示例】`）不动：
 * 第一分支要求方括号里全是 ascii id，第二分支要求以 ascii id 开头。
 */
const CONCEPT_PREFIX =
  /^\s*(?:【\s*(?:目标概念\s*[:：]\s*)?[a-z][a-z0-9_]*(?:\s*[&,、和]\s*[a-z][a-z0-9_]*)*\s*】|(?:目标概念\s*[:：]\s*)?[a-z][a-z0-9_]*(?:\s*[&,、和]\s*[a-z][a-z0-9_]*)*\s*[-–—:：])\s*/;

/** 剥掉概念 id 前缀；剥完为空就退回原文，宁可露前缀也不给一个空标题。 */
export function stripConceptPrefix(heading: string): string {
  return heading.replace(CONCEPT_PREFIX, '').trim() || heading;
}

// ── 两列挑选与差异 ───────────────────────────────────────────────────────────

/**
 * 两列都拿到了非空值、且值不同，才算「真差异」。
 *
 * 少了非空这一半会出事：引擎某一维没返回时这一列渲染的是「未返回」，
 * 拿它跟另一列的真实值比必然「不同」，等于把数据缺口标成了个性化差异。
 */
export function isRealDiff(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a !== b;
}

/**
 * 同题「异人」是两个人的对照，所以永远只排两列。
 * 预生成对照落盘时跑了三个画像，取首尾两个——背景差得最远的一对。
 */
export function pickPair(entries: CompareEntry[]): [CompareEntry, CompareEntry] | null {
  if (entries.length < 2) return null;
  return [entries[0], entries[entries.length - 1]];
}

function uniqueHeadings(a: ResourceSnapshot, b: ResourceSnapshot): number {
  const other = new Set(b.section_headings);
  return a.section_headings.filter((h) => !other.has(h)).length;
}

/**
 * 背景句自带句号，嵌进「」里再接下半句会多一个点。
 * 单人版归因（`app/report/attribution.ts`）引用同一个，两处的引号里不会一处有点一处没点。
 */
export function trimStop(text: string): string {
  return text.replace(/[。.]\s*$/, '');
}

/**
 * 差异归因的人话渲染。
 *
 * 引擎给的 `differences[].because` 是机器归因链（「掌握向量 rag=0.00」这种），
 * 数据层保留不动，但那不是给人读的。这里的做法是：**用引擎判定的差异维度
 * 决定说哪几条**，句子本身从两个画像的快照字段现拼——每个数字都指得回
 * `entries[i].profile` 里的具体字段，跟 because 链同源。
 *
 * 上限 3 条：再多就没人看了，而且小节级差异在两列的讲义目录里已经逐条标了。
 */
export function humanDifferences(
  a: CompareEntry,
  b: CompareEntry,
  differences: AttributedDifference[],
  limit = 3,
): string[] {
  const dims = new Set(differences.map((d) => d.dimension));
  const an = a.profile.name;
  const bn = b.profile.name;
  const al = a.profile.levels ?? {};
  const bl = b.profile.levels ?? {};
  const am = a.profile.resource_mix ?? {};
  const bm = b.profile.resource_mix ?? {};
  const out: string[] = [];

  // 1) 难度 ← 编程基础
  if (
    dims.has('difficulty') &&
    isRealDiff(a.profile.recommended_difficulty, b.profile.recommended_difficulty) &&
    typeof al.programming === 'number' &&
    typeof bl.programming === 'number'
  ) {
    out.push(
      `${an}的编程基础 ${al.programming}/4，${bn}是 ${bl.programming}/4，` +
        `所以讲义难度一个定在 ${a.profile.recommended_difficulty}、一个定在 ${b.profile.recommended_difficulty}。`,
    );
  }

  // 2) 例子取材 ← 背景
  if (dims.has('mix') && isRealDiff(am.analogy_domain, bm.analogy_domain)) {
    out.push(
      `${an}的背景是「${trimStop(a.profile.background)}」，例子就取自${am.analogy_domain}；` +
        `${bn}是「${trimStop(b.profile.background)}」，例子取自${bm.analogy_domain}。`,
    );
  }

  // 3) 补基础的小节 ← 掌握度不到线的概念数
  //    不写「测验」：掌握度在没做过前测时是从画像分值推的
  //    （`orchestration/workflow.py:368` 走 estimate_pretest_from_profile）。
  if (dims.has('sections')) {
    const ua = uniqueHeadings(a.resources, b.resources);
    const ub = uniqueHeadings(b.resources, a.resources);
    if (ua > 0 || ub > 0) {
      out.push(
        `${an}有 ${a.profile.weak_concepts.length} 个概念的掌握度不到线，讲义单独给他加了 ${ua} 节；` +
          `${bn}是 ${b.profile.weak_concepts.length} 个、${ub} 节。`,
      );
    }
  }

  // 4) 篇幅与代码示例 ← Python 基础
  if (dims.has('mix') && typeof al.python === 'number' && typeof bl.python === 'number') {
    const effects: string[] = [];
    if (
      typeof am.code_example_count === 'number' &&
      typeof bm.code_example_count === 'number' &&
      am.code_example_count !== bm.code_example_count
    ) {
      effects.push(`每节代码示例 ${am.code_example_count} 个和 ${bm.code_example_count} 个`);
    }
    if (isRealDiff(am.section_length_band, bm.section_length_band)) {
      effects.push(`每节篇幅 ${am.section_length_band} 字和 ${bm.section_length_band} 字`);
    }
    if (effects.length > 0) {
      out.push(
        `${an}的 Python 基础 ${al.python}/4、${bn} ${bl.python}/4，两边就分到了${effects.join('，')}。`,
      );
    }
  }

  // 5) 讲法 ← 内容策略第一条
  const as0 = a.profile.content_strategy?.[0];
  const bs0 = b.profile.content_strategy?.[0];
  if (dims.has('strategy') && isRealDiff(as0, bs0)) {
    out.push(`讲法也不一样：${an}是「${trimStop(as0!)}」，${bn}是「${trimStop(bs0!)}」。`);
  }

  // 6) 实操任务难度
  if (dims.has('task') && isRealDiff(a.resources.task_difficulty, b.resources.task_difficulty)) {
    out.push(
      `实操任务难度跟着走：${an} ${a.resources.task_difficulty}、${bn} ${b.resources.task_difficulty}。`,
    );
  }

  return out.slice(0, limit);
}

// ── 刷新后接回在飞的 job ─────────────────────────────────────────────────────

export interface JobPoll {
  status?: string;
  elapsedMs?: number;
  result?: Partial<CompareReport>;
}

/**
 * 拿到一次轮询响应后该怎么办。抽成纯函数是为了能测——
 * 四个分支里有三个（结果不完整、已失败、job 过期）在正常演示里都不会走到，
 * 恰恰是这三个出错时最难发现。
 *
 * `now` 显式传进来，不在函数里读时钟：startedAt 要能被断言。
 */
export function resumeDecision(
  poll: JobPoll,
  httpOk: boolean,
  now: number,
):
  | { kind: 'ok'; report: CompareReport }
  | { kind: 'loading'; startedAt: number }
  | { kind: 'drop' } {
  if (!httpOk) return { kind: 'drop' };
  if (poll.status === 'succeeded') {
    return (poll.result?.entries?.length ?? 0) >= 2
      ? { kind: 'ok', report: poll.result as CompareReport }
      : { kind: 'drop' };
  }
  if (poll.status === 'failed') return { kind: 'drop' };
  return { kind: 'loading', startedAt: now - (poll.elapsedMs ?? 0) };
}
