/**
 * 一句话自述 → 画像种子。桥到引擎的确定性抽取器（零 LLM、逐条附证据）。
 *
 * ## 为什么要这条路由
 *
 * 2026-08-13 以零基础视角实测暴露的洞：在生成框里写「我完全不懂技术，也没写过代码」，
 * 画像纹丝不动（`programming_level` 仍是 1、偏好仍是「可运行示例与分步练习」），
 * 生成的课照旧给 `argsort` / `.tolist()` 这种代码摘录。
 *
 * 抽取规则本来就认得「没写过代码」→ programming 0，只是**从来没人拿需求文本去问它**——
 * 抽取器只挂在画像弹窗（手动拖档位）那条路上。
 *
 * 适配率 2A 探针测不出这个洞：探针是把画像直接塞进去的，不走自述这条路。
 * 真实用户第一次来，恰恰是在那个框里描述自己。
 *
 * 引擎没配（GROUNDING_URL 空）或调用失败时返回空种子，调用方保持原画像——
 * 自述抽取是增强，不是必经之路，桥断了不该挡住生成。
 */

import { NextRequest } from 'next/server';

import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('ProfileIntake API');
const TIMEOUT_MS = 5000;

export const runtime = 'nodejs';

export interface ProfileSeed {
  /** 命中的维度 → 档位（0-4）。没命中的维度不出现，语义是「自述没提，别动它」。 */
  levels: Record<string, number>;
  background_hint: string;
  evidence: Array<{ dimension: string; level: number; keyword: string; reason: string }>;
  /** 一条规则都没命中：如实标注，前端提示改用选项，不假装抽到了东西。 */
  unmatched: boolean;
}

const EMPTY: ProfileSeed = { levels: {}, background_hint: '', evidence: [], unmatched: true };

export async function POST(req: NextRequest) {
  let text = '';
  try {
    text = String(((await req.json()) as { text?: unknown }).text ?? '');
  } catch {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '请求体不是合法 JSON');
  }
  if (!text.trim()) return apiSuccess({ seed: EMPTY });

  const base = process.env.GROUNDING_URL;
  if (!base) return apiSuccess({ seed: EMPTY, reason: '未配置引擎地址' });

  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/profile-intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!resp.ok) {
      log.warn(`intake bridge HTTP ${resp.status}`);
      return apiSuccess({ seed: EMPTY, reason: `引擎返回 HTTP ${resp.status}` });
    }
    const payload = (await resp.json()) as { data?: ProfileSeed };
    return apiSuccess({ seed: payload.data ?? EMPTY });
  } catch (error) {
    log.warn(`intake bridge failed: ${String(error)}`);
    return apiSuccess({ seed: EMPTY, reason: '引擎不可达' });
  }
}
