/**
 * 依据子盒：贴进正文的教材出处要作为**值**跟着资源走，不只是日志里的计数。
 *
 * 设计稿 §4.3：依据与审计成对但不合并——**依据答「这句话哪来的」由检索产出**，
 * 审计答「这句话对不对」由判官产出。此前依据只存在于 `scene.audit` 里，
 * 等于把检索的产物寄存在判官身上：判官没跑，这一页就「没有依据」。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { injectExcerpts, type EvidenceBundle } from '@/lib/generation/evidence-grounding';

const para = (html: string) => ({
  type: 'text',
  width: 880,
  height: 640,
  content: `<p style="font-size: 16px;">${html}</p>`,
});

function bundle(...ids: string[]): EvidenceBundle {
  return {
    chunks: ids.map((id) => ({
      source_id: id,
      title: `教材《${id}》`,
      content: '检索增强生成把外部知识接进模型的上下文。'.repeat(4),
    })),
  } as unknown as EvidenceBundle;
}

// 与 excerpt-budget 同理：关掉 GROUNDING_URL，免得去真调引擎的咬合打分。
beforeEach(() => vi.stubEnv('GROUNDING_URL', ''));
afterEach(() => vi.unstubAllEnvs());

describe('依据子盒 = 逐条落位记录', () => {
  test('贴进去的每条都留下 sourceId 与标题', async () => {
    const content = {
      elements: [para('教材原文如下：{{摘录:c1}}'), para('另一处出处：{{摘录:c2}}')],
    };
    const stats = await injectExcerpts(content, bundle('c1', 'c2'), new Set());
    expect(stats.injected).toBe(2);
    // 计数说明「贴了几条」，落位说明「贴的是哪几条」——后者才是依据子盒
    expect(stats.placements.map((p) => p.sourceId)).toEqual(['c1', 'c2']);
    expect(stats.placements[0].title).toContain('c1');
  });

  test('落位数与注入数一致 —— 对不上就是账错了', async () => {
    const content = { elements: [para('教材原文如下：{{摘录:c1}}')] };
    const stats = await injectExcerpts(content, bundle('c1'), new Set());
    expect(stats.placements).toHaveLength(stats.injected);
  });

  test('一条都没贴进去时是空数组，不是 undefined', async () => {
    // 没有占位符 → 没有注入 → 依据为空。空是合法状态：那一页确实没有教材依据，
    // 「无依据段落占比」这个数正是靠它算出来的。
    const stats = await injectExcerpts({ elements: [para('纯自撰内容')] }, bundle('c1'), new Set());
    expect(stats.injected).toBe(0);
    expect(stats.placements).toEqual([]);
  });

  test('没贴成的出处不留落位 —— 落位只记真的进了正文的那些', async () => {
    // 占位符指向 bundle 里没有的 id：无论它被算成 unknown 还是被原样跳过
    // （那是注入器自己的口径，不归本用例断言），**依据账上都不该记一笔**。
    const content = { elements: [para('教材原文如下：{{摘录:nosuch}}')] };
    const stats = await injectExcerpts(content, bundle('c1'), new Set());
    expect(stats.injected).toBe(0);
    expect(stats.placements).toEqual([]);
  });
});
