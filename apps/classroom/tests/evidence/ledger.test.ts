/**
 * 证据流的落盘与选择函数：只追加、作废不删除、按学习者/知识点/资源取。
 *
 * 跑在真 `BrowserRuntimeStore` 上（fake-indexeddb），不是内存桩——存储契约
 * （session 分区、seq 顺序、payload 校验）是这条地基的一半。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import {
  EVIDENCE_KIND,
  EVIDENCE_STAGE,
  appendEvidence,
  appendSignal,
  downgraded,
  evidenceAbout,
  evidenceFor,
  evidenceSessionId,
  history,
  invalidate,
  invalidatedIds,
  readLedger,
  signalsOf,
} from '@/lib/evidence/ledger';
import { measuredKey, type EvidenceDraft, type Measured } from '@/lib/evidence/types';
import { weighAll } from '@/lib/evidence/weight';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

const LEARNER = 'anon:vla-ledger';
const OTHER_LEARNER = 'anon:someone-else';

/** 真实课程 zTWuJxehpv「VLA 视觉-语言-动作模型入门」的场景 id */
const SCENE_TOKENIZATION = 'scene_CBKAJzwtsm'; // 动作 Token 化与动作分块
const SCENE_MILESTONES = 'scene_6EGgZpIswh'; // RT 系列里程碑

const TOKENIZATION: Measured = { kind: 'concept', domain: 'embodied', concept: '动作 Token 化' };
const CHUNKING: Measured = { kind: 'concept', domain: 'embodied', concept: '动作分块' };
const MATH: Measured = { kind: 'general', axis: 'math' };

let store: RuntimeStore;

beforeEach(() => {
  store = new BrowserRuntimeStore({ indexedDB: new IDBFactory(), dbName: 'evidence-test' });
});

function deps(learnerKey = LEARNER, now?: string) {
  return { store, learnerKey, ...(now ? { now: () => now } : {}) };
}

/** 纯选择题：只有题级对错，判定摊给各测项 → 这些证据都标 `item-level`。 */
function quizDraft(
  learnerKey: string,
  at: string,
  resourceId: string,
  items: EvidenceDraft['items'],
  outcome: 'correct' | 'partial' | 'incorrect' = 'correct',
): EvidenceDraft {
  return {
    learnerKey,
    source: { interactionId: `quiz:${resourceId}:${at}`, resourceId, fragmentId: 'q1', at },
    verdict: {
      outcome,
      because: {
        hit: outcome === 'incorrect' ? [] : ['答出了动作被离散成词表条目'],
        missed: outcome === 'correct' ? [] : ['没提分块降低自回归步数'],
      },
    },
    items,
  };
}

describe('只追加的证据流', () => {
  it('一次交互两个知识点 → 流里两条记录，共享来源', async () => {
    const written = await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T09:00:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz', difficulty: 0.4 } },
        { measured: CHUNKING, context: { encounter: 1, modality: 'quiz', difficulty: 0.7 } },
      ]),
      deps(),
    );
    expect(written).toHaveLength(2);

    const ledger = await readLedger(deps());
    expect(ledger.evidence).toHaveLength(2);
    expect(ledger.evidence.map((e) => e.source.interactionId)).toEqual([
      written[0].source.interactionId,
      written[0].source.interactionId,
    ]);
    expect(new Set(ledger.evidence.map((e) => measuredKey(e.measured))).size).toBe(2);
  });

  it('履历只增不改：追加序稳定，session 跨课复用同一条', async () => {
    await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T09:00:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } },
      ]),
      deps(),
    );
    await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T10:00:00.000Z', SCENE_MILESTONES, [
        { measured: MATH, context: { encounter: 1, modality: 'tutor' } },
      ]),
      deps(),
    );

    const session = await store.getSession(evidenceSessionId(LEARNER));
    expect(session?.kind).toBe(EVIDENCE_KIND);
    // 哨兵 stage：履历不属于任何一门课，删课的级联碰不到它
    expect(session?.stageId).toBe(EVIDENCE_STAGE);
    expect(await store.listSessions(EVIDENCE_STAGE, LEARNER)).toHaveLength(1);

    const records = await store.listRecords(session!.id);
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
  });

  it('学习者分区：别人的证据读不到', async () => {
    await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T09:00:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } },
      ]),
      deps(),
    );
    await appendEvidence(
      quizDraft(OTHER_LEARNER, '2026-08-11T09:05:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } },
      ]),
      deps(OTHER_LEARNER),
    );

    expect((await readLedger(deps())).evidence).toHaveLength(1);
    expect((await readLedger(deps(OTHER_LEARNER))).evidence).toHaveLength(1);
  });

  it('写进别人的账本 → 抛', async () => {
    await expect(
      appendEvidence(
        quizDraft(OTHER_LEARNER, '2026-08-11T09:00:00.000Z', SCENE_TOKENIZATION, [
          { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } },
        ]),
        deps(LEARNER),
      ),
    ).rejects.toThrow(/不符/);
  });

  it('登录合并（mergeLearner）之后履历还在——按分区读，不按 id 读', async () => {
    const ANON = 'anon:before-signin';
    const ACCOUNT = 'account:after-signin';
    await appendEvidence(
      quizDraft(ANON, '2026-08-11T09:00:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } },
      ]),
      deps(ANON),
    );

    expect(await store.mergeLearner(ANON, ACCOUNT)).toBe(1);

    // session id 里还写着旧 key（合并只改 learnerKey，不改 id）——按 id 读会读空
    expect(await store.getSession(evidenceSessionId(ACCOUNT))).toBeUndefined();
    const ledger = await readLedger(deps(ACCOUNT));
    expect(history(ledger).map((e) => e.learnerKey)).toEqual([ANON]);

    // 登录后继续答题，新证据接在同一本账后面
    await appendEvidence(
      quizDraft(ACCOUNT, '2026-08-11T10:00:00.000Z', SCENE_MILESTONES, [
        { measured: MATH, context: { encounter: 1, modality: 'tutor' } },
      ]),
      deps(ACCOUNT),
    );
    expect(history(await readLedger(deps(ACCOUNT)))).toHaveLength(2);
  });

  it('没写过任何东西 → 空账本，且不建 session（读无副作用）', async () => {
    const ledger = await readLedger(deps());
    expect(ledger).toEqual({
      learnerKey: LEARNER,
      evidence: [],
      signals: [],
      invalidations: [],
      giveUps: [],
    });
    expect(await store.getSession(evidenceSessionId(LEARNER))).toBeUndefined();
  });
});

describe('作废而非删除', () => {
  it('作废后原证据仍在流里，但不进有效履历、权重为 0', async () => {
    const [badQuestion] = await appendEvidence(
      quizDraft(
        LEARNER,
        '2026-08-11T09:00:00.000Z',
        SCENE_TOKENIZATION,
        [{ measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } }],
        'incorrect',
      ),
      deps(),
    );
    const [good] = await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T10:00:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 2, modality: 'quiz' } },
      ]),
      deps(),
    );

    const record = await invalidate(badQuestion.id, '坏题：选项 B 与 D 等价，判官打回', {
      ...deps(LEARNER, '2026-08-11T11:00:00.000Z'),
      by: 'judge:audit-2',
    });

    const ledger = await readLedger(deps());
    // 原证据一个字节没动
    expect(ledger.evidence.map((e) => e.id)).toEqual([badQuestion.id, good.id]);
    expect(ledger.evidence[0]).toEqual(badQuestion);
    // 追加了一条作废记录，理由和作废人都在
    expect(ledger.invalidations).toEqual([record]);
    expect(record.reason).toContain('坏题');
    expect(record.by).toBe('judge:audit-2');
    expect(invalidatedIds(ledger)).toEqual(new Set([badQuestion.id]));

    // 有效履历里没有它
    expect(history(ledger).map((e) => e.id)).toEqual([good.id]);
    expect(evidenceFor(ledger, TOKENIZATION).map((e) => e.id)).toEqual([good.id]);

    const weighed = weighAll(ledger.evidence, { invalidated: invalidatedIds(ledger) });
    expect(weighed.map((w) => w.evidence.id)).toEqual([good.id]);
  });
});

describe('选择函数', () => {
  beforeEach(async () => {
    await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T09:00:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz', difficulty: 0.4 } },
        { measured: CHUNKING, context: { encounter: 1, modality: 'quiz', difficulty: 0.7 } },
      ]),
      deps(),
    );
    await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T10:00:00.000Z', SCENE_MILESTONES, [
        { measured: TOKENIZATION, context: { encounter: 2, modality: 'tutor' } },
      ]),
      deps(),
    );
  });

  it('按学习者取履历', async () => {
    expect(history(await readLedger(deps()))).toHaveLength(3);
  });

  it('按知识点取证据——四种交互的产物归拢到同一个测项上', async () => {
    const ledger = await readLedger(deps());
    const forTokenization = evidenceFor(ledger, TOKENIZATION);
    expect(forTokenization).toHaveLength(2);
    // 一条来自测验、一条来自导学：多形式正是置信度涨起来的原因
    expect(forTokenization.map((e) => e.context.modality)).toEqual(['quiz', 'tutor']);
    expect(evidenceFor(ledger, CHUNKING)).toHaveLength(1);
    expect(evidenceFor(ledger, MATH)).toHaveLength(0);
  });

  it('按资源取证据——「关于资源的证据」那条线的入口', async () => {
    const ledger = await readLedger(deps());
    expect(evidenceAbout(ledger, SCENE_TOKENIZATION)).toHaveLength(2);
    expect(evidenceAbout(ledger, SCENE_MILESTONES)).toHaveLength(1);
    expect(evidenceAbout(ledger, 'scene_不存在')).toHaveLength(0);
  });

  it('判定降级查得到——纯选择题的证据全是 item-level，判官逐测项出的不是', async () => {
    // 上面 beforeEach 写的三条都走 quizDraft（题级判定摊下来）
    expect(downgraded(await readLedger(deps()))).toHaveLength(3);

    await appendEvidence(
      {
        learnerKey: LEARNER,
        source: {
          interactionId: 'tutor:zTWuJxehpv:CBKAJzwtsm:2',
          resourceId: SCENE_TOKENIZATION,
          at: '2026-08-11T11:00:00.000Z',
        },
        items: [
          {
            measured: CHUNKING,
            context: { encounter: 2, modality: 'tutor' },
            verdict: {
              outcome: 'correct',
              because: { hit: ['说出分块降低了自回归步数'], missed: [] },
            },
          },
        ],
      },
      deps(),
    );

    const ledger = await readLedger(deps());
    expect(history(ledger)).toHaveLength(4);
    expect(downgraded(ledger)).toHaveLength(3);
  });
});

describe('信号通道', () => {
  it('信号进流、进权重，但不进履历', async () => {
    const [answered] = await appendEvidence(
      quizDraft(LEARNER, '2026-08-11T09:00:00.000Z', SCENE_TOKENIZATION, [
        { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } },
      ]),
      deps(),
    );
    const signal = await appendSignal(
      {
        source: {
          interactionId: answered.source.interactionId,
          resourceId: SCENE_TOKENIZATION,
          at: '2026-08-11T08:59:58.000Z',
        },
        kind: 'lowDwell',
        value: 1900,
        note: '整节停留不到 2 秒',
      },
      deps(),
    );

    const ledger = await readLedger(deps());
    expect(ledger.signals).toEqual([signal]);
    expect(signalsOf(ledger, answered.source.interactionId)).toEqual([signal]);
    // 履历里只有证据，信号一条都没混进去
    expect(history(ledger).map((e) => e.id)).toEqual([answered.id]);

    const withSignal = weighAll(ledger.evidence, { signals: ledger.signals })[0].weight;
    const without = weighAll(ledger.evidence)[0].weight;
    expect(withSignal).toBeLessThan(without);
  });
});
