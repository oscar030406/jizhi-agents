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

  it('两者都没有时判 unknown——不冒充主域', () => {
    // 原来这条兜底是「不知道就当主域」。2026-08-23 立案：那是静默回退，
    // 一门来路不明的课会混进主域课程卡。实测盘上 41 门课没有一门走到这条兜底
    // （30 门在路径上、5 门有出身记录、6 门靠前缀投票），所以改成 unknown
    // 对现有数据零影响——它拦的是将来那门「什么都没有」的课。
    expect(courseDomainOf(empty as never, false)).toBe('unknown');
  });

  it('挂在学习路径上，也不许改写课程自己记的库', () => {
    // 原来是「路径上的课一律归主域」，压过出身记录。那条规则存在的理由只是
    // 纠正前缀投票误判（AI 课引用 em 块会被投成 embodied），没有理由去改写
    // 课程自己写下的出身——c3HH74qwAH/sVnMPbeeXn 的口径打架就是这么来的。
    expect(
      courseDomainOf(
        { ...empty, stage: { origin: { corpus: 'smart-manufacturing' } } } as never,
        true,
      ),
    ).toBe('smart-manufacturing');
  });

  it('没有出身记录时，路径规则照旧纠正前缀投票', () => {
    const cited = {
      ...empty,
      scenes: [{ audit: { sources: [{ source_id: 'em1#s2' }] } }],
    };
    expect(courseDomainOf(cited as never, true)).toBe('ai');
    expect(courseDomainOf(cited as never, false)).toBe('embodied');
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

describe('两条生成路都写 origin', () => {
  it('客户端路（generation-preview）建 stage 时带 origin', async () => {
    // P0-A 的后半截：服务端生成链早就写了，客户端这条漏了——
    // 而首页「一句需求」走的正是客户端路，于是学习者自己造的课
    // 在归属表里永远认不出新域。
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'app/generation-preview/page.tsx'), 'utf-8');
    expect(src).toMatch(/origin: \{/);
    expect(src).toContain('loadLearnerProfile');
  });

  it('服务端路（classroom-generation）也带', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/server/classroom-generation.ts'), 'utf-8');
    expect(src).toMatch(/origin: \{/);
  });
});
