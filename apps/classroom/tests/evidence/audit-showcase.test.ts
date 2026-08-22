/**
 * 区 C「判官抓错的那一次」场景挑选逻辑（components/evidence/audit-showcase.tsx）。
 *
 * 规则回顾：revised 且带 fix 优先（三栏能填满），同课多个取 fix 最多的；
 * 没有 → caveat（uncertain 且有 reason）兜底；都没有 → null（整区不渲染）。
 */

import { describe, expect, it } from 'vitest';

import {
  classifyReason,
  countCatches,
  judgeRole,
  maskJudgeVerdict,
  pickAuditShowcase,
  sortAuditEntries,
  sourceLabel,
} from '@/components/evidence/audit-showcase';
import type { AuditClaim, DebateRound } from '@/lib/generation/hallucination-audit';
import type { Scene } from '@/lib/types/stage';

function makeScene(
  title: string,
  verdict: 'pass' | 'caveat' | 'revised' | 'flagged',
  claims: Partial<AuditClaim>[],
  debate?: Partial<DebateRound>[],
): Scene {
  return {
    id: title,
    title,
    type: 'slide',
    audit: {
      verdict,
      claims: claims.map((c) => ({ claim: '断言', verdict: 'supported', reason: '', ...c })),
      totalClaims: claims.length,
      flaggedCount: 0,
      uncertainCount: 0,
      incorrectCount: 0,
      judgeModel: 'judge-a',
      rounds: 1,
      durationMs: 0,
      decision: 'publish',
      rationale: '',
      grounded: true,
      evidenceCount: 0,
      ...(debate ? { debate: debate.map((d) => ({ claim: '', judgeVerdicts: [], defense: '', arbiterVerdict: '', rationale: '', ...d })) } : {}),
    },
  } as unknown as Scene;
}

const course = (scenes: Scene[]) => ({ id: 'c1', title: '测试课', scenes });

describe('pickAuditShowcase', () => {
  it('revised 带 fix 的场景优先于 caveat', () => {
    const pick = pickAuditShowcase(
      course([
        makeScene('保留意见', 'caveat', [{ verdict: 'uncertain', reason: '资料未覆盖' }]),
        makeScene('抓错重修', 'revised', [
          { verdict: 'uncertain', reason: '表述绝对化', fix: '改后的表述' },
        ]),
      ]),
    );
    expect(pick?.kind).toBe('revised');
    expect(pick?.sceneTitle).toBe('抓错重修');
    expect(pick?.claims).toHaveLength(1);
    expect(pick?.claims[0].fix).toBe('改后的表述');
  });

  it('多个 revised 场景取带 fix 断言最多的一个', () => {
    const pick = pickAuditShowcase(
      course([
        makeScene('一条', 'revised', [{ reason: 'r', fix: 'f1' }, { reason: 'r' }]),
        makeScene('三条', 'revised', [
          { reason: 'r', fix: 'f1' },
          { reason: 'r', fix: 'f2' },
          { reason: 'r', fix: 'f3' },
        ]),
      ]),
    );
    expect(pick?.sceneTitle).toBe('三条');
    expect(pick?.claims).toHaveLength(3);
  });

  it('revised 场景没有任何 fix（三栏填不满）时退到 caveat 兜底', () => {
    const pick = pickAuditShowcase(
      course([
        makeScene('无fix重修', 'revised', [{ verdict: 'uncertain', reason: '理由' }]),
        makeScene('保留意见', 'caveat', [{ verdict: 'uncertain', reason: '资料未覆盖' }]),
      ]),
    );
    expect(pick?.kind).toBe('caveat');
    expect(pick?.sceneTitle).toBe('保留意见');
  });

  it('caveat 场景必须有带 reason 的 uncertain 断言才算数', () => {
    const pick = pickAuditShowcase(
      course([makeScene('空保留', 'caveat', [{ verdict: 'supported', reason: '' }])]),
    );
    expect(pick).toBeNull();
  });

  it('全库既无 revised 也无 caveat（含无 audit 场景）返回 null', () => {
    const bare = { id: 's', title: '无审核', type: 'slide' } as unknown as Scene;
    const pick = pickAuditShowcase(
      course([bare, makeScene('全过', 'pass', [{ verdict: 'supported', reason: '' }])]),
    );
    expect(pick).toBeNull();
  });

  it('展示行截到 4 条、仲裁分歧截到 3 条（版式约束）', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      reason: `r${i}`,
      fix: `f${i}`,
    }));
    const debates = Array.from({ length: 5 }, (_, i) => ({ claim: `d${i}` }));
    const pick = pickAuditShowcase(course([makeScene('多条', 'revised', many, debates)]));
    expect(pick?.claims).toHaveLength(4);
    expect(pick?.debate).toHaveLength(3);
  });

  it('flagged 场景与 revised 同级优先（选择器切到该课要能看到案例）', () => {
    const pick = pickAuditShowcase(
      course([
        makeScene('保留意见', 'caveat', [{ verdict: 'uncertain', reason: '资料未覆盖' }]),
        makeScene('拦下未修', 'flagged', [
          { verdict: 'incorrect', reason: '数值有误', fix: '修正表述' },
        ]),
      ]),
    );
    expect(pick?.kind).toBe('revised');
    expect(pick?.sceneTitle).toBe('拦下未修');
  });

  it('judgeModels 缺失时回落到单判官 judgeModel', () => {
    const pick = pickAuditShowcase(
      course([makeScene('单判官', 'revised', [{ reason: 'r', fix: 'f' }])]),
    );
    expect(pick?.judgeModels).toEqual(['judge-a']);
  });
});

describe('课程选择器辅助（纯函数）', () => {
  it('countCatches 数全部场景里非 supported 的断言（无 audit 场景跳过）', () => {
    const scenes = [
      makeScene('抓错', 'revised', [
        { verdict: 'incorrect', reason: 'r', fix: 'f' },
        { verdict: 'uncertain', reason: 'r' },
        { verdict: 'supported', reason: '' },
      ]),
      makeScene('全过', 'pass', [{ verdict: 'supported', reason: '' }]),
      { id: 'bare', title: '无审核', type: 'slide' } as unknown as Scene,
    ];
    expect(countCatches(scenes)).toBe(2);
  });

  it('sortAuditEntries 按抓错数降序，同数保持原序', () => {
    const entry = (id: string, catchCount: number) => ({
      id,
      title: id,
      catchCount,
      pick: null,
    });
    const sorted = sortAuditEntries([entry('a', 0), entry('b', 3), entry('c', 1), entry('d', 3)]);
    expect(sorted.map((e) => e.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});

describe('纠错卡渲染辅助（纯函数）', () => {
  it('classifyReason 按理由关键词粗分：数值→事实性、术语→术语、其余→表述', () => {
    expect(classifyReason('数值 3.5 与教材不符').label).toBe('事实性');
    expect(classifyReason('单位应为毫秒').label).toBe('事实性');
    expect(classifyReason('该术语定义有误').label).toBe('术语');
    expect(classifyReason('概念混用').label).toBe('术语');
    expect(classifyReason('表述过于绝对').label).toBe('表述');
  });

  it('sourceLabel 把 source_id 前缀映射为书名+章节，未知前缀原样展示', () => {
    expect(sourceLabel('ha07s04#s8')).toBe('《Hello-Agents》 第7章');
    expect(sourceLabel('hl07s03#s6')).toBe('《Happy-LLM》 第7章');
    expect(sourceLabel('d2l03s01#s2')).toBe('《动手学深度学习》 第3章');
    expect(sourceLabel('ag12s01')).toBe('《AgentGuide》 第12章');
    expect(sourceLabel('xx99')).toBe('引用 xx99');
  });

  it('maskJudgeVerdict 按面板顺序把模型名换成审核智能体称谓，保留判定部分', () => {
    expect(maskJudgeVerdict('siliconflow:Qwen/Qwen3.6-35B → 判错', 0)).toBe('审核智能体甲 → 判错');
    expect(maskJudgeVerdict('siliconflow:deepseek-ai/DeepSeek-V3.2 → 未提出该断言', 1)).toBe(
      '审核智能体乙 → 未提出该断言',
    );
    // 没有箭头分隔时兜底：整条当判定，不漏模型名之外的信息
    expect(maskJudgeVerdict('存疑', 0)).toBe('审核智能体甲 → 存疑');
    expect(judgeRole(2)).toBe('审核智能体3');
  });
});
