/**
 * /api/skills 的分域取数（WO-3）。
 *
 * 这条路由此前不带域问引擎，回来的永远是主域岗位；学习端只能在浏览器里靠画像
 * 猜一句「你是外域」把图谱藏掉——绕过页面直取接口，拿到的仍是整张 AI 岗位图谱。
 *
 * 三件事钉在这里：域要原样带给引擎；引擎说「这个域没登记岗位数据」（jobs 空 +
 * reason）是答案不是失败，不许当 204 吞掉；进程内兜底按域分桶，A 域的数据不能
 * 当 B 域的答案回出去。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const MAIN = {
  provenance: {},
  market_stats: {},
  jobs: [{ job_id: 'j1', title: '大模型应用工程师', summary: '', core_concepts: [], skills: [], covered_count: 0 }],
  corpora: [{ corpus: 'ai', available: true, chunk_count: 1, index_path: 'x' }],
  coverage_rule: '',
};

const EMPTY = {
  ...MAIN,
  jobs: [],
  domain: 'manufacturing',
  reason: '该领域尚未登记岗位要求数据（接入时未提供岗位/技能清单）',
};

/** 引擎侧的应答桩：按请求 URL 决定给什么。返回记录下来的调用 URL 列表。 */
function stubEngine(reply: (url: string) => { ok: boolean; body?: unknown }) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seen.push(String(url));
      const r = reply(String(url));
      if (!r.ok) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ data: r.body }) } as Response;
    }),
  );
  return seen;
}

async function get(query: string) {
  process.env.GROUNDING_URL = 'http://engine.test';
  const { GET } = await import('@/app/api/skills/route');
  return GET(new Request(`http://localhost/api/skills${query}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules(); // 路由的兜底表是模块级的，用例之间不共享
});

describe('/api/skills 分域', () => {
  it('把 domain 原样带给引擎', async () => {
    const seen = stubEngine(() => ({ ok: true, body: MAIN }));
    await get('?domain=manufacturing');
    expect(seen[0]).toContain('/internal/v1/personalize/skill-map?domain=manufacturing');
  });

  it('corpus 是同义参数', async () => {
    const seen = stubEngine(() => ({ ok: true, body: MAIN }));
    await get('?corpus=iotdb');
    expect(seen[0]).toContain('skill-map?domain=iotdb');
  });

  it('空 jobs + reason 原样带出，不当失败吞掉', async () => {
    stubEngine(() => ({ ok: true, body: EMPTY }));
    const resp = await get('?domain=manufacturing');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { jobs: unknown[]; reason: string; domain: string };
    expect(body.jobs).toHaveLength(0);
    expect(body.reason).toBe(EMPTY.reason);
    expect(body.domain).toBe('manufacturing');
  });

  it('既没岗位也没理由才算没取到', async () => {
    stubEngine(() => ({ ok: true, body: { ...MAIN, jobs: [] } }));
    expect((await get('?domain=x')).status).toBe(204);
  });

  it('兜底按域分桶：A 域的数据不给 B 域当答案', async () => {
    stubEngine((url) => (url.includes('domain=ai') ? { ok: true, body: MAIN } : { ok: false }));
    expect((await get('?domain=ai')).status).toBe(200);
    // 引擎这时对 manufacturing 挂了，没有该域的历史成功数据 → 如实空手，不冒充 ai
    expect((await get('?domain=manufacturing')).status).toBe(204);
  });
});
