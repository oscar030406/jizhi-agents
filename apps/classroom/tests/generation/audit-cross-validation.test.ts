import { describe, expect, it } from 'vitest';
import {
  auditSceneContent,
  claimSimilarity,
  crossValidate,
  type AuditClaim,
} from '@/lib/generation/hallucination-audit';
import { EvidenceGateError } from '@/lib/generation/evidence-grounding';

const c = (claim: string, verdict: AuditClaim['verdict'], reason = 'r'): AuditClaim => ({
  claim,
  verdict,
  reason,
});

describe('crossValidate', () => {
  it('matches the same claim across judges despite truncation and punctuation drift', () => {
    // The real drift between two judges quoting the same sentence: one truncates.
    expect(
      claimSimilarity('该标准于 1998 年发布，适用于全部工况', '该标准于1998年发布'),
    ).toBeGreaterThan(0.6);
    expect(claimSimilarity('电压等于电流乘以电阻', '光合作用发生在叶绿体')).toBeLessThan(0.2);
  });

  it('settles agreement as consensus and raises no dispute', () => {
    const { claims, disputes } = crossValidate(
      [c('电压等于电流乘以电阻', 'supported')],
      [c('电压等于电流乘以电阻。', 'supported')],
    );
    expect(disputes).toHaveLength(0);
    expect(claims[0].decidedBy).toBe('consensus');
  });

  it('disputes a split, provisionally keeping the stricter verdict', () => {
    const { claims, disputes } = crossValidate(
      [c('该标准于 1998 年发布', 'incorrect')],
      [c('该标准于 1998 年发布', 'uncertain')],
    );
    expect(disputes).toHaveLength(1);
    expect(claims[0].verdict).toBe('incorrect');
    expect(claims[0].decidedBy).toBeUndefined();
    expect(disputes[0].judgeVerdicts).toEqual(['审核智能体甲 → 有误', '审核智能体乙 → 存疑']);
  });

  it('treats a unilateral flag as a dispute but an uncontested supported claim as consensus', () => {
    const { claims, disputes } = crossValidate(
      [c('甲说法', 'incorrect'), c('乙说法', 'supported')],
      [],
    );
    expect(disputes).toHaveLength(1);
    expect(claims[disputes[0].at].claim).toBe('甲说法');
    expect(claims[1].decidedBy).toBe('consensus');
  });

  it('drops a judge’s duplicate cut of an already-matched claim', () => {
    const { claims } = crossValidate(
      [c('铜的电阻率随温度升高而增大，因此导线电阻会上升', 'uncertain')],
      [
        c('铜的电阻率随温度升高而增大，因此导线电阻会上升', 'uncertain'),
        c('铜的电阻率随温度升高而增大', 'uncertain'),
      ],
    );
    expect(claims).toHaveLength(1);
  });
});

describe('auditSceneContent debate', () => {
  const content = { type: 'slide', text: '该标准于 1998 年发布，适用于全部工况。' };

  it('single judge behaves exactly as before — no debate trail', async () => {
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCall: async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'supported')] }),
      judgeModel: 'j1',
    });
    expect(audit.debate).toBeUndefined();
    expect(audit.verdict).toBe('pass');
  });

  it('arbiter overturns a false red, so no revision runs', async () => {
    let revised = false;
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCalls: [
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'incorrect')] }),
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'supported')] }),
      ],
      arbiterCall: async () =>
        JSON.stringify({
          rulings: [
            { index: 1, verdict: 'supported', rationale: '资料 S1 明载', sourceIds: ['S1'] },
          ],
        }),
      reviseCall: async () => {
        revised = true;
        return JSON.stringify({ defenses: [{ index: 1, stance: 'rebut', argument: '有资料' }] });
      },
      judgeModel: 'j1',
      judgeModels: ['j1', 'j2'],
      arbiterModel: 'arb',
    });
    expect(audit.debate).toHaveLength(1);
    expect(audit.debate?.[0].arbiterVerdict).toBe('supported');
    expect(audit.claims[0].decidedBy).toBe('arbitration');
    expect(audit.claims[0].sourceIds).toEqual(['S1']);
    expect(audit.sources).toBeUndefined();
    expect(audit.incorrectCount).toBe(0);
    // reviseCall was used for the defense round only — never for a rewrite.
    expect(revised).toBe(true);
    expect(audit.rounds).toBe(1);
  });

  it('reports an unresolved dispute honestly when no arbiter is configured', async () => {
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCalls: [
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'uncertain')] }),
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'supported')] }),
      ],
      judgeModel: 'j1',
    });
    expect(audit.debate?.[0].arbiterVerdict).toBe('unresolved');
    expect(audit.claims[0].decidedBy).toBeUndefined();
    expect(audit.claims[0].verdict).toBe('uncertain');
  });

  it('does not swallow a configured evidence-gate failure during claim rescue', async () => {
    await expect(
      auditSceneContent({
        sceneTitle: 't',
        content,
        judgeCall: async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'uncertain')] }),
        judgeModel: 'j1',
        retrieveForClaim: async () => {
          throw new EvidenceGateError('证据检索桥不可达');
        },
      }),
    ).rejects.toThrow('证据检索桥不可达');
  });

  it('binds abbreviated citations to the real evidence pool and drops unknown ones', async () => {
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCall: async () =>
        JSON.stringify({
          claims: [
            { ...c('甲', 'supported'), sourceIds: ['s5', 'ag020#s3', '不存在的来源'] },
            { ...c('乙说法与甲说法完全不同无关', 'supported'), sourceIds: ['不存在的来源'] },
          ],
        }),
      judgeModel: 'j1',
      sources: [
        { source_id: 'ag020#s5', title: '安全防护' },
        { source_id: 'ag020#s3', title: '合规保障' },
      ],
    });
    expect(audit.claims[0].sourceIds).toEqual(['ag020#s5', 'ag020#s3']);
    expect(audit.claims[1].sourceIds).toBeUndefined();
    expect(audit.sources).toHaveLength(2);
  });

  it('survives one judge throwing — the other judge still decides the round', async () => {
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCalls: [
        async () => {
          throw new Error('429 rate limited');
        },
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'supported')] }),
      ],
      judgeModel: 'j1',
      judgeModels: ['j1', 'j2'],
    });
    expect(audit.verdict).toBe('pass');
    expect(audit.totalClaims).toBe(1);
    expect(audit.debate).toBeUndefined();
  });

  it('re-audit replaces the debate trail instead of stacking rounds', async () => {
    // Round 1 splits and the arbiter confirms an error → rewrite → round 2 agrees.
    // The shipped claims are round 2's, so the trail must be round 2's too:
    // a stacked trail would report disputes over text that no longer exists.
    let round = 0;
    const judge = (first: AuditClaim['verdict']) => async () => {
      const v = round === 0 ? first : 'supported';
      return JSON.stringify({ claims: [c('该标准于 1998 年发布', v)] });
    };
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCalls: [judge('incorrect'), judge('uncertain')],
      arbiterCall: async () =>
        JSON.stringify({ rulings: [{ index: 1, verdict: 'incorrect', fix: '1999 年' }] }),
      reviseCall: async (system) => {
        if (system.includes('答辩')) return JSON.stringify({ defenses: [] });
        round = 1;
        return JSON.stringify({ ...content, text: '该标准于 1999 年发布。' });
      },
      judgeModel: 'j1',
    });
    expect(audit.rounds).toBe(2);
    expect(audit.verdict).toBe('revised');
    expect(audit.debate).toEqual([]);
  });

  /**
   * 源头脱敏（ACCEPTANCE 第四批遗留第 1 条）。
   *
   * 以前 judgeVerdicts 拼的是 `options.judgeModels` 的原串，四个渲染点各自过
   * `maskJudgeVerdict` 兜住——加第五个渲染点就会漏。现在源头写的就是面板称谓，
   * 这条测试盯的是「写入的字符串里不含模型串」，不是「渲染时被抹掉了」。
   */
  it('never writes the model id into the debate trail, even when judgeModels are real ids', async () => {
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCalls: [
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'incorrect')] }),
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'supported')] }),
      ],
      judgeModel: 'siliconflow:Qwen/Qwen3.6-35B-A3B',
      judgeModels: ['siliconflow:Qwen/Qwen3.6-35B-A3B', 'deepseek-ai/DeepSeek-V3.2'],
      arbiterModel: 'zai-org/GLM-4.5-Air',
    });
    const trail = JSON.stringify(audit.debate?.[0].judgeVerdicts);
    expect(trail).not.toMatch(/Qwen|DeepSeek|GLM|siliconflow/i);
    expect(audit.debate?.[0].judgeVerdicts).toEqual(['审核智能体甲 → 有误', '审核智能体乙 → 核实']);
  });

  it('records an empty trail when both judges agree on everything', async () => {
    const { audit } = await auditSceneContent({
      sceneTitle: 't',
      content,
      judgeCalls: [
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'supported')] }),
        async () => JSON.stringify({ claims: [c('该标准于 1998 年发布', 'supported')] }),
      ],
      judgeModel: 'j1',
    });
    expect(audit.debate).toEqual([]);
  });
});
