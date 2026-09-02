import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  } as Storage;
}

describe('persistence client bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('leaves both sealed storage seams untouched when the flag is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
  });

  it('configures both HTTP stores and passes app validators through', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ account: { id: 'acct_test' } }), { status: 200 }),
      ),
    );

    const { HttpDocumentStore } = await import('@openmaic/storage');
    const { HttpRuntimeStore } = await import('@openmaic/storage/runtime/http');
    // Importing either seam must structurally run bootstrap before the seam can
    // resolve its default store.
    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');

    expect(runtime.isRuntimeStorageConfigured()).toBe(true);
    expect(documents.isDocumentStorageConfigured()).toBe(true);

    const runtimeStore = runtime.getRuntimeStore();
    const documentStore = documents.getDocumentStore();
    expect(runtimeStore).toBeInstanceOf(HttpRuntimeStore);
    expect(documentStore).toBeInstanceOf(HttpDocumentStore);

    const documentInternals = documentStore as unknown as {
      validateSceneFn: unknown;
      validateStageFn: unknown;
    };
    expect(documentInternals.validateSceneFn).toBe(documents.validateAppScene);
    expect(documentInternals.validateStageFn).toBe(documents.validateAppStage);

    const runtimeHeaders = await (
      runtimeStore as unknown as {
        headersHook: (context: { method: string; path: string }) => Promise<HeadersInit>;
      }
    ).headersHook({ method: 'GET', path: '/runtime/sessions/example' });
    expect(new Headers(runtimeHeaders).get('authorization')).toBeNull();
    expect(new Headers(runtimeHeaders).get('x-learner-key')).toBe('acct_test');

    runtime.resetRuntimeStorageForTests();
    documents.resetDocumentStorageForTests();
    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
  });

  it('uses the account id and refuses server persistence without a session', async () => {
    async function learnerKeyHeader(auth: unknown): Promise<string | null> {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
      vi.stubGlobal('window', {});
      vi.stubGlobal('localStorage', memoryStorage());
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(auth), { status: 200 })),
      );
      const runtime = await import('@/lib/runtime/store');
      const headers = await (
        runtime.getRuntimeStore() as unknown as {
          headersHook: (context: { method: string; path: string }) => Promise<HeadersInit>;
        }
      ).headersHook({ method: 'GET', path: '/runtime/sessions/example' });
      const value = new Headers(headers).get('x-learner-key');
      runtime.resetRuntimeStorageForTests();
      return value;
    }

    // 服务端在有会话时把 learnerKey 强制取成账号 id 并忽略客户端头
    // （lib/persistence/server-auth.ts）。客户端送错分区键 = 每次读写都 403。
    expect(await learnerKeyHeader({ enabled: true, account: { id: 'acct_abc123' } })).toBe(
      'acct_abc123',
    );
    await expect(learnerKeyHeader({ enabled: true, account: null })).rejects.toThrow(/请先登录/);
  });

  it('does not run client configuration during server module evaluation', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
  });

  it('preflights both seams so a failure cannot partially configure bootstrap', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubGlobal('window', {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const documents = await import('@/lib/document-store/config');
    documents.configureDocumentStorage({});

    const runtime = await import('@/lib/runtime/store');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(true);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain('FATAL');
  });
});
