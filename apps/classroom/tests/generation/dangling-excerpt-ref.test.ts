/**
 * 摘录被丢弃之后，正文里指向它的话不能留着。
 *
 * 第三代同题对照课屏 1 的原形：摘录被 rejected、诚实缺口说明也留了，
 * 紧接着正文写「注意摘录中提到的关键数字：超两倍切 STOP」——
 * 读者视角自相矛盾，说好没贴出来，又让人去看没贴出来的东西。
 *
 * 既有的 `dropLeadIn` 撤的是摘录**前面**那句导语，管不到后面正文里的指代。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { excerptDirective, injectExcerpts } from '@/lib/generation/evidence-grounding';
import type { EvidenceBundle } from '@/lib/generation/evidence-grounding';

/** 一份不含任何可引用块的证据包：占位符必然走「未知 id」丢弃路径。 */
const emptyBundle = (): EvidenceBundle => ({
  chunks: [],
  matchedConcepts: [],
  summary: '',
});

const scene = (paras: string[]) => ({
  elements: paras.map((content, i) => ({ id: `t${i}`, type: 'text', content })),
});

describe('悬空指代改写', () => {
  it('摘录掉了，后面正文里的「摘录中提到的」改成直接陈述', async () => {
    const content = scene([
      '<p>{{摘录:docs-plc#s31}}</p>',
      '<p>注意摘录中提到的关键数字：超两倍切 STOP。</p>',
    ]);
    const stats = await injectExcerpts(content, emptyBundle());
    const text = JSON.stringify(content);
    expect(stats.danglingRefsFixed).toBeGreaterThan(0);
    expect(text).not.toContain('摘录中提到的');
    expect(text).toContain('教材规定的关键数字');
    // 事实本身留着，只是不再绕道指向一段不存在的引文
    expect(text).toContain('超两倍切 STOP');
  });

  it('几种说法都收', async () => {
    const content = scene([
      '<p>{{摘录:docs-plc#s31}}</p>',
      '<p>如摘录所示，阈值是 150ms。上述摘录还给了余量算法。</p>',
    ]);
    await injectExcerpts(content, emptyBundle());
    const text = JSON.stringify(content);
    expect(text).not.toContain('如摘录所示');
    expect(text).not.toContain('上述摘录');
    expect(text).toContain('150ms');
  });

  it('一条摘录都没掉时不动正文——那时候指代指得实', async () => {
    const content = scene(['<p>注意摘录中提到的关键数字：超两倍切 STOP。</p>']);
    const stats = await injectExcerpts(content, emptyBundle());
    expect(stats.danglingRefsFixed).toBe(0);
    expect(JSON.stringify(content)).toContain('摘录中提到的');
  });

  it('生成侧也从源头劝阻这种措辞', () => {
    const directive = excerptDirective({
      chunks: [
        {
          source_id: 'docs-plc#s31',
          title: 'PLC 手册',
          content: '循环监视时间默认 150ms。',
        } as never,
      ],
      matchedConcepts: [],
      summary: '',
    });
    expect(directive).toContain('不要用「摘录中提到的」');
    expect(directive).toContain('直接陈述');
  });
});

describe('流式成稿路也过脚手架清除', () => {
  it('第三条出口挂上了，且共用同一份判据不写第三遍', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/generate/scene-content/route.ts'),
      'utf-8',
    );
    expect(route).toContain('scrubScaffoldElements');
    const gen = readFileSync(join(process.cwd(), 'lib/generation/scene-generator.ts'), 'utf-8');
    // 判据只有一份实现，导出给两条路用
    expect(gen).toContain('export function scrubScaffoldElements');
    expect((gen.match(/scrubScaffoldHtml\(/g) ?? []).length).toBe(1);
  });
});
