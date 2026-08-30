'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * 首页需求输入框的草稿键。首页用本 hook 读它，/skills 与 /path 的「拿这个去造课」
 * 先写它再跳首页——同一个字面量散在四五处写过，改一次要满仓库找。键的读写归本模块管，
 * 常量就落在这里。
 */
export const REQUIREMENT_DRAFT_KEY = 'requirementDraft';

interface UseDraftCacheOptions {
  key: string;
  debounceMs?: number;
}

interface UseDraftCacheReturn<T> {
  cachedValue: T | undefined;
  updateCache: (value: T) => void;
  clearCache: () => void;
}

export function useDraftCache<T>({
  key,
  debounceMs = 500,
}: UseDraftCacheOptions): UseDraftCacheReturn<T> {
  // Start undefined to match SSR (no `window`); load from localStorage in an effect
  // so the consumer gets a state update when the cache is hydrated. Using lazy
  // useState here doesn't work — React preserves SSR state on hydration and the
  // initializer never re-runs on the client, so cachedValue stays undefined.
  const [cachedValue, setCachedValue] = useState<T | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = useRef<T | undefined>(undefined);
  const keyRef = useRef(key);

  /* eslint-disable react-hooks/set-state-in-effect -- Hydration from localStorage must happen in effect (SSR-safe) */
  useEffect(() => {
    keyRef.current = key;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        setCachedValue(JSON.parse(raw) as T);
      } else {
        setCachedValue(undefined);
      }
    } catch {
      /* ignore parse errors */
    }
  }, [key]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const flushPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingValueRef.current !== undefined) {
      try {
        localStorage.setItem(keyRef.current, JSON.stringify(pendingValueRef.current));
      } catch {
        /* ignore quota errors */
      }
      pendingValueRef.current = undefined;
    }
  }, []);

  const updateCache = useCallback(
    (value: T) => {
      pendingValueRef.current = value;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        try {
          localStorage.setItem(keyRef.current, JSON.stringify(value));
        } catch {
          /* ignore quota errors */
        }
        pendingValueRef.current = undefined;
      }, debounceMs);
    },
    [debounceMs],
  );

  const clearCache = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingValueRef.current = undefined;
    try {
      localStorage.removeItem(keyRef.current);
    } catch {
      /* ignore */
    }
  }, []);

  // Flush pending write on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  return { cachedValue, updateCache, clearCache };
}
