import { describe, expect, it } from 'vitest';

import {
  alreadyMerged,
  markMerged,
  mergeDoneKey,
  mergeLearnerProfile,
  mergePendingKey,
  type ProfileFields,
} from '@/lib/learner/merge-learner';

/**
 * 匿名进度并进账号的冲突规则。
 *
 * 判据只有一个：`derivedFrom.at`（profile-bridge 每次重算画像写的 ISO 时间戳，
 * 也是整份画像里唯一的时间信息）。判不出就保留账号侧——服务器上是真实学习记录，
 * 本地那份可能是上一个用这台浏览器的人留下的。
 */

const OLD = { evidenceCount: 2, at: '2026-08-01T00:00:00.000Z' };
const NEW = { evidenceCount: 5, at: '2026-08-20T00:00:00.000Z' };

describe('概念冲突取较新', () => {
  it('本地时间戳更晚 → 撞车的概念用本地的值', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { rag: 0.9 }, derivedFrom: NEW },
      { conceptMastery: { rag: 0.3 }, derivedFrom: OLD },
    );
    expect(out.fields.conceptMastery).toEqual({ rag: 0.9 });
    expect(out.adoptedConcepts).toEqual(['conceptMastery.rag']);
  });

  it('账号时间戳更晚 → 撞车的概念留账号的，本地不许覆盖', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { rag: 0.9 }, derivedFrom: OLD },
      { conceptMastery: { rag: 0.3 }, derivedFrom: NEW },
    );
    expect(out.fields.conceptMastery).toEqual({ rag: 0.3 });
    expect(out.adoptedConcepts).toEqual([]);
  });

  it('时间戳相等 → 分不出先后，留账号的', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { rag: 0.9 }, derivedFrom: NEW },
      { conceptMastery: { rag: 0.3 }, derivedFrom: { ...NEW } },
    );
    expect(out.fields.conceptMastery).toEqual({ rag: 0.3 });
    expect(out.adoptedConcepts).toEqual([]);
  });

  it('没撞车的概念直接收下——这不是冲突，是补齐', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { agent: 0.7 }, derivedFrom: OLD },
      { conceptMastery: { rag: 0.3 }, derivedFrom: NEW },
    );
    // 账号那份更新，但 agent 它压根没有，照收
    expect(out.fields.conceptMastery).toEqual({ rag: 0.3, agent: 0.7 });
    expect(out.adoptedConcepts).toEqual(['conceptMastery.agent']);
  });

  it('值一样就不算带进来了，别让调用方为没变化的东西发一次上行请求', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { rag: 0.3 }, derivedFrom: NEW },
      { conceptMastery: { rag: 0.3 }, derivedFrom: OLD },
    );
    expect(out.adoptedConcepts).toEqual([]);
    expect(out.adoptedFields).toEqual([]);
  });

  it('三张表各自逐键合，不是整表替换', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { a: 0.9 }, conceptRecall: { b: 0.5 }, derivedFrom: NEW },
      { conceptMastery: { a: 0.1, c: 0.2 }, conceptConfidence: { a: 0.8 }, derivedFrom: OLD },
    );
    expect(out.fields.conceptMastery).toEqual({ a: 0.9, c: 0.2 });
    expect(out.fields.conceptConfidence).toEqual({ a: 0.8 });
    expect(out.fields.conceptRecall).toEqual({ b: 0.5 });
  });
});

describe('时间戳缺失一律走安全侧', () => {
  it('本地没有 derivedFrom → 撞车的留账号的', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { rag: 0.9 } },
      { conceptMastery: { rag: 0.3 }, derivedFrom: OLD },
    );
    expect(out.fields.conceptMastery).toEqual({ rag: 0.3 });
  });

  it('账号没有 derivedFrom → 同样留账号的（判不出≠本地赢）', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { rag: 0.9 }, derivedFrom: NEW },
      { conceptMastery: { rag: 0.3 } },
    );
    expect(out.fields.conceptMastery).toEqual({ rag: 0.3 });
    // 账号自己没时间戳时把本地那份记上，别让合并结果变成无时间的
    expect(out.fields.derivedFrom).toEqual(NEW);
  });

  it('时间戳不是合法日期 → 判不出，留账号的', () => {
    const out = mergeLearnerProfile(
      { conceptMastery: { rag: 0.9 }, derivedFrom: { at: '刚刚' } },
      { conceptMastery: { rag: 0.3 }, derivedFrom: OLD },
    );
    expect(out.fields.conceptMastery).toEqual({ rag: 0.3 });
    expect(out.fields.derivedFrom).toEqual(OLD);
  });

  it('非数值混进概念表不进合并', () => {
    const dirty = { rag: 'high', agent: 0.7 } as unknown as Record<string, number>;
    const out = mergeLearnerProfile(
      { conceptMastery: dirty, derivedFrom: NEW },
      { conceptMastery: { rag: 0.3 }, derivedFrom: OLD },
    );
    expect(out.fields.conceptMastery).toEqual({ rag: 0.3, agent: 0.7 });
  });
});

describe('只有一边有数据 / 两边都空', () => {
  it('账号没档案（null）→ 本地整份带过去', () => {
    const local: ProfileFields = { domain: 'ai', conceptMastery: { rag: 0.6 }, derivedFrom: NEW };
    const out = mergeLearnerProfile(local, null);
    expect(out.fields).toEqual(local);
    expect(out.adoptedFields).toEqual(['domain']);
    expect(out.adoptedConcepts).toEqual(['conceptMastery.rag']);
  });

  it('本地什么都没有 → 账号那份原样返回，什么也没带进来', () => {
    const account: ProfileFields = { domain: 'manufacturing', conceptMastery: { rag: 0.3 } };
    const out = mergeLearnerProfile(null, account);
    expect(out.fields).toEqual(account);
    expect(out.adoptedConcepts).toEqual([]);
    expect(out.adoptedFields).toEqual([]);
  });

  it('两边都空 → 空对象，不凭空造出三张空表', () => {
    expect(mergeLearnerProfile(null, null).fields).toEqual({});
    const both = mergeLearnerProfile({}, {});
    expect(both.fields).toEqual({});
    expect(both.adoptedConcepts).toEqual([]);
  });

  it('不改入参', () => {
    const local = { conceptMastery: { rag: 0.9 }, derivedFrom: NEW };
    const account = { conceptMastery: { rag: 0.3 }, derivedFrom: OLD };
    mergeLearnerProfile(local, account);
    expect(local.conceptMastery).toEqual({ rag: 0.9 });
    expect(account.conceptMastery).toEqual({ rag: 0.3 });
  });
});

describe('静态字段：账号是真源，本地只填空位', () => {
  it('账号有值就不动——没有时间戳的字段谈不上「较新」', () => {
    const out = mergeLearnerProfile(
      { domain: 'ai', corpus: 'odoo', role: '在校学生' },
      { domain: 'manufacturing', corpus: '' },
    );
    expect(out.fields.domain).toBe('manufacturing');
    expect(out.fields.corpus).toBe('odoo'); // 空串算空位
    expect(out.fields.role).toBe('在校学生');
    expect(out.adoptedFields).toEqual(['corpus', 'role']);
  });

  it('0 是合法档位，不算空位', () => {
    const out = mergeLearnerProfile({ rag_level: 3 }, { rag_level: 0 });
    expect(out.fields.rag_level).toBe(0);
    expect(out.adoptedFields).toEqual([]);
  });
});

describe('合并只做一次', () => {
  /** 最小 Storage 替身：合并的一次性判定只用得着 getItem/setItem。 */
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it('打过标记之后 alreadyMerged 为真，第二次登录跳过合并', () => {
    const s = fakeStorage();
    expect(alreadyMerged(s, 'acc-1')).toBe(false);
    markMerged(s, 'acc-1');
    expect(alreadyMerged(s, 'acc-1')).toBe(true);
    expect(s.map.has(mergeDoneKey('acc-1'))).toBe(true);
  });

  it('标记按账号分键，A 并过不影响 B', () => {
    const s = fakeStorage();
    markMerged(s, 'acc-1');
    expect(alreadyMerged(s, 'acc-2')).toBe(false);
  });

  it('连登三次，合并规则只跑一次', () => {
    const s = fakeStorage();
    let ran = 0;
    const login = (accountId: string) => {
      if (alreadyMerged(s, accountId)) return;
      ran += 1;
      mergeLearnerProfile({ conceptMastery: { rag: 0.9 } }, null);
      markMerged(s, accountId);
    };
    login('acc-1');
    login('acc-1');
    login('acc-1');
    expect(ran).toBe(1);
  });

  it('存储抛异常时当作没并过，不因读不出标记就永远不并', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(alreadyMerged(broken, 'acc-1')).toBe(false);
    expect(() => markMerged(broken, 'acc-1')).not.toThrow();
  });

  it('重试用的寄存键和完成标记不是同一个键', () => {
    expect(mergePendingKey('acc-1')).not.toBe(mergeDoneKey('acc-1'));
    expect(mergePendingKey('acc-1')).toContain('acc-1');
  });
});
