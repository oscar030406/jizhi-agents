/**
 * 逐屏路也要拿到课程一致性状态。
 *
 * 同题对照课实测：批量路治好了类比换喻体，客户端逐屏路照旧
 * 食堂排队 → 超市收银 → 保安巡逻，每屏一个新喻体。
 * 根因是 `coherenceDirective` 只接了批量路——**与 usedTemplateIds 同一个坑位，
 * 这是第三次**。
 *
 * 状态不走新请求字段：请求里本来就带着 `allOutlines`，从大纲现算。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { coherenceFromOutlines, coherenceDirective } from '@/lib/generation/course-coherence';

const OUTLINES = [
  { id: 'a', title: '什么是循环周期', keyPoints: ['扫描周期就像食堂排队，一轮走完才轮到下一轮'] },
  { id: 'b', title: '监视时间怎么算', keyPoints: ['默认 150ms，任务占 80ms，余量 70ms'] },
  { id: 'c', title: '超时了怎么办', keyPoints: ['超时直接停机'] },
];

describe('逐屏路一致性状态', () => {
  it('类比全课一个口径——最后一屏拿到的和第一屏一样', () => {
    const first = coherenceFromOutlines(OUTLINES, 'a').frame.analogy;
    const last = coherenceFromOutlines(OUTLINES, 'c').frame.analogy;
    expect(first).toBeTruthy();
    expect(first).toContain('食堂排队');
    expect(last).toBe(first);
  });

  it('已讲概念只算当前屏之前的', () => {
    expect(coherenceFromOutlines(OUTLINES, 'a').progress.concepts).toEqual([]);
    expect(coherenceFromOutlines(OUTLINES, 'c').progress.concepts).toEqual([
      '什么是循环周期',
      '监视时间怎么算',
    ]);
  });

  it('已演数字例进清单，指令里明写别再演一遍', () => {
    const { frame, progress } = coherenceFromOutlines(OUTLINES, 'c');
    expect(progress.workedExamples.some((e) => e.includes('150ms'))).toBe(true);
    const directive = coherenceDirective(frame, progress);
    expect(directive).toContain('150ms');
    expect(directive).toContain('不要再演一遍');
  });

  it('认不出类比就不硬造', () => {
    const bare = [{ id: 'x', title: '定时器', keyPoints: ['定时器用于延时'] }];
    expect(coherenceFromOutlines(bare, 'x').frame.analogy).toBeUndefined();
  });

  it('逐屏路真的接上了——路障', () => {
    // 这条盯的是接线不是逻辑：函数写好了没接进路由，等于没做（今天第三次）。
    const src = readFileSync(
      join(process.cwd(), 'app/api/generate/scene-content/route.ts'),
      'utf-8',
    );
    expect(src).toContain('coherenceFromOutlines');
    expect(src).toContain('coherenceDirective(frame, progress)');
  });
});
