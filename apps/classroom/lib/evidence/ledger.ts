/**
 * 证据流的落盘与选择函数。
 *
 * **只追加**。复用现有的 `RuntimeStore`（`@openmaic/storage`，append-only
 * records + 学习者分区 + store 分配的单调 `seq`），不自造存储抽象。
 *
 * 分区选择：证据挂在一个**哨兵 stage** {@link EVIDENCE_STAGE} 下，每个学习者
 * 一条 session。理由有两条，都来自设计稿：
 * - 「证据永不丢弃」——真 stage 被删时 `deleteStageRuntime(stageId)` 会级联清
 *   掉该 stage 的 runtime 数据。履历不能跟着课一起没。
 * - 履历是跨课的——`listSessions` 按 `(stageId, learnerKey)` 分区，履历挂在
 *   单个哨兵 stage 上才能一次读全，不必遍历学习者上过的每一门课。
 *
 * 服务端持久化不在这里实现，也不需要新接口：`RuntimeStore` 就是那道缝。
 * `lib/persistence/bootstrap.ts` 在 `NEXT_PUBLIC_PERSISTENCE=1` 时已经把后端换成
 * `HttpRuntimeStore`（`/api/persistence`），证据流跟着一起过去，本模块一行不改。
 * `EvidenceDeps.store` 是测试与服务端直连的注入口。
 *
 * Client-only 默认路径：不传 `store` / `learnerKey` 时会走浏览器 IndexedDB 与
 * localStorage。服务端调用必须自带这两样。
 */

import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import type { RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

import {
  createEvidence,
  isEvidence,
  measuredKey,
  mintGiveUpId,
  mintInvalidationId,
  mintSignalId,
  type Evidence,
  type EvidenceDraft,
  type EvidenceSource,
  type Invalidation,
  type Measured,
  type Signal,
} from './types';
import { GIVE_UP_STREAK, type GiveUp, type WheelSpin } from './wheel-spinning';

/** 哨兵 stage：履历不属于任何一门课，也不该被任何一门课的删除级联带走。 */
export const EVIDENCE_STAGE = 'evidence-ledger';

/** `RuntimeSession.kind`。kind 是开放字符串，不用改 DSL。 */
export const EVIDENCE_KIND = 'evidence';

/** 一个学习者一条 session，id 由 learnerKey 决定，多标签页天然收敛到同一条。 */
export function evidenceSessionId(learnerKey: string): string {
  return `${EVIDENCE_KIND}:${encodeURIComponent(learnerKey)}`;
}

/** 证据流里的一条追加项。四种都进同一条流，读的时候按 `type` 分。 */
export type LedgerEntry =
  | { payloadVersion: 1; type: 'evidence'; evidence: Evidence }
  | { payloadVersion: 1; type: 'signal'; signal: Signal }
  | { payloadVersion: 1; type: 'invalidation'; invalidation: Invalidation }
  | { payloadVersion: 1; type: 'give-up'; giveUp: GiveUp };

export interface EvidenceDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
}

async function resolve(deps: EvidenceDeps): Promise<{ store: RuntimeStore; learnerKey: string }> {
  return {
    store: deps.store ?? getRuntimeStore(),
    learnerKey: deps.learnerKey ?? (await getLearnerKey()),
  };
}

/**
 * 该学习者名下的全部证据 session，按 store 的 `createdAt` 升序。
 *
 * **按分区找，不按 id 找**：`mergeLearner(anon, account)` 只改 session 的
 * `learnerKey`，不改 id，所以登录后 `evidenceSessionId(account)` 是查不到那条
 * `evidence:anon:…` 的——按 id 读会让整本履历在登录那一刻凭空消失，正撞「证据永不
 * 丢弃」。quiz 也是这么读的（`listSessions(stageId, learnerKey)`）。
 * 合并后一个学习者名下会有两条（原账号的 + 迁过来的），所以返回全部。
 */
async function evidenceSessions(
  store: RuntimeStore,
  learnerKey: string,
): Promise<RuntimeSession[]> {
  const sessions = await store.listSessions(EVIDENCE_STAGE, learnerKey);
  return sessions.filter((s) => s.kind === EVIDENCE_KIND);
}

/** 拿到（必要时创建）该学习者的证据 session。并发创建按 quiz 的先例重读胜者。 */
async function ensureSession(
  store: RuntimeStore,
  learnerKey: string,
  now: string,
): Promise<RuntimeSession> {
  const id = evidenceSessionId(learnerKey);
  const existing = (await evidenceSessions(store, learnerKey)).at(-1);
  if (existing) return existing;
  try {
    return await store.createSession({
      id,
      kind: EVIDENCE_KIND,
      stageId: EVIDENCE_STAGE,
      learnerKey,
      // 履历永远开着：session 是账本不是一次会话，没有「结课」这回事。
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    // 另一个标签页可能刚好赢了这次确定性创建，重读它的结果而不是丢掉这次写。
    const raced = await store.getSession(id);
    if (!raced) throw error;
    return raced;
  }
}

async function append(
  store: RuntimeStore,
  sessionId: string,
  entry: LedgerEntry,
  id: string,
  at: string,
  sceneId?: string,
): Promise<void> {
  await store.appendRecord({
    id: `${EVIDENCE_KIND}-record:${id}`,
    sessionId,
    // 最佳努力锚点（DSL 明说可能悬空）：资源 id 走 sceneId，让「关于资源的
    // 证据」将来能用 store 自带的 listRecords({ sceneId }) 过滤，不必全量拉。
    ...(sceneId ? { sceneId } : {}),
    createdAt: at,
    payload: entry,
  });
}

/**
 * 构造并落盘一次交互的证据。N 个测项 → N 条，测项唯一性由
 * {@link createEvidence} 保证；这里只负责按追加序把它们写进流里。
 */
export async function appendEvidence(
  draft: EvidenceDraft,
  deps: EvidenceDeps = {},
): Promise<Evidence[]> {
  const { store, learnerKey } = await resolve(deps);
  if (draft.learnerKey !== learnerKey) {
    throw new Error(
      `证据落盘：draft.learnerKey ${JSON.stringify(draft.learnerKey)} 与当前学习者 ` +
        `${JSON.stringify(learnerKey)} 不符——履历只能写进自己的账本`,
    );
  }
  const now = deps.now?.() ?? new Date().toISOString();
  const evidence = createEvidence(draft);
  const session = await ensureSession(store, learnerKey, now);
  for (const e of evidence) {
    await append(
      store,
      session.id,
      { payloadVersion: 1, type: 'evidence', evidence: e },
      e.id,
      e.source.at,
      e.source.resourceId,
    );
  }
  return evidence;
}

/** 信号进同一条流，但选择函数不会把它算进履历——它只影响权重。 */
export async function appendSignal(
  input: { source: EvidenceSource; kind: string; value?: number; note?: string },
  deps: EvidenceDeps = {},
): Promise<Signal> {
  const { store, learnerKey } = await resolve(deps);
  const now = deps.now?.() ?? new Date().toISOString();
  const signal: Signal = { id: mintSignalId(), learnerKey, ...input };
  const session = await ensureSession(store, learnerKey, now);
  await append(
    store,
    session.id,
    { payloadVersion: 1, type: 'signal', signal },
    signal.id,
    signal.source.at,
    signal.source.resourceId,
  );
  return signal;
}

/**
 * 作废而非删除：追加一条作废记录，原证据一个字节都不动。
 * 用于坏题、判官判错、申诉成立。作废的证据仍在履历流里（能查到它为什么被推翻），
 * 但 {@link history} 不返回它，{@link weighAll} 给它 0 权重。
 */
export async function invalidate(
  evidenceId: string,
  reason: string,
  deps: EvidenceDeps & { by?: string } = {},
): Promise<Invalidation> {
  const { store, learnerKey } = await resolve(deps);
  const now = deps.now?.() ?? new Date().toISOString();
  const invalidation: Invalidation = {
    id: mintInvalidationId(),
    evidenceId,
    reason,
    at: now,
    ...(deps.by ? { by: deps.by } : {}),
  };
  const session = await ensureSession(store, learnerKey, now);
  await append(
    store,
    session.id,
    { payloadVersion: 1, type: 'invalidation', invalidation },
    invalidation.id,
    invalidation.at,
  );
  return invalidation;
}

/**
 * 放弃一个知识点：追加一条记录，什么都不删。
 *
 * 判据在 `./wheel-spinning`（连错到阈值），这里只管落盘。**放弃状态本身不存**——
 * 它由 `wheelSpinning(history(ledger))` 从履历算出来。这条记录留的是「当时确实
 * 做了这个决定、按的是哪个阈值」，阈值以后改了也追得回去。
 */
export async function recordGiveUp(
  spin: WheelSpin,
  deps: EvidenceDeps & { threshold?: number } = {},
): Promise<GiveUp> {
  const { store, learnerKey } = await resolve(deps);
  if (spin.last.learnerKey !== learnerKey) {
    throw new Error(
      `放弃记录：证据属于 ${JSON.stringify(spin.last.learnerKey)}，当前学习者是 ` +
        `${JSON.stringify(learnerKey)}——履历只能写进自己的账本`,
    );
  }
  const now = deps.now?.() ?? new Date().toISOString();
  const giveUp: GiveUp = {
    id: mintGiveUpId(),
    learnerKey,
    measured: spin.measured,
    streak: spin.streak,
    threshold: deps.threshold ?? GIVE_UP_STREAK,
    triggeredBy: spin.last.id,
    at: now,
  };
  const session = await ensureSession(store, learnerKey, now);
  await append(
    store,
    session.id,
    { payloadVersion: 1, type: 'give-up', giveUp },
    giveUp.id,
    giveUp.at,
    spin.last.source.resourceId,
  );
  return giveUp;
}

/** 一个学习者的整本账：追加序，作废的证据也在里面。 */
export interface Ledger {
  learnerKey: string;
  /** 全部证据，含已作废的。追加序（store 的 `seq`）。 */
  evidence: Evidence[];
  signals: Signal[];
  invalidations: Invalidation[];
  /** 放弃过哪些知识点（wheel-spinning）。 */
  giveUps: GiveUp[];
}

function asEntry(record: RuntimeRecord): LedgerEntry | undefined {
  const p = record.payload as Partial<LedgerEntry> | null;
  if (typeof p !== 'object' || p === null || p.payloadVersion !== 1) return undefined;
  if (p.type === 'evidence') return isEvidence(p.evidence) ? (p as LedgerEntry) : undefined;
  if (p.type === 'signal' || p.type === 'invalidation' || p.type === 'give-up') {
    return p as LedgerEntry;
  }
  return undefined;
}

/**
 * 按学习者取履历——证据模型对外的主选择函数。
 *
 * 学习者没写过任何东西时返回空账本，不建 session（读不该有副作用）。
 */
export async function readLedger(deps: EvidenceDeps = {}): Promise<Ledger> {
  const { store, learnerKey } = await resolve(deps);
  const ledger: Ledger = {
    learnerKey,
    evidence: [],
    signals: [],
    invalidations: [],
    giveUps: [],
  };
  // 登录合并后名下可能有多条（见 evidenceSessions），按 session 创建序拼起来。
  for (const session of await evidenceSessions(store, learnerKey)) {
    for (const record of await store.listRecords(session.id)) {
      const entry = asEntry(record);
      if (entry?.type === 'evidence') ledger.evidence.push(entry.evidence);
      else if (entry?.type === 'signal') ledger.signals.push(entry.signal);
      else if (entry?.type === 'invalidation') ledger.invalidations.push(entry.invalidation);
      else if (entry?.type === 'give-up') ledger.giveUps.push(entry.giveUp);
    }
  }
  return ledger;
}

/** 被作废的证据 id。 */
export function invalidatedIds(ledger: Ledger): Set<string> {
  return new Set(ledger.invalidations.map((i) => i.evidenceId));
}

/** 有效履历：剔除已作废的，追加序不变。 */
export function history(ledger: Ledger): Evidence[] {
  const dead = invalidatedIds(ledger);
  return ledger.evidence.filter((e) => !dead.has(e.id));
}

/** 按知识点（或通用能力维）取证据。这是掌握度二元组的输入。 */
export function evidenceFor(ledger: Ledger, measured: Measured): Evidence[] {
  const key = measuredKey(measured);
  return history(ledger).filter((e) => measuredKey(e.measured) === key);
}

/**
 * 判定被降级的证据（`verdictScope === 'item-level'`）：题级对错摊到了 KC 上，
 * 没有逐 KC 判定。
 *
 * 有这个函数是因为**降级不许静默**（2026-08-11 调研纠正，见 `./types` 的
 * `EvidenceDraft`）：答错时不知道该怪哪个 KC，权重已经打了折（`./weight`），
 * 但打折这件事本身要能被查出来——占比高就说明出题形态偏了（全是选择题），
 * 该去改判官的输出结构或题型，而不是在下游猜为什么掌握度涨不上去。
 */
export function downgraded(ledger: Ledger): Evidence[] {
  return history(ledger).filter((e) => e.verdictScope === 'item-level');
}

/**
 * 按资源取证据——「关于资源的证据」那条线的入口：这份资源被多少人做过、
 * 做的人表现如何，是资源自检（适配准确率）的原始事实。
 */
export function evidenceAbout(ledger: Ledger, resourceId: string): Evidence[] {
  return history(ledger).filter((e) => e.source.resourceId === resourceId);
}

/** 某次交互的信号。权重函数自己也会筛，这个是给可视化用的。 */
export function signalsOf(ledger: Ledger, interactionId: string): Signal[] {
  return ledger.signals.filter((s) => s.source.interactionId === interactionId);
}
