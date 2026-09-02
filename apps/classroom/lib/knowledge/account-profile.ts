'use client';

import { useEffect, useRef, useState } from 'react';

import type { DomainContextProfile } from '@/lib/knowledge/domain-context';

export type AccountProfileState<T extends DomainContextProfile = DomainContextProfile> =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: T | null; source: 'server' | 'anonymous-local' }
  | { kind: 'error'; reason: string };

const PROFILE_UNAVAILABLE = '当前账户画像暂时无法读取；未使用本地旧画像。';

/**
 * 登录账户以 `/api/profile` 为唯一真源；只有接口明确返回 401 时才读取匿名本地画像。
 * 网络、权限和服务端错误都显式失败，避免新浏览器或旧缓存把别人的领域带进当前会话。
 */
export async function loadAccountProfile<T extends DomainContextProfile>(
  readAnonymousProfile: () => T | null,
  fetcher: typeof fetch = fetch,
): Promise<AccountProfileState<T>> {
  let response: Response;
  try {
    response = await fetcher('/api/profile', { cache: 'no-store' });
  } catch {
    return { kind: 'error', reason: PROFILE_UNAVAILABLE };
  }

  if (response.status === 401) {
    try {
      return { kind: 'ready', profile: readAnonymousProfile(), source: 'anonymous-local' };
    } catch {
      return { kind: 'error', reason: '匿名学习画像无法读取。' };
    }
  }
  if (!response.ok) return { kind: 'error', reason: PROFILE_UNAVAILABLE };

  const body = (await response.json().catch(() => null)) as { fields?: unknown } | null;
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'fields')) {
    return { kind: 'error', reason: PROFILE_UNAVAILABLE };
  }
  if (body.fields !== null && (typeof body.fields !== 'object' || Array.isArray(body.fields))) {
    return { kind: 'error', reason: PROFILE_UNAVAILABLE };
  }
  return { kind: 'ready', profile: body.fields as T | null, source: 'server' };
}

export function useAccountProfile<T extends DomainContextProfile>(
  readAnonymousProfile: () => T | null,
): AccountProfileState<T> {
  const [state, setState] = useState<AccountProfileState<T>>({ kind: 'loading' });
  const readAnonymousProfileRef = useRef(readAnonymousProfile);

  useEffect(() => {
    readAnonymousProfileRef.current = readAnonymousProfile;
  }, [readAnonymousProfile]);

  useEffect(() => {
    let cancelled = false;
    void loadAccountProfile(() => readAnonymousProfileRef.current()).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
