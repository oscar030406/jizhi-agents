'use client';

/**
 * 域注册清单的 React 挂钩：把「清单灌注完成」翻译成一次重渲染。
 *
 * 用法：在读 `domainLabel()` / `examplePromptsFor()` 的组件里取一次版本号，
 * 并把它放进相关 useMemo 的依赖——灌注（DomainRegistryInit 的 fetch）落地时
 * 版本号自增，组件重读到真值。不用它的组件不受影响。
 */
import { useSyncExternalStore } from 'react';

import { domainRegistryVersion, subscribeDomainRegistry } from './domain-registry';

export function useDomainRegistryVersion(): number {
  return useSyncExternalStore(subscribeDomainRegistry, domainRegistryVersion, () => 0);
}
