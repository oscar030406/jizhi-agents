/**
 * 域注册清单的读盘那一半。
 *
 * 真源：引擎数据目录下的 `data/knowledge_base/domain_registry.json`，由入库链第 ⑧ 站写出。
 * 路径口径与 `lib/server/knowledge-center.ts` 完全一致（复用它的 `enginePath()`），
 * 也就是同一个 `ENGINE_DATA_DIR` 约定——不另开一套目录规则。
 *
 * 为什么不走引擎 HTTP：与知识库中心同理，这是一份静态产物文件，引擎自己也只是去读它；
 * 多一跳只多一个「引擎离线 = 学习端不认识新库」的失败态。
 *
 * **文件不存在 = 不是错误。** 引擎还没跑过 ⑧ 站（本地刚 clone、新环境）时清单就是没有的，
 * 那时全站照常启动、各处走原有兜底。这里任何一条路径都不抛错。
 */

import { promises as fs } from 'node:fs';

import {
  applyDomainRegistry,
  parseDomainRegistry,
  type DomainRegistry,
} from '@/lib/knowledge/domain-registry';
import { enginePath } from '@/lib/server/knowledge-center';

/** 清单文件的引擎相对路径。展示/复算时用它，别在别处拼第二遍。 */
export const DOMAIN_REGISTRY_REL = 'data/knowledge_base/domain_registry.json';

/**
 * 读一次清单并灌进内存视图（`lib/knowledge/domain-registry.ts`），顺手把它返回。
 *
 * 每次调用都真去读盘：清单随建库变化，缓存住等于新库建成后学习端还认不出它。
 * 文件不存在 / JSON 坏了 / 形状不认识，一律返回空视图并把内存视图清空——
 * 宁可回退到硬编码兜底，也不留一份过期的清单在内存里冒充真源。
 */
export async function readDomainRegistry(): Promise<DomainRegistry> {
  let registry: DomainRegistry | null = null;
  try {
    registry = parseDomainRegistry(
      JSON.parse(await fs.readFile(enginePath(DOMAIN_REGISTRY_REL), 'utf-8')),
    );
  } catch {
    registry = null;
  }
  applyDomainRegistry(registry);
  return registry ?? { entries: {}, generatedAt: null, sourceRunId: null };
}
