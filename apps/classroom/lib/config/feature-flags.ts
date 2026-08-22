/**
 * Feature flags. Public flags come from `NEXT_PUBLIC_*` env vars, which
 * Next.js inlines at build time so they are safe to read from client
 * components. Server-only flags must not use the `NEXT_PUBLIC_` prefix.
 *
 * Truthy values: `'true'` or `'1'`. Anything else (including unset) is
 * treated as disabled.
 */

function readBoolean(envValue: string | undefined): boolean {
  return envValue === 'true' || envValue === '1';
}

/**
 * MAIC Editor (Pro mode) gate. Default OFF — gates only the Pro toggle
 * affordance in `Header`. The `StageMode` type union is unaffected so
 * existing code paths typecheck identically with the flag in either
 * state.
 */
export function isMaicEditorEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_ENABLED);
}

/**
 * Experimental Pi-based classroom chat runtime. Default OFF. The same public
 * flag selects the client runtime and gates the corresponding server route.
 */
export function isPiChatEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_PI_CHAT_ENABLED);
}

/**
 * Server-authoritative gate for the vocational task-engine generation path.
 * Default OFF. When disabled, requests that include taskEngineMode must
 * silently fall back to the ordinary standard / interactive generation paths.
 */
export function isVocationalTaskEngineEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_VOCATIONAL);
}

export function resolveVocationalActive(
  requirements?: { taskEngineMode?: boolean } | null,
): boolean {
  return Boolean(requirements?.taskEngineMode) && isVocationalTaskEngineEnabled();
}

/**
 * Experimental classroom video export (Hyperframes composition ZIP, #865).
 * Default OFF — gates only the "Export Video" affordance in the export menu.
 * The emitter/compiler code paths are unaffected; this hides the UI entry
 * point until the render pipeline (#866) lands.
 */
export function isVideoExportEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_ENABLE_VIDEO_EXPORT);
}

/**
 * 审核第二轮的增量复审（WO-N9）。默认 **关**，设 `INCREMENTAL_REAUDIT=1` 打开。
 *
 * 开了之后第二轮只把修订新增的行喂给判官，未改段沿用第一轮判定，实测 7 屏单屏
 * 审核耗时合计降 19%（`审核架构实验/RESULTS.md` §4.2）。
 *
 * 默认关的理由不是代码没验，是口径：增量沿用了第一轮 `rescueUncertain` 的救回
 * 成果（基线第二轮会把它们重判掉），二轮屏 supported 率 67.3% → 72.4%（+5.1pp，
 * 噪声地板仅 +0.1pp）。对外的 `api_hallucination_v2` 用 `scripts/run_real_llm_eval.py`
 * 重标定之前打开，同一个对外数字就会有两套口径。**先重标定，再翻这个开关。**
 */
export function isIncrementalReauditEnabled(): boolean {
  return readBoolean(process.env.INCREMENTAL_REAUDIT);
}

/**
 * 语音能力（语音输入 ASR + 角色音色 TTS）总开关。
 *
 * 2026-08-04 用户裁决：语音模块整体搁置，与教具、导学 Agent 同列为主线之后的
 * 可选项。搁置期间界面上不该出现任何语音入口——不是禁用态，是不渲染。
 * 之所以用显式开关而不是"探测 ASR 是否可用"：浏览器原生语音识别在任何 Chrome
 * 上都判定为可用，探测永远为真，麦克风按钮照样露出来（线上实测）。
 *
 * 恢复语音时设 NEXT_PUBLIC_ENABLE_VOICE=true 即可，无需回滚代码。
 */
export function isVoiceEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_ENABLE_VOICE);
}
