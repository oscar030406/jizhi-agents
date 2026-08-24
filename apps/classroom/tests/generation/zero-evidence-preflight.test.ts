/**
 * 检索零命中就别开跑：开跑前问一句，不出零据课。
 *
 * ## 为什么要这道闸
 *
 * 2026-08-23 ③ 跨域三联实测：一条领域中性的需求（「给零基础新人的入门第一课」）
 * 在 ai / smart-manufacturing / iotdb **三个库里检索全部返回空**，
 * 产品照样生成了三门通用 Python 课——证据块 0、所有屏 `grounded: false`、
 * 判官盲猜领域 0/3。记录是诚实的（`grounded:false` 落了盘），
 * 但学习者拿到的是一门看起来正常、却跟所选库毫无关系的课。
 *
 * ## 为什么不复用 fetchEvidence
 *
 * `fetchEvidence` 把四种情况**全返回 `null`**：没配 `GROUNDING_URL`、请求失败、
 * 零命中、引擎判「证据不足」。对生成主路径这样是对的（四种都该降级成裸生成、别拦车），
 * 但开跑前的判断必须把「本机没配检索」和「这个库真查不到」分开——
 * 前者拦车会让本地开发跑不动，后者不拦车就产出零据课。
 *
 * 下面钉的就是这条分界：**只有确实零命中才拦**，其余一律放行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { zeroEvidenceReason } from '@/lib/generation/evidence-grounding';

const OLD_URL = process.env.GROUNDING_URL;
const mockFetch = vi.fn();

function evidenceResponse(chunkCount: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: { chunks: Array.from({ length: chunkCount }, (_, i) => ({ source_id: `x#s${i}` })) },
    }),
  };
}

describe('开跑前的零命中闸', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    process.env.GROUNDING_URL = 'http://127.0.0.1:8001';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (OLD_URL === undefined) delete process.env.GROUNDING_URL;
    else process.env.GROUNDING_URL = OLD_URL;
  });

  it('检索有命中就放行', async () => {
    mockFetch.mockResolvedValue(evidenceResponse(6));
    expect(await zeroEvidenceReason('检索增强怎么减少幻觉', 'ai')).toBeNull();
  });

  it('确实零命中才拦车，理由要说清出路', async () => {
    mockFetch.mockResolvedValue(evidenceResponse(0));
    const reason = await zeroEvidenceReason('红烧肉的火候', 'iotdb');
    expect(reason).toBeTruthy();
    expect(reason).toContain('iotdb');
    expect(reason).toContain('0 命中');
    // 拦了要给出路，不能只说「不行」。
    expect(reason).toMatch(/换一个库|换个库/);
  });

  it('没配 GROUNDING_URL 一律放行——本地开发常态，拦了就跑不动', async () => {
    delete process.env.GROUNDING_URL;
    mockFetch.mockResolvedValue(evidenceResponse(0));
    expect(await zeroEvidenceReason('随便什么需求', 'ai')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('探针自身失败放行，不因一次网络抖动挡住生成', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    expect(await zeroEvidenceReason('检索增强怎么减少幻觉', 'ai')).toBeNull();
  });

  it('探针拿到非 200 也放行——拦车的理由必须是「查过、确实没有」', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await zeroEvidenceReason('检索增强怎么减少幻觉', 'ai')).toBeNull();
  });

  it('空需求不探，直接放行', async () => {
    mockFetch.mockResolvedValue(evidenceResponse(0));
    expect(await zeroEvidenceReason('   ', 'ai')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('拦车的理由必须是「查过、确实没有」', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    process.env.GROUNDING_URL = 'http://127.0.0.1:8001';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (OLD_URL === undefined) delete process.env.GROUNDING_URL;
    else process.env.GROUNDING_URL = OLD_URL;
  });

  it('回包里没有 data.chunks 这个键就放行——读不懂 ≠ 零命中', async () => {
    // 一版写成 `chunks?.length ?? 0`，把缺字段当零命中，
    // 当场误拦了一条只想验元数据落库的用例。误拦的代价是用户生成不了。
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    expect(await zeroEvidenceReason('教会我 RAG', 'ai')).toBeNull();
  });

  it('data 在但 chunks 不是数组也放行', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { chunks: null } }),
    });
    expect(await zeroEvidenceReason('教会我 RAG', 'ai')).toBeNull();
  });

  it('明确拿到空数组才拦', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { chunks: [] } }),
    });
    expect(await zeroEvidenceReason('教会我 RAG', 'ai')).toBeTruthy();
  });
});
