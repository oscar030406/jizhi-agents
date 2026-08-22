/**
 * 掌握策略层：把 fold 的三元组（estimate / confidence / recall）消费成
 * 「这项算不算掌握」「下一步该做什么」「哪些该复习了」三个决策。纯函数，无 I/O。
 *
 * 规则提炼自 DeepTutor（HKUDS，Apache-2.0）的 mastery/policy 引擎，见
 * docs/04-research/deeptutor-transplant-decision-20260821.md 的判决表；
 * 数值适配到我们的证据形式：
 *
 * - **门槛即游标**：不设阶段计数器。未过门的第一项就是下一个目标，已证明的
 *   自动跳过（test-out）。DeepTutor 的 next_objective 原样提炼。
 * - **证据封顶**：DeepTutor 用「1 次作答上限 0.5、2 次上限 0.8」防一次答对
 *   即精通。我们的 fold 已把这件事拆成两个量——estimate（会不会）与
 *   confidence（问得够不够多），所以封顶在这里落成**双条件门**：
 *   estimate 过线且 confidence 过下限才算掌握。一两次答对时 confidence
 *   还在地板下，自然封住，不需要另一套上限表。
 * - **到期复习**：DeepTutor 用类型化固定间隔序列；我们已有更细的
 *   retrievability 衰减（recall），所以复习判据直接用 recall 跌破阈值，
 *   不移植间隔表——粗规则不该盖在细模型上。
 *
 * DeepTutor 的「概念/设计型走费曼式定性门」未移植：我们没有对话导师循环，
 * 定性判定无处发生。ponytail: 单一定量门，接判官链做定性门是升级路径。
 */

/** 掌握门：estimate 过线才算会。0.9 对标 Alpha School「90% 才推进」。 */
export const MASTERY_GATE = 0.9;

/**
 * 置信下限：confidence 低于它一律不判「已掌握」。
 * fold 的 confidence = effectiveN / 12，0.25 即约 3 条有效证据——
 * 与 DeepTutor「两次以内作答封顶在门以下」等效（1–2 条证据时必然在地板下）。
 */
export const CONFIDENCE_FLOOR = 0.25;

/** 复习阈值：已掌握项的 recall 跌破它即进入到期复习队列。 */
export const REVIEW_THRESHOLD = 0.6;

/** 一个测项进入策略层所需的最少信息（对应画像缓存的三张表）。 */
export interface MasterySnapshot {
  /** 他会不会。0–1。 */
  estimate: number;
  /** 我们有多确定。0–1。 */
  confidence: number;
  /** 他现在还提不提得出来。0–1，随时间衰减。 */
  recall: number;
}

export type ObjectiveStatus = 'mastered' | 'learning' | 'new';

/** 单项状态。`snapshot` 缺失即 `new`（从未测过）。 */
export function statusOf(snapshot: MasterySnapshot | undefined): ObjectiveStatus {
  if (!snapshot) return 'new';
  if (snapshot.estimate >= MASTERY_GATE && snapshot.confidence >= CONFIDENCE_FLOOR) {
    return 'mastered';
  }
  return 'learning';
}

export interface ReviewTask {
  key: string;
  /** 当前可提取度——同层内的排序键，越低越先复习。 */
  recall: number;
  estimate: number;
  /** 该项最近一次判定是失分——错过的排到没错过的前面。 */
  errorProne: boolean;
}

export interface ReviewOptions {
  /**
   * 最近一次判定失分的测项键集（调用方从账本算：最新一条证据 outcome 非 correct）。
   * DeepTutor 把「有活跃错题记录」的知识点复习优先级置顶，这里同规则。
   */
  errorProne?: ReadonlySet<string>;
  /**
   * 定性通过的测项键集（spaced.ts qualitativePassed：导师概念级判 correct）。
   * DeepTutor 双门的定性路——在此集合里即视为已掌握，不再卡定量门。
   */
  qualitative?: ReadonlySet<string>;
}

/** 双门掌握判定：定性通过是充分条件之一，否则走定量双条件门。 */
function isMastered(
  snapshot: MasterySnapshot | undefined,
  key: string,
  options: ReviewOptions,
): boolean {
  if (options.qualitative?.has(key)) return true;
  return statusOf(snapshot) === 'mastered';
}

/**
 * 到期复习：**已掌握**但 recall 跌破阈值的项。错过的项排最前（错题置顶），
 * 同层内最遗忘的排最前。只看已掌握项——没掌握的不叫遗忘，叫还没学会，
 * 归 nextObjective 管。
 */
export function dueReviews(
  snapshots: Readonly<Record<string, MasterySnapshot>>,
  options: ReviewOptions = {},
): ReviewTask[] {
  const due: ReviewTask[] = [];
  for (const [key, s] of Object.entries(snapshots)) {
    if (isMastered(s, key, options) && s.recall < REVIEW_THRESHOLD) {
      due.push({ key, recall: s.recall, estimate: s.estimate, errorProne: !!options.errorProne?.has(key) });
    }
  }
  due.sort(
    (a, b) =>
      Number(b.errorProne) - Number(a.errorProne) || a.recall - b.recall || a.key.localeCompare(b.key),
  );
  return due;
}

export interface NextStep {
  action: 'review' | 'probe' | 'practice' | 'complete';
  /** action=complete 时为空串。 */
  key: string;
  status: ObjectiveStatus | '';
  reason: string;
}

/**
 * 下一步该做什么。优先级与 DeepTutor next_objective 同构：
 * 1. 到期复习（别让已掌握的地基塌了）；
 * 2. 顺序里第一个未过门的项——没测过的先 probe（试探，允许 test-out），
 *    测过没过门的继续 practice；
 * 3. 全过门且无到期项 → complete。
 *
 * `orderedKeys` 是学习顺序（课程场景顺序）；不在顺序里的测项不参与推进，
 * 但照常参与复习判定。
 */
export function nextObjective(
  orderedKeys: readonly string[],
  snapshots: Readonly<Record<string, MasterySnapshot>>,
  options: ReviewOptions = {},
): NextStep {
  const due = dueReviews(snapshots, options);
  if (due.length > 0) {
    return {
      action: 'review',
      key: due[0].key,
      status: 'mastered',
      reason: `已掌握但可提取度降到 ${due[0].recall.toFixed(2)}，到期复习`,
    };
  }
  for (const key of orderedKeys) {
    if (isMastered(snapshots[key], key, options)) continue;
    const status = statusOf(snapshots[key]);
    if (status === 'new') {
      return { action: 'probe', key, status, reason: '还没测过——先试探，会了就直接跳过' };
    }
    return { action: 'practice', key, status, reason: '低于掌握门，继续练到过线' };
  }
  return { action: 'complete', key: '', status: '', reason: '全部过门且无到期复习' };
}

export interface MasteryMapItem {
  key: string;
  status: ObjectiveStatus;
  estimate: number;
  recall: number;
  /** 掌握判定走的哪扇门：定性（导师判过）还是定量（证据过线）。 */
  gate: 'qualitative' | 'quantitative';
}

export interface MasteryMap {
  counts: { mastered: number; learning: number; new: number; total: number };
  items: MasteryMapItem[];
  /** 全部过门且至少有一项——DeepTutor map_summary 的 complete 同义。 */
  complete: boolean;
}

/**
 * 掌握地图（DeepTutor map_summary 直移，模块层级压平——我们的测项不分模块）。
 * render-ready：计数给总览条，逐项给地图着色。`orderedKeys` 之外但有快照的测项
 * 也计入（学了顺序外的东西不该被藏起来）。
 */
export function masteryMap(
  orderedKeys: readonly string[],
  snapshots: Readonly<Record<string, MasterySnapshot>>,
  options: ReviewOptions = {},
): MasteryMap {
  const keys = [...orderedKeys, ...Object.keys(snapshots).filter((k) => !orderedKeys.includes(k))];
  const counts = { mastered: 0, learning: 0, new: 0, total: 0 };
  const items: MasteryMapItem[] = [];
  for (const key of keys) {
    const s = snapshots[key];
    const status: ObjectiveStatus = isMastered(s, key, options) ? 'mastered' : statusOf(s);
    counts[status] += 1;
    counts.total += 1;
    items.push({
      key,
      status,
      estimate: s?.estimate ?? 0,
      recall: s?.recall ?? 0,
      gate: options.qualitative?.has(key) ? 'qualitative' : 'quantitative',
    });
  }
  return { counts, items, complete: counts.total > 0 && counts.mastered === counts.total };
}

/**
 * 从画像缓存的三张表拼快照。三表键集可能不一致（旧画像没有后两张），
 * 缺置信度按 0 处理——**宁可把不确定当不会，不把不确定当会**；
 * 缺 recall 退回 estimate（旧数据没有衰减信息，不虚构遗忘）。
 */
export function snapshotsFromProfile(fields: {
  conceptMastery?: Record<string, number>;
  conceptConfidence?: Record<string, number>;
  conceptRecall?: Record<string, number>;
}): Record<string, MasterySnapshot> {
  const out: Record<string, MasterySnapshot> = {};
  for (const [key, estimate] of Object.entries(fields.conceptMastery ?? {})) {
    out[key] = {
      estimate,
      confidence: fields.conceptConfidence?.[key] ?? 0,
      recall: fields.conceptRecall?.[key] ?? estimate,
    };
  }
  return out;
}
