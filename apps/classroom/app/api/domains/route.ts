/**
 * 域注册清单的对外只读口——客户端视图的唯一水源。
 *
 * 架构定位（Domain SSOT 的最后一跳）：真源在引擎产物 `domain_registry.json`，
 * 服务端经 `lib/server/domain-registry.ts` 读盘，客户端组件（画像下拉、
 * 造课示例、域工作区）只认 `lib/knowledge/domain-registry.ts` 的内存视图——
 * 而浏览器那份视图靠 `DomainRegistryInit` 在挂载时打这个端点灌注。
 * 此前三层都在、唯独没有这一跳，清单在客户端永远为空，所有查表悄悄走兜底。
 */
import { NextResponse } from 'next/server';

import { readDomainRegistry } from '@/lib/server/domain-registry';

export const dynamic = 'force-dynamic'; // 清单随建库变化，不许命中构建期缓存

export async function GET() {
  return NextResponse.json(await readDomainRegistry());
}
