/**
 * 演示登录与演示账号的服务端护栏：
 * - POST /api/auth/demo 只按 role 解析成两个固定用户名，建会话、种 cookie；
 * - 演示账号做重置他人密码 / 移出成员 / 轮换邀请码 / 注销账户 / 删课时一律 403。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountByUsername: vi.fn(),
  createSession: vi.fn(),
  accountForSession: vi.fn(),
  readProfile: vi.fn(),
  orgForAccount: vi.fn(),
  orgViewFor: vi.fn(),
  membersOf: vi.fn(),
  removeMember: vi.fn(),
  resetPassword: vi.fn(),
  rotateInviteCode: vi.fn(),
  deleteAccount: vi.fn(),
  consume: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'session-token' }) }),
}));
vi.mock('@/lib/accounts/store', () => ({
  accountsEnabled: () => true,
  accountByUsername: mocks.accountByUsername,
  createSession: mocks.createSession,
  accountForSession: mocks.accountForSession,
  readProfile: mocks.readProfile,
  resetPassword: mocks.resetPassword,
  validateCredentials: () => ({ ok: true }),
  authenticate: vi.fn(),
  deleteAccount: mocks.deleteAccount,
}));
vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: mocks.orgForAccount,
  orgViewFor: mocks.orgViewFor,
  membersOf: mocks.membersOf,
  removeMember: mocks.removeMember,
  createOrg: vi.fn(),
  rotateInviteCode: mocks.rotateInviteCode,
}));
vi.mock('@/lib/accounts/credential-rate-limit', () => ({
  credentialLimiter: { consume: mocks.consume, attempt: vi.fn() },
  trustedRequestSource: () => 'test',
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { POST as demoLogin } from '@/app/api/auth/demo/route';
import { DELETE as removeMemberRoute, PATCH as resetPasswordRoute } from '@/app/api/org/members/route';
import { POST as orgAction } from '@/app/api/org/route';
import { DELETE as deleteAccountRoute } from '@/app/api/account/route';
import { DELETE as persistenceDelete } from '@/app/api/persistence/[...path]/route';
import { DEMO_FORBIDDEN_MESSAGE, DEMO_USERNAMES, isDemoAccount } from '@/lib/accounts/demo';

const demoManager = {
  id: 'acc-mgr',
  username: DEMO_USERNAMES.manager,
  displayName: '演示管理者',
  role: 'manager' as const,
  createdAt: '2026-09-01T00:00:00.000Z',
};
const demoLearner = { ...demoManager, id: 'acc-stu', username: DEMO_USERNAMES.learner, role: 'learner' as const };
const realOwner = { ...demoManager, id: 'acc-real', username: 'real_owner' };

function json(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: 'jizhi_session=t' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consume.mockResolvedValue({ kind: 'allowed' });
  mocks.createSession.mockResolvedValue({ token: 'tok', maxAge: 60 });
  mocks.readProfile.mockResolvedValue(null);
  mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });
  mocks.orgViewFor.mockResolvedValue({ org: { id: 'org-a', memberRole: 'owner' } });
  mocks.membersOf.mockResolvedValue([{ accountId: 'x', username: 'x', role: 'member' }]);
  mocks.removeMember.mockResolvedValue({ ok: true });
  mocks.resetPassword.mockResolvedValue({ ok: true });
  mocks.rotateInviteCode.mockResolvedValue('NEWCODE');
});

describe('POST /api/auth/demo', () => {
  it('按角色解析成固定用户名并建会话，响应带 demo 标记与 cookie', async () => {
    mocks.accountByUsername.mockResolvedValue(demoLearner);
    const res = await demoLogin(json('/api/auth/demo', 'POST', { role: 'learner' }));
    expect(res.status).toBe(200);
    expect(mocks.accountByUsername).toHaveBeenCalledWith(DEMO_USERNAMES.learner);
    expect(mocks.createSession).toHaveBeenCalledWith('acc-stu');
    const body = (await res.json()) as { account: { demo?: boolean; username: string } };
    expect(body.account.demo).toBe(true);
    expect(res.headers.get('set-cookie')).toContain('jizhi_session=tok');
  });

  it('只认 learner / manager 两个 role，请求体里的用户名不起作用', async () => {
    const res = await demoLogin(
      json('/api/auth/demo', 'POST', { role: 'owner', username: 'someone_else' }),
    );
    expect(res.status).toBe(400);
    expect(mocks.accountByUsername).not.toHaveBeenCalled();
  });

  it('演示账号缺失或角色对不上时 503，不建会话', async () => {
    mocks.accountByUsername.mockResolvedValue({ ...demoManager, role: 'learner' });
    const res = await demoLogin(json('/api/auth/demo', 'POST', { role: 'manager' }));
    expect(res.status).toBe(503);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('限流命中时 429', async () => {
    mocks.consume.mockResolvedValue({ kind: 'blocked', retryAfterSeconds: 30 });
    const res = await demoLogin(json('/api/auth/demo', 'POST', { role: 'learner' }));
    expect(res.status).toBe(429);
  });
});

describe('演示账号护栏', () => {
  it('isDemoAccount 只认两个固定用户名（忽略大小写）', () => {
    expect(isDemoAccount(demoManager)).toBe(true);
    expect(isDemoAccount({ username: DEMO_USERNAMES.learner.toUpperCase() })).toBe(true);
    expect(isDemoAccount(realOwner)).toBe(false);
    expect(isDemoAccount(null)).toBe(false);
  });

  it('移出成员：演示管理者 403，真实所有者照常', async () => {
    mocks.accountForSession.mockResolvedValue(demoManager);
    const denied = (await removeMemberRoute(json('/api/org/members?accountId=x', 'DELETE')))!;
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe(DEMO_FORBIDDEN_MESSAGE);
    expect(mocks.removeMember).not.toHaveBeenCalled();

    mocks.accountForSession.mockResolvedValue(realOwner);
    const ok = (await removeMemberRoute(json('/api/org/members?accountId=x', 'DELETE')))!;
    expect(ok.status).toBe(200);
  });

  it('重置成员密码：演示管理者 403', async () => {
    mocks.accountForSession.mockResolvedValue(demoManager);
    const res = (await resetPasswordRoute(
      json('/api/org/members', 'PATCH', { accountId: 'x', newPassword: 'abc12345' }),
    ))!;
    expect(res.status).toBe(403);
    expect(mocks.resetPassword).not.toHaveBeenCalled();
  });

  it('轮换邀请码：演示管理者 403，真实所有者照常', async () => {
    mocks.accountForSession.mockResolvedValue(demoManager);
    const denied = (await orgAction(json('/api/org', 'POST', { action: 'rotate' })))!;
    expect(denied.status).toBe(403);
    expect(mocks.rotateInviteCode).not.toHaveBeenCalled();

    mocks.accountForSession.mockResolvedValue(realOwner);
    const ok = (await orgAction(json('/api/org', 'POST', { action: 'rotate' })))!;
    expect(ok.status).toBe(200);
  });

  it('注销账户：演示账号 403，不读密码', async () => {
    mocks.accountForSession.mockResolvedValue(demoLearner);
    const res = (await deleteAccountRoute(json('/api/account', 'DELETE', { password: 'x' })))!;
    expect(res.status).toBe(403);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('删课（持久化 DELETE）：演示账号 403', async () => {
    mocks.accountForSession.mockResolvedValue(demoLearner);
    const res = await persistenceDelete(
      new Request('http://localhost/api/persistence/documents/x', {
        method: 'DELETE',
        headers: { cookie: 'jizhi_session=t' },
      }),
    );
    expect(res.status).toBe(403);
  });
});
