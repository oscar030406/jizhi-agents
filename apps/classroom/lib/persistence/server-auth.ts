/** 持久化身份只取服务端会话；客户端请求头不能声明或改写账户分区。 */
import type { IncomingMessage } from 'node:http';

import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';

import { sessionTokenFromRequest } from '@/lib/accounts/session';
import { accountForSession } from '@/lib/accounts/store';

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<RuntimeHttpPrincipal | undefined> {
  const account = await accountForSession(sessionTokenFromRequest(req));
  return account ? { learnerKey: account.id } : undefined;
}
