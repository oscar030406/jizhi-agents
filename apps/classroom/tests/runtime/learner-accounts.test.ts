/** 学习者档案切换：分区 key 写入与画像快照换入换出的行为锁。 */

import { afterEach, describe, expect, test, vi } from 'vitest';

// node 环境无 DOM——最小 shim：Map 版 localStorage + 可 mock 的 reload。
// 必须在被测模块 import 前就位（BrowserKVStore 构造时摸 globalThis.localStorage）。
const store = new Map<string, string>();
const reloadMock = vi.fn();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  },
  window: { location: { reload: reloadMock } },
});

const { BrowserKVStore } = await import('@openmaic/storage');
const { createAccount, listAccounts, switchAccount } = await import(
  '@/lib/runtime/learner-accounts'
);
const { LEARNER_KEY_KV_KEY } = await import('@/lib/runtime/learner-key');

async function seedCurrentKey(key: string) {
  await new BrowserKVStore().set(LEARNER_KEY_KV_KEY, key, 'device');
}

afterEach(() => {
  localStorage.clear();
  reloadMock.mockClear();
});

describe('learner accounts', () => {
  test('首个匿名 key 自动登记为默认档案', async () => {
    await seedCurrentKey('anon:first');
    const { accounts, current } = await listAccounts();
    expect(current).toBe('anon:first');
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe('默认档案');
  });

  test('切换档案：快照换出换入 + KV key 更新 + reload', async () => {
    await seedCurrentKey('anon:a');
    await listAccounts();
    localStorage.setItem('learnerProfile', JSON.stringify({ role: '甲的画像' }));
    // 目标档案 b 已有自己的快照
    localStorage.setItem('maic.learnerAccounts', JSON.stringify([
      { key: 'anon:a', name: 'A', createdAt: 1 },
      { key: 'anon:b', name: 'B', createdAt: 2 },
    ]));
    localStorage.setItem('learnerProfile@anon:b', JSON.stringify({ role: '乙的画像' }));

    await switchAccount('anon:b');

    expect(localStorage.getItem('learnerProfile@anon:a')).toContain('甲的画像');
    expect(localStorage.getItem('learnerProfile')).toContain('乙的画像');
    expect(await new BrowserKVStore().get(LEARNER_KEY_KV_KEY, 'device')).toBe('anon:b');
    expect(reloadMock).toHaveBeenCalled();
  });

  test('新建档案：画像从空开始', async () => {
    await seedCurrentKey('anon:a');
    await listAccounts();
    localStorage.setItem('learnerProfile', JSON.stringify({ role: '旧画像' }));

    await createAccount('新学员');

    const key = (await new BrowserKVStore().get<string>(LEARNER_KEY_KV_KEY, 'device')) ?? '';
    expect(key).toMatch(/^anon:/);
    expect(key).not.toBe('anon:a');
    expect(localStorage.getItem('learnerProfile')).toBeNull(); // 新分区无画像
    expect(localStorage.getItem('learnerProfile@anon:a')).toContain('旧画像');
    expect(reloadMock).toHaveBeenCalled();
  });

  test('切到未知档案抛错且不动状态', async () => {
    await seedCurrentKey('anon:a');
    await listAccounts();
    await expect(switchAccount('anon:ghost')).rejects.toThrow('未知档案');
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
