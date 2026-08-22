'use client';

import { createContext, useContext, useEffect, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type Locale, defaultLocale, supportedLocales } from '@/lib/i18n';
import '@/lib/i18n/config';

const LOCALE_STORAGE_KEY = 'locale';

/** Match a browser language code (e.g. 'en', 'zh-TW') to a supported locale */
function resolveLocale(lang: string): Locale {
  // Exact match
  const exact = supportedLocales.find((l) => l.code === lang);
  if (exact) return exact.code;
  // Prefix match: 'en' → 'en-US', 'zh' → 'zh-CN'
  const prefix = lang.split('-')[0].toLowerCase();
  const match = supportedLocales.find((l) => l.code.toLowerCase().startsWith(prefix));
  return match?.code ?? defaultLocale;
}

type I18nContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();

  const locale = (i18n.language || defaultLocale) as Locale;

  // Read the stored locale after hydration to avoid SSR mismatch.
  // 界面统一简体中文（WO-J4）：切换器撤除后没有任何控件能把语言切回来，
  // 所以这里不再嗅探 navigator.language——否则非中文浏览器一进来就是外文
  // 界面且无处纠偏。只认显式写进 localStorage 的值（e2e 用它固定语言）。
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      const target = resolveLocale(stored || defaultLocale);
      if (target !== i18n.language) i18n.changeLanguage(target);
    } catch {
      // localStorage unavailable, keep default
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocale = (newLocale: Locale) => {
    i18n.changeLanguage(newLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    } catch {
      // localStorage unavailable
    }
  };

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
