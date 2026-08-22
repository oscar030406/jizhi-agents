/**
 * wheel-spinning：连错到阈值就放弃这个知识点、换点，并往账本记一条。
 *
 * 钉住四件事：阈值差一次不许触发、中间答对一次必须清零、放弃的点不再进候选、
 * 放弃记录进得了账本且记下了当时的阈值。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';

import { readLedger, recordGiveUp } from '@/lib/evidence/ledger';
import { measuredKey, type Evidence, type Measured } from '@/lib/evidence/types';
import {
  GIVE_UP_STREAK,
  abandonedKeys,
  dropAbandoned,
  trailingFailStreaks,
  unrecorded,
  wheelSpinning,
} from '@/lib/evidence/wheel-spinning';

if (!('IDBKeyRange' in globalThis)) {
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
}

const LEARNER = 'anon:wheel-spin';
const T0 = Date.parse('2026-08-01T00:00:00Z');

/** 真实课程里的一个概念键（测项今天是场景标题，见 from-quiz 的注释）。 */
const TOKENIZATION: Measured = { kind: 'concept', domain: 'ai', concept: '动作 Token 化' };
const CHUNKING: Measured = { kind: 'concept', domain: 'ai', concept: '动作分块' };

/** score < 0.5 算答错（沿用权重函数的 FAIL_THRESHOLD）。 */
function ev(i: number, score: number, measured: Measured = TOKENIZATION): Evidence {
  return {
    id: `e${i}`,
    learnerKey: LEARNER,
    source: {
      interactionId: `i${i}`,
      resourceId: 'scene_CBKAJzwtsm',
      at: new Date(T0 + i * 60_000).toISOString(),
    },
    measured,
    verdict: {
      outcome: score >= 0.8 ? 'correct' : score >= 0.4 ? 'partial' : 'incorrect',
      score,
      because: { hit: [], missed: [] },
    },
    verdictScope: 'per-kc',
    context: { encounter: i + 1, modality: 'quiz' },
  };
}

/** 连着答错 n 次。 */
function fails(n: number, measured?: Measured): Evidence[] {
  return Array.from({ length: n }, (_, i) => ev(i, 0, measured));
}

describe('连错到阈值才放弃', () => {
  it('差一次不触发，达到阈值才触发', () => {
    expect(wheelSpinning(fails(GIVE_UP_STREAK - 1))).toEqual([]);
    const spun = wheelSpinning(fails(GIVE_UP_STREAK));
    expect(spun).toHaveLength(1);
    expect(spun[0].key).toBe(measuredKey(TOKENIZATION));
    expect(spun[0].streak).toBe(GIVE_UP_STREAK);
    // 触发它的是最后一次答错，不是第一次
    expect(spun[0].last.id).toBe(`e${GIVE_UP_STREAK - 1}`);
  });

  it('阈值是参数，不是写死的数', () => {
    expect(wheelSpinning(fails(3), { threshold: 3 })).toHaveLength(1);
    expect(wheelSpinning(fails(3), { threshold: 9 })).toEqual([]);
  });

  it('中间答对一次，计数清零 —— 连错段只从末尾算', () => {
    // 错错错错 → 对 → 错错：末尾只有 2 次
    const history = [...fails(4), ev(4, 1), ev(5, 0), ev(6, 0)];
    expect(trailingFailStreaks(history).get(measuredKey(TOKENIZATION))?.streak).toBe(2);
    expect(wheelSpinning(history)).toEqual([]);
  });

  it('部分对也断连错段 —— 「连续答错」按字面理解，不加权', () => {
    const history = [...fails(4), ev(4, 0.5), ev(5, 0)];
    expect(trailingFailStreaks(history).get(measuredKey(TOKENIZATION))?.streak).toBe(1);
  });

  it('按作答时刻排序，不按追加序 —— 补记的旧证据不该被当成末尾', () => {
    const late = ev(9, 1); // 最晚的一条是答对
    const history = [late, ...fails(GIVE_UP_STREAK)];
    expect(wheelSpinning(history)).toEqual([]);
  });

  it('各测项各算各的，不串台', () => {
    const history = [...fails(GIVE_UP_STREAK), ev(9, 0, CHUNKING)];
    expect(wheelSpinning(history).map((s) => s.measured)).toEqual([TOKENIZATION]);
  });
});

describe('放弃后不再进候选', () => {
  it('放弃的知识点从候选里剔掉，其余原样', () => {
    const history = fails(GIVE_UP_STREAK);
    const candidates = ['动作 Token 化', '动作分块', 'RT 系列里程碑'];
    expect(dropAbandoned(candidates, history)).toEqual(['动作分块', 'RT 系列里程碑']);
  });

  it('没人被放弃时原样返回', () => {
    const candidates = ['动作 Token 化', '动作分块'];
    expect(dropAbandoned(candidates, fails(2))).toEqual(candidates);
  });

  it('域对不上就不剔 —— 不做模糊匹配', () => {
    const history = fails(GIVE_UP_STREAK);
    expect(dropAbandoned(['动作 Token 化'], history, { domain: 'embodied' })).toEqual([
      '动作 Token 化',
    ]);
  });

  it('后来答对了，连错段断掉，这个点自己回到候选里', () => {
    const history = [...fails(GIVE_UP_STREAK), ev(9, 1)];
    expect(abandonedKeys(history).size).toBe(0);
    expect(dropAbandoned(['动作 Token 化'], history)).toEqual(['动作 Token 化']);
  });
});

describe('放弃记录进账本', () => {
  let store: RuntimeStore;

  beforeEach(() => {
    store = new BrowserRuntimeStore({ indexedDB: new IDBFactory(), dbName: 'wheel-spin-test' });
  });

  it('追加一条形状合法的记录，记下当时的阈值与触发它的证据', async () => {
    const history = fails(GIVE_UP_STREAK);
    const [spin] = wheelSpinning(history);
    const written = await recordGiveUp(spin, {
      store,
      learnerKey: LEARNER,
      now: () => '2026-08-01T01:00:00.000Z',
    });

    expect(written).toMatchObject({
      learnerKey: LEARNER,
      measured: TOKENIZATION,
      streak: GIVE_UP_STREAK,
      threshold: GIVE_UP_STREAK,
      triggeredBy: `e${GIVE_UP_STREAK - 1}`,
      at: '2026-08-01T01:00:00.000Z',
    });
    expect(written.id.startsWith('give-up:')).toBe(true);

    const ledger = await readLedger({ store, learnerKey: LEARNER });
    expect(ledger.giveUps).toEqual([written]);
    // 只追加：证据流本身一条没动
    expect(ledger.evidence).toEqual([]);
  });

  it('阈值改了，旧记录仍说得清当初按几判的', async () => {
    const [spin] = wheelSpinning(fails(3), { threshold: 3 });
    const written = await recordGiveUp(spin, { store, learnerKey: LEARNER, threshold: 3 });
    expect(written.threshold).toBe(3);
  });

  it('别人的证据写不进我的账本', async () => {
    const [spin] = wheelSpinning(fails(GIVE_UP_STREAK));
    await expect(
      recordGiveUp(spin, { store, learnerKey: 'anon:someone-else' }),
    ).rejects.toThrow(/只能写进自己的账本/);
  });

  it('同一个测项不重复记 —— unrecorded 挡在追加之前', async () => {
    const history = fails(GIVE_UP_STREAK);
    const spins = wheelSpinning(history);
    const [written] = await Promise.all(
      unrecorded(spins, []).map((s) => recordGiveUp(s, { store, learnerKey: LEARNER })),
    );

    const ledger = await readLedger({ store, learnerKey: LEARNER });
    expect(unrecorded(spins, ledger.giveUps)).toEqual([]);
    expect(ledger.giveUps).toEqual([written]);
  });
});
