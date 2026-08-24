/**
 * 错题本按账号分桶。
 *
 * 原来是全局单键 `mistakeBank`，同一台浏览器换个账号照样读得出上一个人的错题，
 * 而学情报告拿它算掌握度——**别人的作答算进你的学情**。
 * 2026-08-24 走读实锤：错题本里混进了同浏览器旧账号的 3 条题。
 *
 * 这个文件为「域」那根轴修过一次（`domain` 字段：不带域的错题本换库后必然
 * 把两个库的错题混排）。**账号那根轴当时没人想起来**——同一个文件、同一种病。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ accountState: vi.fn() }));

vi.mock('@/lib/store/account', () => ({
  useAccountStore: { getState: mocks.accountState },
}));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const entry = (id: string) => ({
  questionId: id,
  question: `题 ${id}`,
  chosen: 'A',
  correct: 'B',
  at: '2026-08-24T00:00:00.000Z',
});

async function bank() {
  return import('@/lib/evidence/mistake-bank');
}

function asAccount(id: string | null) {
  mocks.accountState.mockReturnValue({ account: id ? { id } : null });
}

describe('错题本按账号分桶', () => {
  beforeEach(() => {
    store.clear();
    mocks.accountState.mockReset();
  });

  it('两个账号各读各的', async () => {
    const { appendMistakes, readMistakes } = await bank();

    asAccount('alice');
    appendMistakes([entry('q1')]);
    asAccount('bob');
    appendMistakes([entry('q2')]);

    asAccount('alice');
    expect(readMistakes().map((m) => m.questionId)).toEqual(['q1']);
    asAccount('bob');
    expect(readMistakes().map((m) => m.questionId)).toEqual(['q2']);
  });

  it('没登录时用匿名桶，不炸', async () => {
    const { appendMistakes, readMistakes } = await bank();
    asAccount(null);
    appendMistakes([entry('anon')]);
    expect(readMistakes().map((m) => m.questionId)).toEqual(['anon']);
    expect(store.has('mistakeBank')).toBe(true);
  });

  it('store 没挂载时退回匿名桶，不抛', async () => {
    const { readMistakes } = await bank();
    mocks.accountState.mockImplementation(() => {
      throw new Error('store not mounted');
    });
    expect(() => readMistakes()).not.toThrow();
  });
});

describe('老数据认领：加前缀不能让现存错题本凭空消失', () => {
  beforeEach(() => {
    store.clear();
    mocks.accountState.mockReset();
  });

  it('第一个登录的账号认领匿名桶，认领完老键删掉', async () => {
    const { readMistakes } = await bank();
    store.set('mistakeBank', JSON.stringify([entry('legacy')]));

    asAccount('alice');
    expect(readMistakes().map((m) => m.questionId)).toEqual(['legacy']);
    // 认领完删老键——否则下一个账号又认领一次，等于没分桶。
    expect(store.has('mistakeBank')).toBe(false);
    expect(store.has('mistakeBank@alice')).toBe(true);

    asAccount('bob');
    expect(readMistakes()).toEqual([]);
  });

  it('账号已有自己的桶时不认领，不覆盖', async () => {
    const { readMistakes } = await bank();
    store.set('mistakeBank@alice', JSON.stringify([entry('mine')]));
    store.set('mistakeBank', JSON.stringify([entry('legacy')]));

    asAccount('alice');
    expect(readMistakes().map((m) => m.questionId)).toEqual(['mine']);
    // 没认领，老键原样留着给别人
    expect(store.has('mistakeBank')).toBe(true);
  });
});
