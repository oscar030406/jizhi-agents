import { BrowserKVStore, HttpDocumentStore, type HttpDocumentHeadersHook } from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  type DocumentStorageOptions,
} from '@/lib/document-store/config';
import { assertRuntimeStorageConfigurable, configureRuntimeStorage } from '@/lib/runtime/config';
import { getLearnerKey } from '@/lib/runtime/learner-key';

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1') {
  const deviceKv = new BrowserKVStore();
  let learnerKeyPromise: Promise<string> | undefined;

  /**
   * 分区键：有会话时用账号 id，否则用设备匿名 key。
   *
   * 服务端（`lib/persistence/server-auth.ts`）在有会话 cookie 时把 learnerKey
   * 强制取成账号 id 并忽略客户端头。客户端若继续送 `anon:<uuid>`，每一次运行时
   * 读写都会撞 403 FORBIDDEN_LEARNER——这就是登录后 quiz 只剩一个重试按钮的原因。
   * 这里让两边对齐，代价是每页多一次 `/api/auth` GET（本页内只解析一次）。
   *
   * 匿名分区里的存量数据不迁移：账号分区本来就是另一条履历，迁移要的是
   * `RuntimeStore.mergeLearner`，另议。登录/登出都会整页 reload
   * （`lib/store/account.ts`），所以每页解析一次就够。
   */
  const resolveLearnerKey = async (): Promise<string> => {
    try {
      const res = await fetch('/api/auth', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { account?: { id?: unknown } | null };
        const id = data.account?.id;
        if (typeof id === 'string' && id) return id;
      }
    } catch {
      // 接口不可用时按访客处理：设备匿名 key 与服务端未登录分支一致
    }
    return getLearnerKey(deviceKv);
  };

  const learnerKey = (): Promise<string> =>
    (learnerKeyPromise ??= resolveLearnerKey().catch((error) => {
      learnerKeyPromise = undefined;
      throw error;
    }));

  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  const headers = async (): Promise<Record<string, string>> => {
    const resolvedLearnerKey = await learnerKey();
    return {
      'x-learner-key': resolvedLearnerKey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  };

  const runtimeOptions = {
    store: () =>
      new HttpRuntimeStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpRuntimeHeadersHook,
      }),
    learnerKey,
  };
  const documentOptions: DocumentStorageOptions = {
    store: ({ validateScene, validateStage }) =>
      new HttpDocumentStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpDocumentHeadersHook,
        validateScene,
        validateStage,
      }),
  };

  try {
    // Both checks are mutation-free. Once both pass, the synchronous configure
    // calls cannot leave only one seam configured.
    assertRuntimeStorageConfigurable();
    assertDocumentStorageConfigurable();
    configureRuntimeStorage(runtimeOptions);
    configureDocumentStorage(documentOptions);
  } catch (error) {
    console.error(
      'FATAL: server-backed persistence bootstrap failed; no storage seam changes were applied',
      error,
    );
  }
}
