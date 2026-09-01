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
 * 开跑前的判断必须把「本机没配检索」和「已配置的检索桥失败」分开——
 * 前者拦车会让本地开发跑不动，后者静默放行就会产出零据课。
 *
 * 下面钉的就是这条分界：未配置保持本地开发语义；一旦配置，零命中或桥失败都拦。
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

  it('已配置时探针异常必须明确拦车', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const reason = await zeroEvidenceReason('检索增强怎么减少幻觉', 'ai');
    expect(reason).toContain('检索服务调用异常');
    expect(reason).toContain('本次生成已停止');
  });

  it('已配置时探针拿到非 200 必须明确拦车', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const reason = await zeroEvidenceReason('检索增强怎么减少幻觉', 'ai');
    expect(reason).toContain('HTTP 503');
    expect(reason).toContain('本次生成已停止');
  });

  it('空需求不探，直接放行', async () => {
    mockFetch.mockResolvedValue(evidenceResponse(0));
    expect(await zeroEvidenceReason('   ', 'ai')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('已配置检索桥的响应契约', () => {
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

  it('回包里没有 data.chunks 时按非法响应拦车', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const reason = await zeroEvidenceReason('教会我 RAG', 'ai');
    expect(reason).toContain('响应格式无效');
    expect(reason).toContain('本次生成已停止');
  });

  it('data 在但 chunks 不是数组时按非法响应拦车', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { chunks: null } }),
    });
    expect(await zeroEvidenceReason('教会我 RAG', 'ai')).toContain('响应格式无效');
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
