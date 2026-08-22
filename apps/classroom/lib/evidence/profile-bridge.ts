/**
 * 把 fold 算出来的画像写回 localStorage —— 画像从「存储量」切成「导出量」的那一刀。
 *
 * ## 为什么是这种切法
 *
 * `conceptMastery` 有 6 个读点（生成链、导学、控制台、学情报告两处）。
 * 一次性把它们全改成 async 读履历，改动面大、回归风险高，而且没必要：
 * **真正的病不是「值存在 localStorage 里」，是「值被就地增量改写」。**
 *
 * 旧路是 `mastery[c] = prev*(1-w) + score*w` —— 一个自己迭代自己的状态。
 * 病在三处（设计稿 §4.1 逐条点过）：
 * 1. 数字不可对质：说不清 0.62 是哪几条证据算出来的
 * 2. 改更新规则就废掉历史数据：旧值已经被覆盖，重算不回来
 * 3. 申诉没地方写：改了数字，但没有产生任何可复核的记录
 *
 * 新路是**每次从全量履历重跑 fold**，结果写进同一个字段。于是那个字段变成
 * **导出量的缓存**：删掉能重建，换更新规则重跑一遍就是新值，每个数都能
 * 用 `evidenceBehind()` 展开成「由这几条证据算出来的」。读点一行不改。
 *
 * ## 写进去的是 estimate，不是 recall
 *
 * `conceptMastery` 原本的语义就是「他会不会」，对应 `estimate`。
 * `recall`（现在还提不提得出来）另存 `conceptRecall`，`confidence` 另存
 * `conceptConfidence`——**不合并**。把三个量压成一个数正是本轮纠正掉的做法，
 * 在这里合并等于把刚拆开的东西又粘回去。
 */

import { fold, type FoldOptions } from './fold';
import { history, invalidatedIds, readLedger, type EvidenceDeps } from './ledger';

/** 画像在 localStorage 里的键。与既有读点一致，不另起炉灶。 */
export const PROFILE_KEY = 'learnerProfile';

/**
 * 当前学习者的领域，供构造证据时填 `Measured.domain`（fold 的 `byDomain` 按它分桶）。
 *
 * 取的是画像录入时选的那个 `domain`（`components/generation/learner-profile-popover.tsx`
 * 的 DOMAINS：ai / manufacturing / industrial-internet / software），也就是
 * `LearnerProfileFields.domain`。为什么是它而不是课程的领域：课程本身不带领域字段——
 * `data/classrooms/*.json` 的 stage 只有 id / name / languageDirective / style 这些，
 * 生成时用过的画像没有随课程存下来。所以画像是当前**唯一**拿得到的领域来源。
 *
 * 返回 `undefined` 表示画像里没有这个字段（早期存下的画像、或没走过录入），
 * 由调用方兜到 `LEGACY_DOMAIN`（见 `./types`）。
 */
export function learnerDomain(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    const domain = stored?.domain;
    return typeof domain === 'string' && domain.trim() ? domain.trim() : undefined;
  } catch {
    return undefined; // 画像损坏不拦证据落盘，兜底域照样能记一条
  }
}

/** 由 fold 派生、写回画像的三个字段。 */
export interface DerivedProfileFields {
  /** 他会不会。语义与旧的 `conceptMastery` 一致，读点无感。 */
  conceptMastery: Record<string, number>;
  /** 我们有多确定。新增，旧读点不读它也不会坏。 */
  conceptConfidence: Record<string, number>;
  /** 他现在还提不提得出来。随时间衰减的那一个。 */
  conceptRecall: Record<string, number>;
  /** 这份画像是从几条证据算出来的。可对质的入口。 */
  derivedFrom: { evidenceCount: number; at: string };
}

/**
 * 从履历算出画像的三张表。纯计算，不碰存储——测试直接喂履历即可。
 *
 * 只取**专业面**（`kind: 'concept'`）写进 `conceptMastery`：这个字段的既有读点
 * （导学的 priorMastery、生成链的 weakPast）问的都是「这个概念他会不会」。
 * 通用面是另一回事，不塞进同一张表里混着——那正是图纸 §10 第 3 条
 * 「画像五维向量把通用面与专业面拍平」要治的病。
 */
export function deriveProfileFields(
  evidence: Parameters<typeof fold>[0],
  options: FoldOptions = {},
): DerivedProfileFields {
  const profile = fold(evidence, options);
  const mastery: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  const recall: Record<string, number> = {};
  /** 同名概念跨域撞车时，记住当前占位者的证据数，好让证据多的那个赢。 */
  const winnerEvidence: Record<string, number> = {};
  let count = 0;
  for (const list of Object.values(profile.byDomain)) {
    for (const m of list) {
      if (m.measured.kind !== 'concept') continue;
      // 键用概念名，与旧字段的形状一致（旧路写的就是 `mastery[concept]`）。
      // 同名概念跨域撞车时取证据多的那个——真要分域得改 6 个读点，那是下一步。
      const key = m.measured.concept;
      if (winnerEvidence[key] === undefined || m.evidenceCount > winnerEvidence[key]) {
        winnerEvidence[key] = m.evidenceCount;
        mastery[key] = round2(m.estimate);
        confidence[key] = round2(m.confidence);
        recall[key] = round2(m.recall);
      }
      count += m.evidenceCount;
    }
  }
  return {
    conceptMastery: mastery,
    conceptConfidence: confidence,
    conceptRecall: recall,
    derivedFrom: { evidenceCount: count, at: new Date().toISOString() },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 重算画像并写回 localStorage。**幂等**——同一段履历跑多少次结果都一样，
 * 这正是「导出量」的定义，也是它和旧 EMA 最本质的区别（旧的每跑一次都变）。
 *
 * 调用点：quiz 交卷后、导学判分后。失败不抛——画像没刷新不该拦住教学流程，
 * 下次交互会再算一次。
 */
export async function refreshDerivedProfile(
  deps: EvidenceDeps & FoldOptions = {},
): Promise<DerivedProfileFields | null> {
  if (typeof localStorage === 'undefined') return null;
  try {
    const ledger = await readLedger(deps);
    const fields = deriveProfileFields(history(ledger), {
      ...deps,
      invalidated: invalidatedIds(ledger),
    });
    const stored = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') ?? {};
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...stored, ...fields }));
    return fields;
  } catch {
    // 画像刷新失败不拦教学流程。它是缓存，下次交互会重算——
    // 这也是导出量相对存储量的好处：丢了不心疼。
    return null;
  }
}
