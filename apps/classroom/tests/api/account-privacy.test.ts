import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  authenticate: vi.fn(),
  deleteAccount: vi.fn(),
  exportAccountData: vi.fn(),
  validateCredentials: vi.fn(() => ({ ok: true as const })),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountForSession: mocks.accountForSession,
  authenticate: mocks.authenticate,
  deleteAccount: mocks.deleteAccount,
  exportAccountData: mocks.exportAccountData,
  validateCredentials: mocks.validateCredentials,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const account = {
  id: 'acct-1',
  username: 'learner01',
  displayName: 'learner01',
  role: 'learner',
  createdAt: '2026-09-01T00:00:00.000Z',
};

function request(
  path: string,
  init: { method?: string; body?: BodyInit | null; headers?: HeadersInit } = {},
) {
  const headers = new Headers(init.headers);
  headers.set('cookie', 'jizhi_session=session-token');
  return new NextRequest(`http://localhost${path}`, { ...init, headers });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.accountForSession.mockResolvedValue(account);
  mocks.authenticate.mockResolvedValue(account);
  mocks.deleteAccount.mockResolvedValue({ ok: true });
  mocks.exportAccountData.mockResolvedValue({
    schemaVersion: 1,
    account,
    profile: { version: 1 },
    sessions: [{ expiresAt: '2026-10-01T00:00:00.000Z' }],
  });
});

describe('当前账户隐私 API', () => {
  it('导出当前账户 JSON，并禁止缓存、强制下载', async () => {
    const { GET } = await import('@/app/api/account/export/route');
    const response = await GET(request('/api/account/export'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain('jizhi-learner01-data.json');
    expect(await response.json()).toMatchObject({ schemaVersion: 1, account: { id: 'acct-1' } });
    expect(mocks.exportAccountData).toHaveBeenCalledWith(account);
  });

  it('未登录不能导出', async () => {
    mocks.accountForSession.mockResolvedValue(null);
    const { GET } = await import('@/app/api/account/export/route');
    const response = await GET(request('/api/account/export'));
    expect(response.status).toBe(401);
    expect(mocks.exportAccountData).not.toHaveBeenCalled();
  });

  it('当前密码错误时拒绝删除', async () => {
    mocks.authenticate.mockResolvedValue(null);
    const { DELETE } = await import('@/app/api/account/route');
    const response = await DELETE(
      request('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: 'wrong123' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('删除账户的敏感重认证连续失败五次后限流', async () => {
    mocks.authenticate.mockResolvedValue(null);
    const { DELETE } = await import('@/app/api/account/route');
    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(
        await DELETE(
          request('/api/account', {
            method: 'DELETE',
            headers: { 'x-real-ip': '198.51.100.40' },
            body: JSON.stringify({ password: 'wrong123' }),
          }),
        ),
      );
    }
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 429]);
    expect(mocks.authenticate).toHaveBeenCalledTimes(5);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('owner 仍有成员时把阻断原因原样返回', async () => {
    mocks.deleteAccount.mockResolvedValue({
      ok: false,
      code: 'owner_has_members',
      message: '机构仍有成员，请先移出全部成员',
    });
    const { DELETE } = await import('@/app/api/account/route');
    const response = await DELETE(
      request('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: 'pass123456' }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '机构仍有成员，请先移出全部成员',
      code: 'owner_has_members',
    });
  });

  it('owner 仍有私有知识库时以 409 保留机构与账户', async () => {
    mocks.deleteAccount.mockResolvedValue({
      ok: false,
      code: 'owner_has_corpora',
      message: '机构仍有私有知识库，请先释放知识库归属',
    });
    const { DELETE } = await import('@/app/api/account/route');
    const response = await DELETE(
      request('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: 'pass123456' }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'owner_has_corpora' });
  });

  it('知识库归属服务不可用时以 503 拒绝删户', async () => {
    mocks.deleteAccount.mockResolvedValue({
      ok: false,
      code: 'ownership_unavailable',
      message: '知识库归属服务暂不可用，账户未删除',
    });
    const { DELETE } = await import('@/app/api/account/route');
    const response = await DELETE(
      request('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: 'pass123456' }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'ownership_unavailable' });
  });

  it('验证成功后删除账户并清除当前 cookie', async () => {
    const { DELETE } = await import('@/app/api/account/route');
    const response = await DELETE(
      request('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: 'pass123456' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.deleteAccount).toHaveBeenCalledWith('acct-1');
    expect(response.headers.get('set-cookie')).toContain('jizhi_session=');
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });
});
