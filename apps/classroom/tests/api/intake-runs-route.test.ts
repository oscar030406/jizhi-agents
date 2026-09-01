/**
 * POST /api/knowledge/intake-runs：发起接入的桥。
 *
 * 三件事必须钉住：
 *
 * ① **角色闸**——引擎那边没有角色系统，manager 只在这一层拦。
 *
 * ② **不解析请求体，流式转发**。2026-08-22 验收第四坎：桥原本 `await req.formData()`
 *    把表单读进内存、再交给 fetch 重新序列化，393MB 的包在 4G 机器上至少两份副本，
 *    进程被内核干掉（`status=9/KILL`、`Failed with result 'oom-kill'`），
 *    nginx 拿不到 upstream 响应，管理者看到 502。
 *    现在 `body: req.body` 直接透传。**这条性质一旦被后人「顺手改回 FormData」
 *    就会重演那次 OOM，而且只有大包才现形**——所以这里锁死。
 *
 * ③ **multipart 边界跟着走**：`content-type` 必须原样带给引擎，否则它认不出分段。
 *
 * 原先这个文件还锁「库名为空本层退回」「三种投料都空才拦」——那两项校验随
 * ② 一起删了：它们要求先解析表单，而引擎本来就要判同样的东西。少一处第二真源。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let role: string | null = 'manager';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'session-token' }) }),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountsEnabled: () => true,
  accountForSession: vi.fn(async () =>
    role ? { id: 'acc_1', username: 'u', displayName: 'u', role } : null,
  ),
}));

const orgMocks = vi.hoisted(() => ({
  orgForAccount: vi.fn(),
  setCorpusOrg: vi.fn(),
}));

vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: orgMocks.orgForAccount,
  setCorpusOrg: orgMocks.setCorpusOrg,
}));

const engineFetch = vi.fn();

function request(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('files', new File(['# 标题\n\n正文'], 'a.md', { type: 'text/markdown' }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost/api/knowledge/intake-runs', {
    method: 'POST',
    headers: fields.corpus ? { 'x-jizhi-corpus': fields.corpus } : undefined,
    body: form,
  }) as unknown as NextRequest;
}

async function post(req: NextRequest) {
  const { POST } = await import('@/app/api/knowledge/intake-runs/route');
  return POST(req);
}

describe('POST /api/knowledge/intake-runs', () => {
  beforeEach(() => {
    role = 'manager';
    process.env.GROUNDING_URL = 'http://engine.local';
    process.env.GROUNDING_TOKEN = 'probe-token';
    engineFetch.mockReset();
    orgMocks.orgForAccount.mockReset();
    orgMocks.setCorpusOrg.mockReset();
    orgMocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });
    orgMocks.setCorpusOrg.mockResolvedValue({ ok: true });
    engineFetch.mockResolvedValue(
      new Response(JSON.stringify({ run_id: '20260816T101010-abcdef' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', engineFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GROUNDING_URL;
  });

  it('非 manager 一律 403，且不碰引擎', async () => {
    role = 'learner';
    const resp = await post(request({ corpus: 'probe' }));
    expect(resp.status).toBe(403);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('转给引擎的是请求流本身，不是解析后的 FormData', async () => {
    const req = request({ corpus: 'probe', trial_run: 'true' });
    const resp = await post(req);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ run: { run_id: '20260816T101010-abcdef' } });

    const [url, init] = engineFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://engine.local/api/domain-intake/runs');

    // 这是本文件的核心断言：body 是流，不是 FormData。
    // 变回 FormData 就意味着整包又进内存了——那次 OOM 的直接原因。
    expect(init.body).not.toBeInstanceOf(FormData);
    expect(init.body).toBe(req.body);
  });

  it('multipart 边界与内部令牌都带给引擎', async () => {
    await post(request({ corpus: 'probe' }));
    const headers = (engineFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-internal-token']).toBe('probe-token');
    expect(headers['x-jizhi-corpus']).toBe('probe');
    // content-type 里带着 boundary=...，丢了引擎就切不出分段
    expect(headers['content-type']).toMatch(/multipart\/form-data;\s*boundary=/);
  });

  it('流式请求体必须声明 duplex，否则 Node fetch 运行时直接抛', async () => {
    await post(request({ corpus: 'probe' }));
    const init = engineFetch.mock.calls[0][1] as RequestInit & { duplex?: string };
    expect(init.duplex).toBe('half');
  });

  it('引擎的报错原样透传，不在桥这层改写', async () => {
    engineFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: '这份投料里没有任何可读文档' }), { status: 400 }),
    );
    const resp = await post(request({ corpus: 'probe' }));
    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ error: '这份投料里没有任何可读文档' });
  });

  it('他机构已认领的库在上传前拒绝', async () => {
    orgMocks.setCorpusOrg.mockResolvedValue({ ok: false, message: '该知识库已归属其他机构' });
    const resp = await post(request({ corpus: 'private-b' }));
    expect(resp.status).toBe(403);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('引擎不可达时回 502 并说清没发起', async () => {
    engineFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const resp = await post(request({ corpus: 'probe' }));
    expect(resp.status).toBe(502);
    expect((await resp.json()).error).toContain('没有发起');
  });
});
