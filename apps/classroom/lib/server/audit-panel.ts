/**
 * 判官团构造（异族三方：判官1 / 判官2 / 仲裁），供两条生成路径共用。
 *
 * 抽出来的原因：服务端批量生成（classroom-generation.ts）原本只传一个
 * judgeCall，而且传的是生成器自己的模型——写手给自己判卷。注释写着
 * "same contract as the client path"，实际不是。公共页课程卡要印
 * 「独立判官核验 N 条断言」，自评的数字不能上页。
 *
 * 模型解析口径与 /api/generate/scene-audit 保持一致：
 * MODEL_ROUTES['scene-audit'] > AUDIT_MODEL env > 生成器模型（自审兜底，
 * 弱但不会让审核阶段整段失效）。判官2/仲裁未配置就退回单判官，绝不让
 * resolveModel 兜底到 DEFAULT_MODEL 把生成器的模型冒充成"第二个判官"。
 */

import { callLLM } from '@/lib/ai/llm';
import type { AiCall } from '@/lib/generation/hallucination-audit';
import { createLogger } from '@/lib/logger';
import { getStageModel, type LlmStage } from '@/lib/server/model-routes';
import { resolveModel } from '@/lib/server/resolve-model';

const log = createLogger('Audit Panel');

type ResolvedModel = Awaited<ReturnType<typeof resolveModel>>;

// 判官链延迟根治（2026-08-03 实测：思考型判官非流式整包缓冲，首字节挂
// 12-18min 吃满 undici 上限；同时段直连同模型秒回）。三板斧：
// ① 判官/仲裁关思考——核对事实清单不需要长推理；修订仍是生成器、保留思考。
// ② 每次调用 180s 硬超时（AbortSignal），不再依赖 15min undici 兜底。
// ③ 超时/失败重试一次——偶发冷启动从拖垮整单变成一次 3min 重试。
const CALL_TIMEOUT_MS = 180_000;
const NO_THINKING = { mode: 'disabled', enabled: false } as const;

export function makeAuditCall(
  resolved: ResolvedModel,
  source: string,
  opts?: { noThinking?: boolean },
): AiCall {
  return async (system, user) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // noThinking 只对真有思考能力的模型下发关思考指令——对非思考模型
        // （如 DeepSeek-V3.2 判官2）注入 enable_thinking=false 会被硅基流动
        // 拒 400 Bad Request（实测 2026-08-04），此时传 undefined 即可。
        const disableThinking = opts?.noThinking
          ? resolved.modelInfo?.capabilities?.thinking
            ? NO_THINKING
            : undefined
          : resolved.thinkingConfig;
        const result = await callLLM(
          {
            model: resolved.model,
            system,
            prompt: user,
            maxOutputTokens: resolved.modelInfo?.outputWindow,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          },
          source,
          undefined,
          disableThinking,
        );
        return result.text;
      } catch (err) {
        lastErr = err;
        if (attempt === 1) {
          const body = (err as { responseBody?: string })?.responseBody;
          log.warn(
            `[${source}] call failed/timed out (attempt 1/2), retrying: ${String(err)}` +
              (body ? ` | responseBody: ${String(body).slice(0, 300)}` : ''),
          );
        }
      }
    }
    // 两次都没成 —— 这条必须吼出来，不能只让调用方拿到一个异常自己消化。
    //
    // 后果是实打实的：判官/仲裁调用抛出后，`auditSceneContent` 最外层 catch 把整屏
    // 降级成 `flagged / 0 条断言`，`ruleOnClaims` 走 `auditFailed` 分支，
    // 那一屏的结论变成「审核服务未能完成核验，本场景未经事实校验即放行」。
    // 也就是说**这条链慢到超时的时候不是变慢，是静默地不审**——而 180s 这个上限
    // 曾经真的不够：WO-N9 实测修订调用 197s，超时两次直接触发这条路径
    // （关掉修订思考后降到 ~109s，但上限本身还是可能被撞到）。
    // 错误级别 + 明写后果，让它在日志和告警里跟普通重试警告区分开。
    log.error(
      `[${source}] 两次调用均失败（每次上限 ${CALL_TIMEOUT_MS / 1000}s）——` +
        `该场景将按「未经事实校验」降级放行，不是审核通过：${String(lastErr)}`,
    );
    throw lastErr;
  };
}

export interface AuditPanel {
  judgeCalls: AiCall[];
  arbiterCall?: AiCall;
  reviseCall: AiCall;
  /**
   * 作者答辩专用调用。与 `reviseCall` 同一个生成器模型，**但保留思考**。
   *
   * 原来这两件事共用一个 `reviseCall`（`adjudicate` 的 `defendCall: reviseCall`），
   * 于是「关不关思考」只能一起决定。WO-N9 逐跳计时后发现它们的最优解相反：
   *
   * - **修订**关思考：183s→109s（−41%），修订后仍判错 4 条→**2 条**，结构守卫 6/6 打平。
   *   因为问题清单里已写明哪句错、该改成什么——判据清晰，思维链没有增量
   *   （arXiv:2506.13639：clear criteria 时 CoT 增益极小）。
   * - **答辩**关思考：快 67%，但一致率 52.9% **跌破噪声地板 73.5%**（机遇校正 −0.777），
   *   作者 rebut 从 8 涨到 15。`DEFEND_SYSTEM` 要模型自己认输，没有外部判据可依、
   *   全靠自评，正是仍然需要思维链的那一类。
   *
   * 拆开还有个附带好处：两种调用的日志 source 名从此不同
   * （`scene-audit-revise` / `scene-audit-defend`），生产日志里
   * 「答辩占审核一半墙钟」这件事直接看得见，不再混成一坨。
   */
  defendCall: AiCall;
  judgeModel: string;
  judgeModels: string[];
  arbiterModel?: string;
  /** 便于调用方打一行日志说明这次坐了谁 */
  describe: string;
}

/** 按 env/MODEL_ROUTES 组一支判官团；生成器负责修订稿。 */
export async function buildAuditPanel(generator: ResolvedModel): Promise<AuditPanel> {
  let judge = generator;
  try {
    const auditModelString = process.env.AUDIT_MODEL;
    judge = await resolveModel({
      modelString: auditModelString || generator.modelString,
      stage: 'scene-audit',
    });
  } catch (err) {
    log.warn(`Judge model resolution failed, falling back to generator model: ${String(err)}`);
  }

  const resolveOptional = async (stage: LlmStage, envVar: string) => {
    const modelString = getStageModel(stage) || process.env[envVar];
    if (!modelString?.trim()) return null;
    try {
      return await resolveModel({ modelString, stage });
    } catch (err) {
      log.warn(`${stage} model resolution failed, degrading to single judge: ${String(err)}`);
      return null;
    }
  };
  const judge2 = await resolveOptional('scene-audit-2', 'AUDIT_MODEL_2');
  // An arbiter with nothing to arbitrate is a wasted resolution.
  const arbiter = judge2 ? await resolveOptional('scene-audit-arbiter', 'ARBITER_MODEL') : null;

  return {
    judgeCalls: [
      makeAuditCall(judge, 'scene-audit', { noThinking: true }),
      ...(judge2 ? [makeAuditCall(judge2, 'scene-audit-2', { noThinking: true })] : []),
    ],
    ...(arbiter
      ? { arbiterCall: makeAuditCall(arbiter, 'scene-audit-arbiter', { noThinking: true }) }
      : {}),
    // 修订关思考、答辩保留思考——两者最优解相反，理由见 AuditPanel.defendCall 的注释。
    reviseCall: makeAuditCall(generator, 'scene-audit-revise', { noThinking: true }),
    defendCall: makeAuditCall(generator, 'scene-audit-defend'),
    judgeModel: judge.modelString,
    judgeModels: [judge.modelString, ...(judge2 ? [judge2.modelString] : [])],
    ...(arbiter ? { arbiterModel: arbiter.modelString } : {}),
    describe:
      `judge=${judge.modelString}` +
      `${judge2 ? `, judge2=${judge2.modelString}` : ''}` +
      `${arbiter ? `, arbiter=${arbiter.modelString}` : ''}` +
      `, generator=${generator.modelString}`,
  };
}
