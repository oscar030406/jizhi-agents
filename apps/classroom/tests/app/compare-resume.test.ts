import { describe, expect, it } from 'vitest';

import { isRealDiff, resumeDecision } from '@/app/compare/report';

/**
 * 同题异人对比：刷新后接回在飞的 job。
 *
 * 起因：引擎跑完一次对比要 3-5 分钟，而 jobId 原先只活在 submit 的闭包里。
 * 用户一刷新页面，**服务端那次运行其实还在后台跑完了**（job 存 globalThis，TTL 2 小时），
 * 但前端再也找不回来，只能从头再跑一遍 3-5 分钟。
 *
 * 这里测的是拿到轮询响应之后的分支判断。四个分支里三个在顺利演示时都走不到，
 * 正是出错时最难发现的那几个。
 */

const twoEntries = { entries: [{ id: 'a' }, { id: 'b' }] } as never;

describe('resumeDecision', () => {
  it('已完成且结果完整 → 直接出报告，不用再等', () => {
    const d = resumeDecision({ status: 'succeeded', result: twoEntries }, true, 1000);
    expect(d.kind).toBe('ok');
  });

  it('running → 回到等待态，秒表起点按 elapsedMs 倒推', () => {
    const d = resumeDecision({ status: 'running', elapsedMs: 95_000 }, true, 1_000_000);
    expect(d).toEqual({ kind: 'loading', startedAt: 905_000 });
  });

  it('queued 同样接着等', () => {
    expect(resumeDecision({ status: 'queued', elapsedMs: 0 }, true, 500).kind).toBe('loading');
  });

  it('服务端没给 elapsedMs 时按「刚开始」算，不把起点算到未来', () => {
    const d = resumeDecision({ status: 'running' }, true, 777);
    expect(d).toEqual({ kind: 'loading', startedAt: 777 });
  });

  it('job 过期或不存在（HTTP 非 2xx）→ 丢掉，不弹错', () => {
    // 用户可能只是打开了一条旧链接，这种情况不该报错吓人
    expect(resumeDecision({ status: 'running' }, false, 0).kind).toBe('drop');
  });

  it('已失败 → 丢掉', () => {
    expect(resumeDecision({ status: 'failed' }, true, 0).kind).toBe('drop');
  });

  it('声称成功但结果不完整 → 丢掉，不拿半份报告糊弄', () => {
    expect(resumeDecision({ status: 'succeeded', result: { entries: [] } }, true, 0).kind).toBe(
      'drop',
    );
    expect(
      resumeDecision({ status: 'succeeded', result: { entries: [{ id: 'a' }] } as never }, true, 0)
        .kind,
    ).toBe('drop');
  });
});

/**
 * 「两列不同」的标记只允许标真差异。
 *
 * 踩过的坑：引擎某一维没返回时该列渲染的是「未返回」，跟另一列的真实值一比必然不同，
 * 标记就打在「未返回」三个字上——把数据缺口标成了个性化差异。
 */
describe('isRealDiff', () => {
  it('两边都有值且不同 → 标', () => {
    expect(isRealDiff('L1', 'L2')).toBe(true);
    expect(isRealDiff('full', 'minimal')).toBe(true);
  });

  it('两边相同 → 不标', () => {
    expect(isRealDiff('L2', 'L2')).toBe(false);
  });

  it('任一边缺值（显示「未返回」）→ 不标', () => {
    expect(isRealDiff('L1', undefined)).toBe(false);
    expect(isRealDiff(undefined, 'L1')).toBe(false);
    expect(isRealDiff('L1', '')).toBe(false);
    expect(isRealDiff('', 'L1')).toBe(false);
    expect(isRealDiff(undefined, undefined)).toBe(false);
  });
});
