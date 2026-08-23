/**
 * MFI 的两个消费方。
 *
 * `lib/quiz/item-selection.ts` 写好之后一度零消费方——「真源建了要接线」，
 * 产物落盘不算做完。这份钉的就是那条线还在：
 *
 * 1. 分阶测验：补救 outline 的 `quizConfig.difficulty` 跟着掌握度走，不再写死。
 * 2. 错题重练：学情报告的错题本按信息量排，不再按时间平铺。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseTier, pickTier, quizDifficultyOf, TIERS } from '@/lib/quiz/item-selection';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('分阶测验接上了', () => {
  const src = () => read('app/api/adaptive/remediation/route.ts');

  it('难度不再是写死的常量', () => {
    const s = src();
    expect(s).toContain('adaptiveDifficulty');
    expect(s).toContain('pickTier');
    // PLANS 里那两个静态值仍在（拿不到掌握度时的退路），但不再是唯一来源
    expect(s).toContain('...(adaptive ? { difficulty: adaptive.difficulty } : {})');
  });

  it('掌握度一条都没有时不推断，退回预设档', () => {
    const s = src();
    expect(s).toContain('if (values.length === 0) return null;');
    expect(s).toContain('不编一个「中等水平」出来');
  });

  it('难度带来自画像的 quiz_difficulty_band，逐个 parseTier', () => {
    const s = src();
    expect(s).toContain('quiz_difficulty_band');
    expect(s).toContain('parseTier(raw)');
  });

  it('返回体带上「为什么是这一档」，界面说得出理由', () => {
    expect(src()).toContain('difficultyBecause');
  });
});

describe('锚点 + 位移的算法本身', () => {
  // route 里的私有函数不导出，这里用同一套原语复算，确保口径可复现
  const shiftOf = (d: string) => (d === 'add_practice' ? -1 : d === 'advance_challenge' ? 1 : 0);
  const decide = (mastery: number, band: string[], decision: string) => {
    const allowed = band.map(parseTier).filter((t): t is NonNullable<typeof t> => t !== null);
    const anchor = pickTier(mastery, { allowed });
    const pool = allowed.length ? TIERS.filter((t) => allowed.includes(t)) : TIERS;
    const at = pool.indexOf(anchor.tier);
    const i = Math.min(pool.length - 1, Math.max(0, at + shiftOf(decision)));
    return quizDifficultyOf(pool[i] ?? anchor.tier);
  };

  it('强的人再练一遍，也不该掉到最简单那档', () => {
    // 写死 easy 的旧行为对高掌握度是浪费
    expect(decide(0.9, [], 'add_practice')).not.toBe('easy');
  });

  it('弱的人进阶挑战，不该直接顶到 hard', () => {
    expect(decide(0.1, [], 'advance_challenge')).not.toBe('hard');
  });

  it('同一个人，再练比进阶低', () => {
    const order = { easy: 0, medium: 1, hard: 2 } as const;
    for (const m of [0.2, 0.5, 0.8]) {
      expect(order[decide(m, [], 'add_practice')]).toBeLessThanOrEqual(
        order[decide(m, [], 'advance_challenge')],
      );
    }
  });

  it('画像难度带是硬边界，位移不许越出去', () => {
    // 带里只有 medium 一档：无论什么决策都只能是 medium
    for (const d of ['add_practice', 'advance_challenge']) {
      expect(decide(0.9, ['medium'], d)).toBe('medium');
      expect(decide(0.1, ['medium'], d)).toBe('medium');
    }
  });

  it('认不出的档位被丢弃，不当成边界', () => {
    // 全是垃圾值 = 没给带 = 不设限，不该崩也不该锁死
    expect(['easy', 'medium', 'hard']).toContain(decide(0.5, ['困难', ''], 'add_practice'));
  });
});

describe('错题重练接上了', () => {
  it('报告页用 rankRepractice，不再按时间平铺', () => {
    const s = read('app/report/page.tsx');
    expect(s).toContain('rankRepractice');
    expect(s).toContain('ordered.slice(0, 6)');
    // 没有掌握度时如实退回时间序，并且界面上说出来
    expect(s).toContain('暂按时间倒序');
  });

  it('错题本存下了排序要用的三格', () => {
    const bank = read('lib/evidence/mistake-bank.ts');
    expect(bank).toContain('tier?: string');
    expect(bank).toContain('questionType?: string');
    expect(bank).toContain('optionCount?: number');
  });

  it('交卷时按 outlineId 认大纲取难度档——不按 order 认', () => {
    const s = read('components/scene-renderers/quiz-view.tsx');
    expect(s).toContain('outlineId');
    expect(s).toContain('quizConfig?.difficulty');
    // 认不到就不写这一格
    expect(s).toContain('...(tier ? { tier } : {})');
  });
});
