/**
 * 课程记住自己的出身（P0-A 的一半）。
 *
 * 实锤（2026-08-23）：本机文档库里 stage 记录的字段是
 * `id / name / languageDirective / videoManifest / style / createdAt / updatedAt / agentIds`
 * ——**一个域字段都没有**。客户端生成的课只存本机，服务端那份 `generation.profile`
 * 它没有；于是归属只能靠 source_id 前缀反推，而那张前缀表是手工维护的 AI 域清单，
 * **投币建的新库生成的课必然反推错**——在首页「本域课程」里永远看不见。
 */
import { describe, expect, it } from 'vitest';

import { courseDomainOf } from '@/lib/server/course-domains';

const empty = { scenes: [] as never[] };

describe('课程归属的判据优先级', () => {
  it('课自己记的出身最优先', () => {
    const got = courseDomainOf(
      {
        ...empty,
        stage: { origin: { corpus: 'smart-manufacturing' } },
        // 服务端记录说的是别的域：以课自己记的为准
        generation: { profile: { corpus: 'ai' } },
      } as never,
      false,
    );
    expect(got).toBe('smart-manufacturing');
  });

  it('只记了 domain 没记 corpus 时用 domain', () => {
    expect(
      courseDomainOf({ ...empty, stage: { origin: { domain: 'mfg' } } } as never, false),
    ).toBe('mfg');
  });

  it('没有出身时退回服务端生成记录', () => {
    expect(
      courseDomainOf({ ...empty, generation: { profile: { corpus: 'iotdb' } } } as never, false),
    ).toBe('iotdb');
  });

  it('两者都没有时退回 ai——source_id 前缀表只覆盖主域', () => {
    // 前缀表是手工维护的 AI 域清单，对新库反推不出东西。
    // 这条兜底是「不知道就当主域」，不是「推导正确」——所以出身字段才是主判据。
    expect(courseDomainOf(empty as never, false)).toBe('ai');
  });

  it('挂在学习路径上的课一律归主域', () => {
    expect(
      courseDomainOf(
        { ...empty, stage: { origin: { corpus: 'smart-manufacturing' } } } as never,
        true,
      ),
    ).toBe('ai');
  });
});

describe('生成链把出身写进课里', () => {
  it('classroom-generation 构造 stage 时带 origin', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'lib/server/classroom-generation.ts'),
      'utf-8',
    );
    // 「类型上有这个字段」证明不了「生成时写了它」——这族问题今天数到第十一例。
    expect(src).toMatch(/origin:\s*\{/);
    expect(src).toContain('learnerProfile?.corpus?.trim()');
  });

  it('骨架落盘失败会进进度消息，不再只 warn', () => {
    // 原来失败只 log.warn：落盘链一直失败也没人知道，学习者关掉标签页
    // 才发现课没了，排查时服务端日志里连一行都没有。
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/server/classroom-generation.ts'), 'utf-8');
    expect(src).toContain('skeletonPersistError');
    expect(src).toMatch(/没能存到服务器上/);
  });
});
