/**
 * 一个「算得上可用」的模型服务商。
 *
 * 判据在 `lib/store/settings-validation.ts` 的 `isLLMProviderConfigured`：
 * 要 apiKey、要能解析出 endpoint、**还要至少一个模型**。少了 models 那一项，
 * `hasUsableLLMProvider` 就是 false，首页造课按钮永远是灰的——按钮点不动，
 * 后面整条生成链一步都走不到。
 *
 * 下面 `createSettingsStorage` 的默认值里那份 `{ apiKey: 'test-key' }` 缺 models，
 * 够不着这条判据。改默认值会动到所有 spec，所以这里另起一份具名常量：
 * 要走造课流程的用例显式 override 成它，不影响只看首页静态元素的老用例。
 */
export const USABLE_PROVIDERS_CONFIG = {
  openai: {
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/v1',
    models: ['gpt-4o'],
  },
} as const;

/** Default settings-storage value for e2e tests (Zustand persist v4 format) */
export function createSettingsStorage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    state: {
      modelId: 'gpt-4o',
      providerId: 'openai',
      providersConfig: {
        openai: { apiKey: 'test-key' },
      },
      agentMode: 'preset',
      selectedAgentIds: [],
      ttsEnabled: false,
      reviewOutlineEnabled: false,
      autoConfigApplied: true,
      ...overrides,
    },
    version: 2,
  });
}
