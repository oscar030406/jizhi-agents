/**
 * 三级提示阶梯在课堂侧的接线。
 *
 * 引擎那边接口早就完整了，课堂这层的字段白名单把 `hint_request` /
 * `hints_used` / `hint_question_id` **静默丢掉**——界面点不出提示，交答案也不回传，
 * 于是「看了答案照样记成会了」。这份钉的就是这三处别再断。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tutorEvidenceDraft } from '@/lib/evidence/from-tutor';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

describe('路由转发', () => {
  const src = () => read('app/api/tutor/route.ts');

  it('三个字段真的转发出去，不是只加在入参类型上', () => {
    const s = src();
    expect(s).toContain('hint_request: body.hintRequest ?? 0');
    expect(s).toContain('hints_used: body.hintsUsed ?? 0');
    expect(s).toContain("hint_question_id: body.hintQuestionId ?? ''");
  });

  it('提示轮不会被当成坏载荷退 204', () => {
    // 提示分支既没有 decision 也没有 mode，只有 steps。
    // 少这一条判据的话引擎正常返回、界面什么都收不到——最难查的那种静默失败。
    const s = src();
    expect(s).toContain("'steps' in data");
    expect(s).toContain('isLadder');
  });

  it('LectureExchange 带 hints_used，历史回放才算得对代价', () => {
    expect(src()).toContain('hints_used?: number');
  });

  it('HintStep 的 content 语义写清了未解锁为空', () => {
    expect(src()).toContain('未解锁时 `content` 是空串');
  });
});

describe('面板', () => {
  const src = () => read('components/chat/tutor-panel.tsx');

  it('交答案时回传 hints_used', () => {
    expect(src()).toContain('hintsUsed: hintsUsedRef.current');
  });

  it('出下一题时清零——不清就等于替新题记了上一题的提示代价', () => {
    const s = src();
    expect(s).toContain('hintsUsedRef.current = 0;');
    expect(s).toMatch(/新题 = 新阶梯/);
  });

  it('累计级别以引擎回的为准，前端不自增', () => {
    const s = src();
    expect(s).toContain('Math.max(hintsUsedRef.current, got.hints_used ?? 0)');
    expect(s).toContain('不在前端自增');
  });

  it('置灰文案用引擎回的 reason，不另编一套', () => {
    expect(src()).toContain('step?.reason');
  });

  it('每级按钮标出代价，让人知情后再点', () => {
    expect(src()).toContain('verdict_cap');
  });

  it('要提示不出新题（走 hintRequest 分支）', () => {
    expect(src()).toContain('hintRequest: level');
  });
});

describe('证据留痕', () => {
  const base = {
    learnerKey: 'k',
    interactionId: 'i',
    sceneId: 's',
    sceneTitle: '循环监视时间',
    at: '2026-08-23T00:00:00.000Z',
  };

  it('看了兜底答案的那条，履历上看得出来', () => {
    const draft = tutorEvidenceDraft({
      ...base,
      turn: {
        mode: 'verdict',
        verdict: 'incorrect',
        expected_points: ['阈值默认 150ms'],
        profile_evidence: {
          concept: '循环监视时间',
          verdict: 'incorrect',
          confidence: 0.8,
          hints_used: 3,
          raw_verdict: 'correct',
        },
      },
    });
    expect(draft).not.toBeNull();
    const item = draft!.items[0]!;
    const because = item.verdict!.because;
    expect(item.context.hintsUsed).toBe(3);
    // 注记单开一格：塞进 missed 会被复盘的人当成一个知识缺口
    expect(because.note?.join(' ')).toContain('看了兜底答案');
    expect(because.note?.join(' ')).toContain('原始判分 correct');
    expect(because.missed).toEqual(['阈值默认 150ms']);
  });

  it('没要过提示就不留注记，也不写 hintsUsed', () => {
    const draft = tutorEvidenceDraft({
      ...base,
      turn: {
        mode: 'verdict',
        verdict: 'correct',
        expected_points: ['阈值默认 150ms'],
        profile_evidence: { concept: '循环监视时间', verdict: 'correct', confidence: 0.8 },
      },
    });
    const item = draft!.items[0]!;
    expect(item.context.hintsUsed).toBeUndefined();
    expect(item.verdict!.because.note).toBeUndefined();
  });

  it('提示代价不在这里二次打折——分值仍是引擎压过档的那份', () => {
    const draft = tutorEvidenceDraft({
      ...base,
      turn: {
        mode: 'verdict',
        verdict: 'partial',
        mastery_estimate: 0.5,
        profile_evidence: {
          concept: '循环监视时间',
          verdict: 'partial',
          confidence: 0.5,
          hints_used: 2,
          raw_verdict: 'correct',
        },
      },
    });
    expect(draft!.items[0]!.verdict!.score).toBe(0.5);
  });
});
