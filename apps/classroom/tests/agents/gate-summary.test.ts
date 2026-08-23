/**
 * 门禁账的口径自测：分桶必须加得回场景总数，句子必须照实说未过审的那部分。
 *
 * 最后一组用 data/classrooms 里的真实课程跑不变量——这句话是对外可见的数字，
 * 分子分母必须和落库文件对得上，不能只在构造数据上成立。
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { summarizeGate } from '@/components/agents/gate-summary';
import type { Scene } from '@/lib/types/stage';

type Decision = 'publish' | 'publish_with_warnings' | 'block_pending_review';

/** 只造 summarizeGate 读的两个字段：有没有 audit、audit.decision 是什么。 */
function scene(decision?: Decision | 'legacy'): Scene {
  if (!decision) return {} as Scene;
  return { audit: decision === 'legacy' ? {} : { decision } } as unknown as Scene;
}

describe('summarizeGate', () => {
  it('全部放行时说「全部通过」，并给出放行方式的分解', () => {
    const s = summarizeGate([
      scene('publish'),
      scene('publish_with_warnings'),
      scene('publish_with_warnings'),
    ]);
    expect(s.passed).toBe(3);
    expect(s.sentence).toBe('本课 3 个场景全部通过审核门禁（1 个直接放行、2 个带风险标记放行）。');
  });

  it('有场景被拦截时如实写出来，不只在全过时才显示', () => {
    const s = summarizeGate([
      scene('publish_with_warnings'),
      scene('publish_with_warnings'),
      scene('block_pending_review'),
    ]);
    expect(s.blocked).toBe(1);
    expect(s.sentence).toBe(
      '本课 3 个场景，2 个通过审核门禁（2 个带风险标记放行）；1 个裁决为拦截转人工。',
    );
  });

  it('无审核记录与旧数据各自单列，不并进「通过」', () => {
    const s = summarizeGate([scene('publish'), scene('legacy'), scene(), scene()]);
    expect(s.passed).toBe(1);
    expect(s.undecided).toBe(1);
    expect(s.unaudited).toBe(2);
    expect(s.sentence).toBe(
      '本课 4 个场景，1 个通过审核门禁（1 个直接放行）；1 个有审核记录但没有门禁裁决、2 个没有审核记录。',
    );
  });

  it('一个都没通过时不说「通过」', () => {
    const s = summarizeGate([scene('block_pending_review'), scene()]);
    expect(s.sentence).toBe(
      '本课 2 个场景没有一个通过审核门禁：1 个裁决为拦截转人工、1 个没有审核记录。',
    );
  });

  it('空课程不编数字', () => {
    expect(summarizeGate([]).sentence).toBe('本课没有场景。');
  });

  it('落库课程：五个桶加得回场景总数，句首的 N 就是场景数', () => {
    const dir = join(process.cwd(), 'data', 'classrooms');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as { scenes?: Scene[] };
      const scenes = data.scenes ?? [];
      const s = summarizeGate(scenes);
      expect(s.total).toBe(scenes.length);
      expect(
        s.publish + s.publishWithWarnings + s.blocked + s.undecided + s.unaudited,
        `${file} 分桶漏了场景`,
      ).toBe(scenes.length);
      // 0 场景走上面「空课程不编数字」的措辞，不含数字
      expect(s.sentence, `${file} 句子里的场景数与文件对不上`).toContain(
        scenes.length === 0 ? '本课没有场景' : `${scenes.length} 个场景`,
      );
    }
  });
});
