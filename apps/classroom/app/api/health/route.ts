import { apiSuccess } from '@/lib/server/api-response';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';


// 代理引擎实时状态，必须每次真去问。`fetch` 上的 `cache: 'no-store'` 只管住对引擎那一跳，
// 管不住 Next 对 GET 路由处理器自身的缓存（2026-08-19 在 /api/skills 上实测踩过：
// 引擎侧数据都换了，走代理拿到的还是旧的）。
export const dynamic = 'force-dynamic';

const version = process.env.npm_package_version || '0.1.0';

/**
 * 桥探活：端口在听 ≠ 桥通。token 配错、路由没挂，四个引擎桥照样静默降级成裸生成
 * （评分表最低档），页面上看不出任何异常——审计抓过这条。
 *
 * 探针端点从 skill-map 换成 learning-modes：skill-map 每次要读磁盘 job 数据，
 * 冷盘时超过原来的 3 秒限时，引擎明明活着却被报 down（实测误报）。
 * learning-modes 只返回内存里的 dataclass 清单，是最轻的带鉴权只读端点——
 * 仍能验出 token 配错/路由没挂。超时同时放宽到 8 秒，与四个引擎桥的口径一致。
 */
async function probeEngineBridge(): Promise<'ok' | 'down' | 'unconfigured'> {
  const base = process.env.GROUNDING_URL;
  if (!base) return 'unconfigured';
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/learning-modes`, {
      headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    return resp.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

export async function GET() {
  return apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      webSearch: Object.keys(getServerWebSearchProviders()).length > 0,
      imageGeneration: Object.keys(getServerImageProviders()).length > 0,
      videoGeneration: Object.keys(getServerVideoProviders()).length > 0,
      tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
    },
    // 'ok'=四桥可用；'down'=引擎不可达或鉴权失败（课堂会静默退化成裸生成，演示前必须处理）；
    // 'unconfigured'=未配 GROUNDING_URL（开发环境正常，演示环境不正常）
    engineBridge: await probeEngineBridge(),
  });
}
