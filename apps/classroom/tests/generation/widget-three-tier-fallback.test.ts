/**
 * 教具三层轮：模板池 → 上游六类自由 HTML → 讲义。
 *
 * 判决书 P0 第 1 条实锤：`generateTemplateWidgetContent` 选不出模板返回 null，
 * 撞上批量生成侧的 `shouldRetryResult: (result) => result === null`——
 * **同 prompt 重试 6 次，然后整屏丢弃**。
 *
 * 而三处注释都写着「交由上游既有降级链处理（讲义兜底）」。那条链只存在于
 * slide 分支内部，interactive 从来走不到——**注释写了代码没写**，
 * 与「代码写了不生效」互为镜像，读代码的人以为有安全网。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () => readFileSync(join(process.cwd(), 'lib/generation/scene-generator.ts'), 'utf-8');

describe('教具三层轮', () => {
  it('模板池选不出时不直接返回 null', () => {
    const code = src();
    // 原来是 `return generateTemplateWidgetContent(...)` 一行了事
    expect(code).toMatch(/const fromTemplate = await generateTemplateWidgetContent/);
    expect(code).toMatch(/if \(fromTemplate\) return fromTemplate/);
  });

  it('二层回落上游六类自由 HTML', () => {
    // fork 把 interactive 全路由进模板池，上游 generateWidgetContent 的五个 case
    // 成了不可达死代码（判决书：不是「Ultra Mode 锁」，是路由绕过）。
    const code = src();
    expect(code).toMatch(/const fromUpstream = await generateWidgetContent/);
    expect(code).toMatch(/if \(fromUpstream\) return fromUpstream/);
  });

  it('三层退成讲义，不整屏丢弃', () => {
    const code = src();
    const i = code.indexOf('degrading to lecture slide');
    expect(i).toBeGreaterThan(0);
    // 讲义调用要跟在降级日志后面，参数与 case 'slide' 同源
    expect(code.slice(i, i + 500)).toMatch(/generateSlideContent\(\s*\{ \.\.\.outline, type: 'slide' \}/);
  });

  it('注释与实现一致：承诺的降级真的写了', () => {
    // 这条是这族问题的疫苗——注释承诺一条安全网时，
    // 测试要能证明那条网真的织了，而不是只在注释里存在。
    const code = src();
    const promise = code.includes('讲义兜底') || code.includes('降级成讲义');
    if (promise) {
      expect(code).toMatch(/degrading to lecture slide|falling back to upstream/);
    }
  });
});

describe('同课形态去重', () => {
  it('目录里标注已用形态，但不删候选', async () => {
    const { buildTemplateCatalogText } = await import('@/lib/generation/widget-templates');
    const all = buildTemplateCatalogText();
    const withUsed = buildTemplateCatalogText(['process_stepper']);

    // 标注出现了
    expect(withUsed).toContain('这门课已经用过这个形态');
    // 但候选一个没少——硬删会让一门 12 屏的课后面几屏无模板可用、
    // 掉进二层甚至三层降级
    const count = (text: string) => (text.match(/^### /gm) ?? []).length;
    expect(count(withUsed)).toBe(count(all));
  });

  it('没传已用清单时目录不带标注', async () => {
    const { buildTemplateCatalogText } = await import('@/lib/generation/widget-templates');
    expect(buildTemplateCatalogText()).not.toContain('已经用过');
  });

  it('批量生成侧真的收集并透传——不是又一个建了没接线', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/server/classroom-generation.ts'), 'utf-8');
    // 参数加了、目录会标注了，但如果没人填，永远收到空数组
    expect(src).toContain('usedTemplateIds.add(usedId)');
    expect(src).toContain('usedTemplateIds: [...usedTemplateIds]');
  });
});
