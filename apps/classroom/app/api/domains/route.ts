/**
 * 域注册清单的对外只读口——客户端视图的唯一水源。
 *
 * 架构定位（Domain SSOT 的最后一跳）：真源在引擎产物 `domain_registry.json`，
 * 服务端经 `lib/server/domain-registry.ts` 读盘，客户端组件（画像下拉、
 * 造课示例、域工作区）只认 `lib/knowledge/domain-registry.ts` 的内存视图——
 * 而浏览器那份视图靠 `DomainRegistryInit` 在挂载时打这个端点灌注。
 * 此前三层都在、唯独没有这一跳，清单在客户端永远为空，所有查表悄悄走兜底。
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { corpusVisibilityFor } from '@/lib/accounts/org-store';
import { readDomainRegistry } from '@/lib/server/domain-registry';

export const dynamic = 'force-dynamic'; // 清单随建库变化，不许命中构建期缓存

export async function GET() {
  const registry = await readDomainRegistry();
  // 机构可见性（2026-08-30）：有归属的库只对本机构成员出现在清单里；
  // 公共库（无归属行）人人可见。过滤在这一跳做——它是客户端视图的唯一水源，
  // 漏一处旁路就等于没隔离。
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value).catch(() => null);
  const visible = await corpusVisibilityFor(account?.id ?? null);
  const entries = registry?.entries;
  if (entries && typeof entries === 'object') {
    const filtered = Object.fromEntries(
      Object.entries(entries).filter(([corpus]) => visible(corpus)),
    );
    return NextResponse.json({ ...registry, entries: filtered });
  }
  return NextResponse.json(registry);
}
