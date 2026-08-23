/**
 * Load .env.local before tests so API keys are available.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// 语义断言 matcher（toMatchLlmRubric / toBeSimilarTo）。只注册，不联网；
// 没配 key 时调用会抛错而不是静默通过，用法见 tests/matchers/。
import './matchers/llm-judge';

const envPath = resolve(__dirname, '..', '.env.local');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env.local not found, skip
}
