/**
 * 摘录没贴成时页面上要留痕，不许静默剥除。
 *
 * 线上实锤（2026-08-23，PLC 课屏 1）：正文写着「根据上述规则」「如摘录所示」，
 * 页面上根本没有规则和摘录——生成流里的
 * 「教材对此的原文表述是：{{摘录:docs-plc#s31}}」整段消失，**导语留着、引用没了**，
 * 指代悬空。
 *
 * `injectExcerpts` 有六条丢弃分支，原本一律 `return ''`：统计里记了原因，
 * 页面上一个字都没有。
 *
 * **最要命的是它骗过了检查**：先前用「摘录占位符残留数 = 0」验证这条链，
 * 结论是「没问题」——0 是因为剥除不是替换。所以这个文件断言的是
 * 「留下了什么」，不是「没留下占位符」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { injectExcerpts, type EvidenceBundle } from '@/lib/generation/evidence-grounding';

/** 讲义流的真实元素形态：段落是 <p style=…> 包一层。 */
const para = (html: string) => ({
  type: 'text',
  width: 880,
  height: 640,
  content: `<p style="font-size: 16px;">${html}</p>`,
});

const bundle = (...ids: string[]): EvidenceBundle =>
  ({
    chunks: ids.map((id) => ({
      source_id: id,
      title: '测试教材',
      content: '这是一段自足的教材原文，讲清楚了循环监视时间的设定方法与默认值。'.repeat(3),
    })),
  }) as unknown as EvidenceBundle;

let savedUrl: string | undefined;

beforeEach(() => {
  // 不关掉会去真调引擎的咬合打分，成败取决于引擎起没起（见 excerpt-budget.test.ts 的同款注释）
  savedUrl = process.env.GROUNDING_URL;
  delete process.env.GROUNDING_URL;
  vi.restoreAllMocks();
});

afterEach(() => {
  if (savedUrl !== undefined) process.env.GROUNDING_URL = savedUrl;
});

describe('摘录没贴成时留痕', () => {
  it('证据里找不到这一条时，正文留一句带出处 id 的说明', async () => {
    const content = {
      elements: [para('教材对此的原文表述是：{{摘录:docs-plc#s31}}')],
    };
    // bundle 里根本没有 docs-plc#s31
    await injectExcerpts(content, bundle('other#s1'));

    const html = JSON.stringify(content);
    expect(html).not.toContain('{{摘录'); // 占位符确实处理掉了
    // 但**不能什么都不留**——导语「教材对此的原文表述是：」还在，
    // 后面空着就是指代悬空
    expect(html).toContain('docs-plc#s31');
    expect(html).toContain('本应引用教材');
  });

  it('留痕里说清为什么没贴，不是一句「出错了」', async () => {
    const content = { elements: [para('教材原文：{{摘录:missing#s1}}')] };
    await injectExcerpts(content, bundle('present#s1'));
    expect(JSON.stringify(content)).toContain('没找到');
  });

  it('正常能贴时不留说明——留痕只给失败的场合', async () => {
    const content = {
      elements: [para('教材对此的原文表述是：{{摘录:present#s1}}')],
    };
    await injectExcerpts(content, bundle('present#s1'));

    const html = JSON.stringify(content);
    expect(html).not.toContain('本应引用教材');
    expect(html).toContain('循环监视时间'); // 原文真的贴进去了
  });

  it('源码里不再有裸的 return 空串丢弃分支', () => {
    // 这条是给后人的路障：把 excerptGap(...) 改回 return '' 就会红。
    // 「摘录残留 0」这个检查骗过我们一次，静态断言比它可靠。
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'lib/generation/evidence-grounding.ts'),
      'utf-8',
    );
    const injectBody = src.slice(src.indexOf('const replaceIn ='), src.indexOf('stats.injected += 1'));
    expect(injectBody).not.toMatch(/\n\s+return '';/);
    expect((injectBody.match(/excerptGap\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
