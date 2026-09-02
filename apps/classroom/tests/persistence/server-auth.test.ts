import type { IncomingMessage } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatePersistenceRequest } from '@/lib/persistence/server-auth';
import { accountForSession } from '@/lib/accounts/store';

vi.mock('@/lib/accounts/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts/store')>()),
  accountForSession: vi.fn(async () => null),
}));

const mockedAccountForSession = vi.mocked(accountForSession);

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('embedded persistence account authentication', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockedAccountForSession.mockResolvedValue(null);
  });

  it('rejects anonymous requests even when they forge the old public token and learner header', async () => {
    for (const header of ['anon:learner-1', 'acct_victim']) {
      await expect(
        authenticatePersistenceRequest(
          request({
            authorization: 'Bearer shared-secret',
            'x-learner-key': header,
          }),
        ),
      ).resolves.toBeUndefined();
    }
  });

  // 写路径鉴权不许放宽：有会话时 learnerKey 只能来自服务端会话。客户端
  // 伪造 x-learner-key 指向别人的分区，认定结果仍是自己的账号 id，
  // 上游 requireLearner 一比对就 403（端到端复算见工单报告的 curl 三连）。
  it('ignores a forged x-learner-key when a session decides the partition', async () => {
    mockedAccountForSession.mockResolvedValue({
      id: 'acct_self',
      username: 'self',
      displayName: 'self',
      role: 'learner',
      createdAt: '2026-08-15T00:00:00.000Z',
    });

    for (const forged of ['anon:someone-else', 'acct_other']) {
      await expect(
        authenticatePersistenceRequest(
          request({ authorization: 'Bearer shared-secret', 'x-learner-key': forged }),
        ),
      ).resolves.toEqual({ learnerKey: 'acct_self' });
    }
  });

  it('rejects requests without an authenticated account', async () => {
    await expect(authenticatePersistenceRequest(request({}))).resolves.toBeUndefined();
    await expect(
      authenticatePersistenceRequest(request({ authorization: 'Bearer shared-secreu' })),
    ).resolves.toBeUndefined();
  });
});
