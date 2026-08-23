/**
 * 数字断言的正则旁路。
 *
 * 判官既是抽取器也是判定器，而**抽取这一步此前没有兜底**：它没抽到的断言，
 * 后面整条链都碰不到——看起来是「这一屏没问题」，实际是「这一屏没被看过」。
 * 数字尤其吃亏，它常嵌在条件从句里，抽取器倾向把整句压成一条概念性断言。
 *
 * 旁路补进来的一律弃权（uncertain），永不判 incorrect：只知道这里有个数、
 * 不知道它对不对，判错会触发修订环去改一个可能本来正确的参数。
 */
import { describe, expect, it } from 'vitest';

import {
  extractNumericClaims,
  hasCounterpart,
  mergeNumericBypass,
} from '@/lib/generation/numeric-claims';

type C = { claim: string; verdict: string; reason: string };
const make = (claim: string, reason: string): C => ({ claim, verdict: 'uncertain', reason });

describe('抽数字断言', () => {
  it('带单位的数字才算，裸数字不算', () => {
    const got = extractNumericClaims('第 3 章讲定时器。默认阈值是 150ms。');
    expect(got).toHaveLength(1);
    expect(got[0].numbers).toEqual(['150ms']);
  });

  it('条件从句整句进池，不许只留数字', () => {
    const [got] = extractNumericClaims('超过 150ms 就会触发停机保护。');
    expect(got.conditional).toBe(true);
    expect(got.claim).toContain('超过');
    expect(got.claim).toContain('停机');
  });

  it('一次推演里配套的数字算一条——拆开每个都判不了', () => {
    const got = extractNumericClaims('任务占 80ms，留 70ms 余量，所以阈值设 150ms。');
    expect(got).toHaveLength(1);
    expect(got[0].numbers).toEqual(['80ms', '70ms', '150ms']);
  });

  it('多种量纲都收', () => {
    const got = extractNumericClaims('电压 380V。温度 -18℃。转速 1500rpm。占比 12%。');
    expect(got).toHaveLength(4);
  });

  it('没有数字的文本不产出', () => {
    expect(extractNumericClaims('定时器用于延时控制，属于基本指令。')).toEqual([]);
  });
});

describe('第二层：领域计量词 + 参数语境闸', () => {
  it('有参数语境才收计量词', () => {
    // 扰动集里漏掉的 21 条全是这一类，物理单位表够不着
    const got = extractNumericClaims('上下文窗口默认设为 20 轮。');
    expect(got).toHaveLength(1);
    expect(got[0].numbers).toContain('20轮');
  });

  it('没有参数语境就不收——「举 3 个例子」满篇都是', () => {
    expect(extractNumericClaims('下面举 3 个例子来说明。')).toEqual([]);
    expect(extractNumericClaims('这一节分 4 步讲。')).toEqual([]);
  });

  it('闸是量出来要留的，不是凭感觉加的', () => {
    // 1704 块主语料 42676 句：带闸比只收物理单位多抓 19 句，不带闸多抓 325 句。
    // 这条盯住闸别被人删掉——删了误报涨 17 倍，而检出率涨不了多少。
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/generation/numeric-claims.ts'),
      'utf-8',
    );
    expect(src).toContain('PARAM_CONTEXT.test(sentence)');
    expect(src).toContain('+19');
  });

  it('物理单位不受闸限制——它本身就够特异', () => {
    expect(extractNumericClaims('这里随口提一句 150ms。')).toHaveLength(1);
  });
});

describe('弃权策略', () => {
  const claim = { claim: '阈值 150ms', numbers: ['150ms'], conditional: false };

  it('资料里有同一个数值单位才算有对照', () => {
    expect(hasCounterpart(claim, '出厂默认 150ms，可在参数页修改。')).toBe(true);
    expect(hasCounterpart(claim, '出厂默认 300ms。')).toBe(false);
    expect(hasCounterpart(claim, undefined)).toBe(false);
  });

  it('查无对照时补进来的那条明说自己弃权了', () => {
    const out = mergeNumericBypass([], '阈值设成 150ms 即可。', undefined, make);
    expect(out.added).toBe(1);
    expect(out.abstained).toBe(1);
    expect(out.claims[0].verdict).toBe('uncertain');
    expect(out.claims[0].reason).toContain('弃权');
    expect(out.claims[0].reason).toContain('不等于');
  });

  it('永远不判 incorrect——这是这条旁路的底线', () => {
    const out = mergeNumericBypass([], '阈值 999ms，电压 380V，温度 -18℃。', '完全无关的资料', make);
    expect(out.claims.every((c) => c.verdict === 'uncertain')).toBe(true);
  });
});

describe('与判官的分工', () => {
  it('判官已经抽到同一组数字就不重复补', () => {
    const judged = [{ claim: '默认阈值是 150ms', verdict: 'supported', reason: '' }];
    const out = mergeNumericBypass(judged, '默认阈值是 150ms。', '150ms', make);
    expect(out.added).toBe(0);
    expect(out.claims).toHaveLength(1);
  });

  it('判官漏掉的那条补进来，抽到的那条原样保留', () => {
    const judged = [{ claim: '默认阈值是 150ms', verdict: 'supported', reason: '有依据' }];
    const out = mergeNumericBypass(
      judged,
      '默认阈值是 150ms。电压必须是 380V。',
      '150ms 380V',
      make,
    );
    expect(out.added).toBe(1);
    expect(out.claims[0].verdict).toBe('supported'); // 判官那条不动
    expect(out.claims[1].claim).toContain('380V');
  });

  it('带条件的补入项在理由里标出来——它比裸数字更该被人看一眼', () => {
    const out = mergeNumericBypass([], '一旦超过 150ms 就停机。', undefined, make);
    expect(out.claims[0].reason).toContain('带条件从句');
  });
});

describe('真的接进判官链了', () => {
  it('runJudge 用了旁路，且提示词里写了数字拆条口径', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/generation/hallucination-audit.ts'),
      'utf-8',
    );
    expect(src).toContain('mergeNumericBypass');
    // 域适配那三条硬要求
    expect(src).toContain('条件从句不许剥离');
    expect(src).toContain('阈值、单位、参数-后果各自成条');
  });
});
