// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { createAccount, readProfile } from '@/lib/accounts/store';
import { adoptServerProfile } from '@/lib/store/account';
import { loadLearnerProfile } from '@/components/generation/learner-profile-popover';
import { MasterySummaryCard } from '@/components/home/learning-overview';

/**
 * 全新注册的账号，学情必须是空的。
 *
 * 2026-08-21 的现场：匿名期做过一次测验，注册一个全新账号，首页「我的学情」照样显示
 * 「知识巩固测试 0.40 / llm_basics 0.40 / 待补 2 个」。不是注册预置了 demo 数据——
 * 注册那条路（pg 与文件两个后端）压根不写 profile 列。真正的来源是浏览器：
 * `conceptMastery` 存在**全局单键** `learnerProfile` 上、不随 learnerKey 分区
 * （lib/evidence/profile-bridge.ts），而注册成功那一下的旧写法是
 * `if (data.profile) setItem(...)`——空档案的 `activeFields()` 返回 null，
 * 条件判假，上一个身份的残留就原封不动地活过了注册。
 *
 * 所以这条测试走的是真链路：真注册 → 真读档案 → 真的那条「以服务端为准」的规则 →
 * 真的那张卡渲染出来。中间不 mock，换了任何一环都会红。
 */

const RESIDUE = {
  domain: 'ai',
  conceptMastery: { llm_basics: 0.4, 知识巩固测试: 0.4 },
  conceptRecall: { llm_basics: 0.4 },
  derivedFrom: { evidenceCount: 2, at: '2026-08-20T00:00:00.000Z' },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-'));
  process.env.ACCOUNTS_DIR = dir;
  delete process.env.PERSISTENCE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  // 匿名期的派生画像：这就是要被换身份甩掉的那份
  localStorage.setItem('learnerProfile', JSON.stringify(RESIDUE));
});

afterEach(() => {
  delete process.env.ACCOUNTS_DIR;
  localStorage.clear();
  rmSync(dir, { recursive: true, force: true });
});

describe('全新注册的账号学情为空', () => {
  it('注册 → 服务端没有档案 → 匿名期的掌握度不许跟过来', async () => {
    const created = await createAccount('newbie01', 'pass123456', 'learner');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // /api/auth 回给前端的就是这个值（app/api/auth/route.ts 里的 readProfile）
    const serverProfile = await readProfile(created.account.id);
    expect(serverProfile).toBeNull();

    adoptServerProfile(serverProfile);

    const profile = loadLearnerProfile();
    expect(profile.conceptMastery).toBeUndefined();

    const html = renderToStaticMarkup(
      createElement(MasterySummaryCard, { profile, effectiveDomain: 'ai' }),
    );
    expect(html).toContain('还没有测验记录');
    expect(html).not.toContain('llm_basics');
    expect(html).not.toContain('0.40');
  });

  it('服务端有档案时以它为准，不是与本地残留合并', async () => {
    const created = await createAccount('oldhand01', 'pass123456', 'learner');
    if (!created.ok) return;

    adoptServerProfile({ domain: 'manufacturing', role: '产线工程师' });

    const profile = loadLearnerProfile() as typeof RESIDUE & { role?: string };
    expect(profile.domain).toBe('manufacturing');
    expect(profile.conceptMastery).toBeUndefined();
    expect(profile.derivedFrom).toBeUndefined();
  });
});

describe('内部概念代号不上屏', () => {
  it('学情卡把 llm_basics 换成中文名，认不出的键（场景标题）原样显示', () => {
    const html = renderToStaticMarkup(
      createElement(MasterySummaryCard, {
        effectiveDomain: 'ai',
        profile: {
          conceptMasteryByDomain: { ai: { llm_basics: 0.4, 知识巩固测试: 0.4 } },
        },
      }),
    );
    expect(html).toContain('大模型基础');
    expect(html).not.toContain('llm_basics');
    expect(html).toContain('知识巩固测试');
  });
});
