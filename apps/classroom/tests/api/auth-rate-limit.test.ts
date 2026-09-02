import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountsEnabled: vi.fn(() => true),
  accountForSession: vi.fn(),
  authenticateAndCreateSession: vi.fn(),
  createAccount: vi.fn(),
  createSession: vi.fn(),
  readProfile: vi.fn(),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountsEnabled: mocks.accountsEnabled,
  accountForSession: mocks.accountForSession,
  authenticateAndCreateSession: mocks.authenticateAndCreateSession,
  createAccount: mocks.createAccount,
  createSession: mocks.createSession,
  destroySession: vi.fn(),
  normalizeRole: (role: unknown) => role,
  readProfile: mocks.readProfile,
  validateCredentials: () => ({ ok: true as const }),
  writeProfile: vi.fn(),
}));
vi.mock('@/lib/accounts/org-store', () => ({
  corpusVisibilityFor: vi.fn(async () => () => true),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function login(username: string, source: string) {
  return new NextRequest('http://localhost/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': source },
    body: JSON.stringify({ action: 'login', username, password: 'pass123456', role: 'learner' }),
  });
}

function register(username: string, role: 'learner' | 'manager', source = '198.51.100.40') {
  return new NextRequest('http://localhost/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': source },
    body: JSON.stringify({ action: 'register', username, password: 'pass123456', role }),
  });
}

function account(username: string) {
  return {
    id: `acct-${username}`,
    username,
    displayName: username,
    role: 'learner',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.accountsEnabled.mockReturnValue(true);
  mocks.authenticateAndCreateSession.mockResolvedValue(null);
  mocks.createAccount.mockImplementation(
    async (username: string, _password: string, role: string) => ({
      ok: true,
      account: { ...account(username), role },
    }),
  );
  mocks.createSession.mockResolvedValue({ token: 'session-token', maxAge: 3600 });
  mocks.readProfile.mockResolvedValue(null);
});

describe('公共注册边界', () => {
  it('公共 API 明确拒绝管理者自注册，且不进入密码哈希/存储层', async () => {
    const { POST } = await import('@/app/api/auth/route');

    const response = await POST(register('manager01', 'manager'));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('平台签发');
    expect(mocks.createAccount).not.toHaveBeenCalled();
  });

  it('学习者注册保持可用', async () => {
    const { POST } = await import('@/app/api/auth/route');

    const response = await POST(register('learner01', 'learner'));

    expect(response.status).toBe(200);
    expect(mocks.createAccount).toHaveBeenCalledWith('learner01', 'pass123456', 'learner');
  });

  it('注册在创建账户前按规范化用户名限流', async () => {
    const { POST } = await import('@/app/api/auth/route');
    const responses = [];
    for (const username of ['RegUser', 'reguser', 'REGUSER', 'RegUser', 'reguser', 'REGUSER']) {
      responses.push(await POST(register(username, 'learner', '198.51.100.41')));
    }

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 429]);
    expect(mocks.createAccount).toHaveBeenCalledTimes(5);
  });
});

describe('登录失败限流', () => {
  it('同账户同来源的并发请求也只执行五次密码核验，第六次返回 429', async () => {
    const { POST } = await import('@/app/api/auth/route');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => POST(login('limitcon', '198.51.100.10'))),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([
      401, 401, 401, 401, 401, 429,
    ]);
    expect(mocks.authenticateAndCreateSession).toHaveBeenCalledTimes(5);
    expect(responses.find((response) => response.status === 429)?.headers.get('retry-after')).toBe(
      '900',
    );
  });

  it('密码核验成功后清零该账户与来源的失败记录', async () => {
    const { POST } = await import('@/app/api/auth/route');
    for (let index = 0; index < 4; index += 1) {
      expect((await POST(login('resetusr', '198.51.100.11'))).status).toBe(401);
    }
    mocks.authenticateAndCreateSession.mockResolvedValueOnce({
      kind: 'success',
      account: account('resetusr'),
      token: 'session-token',
      maxAge: 3600,
    });
    expect((await POST(login('resetusr', '198.51.100.11'))).status).toBe(200);

    mocks.authenticateAndCreateSession.mockResolvedValue(null);
    for (let index = 0; index < 5; index += 1) {
      expect((await POST(login('resetusr', '198.51.100.11'))).status).toBe(401);
    }
    expect((await POST(login('resetusr', '198.51.100.11'))).status).toBe(429);
  });

  it('用户名轴不能靠换来源绕过，来源轴也不误伤其他来源', async () => {
    const { POST } = await import('@/app/api/auth/route');
    for (let index = 0; index < 5; index += 1) {
      expect((await POST(login('partusr', '198.51.100.12'))).status).toBe(401);
    }
    expect((await POST(login('partusr', '198.51.100.13'))).status).toBe(429);
    expect((await POST(login('otherusr', '198.51.100.12'))).status).toBe(401);
    expect((await POST(login('partusr', '198.51.100.12'))).status).toBe(429);
  });

  it('同一可信来源撞 50 个用户名后只封该来源', async () => {
    const { POST } = await import('@/app/api/auth/route');
    for (let index = 0; index < 50; index += 1) {
      expect((await POST(login(`spray${index}x`, '198.51.100.20'))).status).toBe(401);
    }
    expect((await POST(login('spraynext', '198.51.100.20'))).status).toBe(429);
    expect((await POST(login('spraynext', '198.51.100.21'))).status).toBe(401);
  });

  it('不信任客户端追加的 X-Forwarded-For', async () => {
    const { trustedRequestSource } = await import('@/lib/accounts/credential-rate-limit');
    expect(trustedRequestSource(new Headers({ 'x-forwarded-for': '198.51.100.30' }))).toBe(
      'unknown',
    );
    expect(trustedRequestSource(new Headers({ 'x-real-ip': '198.51.100.31' }))).toBe(
      '198.51.100.31',
    );
  });

  it('GET 三个身份分支都保留服务端学习数据能力字段', async () => {
    process.env.DATABASE_URL = 'postgresql://test.invalid/learning';
    const { GET } = await import('@/app/api/auth/route');

    mocks.accountsEnabled.mockReturnValueOnce(false);
    expect(await (await GET(new NextRequest('http://localhost/api/auth'))).json()).toMatchObject({
      enabled: false,
      account: null,
      capabilities: { serverLearningData: true },
    });

    mocks.accountForSession.mockResolvedValueOnce(null);
    expect(await (await GET(new NextRequest('http://localhost/api/auth'))).json()).toMatchObject({
      enabled: true,
      account: null,
      capabilities: { serverLearningData: true },
    });

    mocks.accountForSession.mockResolvedValueOnce(account('capuser'));
    expect(await (await GET(new NextRequest('http://localhost/api/auth'))).json()).toMatchObject({
      enabled: true,
      account: { username: 'capuser' },
      capabilities: { serverLearningData: true },
    });
    delete process.env.DATABASE_URL;
  });

  it('会话存储异常显式返回 500，不伪装成未登录', async () => {
    mocks.accountForSession.mockRejectedValueOnce(new Error('database unavailable'));
    const { GET } = await import('@/app/api/auth/route');
    const response = await GET(new NextRequest('http://localhost/api/auth'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '会话读取失败' });
  });
});

describe('有界凭据限流器', () => {
  it('注册额度同时按规范化用户名和来源计数', async () => {
    const { CredentialLimiter } = await import('@/lib/accounts/credential-rate-limit');
    const limiter = new CredentialLimiter({
      subjectFailureLimit: 1,
      sourceFailureLimit: 2,
      windowMs: 60_000,
      maxTrackedEntries: 10,
      maxQueuedPerAxis: 2,
    });

    expect(
      await limiter.consume({ namespace: 'register', subject: 'NewUser', source: 'source-a' }),
    ).toEqual({ kind: 'allowed' });
    expect(
      await limiter.consume({ namespace: 'register', subject: 'newuser', source: 'source-b' }),
    ).toMatchObject({ kind: 'blocked' });

    expect(
      await limiter.consume({ namespace: 'register', subject: 'other-1', source: 'source-c' }),
    ).toEqual({ kind: 'allowed' });
    expect(
      await limiter.consume({ namespace: 'register', subject: 'other-2', source: 'source-c' }),
    ).toEqual({ kind: 'allowed' });
    expect(
      await limiter.consume({ namespace: 'register', subject: 'other-3', source: 'source-c' }),
    ).toMatchObject({ kind: 'blocked' });
  });

  it('容量满时淘汰最旧项，不产生全局 429', async () => {
    const { CredentialLimiter } = await import('@/lib/accounts/credential-rate-limit');
    const limiter = new CredentialLimiter({
      subjectFailureLimit: 1,
      sourceFailureLimit: 10,
      windowMs: 60_000,
      maxTrackedEntries: 2,
      maxQueuedPerAxis: 2,
    });
    const failed = () => Promise.resolve(null);
    await limiter.attempt({
      namespace: 'login',
      subject: 'old',
      source: 'source-old',
      verify: failed,
    });
    await limiter.attempt({
      namespace: 'login',
      subject: 'mid',
      source: 'source-mid',
      verify: failed,
    });
    await limiter.attempt({
      namespace: 'login',
      subject: 'new',
      source: 'source-new',
      verify: failed,
    });
    const verify = vi.fn(failed);
    expect(
      await limiter.attempt({ namespace: 'login', subject: 'old', source: 'source-old', verify }),
    ).toEqual({ kind: 'failed' });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('同一轴的等待队列达到上限后立即拒绝新任务', async () => {
    const { CredentialLimiter } = await import('@/lib/accounts/credential-rate-limit');
    const limiter = new CredentialLimiter({
      subjectFailureLimit: 5,
      sourceFailureLimit: 50,
      windowMs: 60_000,
      maxTrackedEntries: 10,
      maxQueuedPerAxis: 1,
    });
    let release!: () => void;
    const pending = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const first = limiter.attempt({
      namespace: 'login',
      subject: 'queued',
      source: 'source-queued',
      verify: () => pending,
    });
    await Promise.resolve();
    const secondVerify = vi.fn(async () => null);
    expect(
      await limiter.attempt({
        namespace: 'login',
        subject: 'queued',
        source: 'source-queued',
        verify: secondVerify,
      }),
    ).toEqual({ kind: 'blocked', retryAfterSeconds: 1 });
    expect(secondVerify).not.toHaveBeenCalled();
    release();
    await first;
  });
});
