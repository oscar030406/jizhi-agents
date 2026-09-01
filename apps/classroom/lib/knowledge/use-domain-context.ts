'use client';

import { useEffect, useState } from 'react';

import {
  resolveEffectiveDomainContext,
  type DomainContextAssignment,
  type DomainContextCourse,
  type DomainContextProfile,
  type DomainContextRegistryEntry,
  type EffectiveDomainContext,
} from '@/lib/knowledge/domain-context';

export type EffectiveDomainContextState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      context: EffectiveDomainContext;
      /** 同一次解析所用的运行时课程归属表，供课程列表做同口径过滤。 */
      courseDomains?: Readonly<Record<string, DomainContextCourse>>;
    }
  | { kind: 'error'; reason: string };

async function jsonOrNull(response: Response): Promise<unknown | null> {
  return response.json().catch(() => null);
}

/**
 * 只从当前账户的公开接口取指派。`/api/org/assignments` 负责按 learner 过滤并兼容旧的
 * 机构全员指派；本模块不读 org-store 原始表，避免把同机构别人的课程算到当前学习者头上。
 */
export async function loadEffectiveDomainContext(
  profile: DomainContextProfile | null,
  fetcher: typeof fetch = fetch,
): Promise<EffectiveDomainContextState> {
  const assignmentsPromise = (async () => {
    try {
      const response = await fetcher('/api/org/assignments', { cache: 'no-store' });
      // 匿名或未加入机构就是“当前账户没有机构指派”，不是服务故障。
      if (response.status === 401 || response.status === 403) {
        return { ok: true as const, assignments: [] as DomainContextAssignment[] };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await jsonOrNull(response)) as { assignments?: unknown } | null;
      return {
        ok: true as const,
        assignments: Array.isArray(body?.assignments)
          ? (body.assignments as DomainContextAssignment[])
          : [],
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();

  const courseDomainsPromise = (async () => {
    try {
      const response = await fetcher('/api/course-domains', { cache: 'no-store' });
      if (!response.ok) return {};
      const body = await jsonOrNull(response);
      return body && typeof body === 'object' ? (body as Record<string, DomainContextCourse>) : {};
    } catch {
      return {};
    }
  })();

  const registryPromise = (async () => {
    try {
      const response = await fetcher('/api/domains', { cache: 'no-store' });
      if (!response.ok) return {};
      const body = (await jsonOrNull(response)) as { entries?: unknown } | null;
      return body?.entries && typeof body.entries === 'object'
        ? (body.entries as Record<string, DomainContextRegistryEntry>)
        : {};
    } catch {
      return {};
    }
  })();

  const [assignmentResult, courseDomains, registry] = await Promise.all([
    assignmentsPromise,
    courseDomainsPromise,
    registryPromise,
  ]);

  if (!assignmentResult.ok) {
    return {
      kind: 'error',
      reason: '当前账户的课程指派暂时无法确认；为避免误用 AI 内容，本页没有继续按旧画像回退。',
    };
  }

  return {
    kind: 'ready',
    context: resolveEffectiveDomainContext({
      assignments: assignmentResult.assignments,
      courseDomains,
      registry,
      profile,
    }),
    courseDomains,
  };
}

export function useEffectiveDomainContext(
  profile: DomainContextProfile | null,
  ready = true,
): EffectiveDomainContextState {
  const [state, setState] = useState<EffectiveDomainContextState>({ kind: 'loading' });

  /* eslint-disable react-hooks/set-state-in-effect -- 三份运行时真源只能在浏览器挂载后读取 */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    void loadEffectiveDomainContext(profile).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [profile, ready]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return state;
}
