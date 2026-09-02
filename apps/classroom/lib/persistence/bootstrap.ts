import { HttpDocumentStore, type HttpDocumentHeadersHook } from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  type DocumentStorageOptions,
} from '@/lib/document-store/config';
import { assertRuntimeStorageConfigurable, configureRuntimeStorage } from '@/lib/runtime/config';

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1') {
  let learnerKeyPromise: Promise<string> | undefined;

  /** 服务端分区只接受当前账户 id；访客学习记录由浏览器本地存储负责。 */
  const resolveLearnerKey = async (): Promise<string> => {
    const res = await fetch('/api/auth', { cache: 'no-store' });
    if (!res.ok) throw new Error(`账户状态读取失败（HTTP ${res.status}）`);
    const data = (await res.json()) as { account?: { id?: unknown } | null };
    const id = data.account?.id;
    if (typeof id !== 'string' || !id) throw new Error('请先登录再保存课程与学习记录');
    return id;
  };

  const learnerKey = (): Promise<string> =>
    (learnerKeyPromise ??= resolveLearnerKey().catch((error) => {
      learnerKeyPromise = undefined;
      throw error;
    }));

  const headers = async (): Promise<Record<string, string>> => {
    const resolvedLearnerKey = await learnerKey();
    return { 'x-learner-key': resolvedLearnerKey };
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
