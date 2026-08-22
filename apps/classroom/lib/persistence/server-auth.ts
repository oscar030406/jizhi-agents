/**
 * 持久化路由的身份认定。
 *
 * **会话优先**：learnerKey 来自服务端会话 cookie 解出的账户 id——客户端无法
 * 自称身份，账户之间的课程与运行时数据天然隔离。这正是本模块原注释里写的
 * 「production must derive learner identity from server-controlled claims」。
 *
 * 匿名访客（未登录）也能用：拿不到会话就落回其自带的 x-learner-key
 * （浏览器本地随机 key），数据进独立分区，登录后自动切到账户分区。访客这条路
 * 仍需持有 `PERSISTENCE_DEV_TOKEN`；该 token 编译进浏览器包，不提供任何保密性
 * 与用户隔离，绝不可用于公网多用户部署。
 *
 * 注意 `accountsEnabled()` 自 2026-08-14 起恒为 true（未配库走文件后备存储），
 * 所以下面 if 之后的「纯 dev token」分支是死路。没顺手删是因为删函数要动
 * 6 个文件 7 处调用，超出本次改动面——见 `lib/accounts/store.ts` 的注释。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';

import { sessionTokenFromRequest } from '@/lib/accounts/session';
import { accountForSession, accountsEnabled } from '@/lib/accounts/store';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
): Promise<RuntimeHttpPrincipal | undefined> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = singleHeader(req.headers.authorization);
  const devTokenOk = !!token && !!authorization && secureEqual(authorization, `Bearer ${token}`);

  if (accountsEnabled()) {
    const account = await accountForSession(sessionTokenFromRequest(req));
    // 登录用户：身份由服务端决定，客户端头一律忽略
    if (account) return { learnerKey: account.id };
    // 未登录访客：仍需持有部署 token，分区用其浏览器本地 key
    if (!devTokenOk) return undefined;
    const anonKey = singleHeader(req.headers['x-learner-key']);
    return anonKey ? { learnerKey: anonKey } : {};
  }

  if (!devTokenOk) return undefined;
  const learnerKey = singleHeader(req.headers['x-learner-key']);
  return learnerKey ? { learnerKey } : {};
}
