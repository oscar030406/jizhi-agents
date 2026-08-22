'use client';

import { useEffect } from 'react';

import { applyDomainRegistry, parseDomainRegistry } from '@/lib/knowledge/domain-registry';

/**
 * 浏览器侧域注册清单灌注——挂载时拉 `/api/domains` 灌进内存视图，渲染为空。
 *
 * 没有它，客户端的 `domainLabel()` / `examplePromptsFor()` 永远查到空清单、
 * 静默走硬编码兜底：新建的库在下拉里裸英文名、示例词退回通用组——
 * 而三层代码（读盘器/视图/消费函数）看起来全都「写好了」。
 * 拉失败不重试也不报错：兜底表本来就是给这种时刻用的。
 */
export function DomainRegistryInit() {
  useEffect(() => {
    let alive = true;
    fetch('/api/domains')
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => {
        if (alive && raw) applyDomainRegistry(parseDomainRegistry(raw));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return null;
}
