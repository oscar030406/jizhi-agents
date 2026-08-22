/**
 * 证据模型 —— 设计稿 §4.4 的类型与构造。
 *
 * 一条证据 = 四个子盒（来源 / 测项 / 判定 / 情境）。四个都填得满才是证据，
 * 填不满的是**信号**（{@link Signal}）：信号只参与权重计算，不进履历。
 *
 * 三条定死的（设计稿 §4.4）在这里的落点：
 * 1. 证据不可变但可作废 —— 没有 setter；作废走 {@link Invalidation} 追加记录。
 * 2. **测项必须唯一** —— 一条 Evidence 只有一个 {@link Measured}。一道题挂 N 个
 *    知识点由 {@link createEvidence} 展开成 N 条，**共享来源，判定逐测项独立**，
 *    情境逐条给。设计稿原文写的是「共享来源与判定」，判定那半个已被纠正，
 *    理由见 {@link EvidenceDraft}——看着像倒退，是文献打回来的，别改回去。
 * 3. 证据永不丢弃 —— 权重（见 `./weight`）只削强度，不影响存在。
 *
 * 注意与 `lib/generation/evidence-grounding.ts` 里的 `EvidenceChunk` 区分：
 * 那是资源的「依据」子盒（检索到的教材块），这里是学习者应答的产物。
 * 两者同名不同物，不要互相 import。
 */

/**
 * 测项：测的是通用能力的哪一维，还是某领域的哪个概念。
 *
 * 这个二选一就是画像通用面 / 专业面的分界（设计稿 §4.1）：`general` 更新通用面，
 * `concept` 更新对应 domain 的专业面。一道矩阵乘法题出现在 AI 课里，测项仍是
 * `{ kind: 'general', axis: 'math' }`。
 */
export type Measured =
  | { kind: 'general'; axis: string }
  | { kind: 'concept'; domain: string; concept: string };

/**
 * 领域取不到时的兜底值。
 *
 * **这是历史数据的兜底，不是新证据的默认。** 2026-08-13 之前所有写进账本的证据
 * 都把 domain 写死成 `'ai'`（三个调用点各写一遍），`byDomain` 因此只有一个桶。
 * 现在领域从画像取（`profile-bridge.ts` 的 `learnerDomain()`），只有画像里
 * 压根没有 domain 字段时才落到这里——落到这里的新证据会和那批旧证据归进同一个桶，
 * 这正是我们要的：不为「没填领域」再开一个空桶。
 */
export const LEGACY_DOMAIN = 'ai';

/** 测项的稳定字符串键，用于归拢同一测项的证据。分段转义，域名里带冒号也不会撞。 */
export function measuredKey(m: Measured): string {
  return m.kind === 'general'
    ? `general:${encodeURIComponent(m.axis)}`
    : `concept:${encodeURIComponent(m.domain)}:${encodeURIComponent(m.concept)}`;
}

/** 来源：哪次交互、哪份资源、哪个片段、什么时刻。 */
export interface EvidenceSource {
  /** 哪次交互。同一次交互产出的多条证据共享它，也是信号挂回证据的连接键。 */
  interactionId: string;
  /** 哪份资源（场景 id / 讲义 id / 题集 id）。 */
  resourceId: string;
  /** 哪个片段：题目 id、段落 id、微任务 id。整份资源级别的判定可省。 */
  fragmentId?: string;
  /** ISO 8601，与 runtime 层的时间编码一致。 */
  at: string;
}

/** 判定结论。连续量走 {@link EvidenceVerdict.score}。 */
export type Outcome = 'correct' | 'partial' | 'incorrect';

/**
 * 错因分型（DeepTutor 四分类的确定性粗分，提炼见
 * docs/04-research/deeptutor-transplant-decision-20260821.md）：
 * 空答是「不知道」（metacognitive），答了但错是「会用错」（application），
 * 一卷里两者都有记 mixed。细分型（知识结构性/理解偏差）需要 LLM 错因诊断，
 * 这里不做——粗分已够指方向：元认知型该降档重讲，应用型该加练订正。
 */
export type ErrorKind = 'metacognitive' | 'application' | 'mixed';

/** 判定：结论 + because（命中哪些要点、漏了哪些）。 */
export interface EvidenceVerdict {
  outcome: Outcome;
  /** 连续量，0–1。缺省时由 outcome 映射（见 {@link verdictScore}）。 */
  score?: number;
  /** 错因分型。只在有失分时存在；旧证据无此字段。 */
  errorType?: ErrorKind;
  because: {
    /** 命中的要点。 */
    hit: string[];
    /** 漏掉的要点。空数组是合法的（全对）。 */
    missed: string[];
  };
}

/**
 * 交互形态。设计稿列的四种是 quiz / tutor / widget / review（测验 / 导学 /
 * 教具 / 讲评），但和 `RuntimeSession.kind` 一样是开放字符串——加形态不改闭环。
 * `skip-probe` 是「跳过时问一句」把信号升格成的证据。
 */
export type EvidenceModality =
  | 'quiz'
  | 'tutor'
  | 'widget'
  | 'review'
  | 'skip-probe'
  | (string & {});

/** 情境：第几次遇到、距上次多久、耗时、题目难度、通过什么形态。 */
export interface EvidenceContext {
  /** 该测项第几次遇到，1 起。 */
  encounter: number;
  modality: EvidenceModality;
  /** 距上次遇到该测项多久（ms）。首次遇到时省略。 */
  sinceLastMs?: number;
  /** 本次作答耗时（ms）。 */
  elapsedMs?: number;
  /** 题目难度 0–1。缺省按 0.5 计权。 */
  difficulty?: number;
}

/**
 * 判定的作用域：这条判定说的是「这个 KC 用对了吗」还是「这道题对不对」。
 *
 * - `per-kc`：判官逐测项出的结论，正路。
 * - `item-level`：题级判定被摊到这个测项上（纯选择题只有对错，拿不到 per-KC 判定）。
 *   **降级必须留痕**：权重上答错要打折（`./weight`），账本上要能被 `downgraded()`
 *   查出来。静默复制题级判定正是本轮纠正掉的那件事。
 *
 * 命名沿用心理测量学口径：item = 题。注意与 {@link EvidenceDraft.items} 不是一回事，
 * 后者是「一次交互展开出的逐测项条目」。
 */
export type VerdictScope = 'per-kc' | 'item-level';

/**
 * 补救场景的 id 前缀。`/api/adaptive/remediation` 铸的是
 * `remediation_<决策>_<时间戳>`，标记天然就在 id 里——**不用给 DSL 契约加字段**
 * （`SceneCore` 是版本化的，为一个展示用的标记改它不划算）。
 */
export const REMEDIATION_ID_PREFIX = 'remediation_';

/**
 * 这个场景是不是讲评（订正）场景。
 *
 * 判据集中在这里：`from-quiz` / `from-tutor` 都要用它决定 modality 记 `review`
 * 还是 `quiz`/`tutor`。分散在两个调用点各写一遍，改前缀时必漏一个。
 *
 * 为什么要分得开：讲评的证据是**订正后**的表现，与首次作答不是一回事。
 * 混成一个 modality，学情轨迹上就看不出「他是错完改对的」还是「一次就对的」——
 * 而这两者对下一步该做什么的含义完全不同。
 */
export function isRemediationScene(sceneId: string): boolean {
  return sceneId.startsWith(REMEDIATION_ID_PREFIX);
}

/** 一条证据。四个子盒齐备，测项唯一，不可变。 */
export interface Evidence {
  id: string;
  learnerKey: string;
  source: EvidenceSource;
  /** 唯一。一条证据只测一件事。 */
  measured: Measured;
  verdict: EvidenceVerdict;
  /** 上面那条 verdict 判的是这个测项，还是整道题摊过来的。见 {@link VerdictScope}。 */
  verdictScope: VerdictScope;
  context: EvidenceContext;
}

/**
 * 信号：只填得满「来源」的交互产物（页面停留时长、跳过某节）。
 *
 * 不进履历、不进画像，只进权重（设计稿：某节停留极短且随后答错，说明那次作答
 * 置信度低）。信号靠 `source.interactionId` 挂回同一次交互的证据。
 *
 * 升格路径不需要新机制：跳过时补问一句「已经会了还是太难了」，拿到测项与判定，
 * 直接调 {@link createEvidence} 就是证据。
 */
export interface Signal {
  id: string;
  learnerKey: string;
  source: EvidenceSource;
  /** 信号类型。`lowDwell`（停留极短）是权重函数目前认识的唯一一种。 */
  kind: string;
  /** 类型相关的量（停留毫秒数等）。 */
  value?: number;
  note?: string;
}

/** 作废记录。原证据不动，追加一条说明为什么它不该再算数。 */
export interface Invalidation {
  id: string;
  evidenceId: string;
  /** 为什么作废：坏题、判官判错、申诉成立。 */
  reason: string;
  /** ISO 8601。 */
  at: string;
  /** 谁作废的：判官 id / 'learner' / 'admin'。 */
  by?: string;
}

/** 判定的连续量。缺省 score 时由 outcome 映射。 */
export function verdictScore(v: EvidenceVerdict): number {
  if (typeof v.score === 'number' && Number.isFinite(v.score)) {
    return Math.min(1, Math.max(0, v.score));
  }
  return v.outcome === 'correct' ? 1 : v.outcome === 'partial' ? 0.5 : 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isMeasured(v: unknown): v is Measured {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<Measured> & { axis?: unknown; domain?: unknown; concept?: unknown };
  if (m.kind === 'general') return isNonEmptyString(m.axis);
  if (m.kind === 'concept') return isNonEmptyString(m.domain) && isNonEmptyString(m.concept);
  return false;
}

function isSource(v: unknown): v is EvidenceSource {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    isNonEmptyString(s.interactionId) &&
    isNonEmptyString(s.resourceId) &&
    isNonEmptyString(s.at) &&
    (s.fragmentId === undefined || isNonEmptyString(s.fragmentId))
  );
}

function isVerdict(v: unknown): v is EvidenceVerdict {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  if (d.outcome !== 'correct' && d.outcome !== 'partial' && d.outcome !== 'incorrect') return false;
  if (d.score !== undefined && (typeof d.score !== 'number' || !Number.isFinite(d.score))) {
    return false;
  }
  const because = d.because as Record<string, unknown> | undefined;
  // because 是判定的一半：没有「命中什么、漏了什么」，结论就没法对质。
  if (typeof because !== 'object' || because === null) return false;
  return isStringArray(because.hit) && isStringArray(because.missed);
}

function isContext(v: unknown): v is EvidenceContext {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.encounter !== 'number' || !Number.isInteger(c.encounter) || c.encounter < 1) {
    return false;
  }
  if (!isNonEmptyString(c.modality)) return false;
  for (const k of ['sinceLastMs', 'elapsedMs', 'difficulty'] as const) {
    const n = c[k];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n))) return false;
  }
  return true;
}

/**
 * 四个子盒齐备吗？这是「什么算有效反馈」的机械答案（设计稿 §4.4）。
 *
 * 填不满的进不了履历——一个 {@link Signal}、一条只有来源的停留记录、一条没有
 * because 的判定，都会在这里被判否。
 */
export function isEvidence(value: unknown): value is Evidence {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    isNonEmptyString(e.id) &&
    isNonEmptyString(e.learnerKey) &&
    isSource(e.source) &&
    isMeasured(e.measured) &&
    isVerdict(e.verdict) &&
    (e.verdictScope === 'per-kc' || e.verdictScope === 'item-level') &&
    isContext(e.context)
  );
}

/**
 * 一次交互的产物：**共享来源，判定逐测项独立**，情境逐条给。
 *
 * `items[i].verdict` 是正路：判官对多 KC 题**逐个 KC 出结论**（「这个 KC 用对了吗」），
 * 不是「这题对不对」。判定子盒本来就是「命中哪些要点、漏了哪些」，把要点绑到测项上
 * 就完成了——不加调用、不加盒子。
 * 依据 Duan et al., arXiv:2602.17542 (2026-02)：题级对错传播给全部关联 KC「掩盖了部分
 * 掌握，往往导致学习曲线拟合很差」；改用 LLM 逐 KC 判定后学习曲线更合幂律、预测更准。
 *
 * `verdict`（题级）是**降级路径**，只在拿不到 per-KC 判定时给（纯选择题）。走这条的
 * 证据一律标 `verdictScope: 'item-level'`。
 *
 * 为什么不能一份题级判定抄 N 份——这是 2026-08-11 学习科学对照调研打回来的纠正，
 * 三处损失都有出处，别看着像倒退就改回去：
 * 1. **答错的归因被伪造**。合取语义下答对无歧义，答错只说明「至少一个 KC 没过」，
 *    抄 N 份错等于把责任平摊给每个 KC（van de Sande, EDM 2016）。
 * 2. **置信度虚增 N 倍**。一次交互变成 N 条**相关**证据，按条数涨置信就是把相关观测
 *    当独立观测——正是设计稿 §5.2 要反对的那件事。
 * 3. **难度记错**。多技能合取的一步比其中任一技能都难（Cen/Koedinger/Junker），
 *    抄下来的难度是合取难度，却被当单 KC 难度用，系统性高估学习者。
 */
export interface EvidenceDraft {
  learnerKey: string;
  source: EvidenceSource;
  /** 题级判定。仅作 `items[i].verdict` 缺席时的降级兜底，用了就标 `item-level`。 */
  verdict?: EvidenceVerdict;
  /** 每项产出一条证据。至少一项，测项不许重复，判定各自独立。 */
  items: ReadonlyArray<{
    measured: Measured;
    context: EvidenceContext;
    /** 这个 KC 用对了吗。给了它就是 `per-kc`，没给就落到 `draft.verdict` 并降级。 */
    verdict?: EvidenceVerdict;
  }>;
}

function mintId(prefix: string): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${suffix}`;
}

/** 新证据 id。 */
export function mintEvidenceId(): string {
  return mintId('evidence');
}

/** 新信号 id。 */
export function mintSignalId(): string {
  return mintId('signal');
}

/** 新作废记录 id。 */
export function mintInvalidationId(): string {
  return mintId('invalidation');
}

/** 新放弃记录 id（wheel-spinning，见 `./wheel-spinning`）。 */
export function mintGiveUpId(): string {
  return mintId('give-up');
}

/**
 * 构造证据，保证「测项唯一」这条不变量：N 个测项 → N 条证据，各自测项唯一，
 * 共享来源，**判定各自独立**，情境逐条给（同一道题对不同知识点难度可以不同）。
 *
 * 判定的取法：`item.verdict` 优先（`per-kc`），缺席时落到 `draft.verdict`
 * 并标 `item-level`——降级是允许的，静默降级不是。
 *
 * 失败即抛：空 items、同一次交互里重复的测项（那会把一次作答在同一测项上重复
 * 计数）、一条判定都没有、以及任何填不满四个子盒的项（那是信号，不是证据）。
 */
export function createEvidence(
  draft: EvidenceDraft,
  mint: () => string = mintEvidenceId,
): Evidence[] {
  if (draft.items.length === 0) {
    throw new Error('证据构造：items 为空——没有测项就不是证据，走 appendSignal');
  }
  const seen = new Set<string>();
  return draft.items.map(({ measured, context, verdict }) => {
    if (!isMeasured(measured)) {
      throw new Error(`证据构造：测项非法 ${JSON.stringify(measured)}`);
    }
    const key = measuredKey(measured);
    if (seen.has(key)) {
      throw new Error(`证据构造：同一次交互里测项 ${key} 重复——一个测项只能出一条证据`);
    }
    seen.add(key);
    const scoped = verdict ?? draft.verdict;
    if (scoped === undefined) {
      throw new Error(
        `证据构造：测项 ${key} 没有判定——要么判官逐测项出结论，要么给 draft.verdict ` +
          `接受 item-level 降级，不能两头都空`,
      );
    }
    const evidence: Evidence = {
      id: mint(),
      learnerKey: draft.learnerKey,
      source: draft.source,
      measured,
      verdict: scoped,
      verdictScope: verdict ? 'per-kc' : 'item-level',
      context,
    };
    if (!isEvidence(evidence)) {
      throw new Error(
        `证据构造：四个子盒没填满（测项 ${key}）——${JSON.stringify({
          source: draft.source,
          verdict: scoped,
          context,
        })}`,
      );
    }
    return evidence;
  });
}
