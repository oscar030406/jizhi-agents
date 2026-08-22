import { describe, expect, it, vi } from 'vitest';
import type { SceneAudit } from '@/lib/generation/hallucination-audit';

// The module under test pulls the whole browser generation stack; stub the
// side-effectful leaves so a pure helper can be imported in node.
vi.mock('@/lib/utils/database', () => ({ db: { audioFiles: { put: vi.fn() } } }));

function audit(over: Partial<SceneAudit>): SceneAudit {
  return {
    verdict: 'pass',
    claims: [],
    totalClaims: 0,
    flaggedCount: 0,
    uncertainCount: 0,
    incorrectCount: 0,
    judgeModel: 'judge',
    rounds: 1,
    durationMs: 10,
    decision: 'publish',
    rationale: 'ok',
    grounded: false,
    evidenceCount: 0,
    ...over,
  };
}

describe('mergeAudits (content audit + speech audit → one badge)', () => {
  it('takes the worse verdict/decision and recounts the merged claims', async () => {
    const { mergeAudits } = await import('@/lib/hooks/use-scene-generator');
    const merged = mergeAudits(
      audit({
        verdict: 'pass',
        decision: 'publish',
        claims: [{ claim: 'slide claim', verdict: 'supported', reason: '资料支持' }],
        totalClaims: 1,
        grounded: true,
        evidenceCount: 6,
      }),
      audit({
        verdict: 'flagged',
        decision: 'block_pending_review',
        rounds: 2,
        durationMs: 40,
        claims: [
          { claim: 'spoken claim', verdict: 'incorrect', reason: '与资料相悖' },
          { claim: 'another', verdict: 'uncertain', reason: '资料未覆盖' },
        ],
        totalClaims: 2,
      }),
    );

    expect(merged.verdict).toBe('flagged');
    expect(merged.decision).toBe('block_pending_review');
    expect(merged.totalClaims).toBe(3);
    expect(merged.flaggedCount).toBe(2);
    expect(merged.incorrectCount).toBe(1);
    expect(merged.uncertainCount).toBe(1);
    expect(merged.rounds).toBe(3);
    expect(merged.durationMs).toBe(50);
    // Grounding of the content audit survives; speech claims are labelled.
    expect(merged.grounded).toBe(true);
    expect(merged.evidenceCount).toBe(6);
    expect(merged.claims[1].reason.startsWith('[讲稿]')).toBe(true);
    expect(merged.claims[0].reason).toBe('资料支持');
  });

  it('keeps a clean content verdict when the script is clean too', async () => {
    const { mergeAudits } = await import('@/lib/hooks/use-scene-generator');
    const merged = mergeAudits(
      audit({ verdict: 'caveat', decision: 'publish_with_warnings' }),
      audit({ verdict: 'pass', decision: 'publish' }),
    );
    expect(merged.verdict).toBe('caveat');
    expect(merged.decision).toBe('publish_with_warnings');
  });

  it('falls back to the speech audit alone when content was never audited', async () => {
    const { mergeAudits } = await import('@/lib/hooks/use-scene-generator');
    const merged = mergeAudits(
      undefined,
      audit({ claims: [{ claim: 'x', verdict: 'uncertain', reason: '资料未覆盖' }] }),
    );
    expect(merged.claims[0].reason).toBe('[讲稿] 资料未覆盖');
  });
});
