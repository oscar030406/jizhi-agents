/**
 * 管理端「以此库视角预览学习端」必须是**只读**的。
 *
 * 这个功能唯一会出事的地方就是它可能写到别人头上：学习端首页那个画像自动保存是
 * 800ms 防抖的，它不知道自己在预览态里。若 `/api/profile` 的写入路径不拦，
 * 管理员点一下预览、学习端一次自动保存，被预览者账户里的 corpus 就被改成了预览的库。
 *
 * 三条：GET 覆盖生效、POST 在预览态被拦、盘上画像一个字节没变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envelope = {
  version: 1 as const,
  activeId: 'p1',
  profiles: [
    {
      id: 'p1',
      name: '默认档案',
      createdAt: 1,
      updatedAt: 1,
      fields: { corpus: 'ai', domain: 'ai' } as Record<string, unknown>,
    },
  ],
};

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  readProfileEnvelope: vi.fn(),
  writeProfileEnvelope: vi.fn(),
  requireCorpusVisible: vi.fn(),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountForSession: mocks.accountForSession,
  readProfileEnvelope: mocks.readProfileEnvelope,
  writeProfileEnvelope: mocks.writeProfileEnvelope,
}));
vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: mocks.requireCorpusVisible,
}));

function request(cookies: Record<string, string>, body?: unknown) {
  return {
    cookies: { get: (k: string) => (cookies[k] ? { value: cookies[k] } : undefined) },
    json: async () => body ?? {},
  } as never;
}

beforeEach(() => {
  mocks.accountForSession.mockResolvedValue({ id: 'acc-1', role: 'learner' });
  mocks.readProfileEnvelope.mockResolvedValue(structuredClone(envelope));
  mocks.writeProfileEnvelope.mockResolvedValue(undefined);
  mocks.requireCorpusVisible.mockResolvedValue({ ok: true });
});

afterEach(() => vi.clearAllMocks());

describe('知识库视角预览', () => {
  it('带预览 cookie 时 GET 覆盖 corpus，并标出预览态', async () => {
    const { GET } = await import('@/app/api/profile/route');
    const res = await GET(request({ session: 't', 'preview-corpus': 'odoo' }));
    const body = (await res.json()) as { fields: { corpus: string }; previewCorpus?: string };

    expect(body.fields.corpus).toBe('odoo');
    expect(body.previewCorpus).toBe('odoo');
    // 覆盖只在返回值上；没有任何写入
    expect(mocks.writeProfileEnvelope).not.toHaveBeenCalled();
  });

  it('没有预览 cookie 时 GET 原样返回真画像', async () => {
    const { GET } = await import('@/app/api/profile/route');
    const res = await GET(request({ session: 't' }));
    const body = (await res.json()) as { fields: { corpus: string }; previewCorpus?: string };

    expect(body.fields.corpus).toBe('ai');
    expect(body.previewCorpus).toBeUndefined();
  });

  it('旧机构 AI corpus 已不可见时只清除响应副本，允许新机构指派继续定域', async () => {
    const denied = new Response(JSON.stringify({ success: false }), { status: 403 });
    mocks.requireCorpusVisible.mockResolvedValue({ ok: false, response: denied });
    const { GET } = await import('@/app/api/profile/route');

    const res = await GET(request({ session: 't' }));
    const body = (await res.json()) as {
      fields: { corpus: null; domain: null };
      profileCorpusUnavailable?: string;
    };

    expect(res.status).toBe(200);
    expect(body.fields).toMatchObject({ corpus: null, domain: null });
    expect(body.profileCorpusUnavailable).toBe('ai');
    expect(mocks.writeProfileEnvelope).not.toHaveBeenCalled();
  });

  it('预览态下 POST 一律拒写，盘上画像不动', async () => {
    const { POST } = await import('@/app/api/profile/route');
    const res = await POST(
      request(
        { session: 't', 'preview-corpus': 'odoo' },
        { action: 'update', fields: { corpus: 'odoo' } },
      ),
    );

    expect(res.status).toBe(409);
    // 这条是本文件的重点：预览绝不能落进别人的账户
    expect(mocks.writeProfileEnvelope).not.toHaveBeenCalled();
  });

  it('不能把画像切到当前账户不可见的知识库', async () => {
    const denied = new Response(JSON.stringify({ success: false }), { status: 403 });
    mocks.requireCorpusVisible.mockResolvedValue({ ok: false, response: denied });
    const { POST } = await import('@/app/api/profile/route');
    const res = await POST(
      request({ session: 't' }, { action: 'update', fields: { corpus: 'private-b' } }),
    );

    expect(res).toBe(denied);
    expect(mocks.requireCorpusVisible).toHaveBeenCalledWith('private-b');
    expect(mocks.writeProfileEnvelope).not.toHaveBeenCalled();
  });

  it('切换到不可见知识库的既有档案时拒绝且不落盘', async () => {
    mocks.readProfileEnvelope.mockResolvedValue({
      ...structuredClone(envelope),
      profiles: [
        ...structuredClone(envelope.profiles),
        {
          id: 'p2',
          name: '私有档案',
          createdAt: 2,
          updatedAt: 2,
          fields: { domain: 'private-b' },
        },
      ],
    });
    const denied = new Response(JSON.stringify({ success: false }), { status: 403 });
    mocks.requireCorpusVisible.mockResolvedValue({ ok: false, response: denied });
    const { POST } = await import('@/app/api/profile/route');
    const res = await POST(request({ session: 't' }, { action: 'activate', id: 'p2' }));

    expect(res).toBe(denied);
    expect(mocks.requireCorpusVisible).toHaveBeenCalledWith('private-b');
    expect(mocks.writeProfileEnvelope).not.toHaveBeenCalled();
  });

  it('更新非活动档案时也校验目标档案的知识库', async () => {
    mocks.readProfileEnvelope.mockResolvedValue({
      ...structuredClone(envelope),
      profiles: [
        ...structuredClone(envelope.profiles),
        {
          id: 'p2',
          name: '备用档案',
          createdAt: 2,
          updatedAt: 2,
          fields: { corpus: 'ai' },
        },
      ],
    });
    const denied = new Response(JSON.stringify({ success: false }), { status: 403 });
    mocks.requireCorpusVisible.mockImplementation(async (corpus: string) =>
      corpus === 'private-b' ? { ok: false, response: denied } : { ok: true },
    );
    const { POST } = await import('@/app/api/profile/route');
    const res = await POST(
      request({ session: 't' }, { action: 'update', id: 'p2', fields: { corpus: 'private-b' } }),
    );

    expect(res).toBe(denied);
    expect(mocks.requireCorpusVisible).toHaveBeenCalledWith('private-b');
    expect(mocks.writeProfileEnvelope).not.toHaveBeenCalled();
  });
});
