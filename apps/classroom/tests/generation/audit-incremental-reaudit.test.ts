/**
 * 增量复审（WO-N9，`INCREMENTAL_REAUDIT`）的零成本自检：假判官驱动，不打 API。
 *
 * 从实验台 `审核架构实验/harness/selfcheck.ts` 搬过来的五条断言，加一条开关对照。
 * 每一条坏了都会让「第二轮只审改动段」这件事悄悄失效或判错，而端到端跑一次要
 * 十几分钟才发现。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditSceneContent } from '@/lib/generation/hallucination-audit';

const ORIGINAL = {
  elements: [
    { type: 'text', content: '光伏组串式逆变器每季度执行一次 IV 曲线扫描。' },
    { type: 'text', content: '扫描前必须强制退出 MPPT 最大功率点跟踪状态。' },
    { type: 'text', content: '直流侧绝缘阻抗低于 1 兆欧时应当立即停机检修。' },
  ],
};
const REVISED = {
  elements: [
    { type: 'text', content: '光伏组串式逆变器每季度执行一次 IV 曲线扫描。' },
    { type: 'text', content: '扫描前必须强制退出 MPPT 最大功率点跟踪状态。' },
    { type: 'text', content: '直流侧绝缘阻抗低于 1 兆欧时应当记录并安排检修。' },
  ],
};

/** 第一轮：三条断言，第三条判错；第二轮：只对喂进来的文本出 supported。 */
function fakeJudge(sink: string[]) {
  return async (_system: string, user: string) => {
    sink.push(user);
    const isRound1 = user.includes('每季度执行一次') && user.includes('绝缘阻抗');
    if (isRound1) {
      return JSON.stringify({
        claims: [
          {
            claim: '光伏组串式逆变器每季度执行一次 IV 曲线扫描。',
            verdict: 'supported',
            reason: 'r1',
          },
          {
            claim: '扫描前必须强制退出 MPPT 最大功率点跟踪状态。',
            verdict: 'uncertain',
            reason: 'r2',
          },
          {
            claim: '直流侧绝缘阻抗低于 1 兆欧时应当立即停机检修。',
            verdict: 'incorrect',
            reason: 'r3',
            fix: '改成记录并安排检修',
          },
        ],
      });
    }
    return JSON.stringify({
      claims: [
        {
          claim: '直流侧绝缘阻抗低于 1 兆欧时应当记录并安排检修。',
          verdict: 'supported',
          reason: '二轮',
        },
      ],
    });
  };
}

const revise = async (_s: string, u: string) =>
  u.includes('场景内容 JSON') ? JSON.stringify(REVISED) : JSON.stringify({ defenses: [] });

const panel = (sink: string[]) => ({
  sceneTitle: '光伏运维',
  judgeCalls: [fakeJudge(sink), fakeJudge(sink)],
  arbiterCall: async () => JSON.stringify({ rulings: [] }),
  reviseCall: revise,
  judgeModel: 'fake',
  judgeModels: ['fake', 'fake'],
  arbiterModel: 'fake',
});

/** 第二轮的判官输入 = 不含第一句的那些（第一句只在整页里出现）。 */
const round2 = (sink: string[]) => sink.filter((u) => !u.includes('每季度执行一次'));

afterEach(() => vi.unstubAllEnvs());

describe('增量复审（INCREMENTAL_REAUDIT=1）', () => {
  it('未改段沿用一轮判定，改动段换成二轮判定，且判官只看到改动段', async () => {
    vi.stubEnv('INCREMENTAL_REAUDIT', '1');
    const sink: string[] = [];
    const { audit } = await auditSceneContent({ ...panel(sink), content: ORIGINAL });

    expect(audit.rounds).toBe(2);
    const inputs = round2(sink);
    expect(inputs.length).toBeGreaterThan(0);
    // 4：第二轮判官不该再看到未改动的第一句——那正是全量重审的浪费
    expect(inputs.every((u) => u.includes('记录并安排检修'))).toBe(true);

    const verdicts = Object.fromEntries(audit.claims.map((c) => [c.claim, c.verdict]));
    // 1：未改段沿用一轮判定
    expect(verdicts['光伏组串式逆变器每季度执行一次 IV 曲线扫描。']).toBe('supported');
    expect(verdicts['扫描前必须强制退出 MPPT 最大功率点跟踪状态。']).toBe('uncertain');
    // 2：改动段的旧判定作废、被二轮判定替换（不能两条并存）
    expect(
      audit.claims.some((c) => c.claim.includes('记录并安排检修') && c.verdict === 'supported'),
    ).toBe(true);
    expect(audit.claims.some((c) => c.claim.includes('立即停机检修'))).toBe(false);
  });

  it('修订没动可见文本时，第二轮零调用', async () => {
    vi.stubEnv('INCREMENTAL_REAUDIT', '1');
    const sink: string[] = [];
    const { audit } = await auditSceneContent({
      ...panel(sink),
      content: ORIGINAL,
      reviseCall: async (_s, u) =>
        u.includes('场景内容 JSON') ? JSON.stringify(ORIGINAL) : JSON.stringify({ defenses: [] }),
    });
    // 3：可见文本没变 → 没有任何新东西可审 → 判官一次都不该被再调用
    expect(round2(sink)).toHaveLength(0);
    // 判错的断言没被改掉，仍应是 flagged
    expect(audit.verdict).toBe('flagged');
  });

  it('沿用断言若标着 arbitration，答辩记录必须跟着沿用', async () => {
    // 这是增量版新引入的不变量。基线第二轮整表替换，trail 与断言表天然同源；
    // 增量沿用了一轮判定，就必须把一轮的 trail 一起带过来，否则公共页会出现
    // 「仲裁了 N 条」但只列得出 M 条。
    vi.stubEnv('INCREMENTAL_REAUDIT', '1');
    const sink: string[] = [];
    const judgeB = async (_s: string, user: string) =>
      user.includes('每季度执行一次') && user.includes('绝缘阻抗')
        ? JSON.stringify({
            claims: [
              // 对第一句给出与判官甲不同的判定 → 形成分歧 → 走答辩仲裁
              {
                claim: '光伏组串式逆变器每季度执行一次 IV 曲线扫描。',
                verdict: 'uncertain',
                reason: '乙有异议',
              },
              {
                claim: '扫描前必须强制退出 MPPT 最大功率点跟踪状态。',
                verdict: 'uncertain',
                reason: 'r2',
              },
              {
                claim: '直流侧绝缘阻抗低于 1 兆欧时应当立即停机检修。',
                verdict: 'incorrect',
                reason: 'r3',
              },
            ],
          })
        : JSON.stringify({
            claims: [
              {
                claim: '直流侧绝缘阻抗低于 1 兆欧时应当记录并安排检修。',
                verdict: 'supported',
                reason: '二轮',
              },
            ],
          });

    const { audit } = await auditSceneContent({
      ...panel(sink),
      judgeCalls: [fakeJudge(sink), judgeB],
      arbiterCall: async () =>
        JSON.stringify({ rulings: [{ index: 1, verdict: 'supported', rationale: '仲裁认定成立' }] }),
      content: ORIGINAL,
    });

    const arbitrated = audit.claims.filter((c) => c.decidedBy === 'arbitration');
    // 先确认测的是要测的东西：这一组必须真的产生了仲裁判定
    expect(arbitrated.length).toBeGreaterThan(0);
    for (const c of arbitrated) {
      expect((audit.debate ?? []).some((d) => d.claim === c.claim)).toBe(true);
    }
  });
});

describe('开关关着时（默认）', () => {
  it('第二轮仍把整页重喂给判官，即旧行为一字不差', async () => {
    // .env.local 可能已开增量复审（2026-09-02 起本地默认开）；这条测的是关着时的基线
    vi.stubEnv('INCREMENTAL_REAUDIT', '0');
    const sink: string[] = [];
    const { audit } = await auditSceneContent({ ...panel(sink), content: ORIGINAL });
    expect(audit.rounds).toBe(2);
    const inputs = sink.filter((u) => u.includes('记录并安排检修'));
    expect(inputs.length).toBeGreaterThan(0);
    // 基线第二轮把整页（含未改段）重新喂一遍——这就是增量要砍掉的浪费
    expect(inputs.every((u) => u.includes('每季度执行一次'))).toBe(true);
  });
});
