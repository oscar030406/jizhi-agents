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
import { isScratchCorpus } from '@/lib/knowledge/domain-registry';
import { readDomainRegistry } from '@/lib/server/domain-registry';

export const dynamic = 'force-dynamic'; // 清单随建库变化，不许命中构建期缓存

export async function GET() {
  const registry = await readDomainRegistry();
  // 机构可见性（2026-08-30）：有归属的库只对本机构成员出现在清单里；
  // 公共库（无归属行）人人可见。过滤在这一跳做——它是客户端视图的唯一水源，
  // 漏一处旁路就等于没隔离。
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value).catch(
    () => null,
  );
  const visible = await corpusVisibilityFor(account?.id ?? null);
  const entries = registry?.entries;
  if (entries && typeof entries === 'object') {
    const filtered = Object.fromEntries(
      Object.entries(entries).filter(
        ([corpus, entry]) =>
          visible(corpus) &&
          !isScratchCorpus(corpus) &&
          // 块数写着 0 的行不出这一跳。引擎的种子名单（personalize_service.py 的
          // DOMAIN_CORPORA）把「产品声明了、库还没建」的领域也写进注册清单，
          // manufacturing / industrial-internet / software / odoo 四条是空壳：
          // 选中它们生成课程时无素材可取。这里是客户端视图的唯一水源，
          // 拦在这一跳 = 库下拉、路径页、示例词一起干净。
          // 缺字段（老清单没写过 chunks）留着，判不了空就不替它下结论。
          !(typeof entry?.chunks === 'number' && entry.chunks <= 0),
      ),
    );
    return NextResponse.json({ ...registry, entries: filtered });
  }
  return NextResponse.json(registry);
}
