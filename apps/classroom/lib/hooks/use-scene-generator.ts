'use client';

import { useCallback, useRef } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
  LearnerProfileFields,
  ScenePipelineMeta,
} from '@/lib/types/generation';
import { useWorkshopStore } from '@/lib/store/workshop';
import { useLectureDraftStore } from '@/lib/store/lecture-draft';
import type { SceneAudit } from '@/lib/generation/hallucination-audit';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { lazyBoundedMap, mapWithConcurrency } from '@/lib/utils/concurrency';
import { createLogger } from '@/lib/logger';
import { redactCaliber } from '@/lib/metrics/redact-caliber';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@/lib/generation/generation-retry';

const log = createLogger('SceneGenerator');

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  /** 流水线各阶段真实结果（车间面板数据源）；老服务端没有该字段时为 undefined */
  pipeline?: ScenePipelineMeta;
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

// ─── 车间事件流：把各阶段的真实结果翻译成一行中文，推给 workshop store ────────
// 只报发生过的事：pipeline 字段为 null（引擎没起/非拼装模式）就不出对应行。

const SCAFFOLD_LABEL: Record<string, string> = {
  full: '完整支架',
  faded: '渐进支架',
  minimal: '主动撤支架',
};

/** 导出仅为测试直拔：三禁要求上屏字符串实拔 DOM，测试得驱动这个真函数而不是复刻它。 */
export function reportPipeline(sceneTitle: string, pipeline: ScenePipelineMeta | undefined): void {
  const push = useWorkshopStore.getState().push;
  // 桥真失败（配了但调用炸了）→ 红行显式告警。静默降级裸生成是彩排翻过的车：
  // 页面看不出异常，评分表却掉到最低档。
  for (const w of pipeline?.bridgeWarnings ?? []) {
    push(sceneTitle, `🔌 引擎桥失联：${w} · 本场景降级为通用生成`, 'red');
  }
  // 跨模型回落（WO-M2）：主模型挂了、这一页是备胎生成的，必须在面板上说出来——
  // 静默替换模型正是这个项目零容忍的那类事故。型号串走 redactCaliber 抹掉，
  // 面板只说「换了一档」，不把内部型号搬上屏。
  for (const f of pipeline?.modelFallback ?? []) {
    push(
      sceneTitle,
      `⚠️ 生成回落：主模型${f.reason}，本页改用备用模型 ${redactCaliber(f.to)} 生成`,
      'yellow',
    );
  }
  const bp = pipeline?.blueprint;
  if (bp) {
    const parts = [
      bp.learnerType,
      bp.difficulty ? `难度 ${bp.difficulty}` : null,
      bp.scaffold ? (SCAFFOLD_LABEL[bp.scaffold] ?? bp.scaffold) : null,
      bp.analogyDomain ? `类比域=${bp.analogyDomain}` : null,
    ].filter(Boolean);
    const engineTag = bp.engine === 'deterministic' ? '（规则判定）' : '';
    push(sceneTitle, `🧭 学情诊断：${parts.join(' · ')}${engineTag}`, 'green');
  }
  const ev = pipeline?.evidence;
  if (ev) {
    let line = `📚 检索：命中 ${ev.hits} 段证据`;
    if (ev.matchedConcepts.length > 0) line += `（${ev.matchedConcepts.slice(0, 3).join('、')}）`;
    if (ev.skippedCount > 0) {
      line += ` · 跳过 ${ev.skippedCount} 段已掌握内容`;
      if (ev.skippedReasons.length > 0) line += `：${ev.skippedReasons.join('；')}`;
    }
    push(sceneTitle, line, 'blue');
  }
  const asm = pipeline?.assembly;
  if (asm && (asm.injected > 0 || asm.deduped > 0)) {
    let line = `📖 拼装：贴入 ${asm.injected} 段教材原文`;
    if (asm.deduped > 0) line += ` · 去重 ${asm.deduped} 段（换行内回指）`;
    push(sceneTitle, line, 'purple');
  }
  push(sceneTitle, '✍️ 生成：版面内容就绪', 'neutral');
  // 可执行验证（KR2）：代码沙箱真跑 + 数值等式复核。有失败必须红行点名——
  // 「课件里的数字被机器验算过」是这条流水线区别于纯文本审核的地方。
  const vr = pipeline?.verification;
  if (vr) {
    const parts: string[] = [];
    const codeTotal = vr.codePassed + vr.codeFailed + vr.codeUnverifiable;
    if (codeTotal > 0) {
      let seg = `代码 ${vr.codePassed}/${codeTotal} 沙箱通过`;
      if (vr.codeUnverifiable > 0) seg += `（${vr.codeUnverifiable} 块缺依赖未验）`;
      parts.push(seg);
    }
    if (vr.arithmeticChecked > 0) parts.push(`数值等式 ${vr.arithmeticPassed}/${vr.arithmeticChecked} 复核通过`);
    if (parts.length) {
      const bad = vr.codeFailed > 0 || vr.arithmeticPassed < vr.arithmeticChecked;
      push(sceneTitle, `🧪 验算：${parts.join(' · ')}`, bad ? 'red' : 'purple');
      for (const f of vr.failures) push(sceneTitle, `🧪 验算不过：${f}`, 'red');
    }
  }
}

function reportAudit(
  sceneTitle: string,
  audit: SceneAudit,
  label: '审核' | '讲稿审核' = '审核',
): void {
  const push = useWorkshopStore.getState().push;
  if (audit.totalClaims === 0) {
    push(sceneTitle, `⚖️ ${label}：无事实性断言（流程/互动类内容），直接放行`, 'yellow');
    return;
  }
  const supported = audit.claims.filter((c) => c.verdict === 'supported').length;
  const factuality = (supported / audit.totalClaims).toFixed(2);
  const judgeCount = audit.judgeModels?.length ?? 1;
  const parts: string[] = [
    judgeCount > 1
      ? audit.debate?.length
        ? `双审核仲裁 ${audit.debate.length} 条分歧`
        : '双审核一致'
      : '单审核',
    `断言 ${audit.totalClaims} 条`,
  ];
  if (audit.verdict === 'revised') parts.push(`修订 ${audit.rounds > 1 ? `${audit.rounds} 轮` : '1 轮'}`);
  if (audit.incorrectCount > 0) parts.push(`仍有 ${audit.incorrectCount} 条判错`);
  if (audit.uncertainCount > 0) parts.push(`${audit.uncertainCount} 条超出资料覆盖`);
  parts.push(`factuality ${factuality}`);
  if (audit.decision === 'block_pending_review') {
    push(sceneTitle, `⛔ ${label}：标记待人工复核 · ${parts.join(' · ')}`, 'red');
  } else if (audit.decision === 'publish_with_warnings') {
    push(sceneTitle, `⚖️ ${label}：带标注放行 · ${parts.join(' · ')}`, 'yellow');
  } else {
    push(sceneTitle, `⚖️ ${label}：通过 · ${parts.join(' · ')}`, 'yellow');
  }
  if (!audit.grounded) {
    push(sceneTitle, `⚠️ ${label}：未接地——本次核验无教材证据兜底`, 'yellow');
  }
}

function reportAuditUnavailable(sceneTitle: string): void {
  useWorkshopStore
    .getState()
    .push(sceneTitle, '⚠️ 审核：审核服务未响应，本场景未经核验放行', 'yellow');
}

function reportFailure(sceneTitle: string, phase: string, error: string): void {
  useWorkshopStore.getState().push(sceneTitle, `❌ ${phase}失败：${error}`, 'red');
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
    // Media generation toggles
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
  };
}

function withThinkingConfig<T extends Record<string, unknown>>(body: T): T {
  const { thinkingConfig } = getCurrentModelConfig();
  return thinkingConfig ? ({ ...body, thinkingConfig } as T) : body;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown; errorCode?: unknown },
  fallback: string,
): Error & { errorCode?: string; statusCode?: number } {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error & { errorCode?: string; statusCode?: number };
  if (typeof data.errorCode === 'string') {
    error.errorCode = data.errorCode;
  }
  error.statusCode = response.status;
  return error;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function errorMeta(error: unknown): Pick<SceneContentResult, 'errorCode' | 'statusCode'> {
  if (!error || typeof error !== 'object') return {};
  const record = error as { errorCode?: unknown; statusCode?: unknown };
  return {
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

/**
 * 画像随每一次正文请求走。
 *
 * 首页只生成第一页就跳课堂，其余页由 `app/classroom/[id]/page.tsx` 续跑，
 * 而那里的 `requirements` 是就地新建的（只带 requirement + taskEngineMode），
 * 画像整个丢了——于是一门课里只有第 1 页按选中的知识库检索、按画像分档，
 * 第 2 页起全部回到默认语料的通用生成。换库「看不出变化」的直接来源。
 *
 * 收在请求出口这一处，而不是补在每个调用点上：正文有两条出口（流式/非流式）、
 * 调用点有主循环、单页重试、补救插页——补调用点等于给自己留一排再忘一次的机会。
 * 判官那一路（`fetchSceneAudit`）早先就是这么收的，两边同源。
 *
 * 调用方显式带了画像就不覆盖（首页那次首场景请求走的是当次融合过的画像）。
 */
function withStoredProfile<T extends { requirements?: UserRequirements }>(params: T): T {
  if (params.requirements?.learnerProfile) return params;
  const stored = readStoredLearnerProfile();
  if (!stored) return params;
  return {
    ...params,
    requirements: { requirement: '', ...params.requirements, learnerProfile: stored },
  };
}

/** 从当前 stage 已生成场景收集 template 教具的模板 id（同课形态去重信号）。 */
function collectUsedTemplateIds(): string[] {
  const ids = useStageStore
    .getState()
    .scenes.map(
      (s) =>
        (s.content as { widgetConfig?: { type?: string; templateId?: string } } | undefined)
          ?.widgetConfig,
    )
    .filter(
      (w): w is { type: 'template'; templateId: string } =>
        w?.type === 'template' && typeof w.templateId === 'string',
    )
    .map((w) => w.templateId);
  return [...new Set(ids)];
}

/** Call POST /api/generate/scene-content (step 1) */
export async function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    pdfImages?: PdfImage[];
    imageMapping?: ImageMapping;
    stageInfo: {
      name: string;
      description?: string;
      language?: string;
      style?: string;
    };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: UserRequirements;
    /** 本课已生成场景里用过的教具模板 id，供服务端选模板时避免同课重形态 */
    usedTemplateIds?: string[];
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-content', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(withStoredProfile(params))),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene content request failed');
        }

        return data as unknown as SceneContentResult;
      },
      {
        label: `scene content "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.content,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Content generation failed'),
      ...errorMeta(error),
    };
  }
}

/**
 * 讲义流式版 scene-content（2026-08-04 提速批三段：边生成边读）。
 * SSE 增量经 onDelta 喂草稿 store；final result 与非流式同构。
 * 服务端发 fallback / 传输异常时返回 { fallback: true }，调用方回落
 * fetchSceneContent（槽位/自由版面降级链不受影响）。
 */
export async function fetchSceneContentStream(
  params: Parameters<typeof fetchSceneContent>[0],
  signal: AbortSignal | undefined,
  onDelta: (text: string) => void,
): Promise<SceneContentResult & { fallback?: boolean }> {
  try {
    const response = await fetch('/api/generate/scene-content', {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify(withThinkingConfig({ ...withStoredProfile(params), stream: true })),
      signal,
    });
    if (!response.ok || !response.body) return { success: false, fallback: true };
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      // 服务端判定不合格流式（媒体场景等），走的是普通 JSON 响应——直接用
      const data = await readJsonResponse(response);
      return data as unknown as SceneContentResult;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final: SceneContentResult | null = null;
    let sawFallback = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const evt = JSON.parse(line.slice(6)) as {
            type: string;
            text?: string;
            payload?: { content: unknown; effectiveOutline: SceneOutline; pipeline: unknown };
          };
          if (evt.type === 'delta' && evt.text) onDelta(evt.text);
          else if (evt.type === 'result' && evt.payload) {
            final = { success: true, ...evt.payload } as unknown as SceneContentResult;
          } else if (evt.type === 'fallback') sawFallback = true;
        } catch {
          // 半截 JSON/杂帧忽略——result 帧完整性由 \n\n 分帧保证
        }
      }
    }
    if (final) return final;
    // fallback 事件与「流断了没等到 result」同治：回落非流式重生成
    if (sawFallback) log.info('Lecture stream fell back to non-stream path');
    return { success: false, fallback: true };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { success: false, fallback: true, error: messageFromError(error, 'stream failed') };
  }
}

interface SceneAuditResult {
  success: boolean;
  audit?: import('@/lib/generation/hallucination-audit').SceneAudit;
  content?: unknown;
  error?: string;
}

/** Call POST /api/generate/scene-audit (between content and actions).
 * Failure degrades to "no audit" — the gate's infrastructure must never be
 * less reliable than the generator it audits.
 *
 * 画像在这里就地读，不走参数：正文那一路靠 `requirements.learnerProfile` 传语料库名，
 * 判官这一路六个调用点没有一个传过，于是判官永远读默认（ai）语料——换库生成的课
 * 由另一本书的判官来评。补在调用点上等于给自己留六个再忘一次的机会，收在这里只有一处。
 * 存的画像与生成时用的画像同源（需求文本融合只改档位，不改 corpus/domain）。 */
export async function fetchSceneAudit(
  params: { outline: SceneOutline; content: unknown; stageId: string; courseTitle?: string },
  signal?: AbortSignal,
): Promise<SceneAuditResult> {
  try {
    const stored = readStoredLearnerProfile();
    const response = await fetch('/api/generate/scene-audit', {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify(
        withThinkingConfig({
          ...params,
          ...(stored ? { learnerProfile: { domain: stored.domain, corpus: stored.corpus } } : {}),
        }),
      ),
      signal,
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw createHttpError(response, data, 'Scene audit request failed');
    }
    return data as unknown as SceneAuditResult;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { success: false, error: messageFromError(error, 'Scene audit failed') };
  }
}

/**
 * Speech audit toggle.
 *
 * The shield badge used to certify slide content only, while the words the AI
 * teacher actually says live in `SpeechAction.text` — generated AFTER the content
 * audit and piped straight into TTS. A badge that says "事实审核通过" over an
 * unaudited script is worse than no badge, so the script gets its own pass
 * through the same station.
 *
 * The trade-off is real and worth stating: this is a second full audit per scene.
 * Measured against the live station (multi-judge + debate/arbitration on
 * disputes) a 3-sentence script cost ~105s; budget roughly a doubling of the
 * per-scene audit time. It is mostly hidden by the "generate while teaching"
 * pipeline (it runs while the previous scene plays), but on a serial cold start
 * it is added wall time. Set `NEXT_PUBLIC_AUDIT_SPEECH=false` to trade the
 * guarantee back for the time.
 * The `NEXT_PUBLIC_` prefix is not optional — this module runs in the browser
 * bundle, where unprefixed env vars are stripped to `undefined`.
 */
const SPEECH_AUDIT_ENABLED = process.env.NEXT_PUBLIC_AUDIT_SPEECH !== 'false';

const VERDICT_RANK: Record<SceneAudit['verdict'], number> = {
  pass: 0,
  caveat: 1,
  revised: 2,
  flagged: 3,
};
const DECISION_RANK: Record<SceneAudit['decision'], number> = {
  publish: 0,
  publish_with_warnings: 1,
  block_pending_review: 2,
};

/**
 * Fold a speech audit into the scene's content audit — worst verdict wins, claims
 * concatenate with a `[讲稿]` marker on their reason. Merging (rather than adding
 * a second field) keeps the badge, the console and the report on one schema.
 */
export function mergeAudits(content: SceneAudit | undefined, speech: SceneAudit): SceneAudit {
  const tagged = speech.claims.map((c) => ({ ...c, reason: `[讲稿] ${c.reason}` }));
  if (!content) return { ...speech, claims: tagged };
  const claims = [...content.claims, ...tagged];
  // `undefined` means no panel ran; `[]` means it ran and agreed. Only concat
  // when at least one side actually has a trail, so the distinction survives.
  const debate =
    content.debate || speech.debate
      ? [...(content.debate ?? []), ...(speech.debate ?? [])]
      : undefined;
  return {
    ...content,
    verdict:
      VERDICT_RANK[speech.verdict] > VERDICT_RANK[content.verdict] ? speech.verdict : content.verdict,
    claims,
    totalClaims: claims.length,
    flaggedCount: claims.filter((c) => c.verdict !== 'supported').length,
    uncertainCount: claims.filter((c) => c.verdict === 'uncertain').length,
    incorrectCount: claims.filter((c) => c.verdict === 'incorrect').length,
    rounds: content.rounds + speech.rounds,
    durationMs: content.durationMs + speech.durationMs,
    decision:
      DECISION_RANK[speech.decision] > DECISION_RANK[content.decision]
        ? speech.decision
        : content.decision,
    rationale: `${content.rationale} 讲稿复核：${speech.rationale}`,
    grounded: content.grounded || speech.grounded,
    evidenceCount: Math.max(content.evidenceCount, speech.evidenceCount),
    ...(debate ? { debate } : {}),
  };
}

/**
 * Audit an assembled scene's spoken script. Rewrites action texts in place when
 * the station returns a clean revision, so TTS speaks the corrected words.
 * Returns null when disabled, when the scene has no narration, or when the audit
 * itself was unusable (degrade, never block).
 */
async function auditSceneSpeech(
  scene: Scene,
  outline: SceneOutline,
  stageId: string,
  courseTitle: string | undefined,
  signal?: AbortSignal,
): Promise<SceneAudit | null> {
  if (!SPEECH_AUDIT_ENABLED) return null;
  const speeches = (scene.actions || []).filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text?.trim(),
  );
  if (speeches.length === 0) return null;

  // Pack the script into a JSON shape the existing audit station already eats.
  // Forced to `slide` rather than the scene's own type on purpose: narration is
  // prose, so the quiz-distractor exemption must not apply to it.
  const result = await fetchSceneAudit(
    {
      outline: { ...outline, type: 'slide', title: `${outline.title}（讲稿）` },
      content: { type: 'slide', speeches: speeches.map((a) => a.text) },
      stageId,
      courseTitle,
    },
    signal,
  );
  if (!result.success || !result.audit) return null;

  // Accept a revision only on an exact round-trip (same count, all non-empty
  // strings); anything else keeps the original script.
  const revised = (result.content as { speeches?: unknown } | null | undefined)?.speeches;
  if (
    Array.isArray(revised) &&
    revised.length === speeches.length &&
    revised.every((s) => typeof s === 'string' && s.trim().length > 0)
  ) {
    speeches.forEach((action, i) => {
      action.text = revised[i] as string;
    });
  }
  return result.audit;
}

/** Call POST /api/generate/scene-actions (step 2) */
export async function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    /** 全课已用过的口播开头（每条前 12 字），用来躲开重复开场 */
    usedOpenings?: string[];
    userProfile?: string;
    languageDirective?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-actions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene actions request failed');
        }

        return data as unknown as SceneActionsResult;
      },
      {
        label: `scene actions "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.scene,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Actions generation failed'),
      ...errorMeta(error),
    };
  }
}

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

/** Generate TTS for one speech action and store in IndexedDB */
export async function generateAndStoreTTS(
  audioId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
): Promise<void> {
  const settings = useSettingsStore.getState();
  if (settings.ttsProviderId === 'browser-native-tts') return;
  // Don't server-generate against a disabled/unconfigured provider (#665).
  if (
    !isTTSProviderEnabled(
      settings.ttsProviderId,
      settings.ttsProvidersConfig?.[settings.ttsProviderId],
    )
  )
    return;

  const ttsProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: settings.ttsProviderId,
    providerConfig: ttsProviderConfig,
    voiceId: settings.ttsVoice,
    language,
  });
  const data = await withGenerationRetry(
    async () => {
      const response = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          audioId,
          ttsProviderId: settings.ttsProviderId,
          ttsModelId: ttsProviderConfig?.modelId,
          ttsVoice: settings.ttsVoice,
          ttsSpeed: settings.ttsSpeed,
          ttsApiKey: ttsProviderConfig?.apiKey || undefined,
          // Managed providers resolve their base URL server-side; only send the
          // client's own base URL (custom providers).
          ttsBaseUrl:
            ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
          ttsProviderOptions: providerOptions,
        }),
        signal,
      });

      const data = (await readJsonResponse(response)) as TTSApiResponse;
      if (!response.ok) {
        throw createHttpError(response, data, 'TTS request failed');
      }
      return data;
    },
    {
      label: `tts "${audioId}"`,
      shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
      ...retryOptions,
      signal,
    },
  );
  if (!data.success || !data.base64 || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', audioId, ':', err);
    throw err;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  // Measure duration once at store time so video export (#854) can map this
  // clip onto a timeline without re-decoding. null → leave undefined; the audio
  // still persists and plays.
  const duration = measureAudioDuration(bytes, data.format) ?? undefined;
  await db.audioFiles.put({
    id: audioId,
    blob,
    duration,
    format: data.format,
    createdAt: Date.now(),
  });
}

/** Generate TTS for all speech actions in a scene. Returns result. */
async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; failedCount: number; error?: string }> {
  const providerId = useSettingsStore.getState().ttsProviderId;
  scene.actions = splitLongSpeechActions(scene.actions || [], providerId);
  const speechActions = scene.actions.filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) return { success: true, failedCount: 0 };

  let failedCount = 0;
  let lastError: string | undefined;

  // Use scene order to make audio IDs unique across scenes
  // This prevents audio collision when action IDs are sequential (e.g., action_1, action_2)
  const sceneOrder = scene.order;

  // Generate + store one action's audio. Failures are counted, not thrown, so
  // one bad clip never aborts the rest of the scene.
  const generateOne = async (action: SpeechAction) => {
    // Include scene order in audioId to prevent collision across scenes
    const audioId = `tts_s${sceneOrder}_${action.id}`;
    action.audioId = audioId;
    try {
      await generateAndStoreTTS(audioId, action.text, language, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;

      failedCount++;
      lastError = error instanceof Error ? error.message : `TTS failed for action ${action.id}`;
      log.warn('TTS generation failed:', {
        providerId,
        actionId: action.id,
        sceneOrder,
        audioId,
        textLength: action.text.length,
        error: lastError,
      });
    }
  };

  // #660 follow-up: speech actions within a scene are independent — each renders
  // its own audio under its own audioId, with no cross-action ordering — so when
  // the server opts into parallel generation, render them with bounded
  // concurrency (reusing the PARALLEL_SCENE_CONCURRENCY knob) instead of one at a
  // time. Default (0 / unset) keeps the original strictly-serial behaviour.
  const ttsConcurrency = Math.max(
    0,
    Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
  );
  if (ttsConcurrency > 1 && speechActions.length > 1) {
    await mapWithConcurrency(speechActions, ttsConcurrency, generateOne);
  } else {
    for (const action of speechActions) {
      await generateOne(action);
    }
  }

  return {
    success: failedCount === 0,
    failedCount,
    error: lastError,
  };
}

export interface UseSceneGeneratorOptions {
  onSceneGenerated?: (scene: Scene, index: number) => void;
  onSceneFailed?: (outline: SceneOutline, error: string) => void;
  onPhaseChange?: (phase: 'content' | 'audit' | 'actions', outline: SceneOutline) => void;
  onComplete?: () => void;
}

export interface GenerationParams {
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
  /**
   * 服务端算职教任务引擎闸门（resolveVocationalActive）要用它。
   *
   * 2026-08-13 之前这个字段没被透传：主生成循环与重试路径都不带 requirements，
   * 于是 `app/api/generate/scene-content/route.ts` 拿到 undefined →
   * allowProceduralSkill 恒为 false → 大纲里的 procedural-skill 场景被
   * applyOutlineFallbacks 改成 diagram、六个职教字段被删 → isProceduralScene 恒为 false →
   * 「导出实操指南」入口永不出现。代码齐、开关开着、产出仍为 0，断点就在这里。
   * 只有首页那次首场景调用传了（app/generation-preview/page.tsx），
   * 但提示词强制第一页是 slide，所以那个例外没用。
   */
  requirements?: UserRequirements;
}

export function useSceneGenerator(options: UseSceneGeneratorOptions = {}) {
  const abortRef = useRef(false);
  const generatingRef = useRef(false);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastParamsRef = useRef<GenerationParams | null>(null);
  const generateRemainingRef = useRef<((params: GenerationParams) => Promise<void>) | null>(null);

  const store = useStageStore;

  const generateRemaining = useCallback(
    async (params: GenerationParams) => {
      lastParamsRef.current = params;
      if (generatingRef.current) return;
      generatingRef.current = true;
      abortRef.current = false;
      const removeGeneratingOutline = (outlineId: string) => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Create a new AbortController for this generation run
      fetchAbortRef.current = new AbortController();
      const signal = fetchAbortRef.current.signal;

      const state = store.getState();
      const { outlines, scenes, stage } = state;
      const startEpoch = state.generationEpoch;
      if (!stage || outlines.length === 0) {
        generatingRef.current = false;
        return;
      }

      store.getState().setGenerationStatus('generating');

      // Determine pending outlines
      const completedOrders = new Set(scenes.map((s) => s.order));
      const pending = outlines
        .filter((o) => !completedOrders.has(o.order))
        .sort((a, b) => a.order - b.order);

      if (pending.length === 0) {
        store.getState().setGenerationStatus('completed');
        store.getState().setGeneratingOutlines([]);
        store.getState().setGenerationComplete(true);
        options.onComplete?.();
        generatingRef.current = false;
        return;
      }

      store.getState().setGeneratingOutlines(pending);
      // 上一轮的讲义草稿全部清掉——本轮 begin/append 重建
      useLectureDraftStore.getState().clear();

      // Launch media generation in parallel — does not block content/action generation
      mediaAbortRef.current = new AbortController();
      generateMediaForOutlines(outlines, stage.id, mediaAbortRef.current.signal).catch((err) => {
        log.warn('Media generation error:', err);
      });

      // Get previousSpeeches from last completed scene
      let previousSpeeches: string[] = [];
      const sortedScenes = [...scenes].sort((a, b) => a.order - b.order);
      if (sortedScenes.length > 0) {
        const lastScene = sortedScenes[sortedScenes.length - 1];
        previousSpeeches = (lastScene.actions || [])
          .filter((a): a is SpeechAction => a.type === 'speech')
          .map((a) => a.text);
      }
      // 全课已用过的开头（每条前 12 字）。previousSpeeches 只带上一页，
      // 模型看不见整门课的重复；实测「这一节的核心」17 次、「大家好，欢迎」23 次。
      const usedOpenings = Array.from(
        new Set(
          sortedScenes.flatMap((sc) =>
            (sc.actions || [])
              .filter((a): a is SpeechAction => a.type === 'speech')
              .map((a) => a.text.replace(/^[\s"'「『（(]+/, '').slice(0, 12))
              .filter(Boolean),
          ),
        ),
      );

      // #572: opt-in parallel content fetch. Concurrency is server-configured
      // (PARALLEL_SCENE_CONCURRENCY), default 0 = off, so out-of-box behaviour is
      // unchanged.
      const parallelConcurrency = Math.max(
        0,
        // Belt-and-suspenders: the value is already clamped server-side and again
        // in the settings store; re-clamp here so a stale/garbage store value can
        // never spawn an unbounded fetch fan-out.
        Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
      );
      const useParallelContent = parallelConcurrency > 1 && pending.length > 1;

      // Pipelined generation loop (#572). When parallelism is on, scene *content*
      // fetches are kicked off up front with bounded concurrency (lazyBoundedMap)
      // but CONSUMED IN ORDER inside the serial loop below — there is no barrier.
      // So the first scene paints after content(1)+actions(1)+TTS(1) (same as
      // serial) while later content fetches run hidden behind earlier scenes'
      // actions/TTS. Content has no cross-scene dependency, so running it ahead is
      // safe; actions + TTS stay strictly serial to preserve previousSpeeches
      // threading and the pause-on-failure UX. With parallelism off this is exactly
      // the original one-at-a-time loop.
      try {
        const contentParams = (outline: SceneOutline) => ({
          outline,
          allOutlines: outlines,
          stageId: stage.id,
          pdfImages: params.pdfImages,
          imageMapping: params.imageMapping,
          stageInfo: params.stageInfo,
          agents: params.agents,
          languageDirective: params.languageDirective,
          requirements: params.requirements,
          // 并发预取时同批在飞的场景互相看不见，退化为无此信号的旧行为
          usedTemplateIds: collectUsedTemplateIds(),
        });
        // slide 走讲义流式（md 增量进草稿 store，等待界面「边生成边读」）；
        // 流不合格/中断回落非流式（槽位/自由版面降级链不变）。其余类型照旧。
        const fetchContent = async (outline: SceneOutline): Promise<SceneContentResult> => {
          if (outline.type !== 'slide') return fetchSceneContent(contentParams(outline), signal);
          const drafts = useLectureDraftStore.getState();
          drafts.begin(outline.id, outline.title);
          const streamed = await fetchSceneContentStream(contentParams(outline), signal, (t) =>
            useLectureDraftStore.getState().append(outline.id, t),
          );
          drafts.finish(outline.id);
          if (streamed.success || !streamed.fallback) return streamed;
          return fetchSceneContent(contentParams(outline), signal);
        };

        // Pre-warm content fetches (<= parallelConcurrency in flight), keyed by
        // outline id. Each promise resolves to a result and never rejects, so an
        // unexpected throw routes through the same mark-failed path as the serial
        // loop instead of taking sibling fetches down with it.
        const contentPromises = useParallelContent
          ? new Map(
              lazyBoundedMap(
                pending,
                parallelConcurrency,
                async (outline): Promise<SceneContentResult> => {
                  options.onPhaseChange?.('content', outline);
                  try {
                    return await fetchContent(outline);
                  } catch (err) {
                    return {
                      success: false,
                      error: err instanceof Error ? err.message : 'Content generation failed',
                    };
                  }
                },
                {
                  shouldContinue: () =>
                    !abortRef.current && store.getState().generationEpoch === startEpoch,
                },
              ).map((promise, i) => [pending[i].id, promise] as const),
            )
          : null;

        let pausedByFailureOrAbort = false;
        let hadContentFailure = false;
        for (const outline of pending) {
          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          store.getState().setCurrentGeneratingOrder(outline.order);

          // Step 1: content — await this outline's pre-warmed fetch (parallel),
          // which usually resolved while the previous scene's actions/TTS ran; or
          // fetch it now (serial).
          let contentResult: SceneContentResult;
          if (contentPromises) {
            contentResult = (await contentPromises.get(outline.id)) ?? {
              success: false,
              error: 'Content generation failed',
            };
          } else {
            options.onPhaseChange?.('content', outline);
            contentResult = await fetchContent(outline);
          }

          // 教具失败降级（2026-08-04 主线收尾）：交互场景生成失败改出讲义页
          // 讲同一主题——教具质量是独立课题（已搁置），但**课必须能走完**。
          // 实测：diagram 类教具反复吐 markdown 抽不出 HTML，一个场景能把整门课
          // 卡在重试马拉松里。降级页走讲义主路径，审核/验算照常。
          let effectiveOutlineForScene: SceneOutline = outline;
          if ((!contentResult.success || !contentResult.content) && outline.type === 'interactive') {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            useWorkshopStore
              .getState()
              .push(outline.title, '⚠️ 教具生成失败，本页降级为讲义', 'yellow');
            log.warn(`Interactive widget failed for "${outline.title}", degrading to lecture page`);
            const slideOutline: SceneOutline = {
              ...outline,
              type: 'slide',
              widgetType: undefined,
              widgetOutline: undefined,
            };
            options.onPhaseChange?.('content', slideOutline);
            const degraded = await fetchContent(slideOutline);
            if (degraded.success && degraded.content) {
              contentResult = degraded;
              effectiveOutlineForScene = slideOutline;
            }
          }

          if (!contentResult.success || !contentResult.content) {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            reportFailure(outline.title, '内容生成', contentResult.error || '未知错误');
            store.getState().addFailedOutline(outline);
            options.onSceneFailed?.(outline, contentResult.error || 'Content generation failed');
            if (contentPromises) {
              // Parallel: surface the failure but keep going with the other scenes
              // (their content is already in flight).
              hadContentFailure = true;
              removeGeneratingOutline(outline.id);
              continue;
            }
            // Serial: pause the batch (unchanged behaviour).
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          // 车间面板：诊断/检索/拼装/生成各阶段的真实结果，一次成型推入事件流。
          reportPipeline(outline.title, contentResult.pipeline);

          // Step 1.5+2（2026-08-04 提速批二段）：**审核异步后置**——判官不再挡
          // actions 与进课堂，场景先组装上台，审核结论/修订稿落地时经
          // updateScene 补写（徽章后到）。生产先例与依据见
          // docs/04-research/generation_latency_research_20260804.md 第 1 条
          // （Braintrust/Arize 在线评估模式：先展示、异步打分、低分打标）。
          //
          // 质量门一条没删：block_pending_review 照旧留痕（13.6% 判决翻转率
          // 决定了概率层只标注不删内容，见 arXiv:2606.13685）、修订稿照旧替换
          // 正文（讲义视图随 store 重渲）。风险注记：speech 现在基于未审正文
          // 生成——苏格拉底口径的 speech 不复述正文事实（slide-actions 提示词
          // 铁律），错位风险可控。
          options.onPhaseChange?.('actions', outline);
          const auditPromise = fetchSceneAudit(
            {
              outline: effectiveOutlineForScene,
              content: contentResult.content,
              stageId: stage.id,
              courseTitle: params.stageInfo?.name,
            },
            signal,
          );

          // Step 2: Generate actions + assemble scene（与审核并行）
          const actionsResult = await fetchSceneActions(
            {
              outline: contentResult.effectiveOutline || effectiveOutlineForScene,
              allOutlines: outlines,
              content: contentResult.content,
              stageId: stage.id,
              agents: params.agents,
              previousSpeeches,
              usedOpenings,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
            },
            signal,
          );

          if (actionsResult.success && actionsResult.scene) {
            const scene = actionsResult.scene;

            // 审核结论异步落地器：内容审/讲稿审谁先到谁先并（mergeAudits 交换
            // 安全：verdict/decision 取重、计数累加）。场景可能已被换课丢弃或
            // 重生成——按 epoch + 在场校验后经 updateScene 写回，触发重渲。
            //
            // ⚠ 修订稿是**生成层**内容（{elements,background,remark}，无 type 壳）
            // ——不能整包塞 scene.content（塞了 type 变 undefined，持久化校验
            // 拒收后 0.5s 无限重试，2026-08-04 实测炸过）。slide 只回填
            // canvas.elements；其他类型修订不落正文，结论徽章照挂（修订细节
            // 在 audit.claims 面板可见）。
            const mergeRevisedContent = (
              cur: Scene['content'],
              revised: unknown,
            ): Scene['content'] | null => {
              const r = revised as { elements?: unknown[] } | null;
              if (
                cur.type === 'slide' &&
                r &&
                typeof r === 'object' &&
                Array.isArray(r.elements)
              ) {
                return {
                  ...cur,
                  canvas: { ...cur.canvas, elements: r.elements },
                } as Scene['content'];
              }
              return null;
            };
            const applyAuditAsync = (audit: SceneAudit, revisedContent?: unknown) => {
              if (store.getState().generationEpoch !== startEpoch) return;
              const cur = store.getState().scenes.find((s) => s.id === scene.id);
              if (!cur) return;
              const mergedContent =
                revisedContent != null ? mergeRevisedContent(cur.content, revisedContent) : null;
              store.getState().updateScene(scene.id, {
                audit: cur.audit ? mergeAudits(cur.audit, audit) : audit,
                ...(mergedContent ? { content: mergedContent } : {}),
              });
            };

            // Step 2.5: 讲稿审核（后置）。语音功能已砍出生成主线（2026-08-04
            // 用户裁决：与教具/导学同列最后可选项），不再有「修订稿必须赶在
            // TTS 合成前」的串行约束。
            const runSpeechAudit = async () => {
              const speechAudit = await auditSceneSpeech(
                scene,
                effectiveOutlineForScene,
                stage.id,
                params.stageInfo?.name,
                signal,
              );
              if (!speechAudit) return null;
              reportAudit(outline.title, speechAudit, '讲稿审核');
              // 讲稿门不丢场景（13.6% 判决翻转率，扔成品代价大于收益）
              if (speechAudit.decision === 'block_pending_review') {
                log.warn(
                  `Scene "${outline.title}" speech flagged for human review (kept): ${speechAudit.rationale}`,
                );
                store.getState().recordBlockedScene(`${outline.title}（讲稿）`, speechAudit);
              }
              return speechAudit;
            };

            // Epoch changed — stage switched, discard this scene
            if (store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }

            removeGeneratingOutline(outline.id);
            store.getState().addScene(scene);
            useWorkshopStore.getState().push(outline.title, '✅ 场景完成，进入课堂', 'green');
            options.onSceneGenerated?.(scene, outline.order);
            previousSpeeches = actionsResult.previousSpeeches || [];

            // 内容审核落地（后台）：徽章/修订稿后到，车间黄行照发
            void auditPromise
              .then((auditResult) => {
                if (auditResult.success && auditResult.audit) {
                  reportAudit(outline.title, auditResult.audit);
                  if (auditResult.audit.decision === 'block_pending_review') {
                    log.warn(
                      `Scene "${outline.title}" flagged for human review (content kept): ${auditResult.audit.rationale}`,
                    );
                    store.getState().recordBlockedScene(outline.title, auditResult.audit);
                  }
                  applyAuditAsync(auditResult.audit, auditResult.content ?? undefined);
                } else if (!auditResult.success) {
                  reportAuditUnavailable(outline.title);
                }
              })
              .catch(() => reportAuditUnavailable(outline.title));

            // 讲稿审核落地（后台）：修订稿原地改 speech 文本，
            // 重写 actions 引用触发持久化与重渲
            void runSpeechAudit()
              .then((speechAudit) => {
                if (!speechAudit) return;
                applyAuditAsync(speechAudit);
                if (store.getState().generationEpoch === startEpoch) {
                  store.getState().updateScene(scene.id, { actions: [...(scene.actions || [])] });
                }
              })
              .catch(() => {});
          } else {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            reportFailure(outline.title, '动作编排', actionsResult.error || '未知错误');
            store.getState().addFailedOutline(outline);
            options.onSceneFailed?.(outline, actionsResult.error || 'Actions generation failed');
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }
        }

        if (!abortRef.current && !pausedByFailureOrAbort) {
          if (hadContentFailure) {
            // Parallel content phase left some outlines failed but kept going;
            // surface them for retry instead of signalling a clean completion.
            store.getState().setGenerationStatus('paused');
          } else {
            store.getState().setGenerationStatus('completed');
            store.getState().setGeneratingOutlines([]);
            store.getState().setGenerationComplete(true);
            options.onComplete?.();
          }
        }
      } catch (err: unknown) {
        // AbortError is expected when stop() is called — don't treat as failure
        if (isAbortError(err)) {
          log.info('Generation aborted');
          store.getState().setGenerationStatus('paused');
        } else {
          throw err;
        }
      } finally {
        generatingRef.current = false;
        fetchAbortRef.current = null;
      }
    },
    [options, store],
  );

  // Keep ref in sync so retrySingleOutline can call it
  generateRemainingRef.current = generateRemaining;

  const stop = useCallback(() => {
    abortRef.current = true;
    store.getState().bumpGenerationEpoch();
    fetchAbortRef.current?.abort();
    mediaAbortRef.current?.abort();
  }, [store]);

  const isGenerating = useCallback(() => generatingRef.current, []);

  /** Retry a single failed outline from scratch (content → actions → TTS). */
  const retrySingleOutline = useCallback(
    async (outlineId: string) => {
      const state = store.getState();
      const outline = state.failedOutlines.find((o) => o.id === outlineId);
      const params = lastParamsRef.current;
      if (!outline || !state.stage || !params) return;

      // Regen-lock (#571): never silently replace a scene that is open in
      // edit mode. Failed outlines have no completed scene yet so this is
      // structurally a no-op today, but the guard is in place for the
      // moment a "regenerate a successful scene" path routes through here.
      const lockedScene = state.scenes.find((s) => s.order === outline.order);
      if (
        lockedScene &&
        isSceneEditLocked({
          sceneId: lockedScene.id,
          mode: state.mode,
          currentSceneId: state.currentSceneId,
        })
      ) {
        return;
      }

      const removeGeneratingOutline = () => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Remove from failed list and mark as generating
      store.getState().retryFailedOutline(outlineId);
      store.getState().setGenerationStatus('generating');
      const currentGenerating = store.getState().generatingOutlines;
      if (!currentGenerating.some((o) => o.id === outline.id)) {
        store.getState().setGeneratingOutlines([...currentGenerating, outline]);
      }

      const abortController = new AbortController();
      const signal = abortController.signal;

      try {
        // Step 1: Content
        const contentResult = await fetchSceneContent(
          {
            outline,
            allOutlines: state.outlines,
            stageId: state.stage.id,
            pdfImages: params.pdfImages,
            imageMapping: params.imageMapping,
            stageInfo: params.stageInfo,
            agents: params.agents,
            languageDirective: params.languageDirective,
            // 重试也要带：漏了的话重试出来的场景会掉回 diagram，
            // 一门课里就会出现「有的页是实操指南、重试过的那页不是」
            requirements: params.requirements,
            usedTemplateIds: collectUsedTemplateIds(),
          },
          signal,
        );

        if (!contentResult.success || !contentResult.content) {
          reportFailure(outline.title, '内容生成', contentResult.error || '未知错误');
          store.getState().addFailedOutline(outline);
          return;
        }
        reportPipeline(outline.title, contentResult.pipeline);

        // Step 1.5: the same hallucination gate the main pipeline runs. Without
        // it a retried scene would ship uncertified — and with no badge at all,
        // which reads as "nothing to report" instead of "never checked".
        const auditResult = await fetchSceneAudit(
          {
            outline,
            content: contentResult.content,
            stageId: state.stage.id,
            courseTitle: params.stageInfo?.name,
          },
          signal,
        );
        if (auditResult.success && auditResult.audit) {
          reportAudit(outline.title, auditResult.audit);
        } else if (!auditResult.success) {
          reportAuditUnavailable(outline.title);
        }
        const auditedContent =
          auditResult.success && auditResult.content != null
            ? auditResult.content
            : contentResult.content;

        // 重试路径同样不丢内容——而且这里原来还有个更糟的问题：只 addFailedOutline
        // 就 return，既没 removeGeneratingOutline 也没复位 generationStatus，
        // 点了重试再被拦，状态机就永久停在 generating。现在根本不拦，问题一并消失。
        if (auditResult.success && auditResult.audit?.decision === 'block_pending_review') {
          log.warn(
            `Retried scene "${outline.title}" flagged for human review (kept): ${auditResult.audit.rationale}`,
          );
          store.getState().recordBlockedScene(outline.title, auditResult.audit);
        }

        // Step 2: Actions
        const sortedScenes = [...store.getState().scenes].sort((a, b) => a.order - b.order);
        const lastScene = sortedScenes[sortedScenes.length - 1];
        const previousSpeeches = lastScene
          ? (lastScene.actions || [])
              .filter((a): a is SpeechAction => a.type === 'speech')
              .map((a) => a.text)
          : [];

        const actionsResult = await fetchSceneActions(
          {
            outline: contentResult.effectiveOutline || outline,
            allOutlines: state.outlines,
            content: auditedContent,
            stageId: state.stage.id,
            agents: params.agents,
            previousSpeeches,
            userProfile: params.userProfile,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!actionsResult.success || !actionsResult.scene) {
          store.getState().addFailedOutline(outline);
          return;
        }

        if (auditResult.success && auditResult.audit) {
          actionsResult.scene.audit = auditResult.audit;
        }

        // Step 2.5: script audit, before TTS.
        const speechAudit = await auditSceneSpeech(
          actionsResult.scene,
          outline,
          state.stage.id,
          params.stageInfo?.name,
          signal,
        );
        if (speechAudit) {
          reportAudit(outline.title, speechAudit, '讲稿审核');
          actionsResult.scene.audit = mergeAudits(actionsResult.scene.audit, speechAudit);
          if (speechAudit.decision === 'block_pending_review') {
            log.warn(
              `Retried scene "${outline.title}" speech flagged for human review (kept): ${speechAudit.rationale}`,
            );
            store.getState().recordBlockedScene(`${outline.title}（讲稿）`, speechAudit);
          }
        }

        // TTS 已砍出生成主线（2026-08-04 用户裁决：语音与教具/导学同列
        // 最后可选项）——重试路径不再合成语音。

        removeGeneratingOutline();
        store.getState().addScene(actionsResult.scene);
        useWorkshopStore.getState().push(outline.title, '✅ 场景完成，进入课堂', 'green');

        // Resume remaining generation if there are pending outlines
        if (store.getState().generatingOutlines.length > 0 && lastParamsRef.current) {
          generateRemainingRef.current?.(lastParamsRef.current);
        } else {
          // This retry may have materialized the final outstanding slide. The
          // generateRemaining completion path is not reached on the retry flow,
          // so mark completion here too — otherwise a later delete would treat
          // the orphaned outline as pending and regenerate it.
          store.getState().markGenerationCompleteIfDone();
        }
      } catch (err) {
        if (!isAbortError(err)) {
          store.getState().addFailedOutline(outline);
        }
      }
    },
    [store],
  );

  return { generateRemaining, retrySingleOutline, stop, isGenerating };
}

// ─── Remediation: turn an adaptive decision into a real classroom change ──────

export type RemediationDecisionKind =
  | 'downgrade_explanation'
  | 'add_practice'
  | 'advance_challenge';

/** Same key the profile popover and the report page use. */
const LEARNER_PROFILE_STORAGE_KEY = 'learnerProfile';

function readStoredLearnerProfile(): LearnerProfileFields | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(LEARNER_PROFILE_STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as LearnerProfileFields) : undefined;
    return withCourseOrigin(stored);
  } catch {
    return undefined;
  }
}

/**
 * 把「这门课出自哪个库」盖在浏览器画像上。
 *
 * ## 为什么必须盖
 *
 * localStorage 里的画像是**浏览器此刻选的库**，不是**这门课出自的库**。
 * 一门课的后续屏是学习者翻页时才逐屏生成的——中间只要去别的域开过一门课，
 * 存的画像就换了，回头补屏就跑在错的库上。
 *
 * 2026-08-24 实测（P4 走读产物 `juOtyfUKQ8`，iotdb 域的权限管理课）：
 * 第 4 屏的 `audit.corpus` 落盘写着 **'ai'**，证据是主语料的两块具身智能内容
 * （`em01s14#s2` 课程总结、`em01s24#s1` 正逆运动学）。仲裁自己判了
 * 「参考资料内容为 ROS2 参数系统、tf2 坐标变换、URDF 及正逆运动学，
 * 与权限机制毫无关联」——**一门 iotdb 的课，拿主库的书来评**。
 * 同一门课早先生成的屏引的是 iotdb 自己的块，所以不是整门课错，
 * 是「后补的屏跟着当前选择跑偏」。
 *
 * ## 为什么收在这里
 *
 * 三条客户端出口都读这份画像：正文（`withStoredProfile`）、判官
 * （`fetchSceneAudit`）、补救插页。补在调用点等于给自己留三个再忘一次的机会
 * ——这个文件里已经为同一个病收过两次口了（判官那一路的注释还在上面）。
 *
 * 课自己没记出身时（老课、或建课时没选库）原样返回存的画像，不硬造。
 */
function withCourseOrigin(stored?: LearnerProfileFields): LearnerProfileFields | undefined {
  let origin: { corpus?: string; domain?: string } | undefined;
  try {
    origin = useStageStore.getState().stage?.origin;
  } catch {
    origin = undefined;
  }
  const corpus = origin?.corpus?.trim();
  const domain = origin?.domain?.trim();
  if (!corpus && !domain) return stored;
  // 课记了什么就用什么：`corpusOf` 的口径是 corpus 优先、缺了才看 domain，
  // 所以两格都按课记的覆盖，不与浏览器里那份混着用——混出来的组合
  // （这门课的库 + 上一门课的域）盘上从来没存在过。
  return {
    ...(stored ?? {}),
    ...(corpus ? { corpus } : { corpus: undefined }),
    ...(domain ? { domain } : {}),
  } as LearnerProfileFields;
}

/**
 * Act on a feedback-decision: plan a remediation scene (`/api/adaptive/remediation`),
 * run it through the *normal* content → audit → actions pipeline, and insert it
 * right after the quiz that triggered it.
 *
 * Going through the production pipeline instead of a private generator is the
 * whole point: the inserted scene is evidence-grounded, profile-adapted, judged
 * by the same independent judge and gated by the same thresholds — so it carries
 * a real audit badge rather than a decorative one.
 *
 * Every failure path returns `{ error }` for the caller to display. A remediation
 * button that silently does nothing is exactly the bug this replaces.
 */
/**
 * 补救链的阶段名。整条链 2.5–10 分钟（F1 实测 155/164/593 秒），界面在这期间
 * 只有一句「生成中…」，看不出是在等哪一步。这几个名字按真实调用顺序报给调用方，
 * **不报百分比**——四段的耗时分布没有可靠分母，编一个进度条就是编数字。
 */
export type RemediationPhase = '规划' | '生成正文' | '事实审核' | '组织讲稿' | '插入课堂';

export async function generateRemediationScene(params: {
  decision: RemediationDecisionKind;
  anchorSceneId: string;
  /** Stems of the questions the learner actually answered wrong. */
  missedPoints: string[];
  /** 阶段回调：每进入一步报一次，调用方拿它显示当前阶段。 */
  onPhase?: (phase: RemediationPhase) => void;
}): Promise<{ scene?: Scene; error?: string }> {
  const state = useStageStore.getState();
  const stage = state.stage;
  const anchor = state.scenes.find((s) => s.id === params.anchorSceneId);
  if (!stage || !anchor) return { error: '当前课堂状态不可用，无法插入补救场景。' };
  // insertSceneAfter rebalances every scene's `order`, and the batch loop matches
  // outlines to scenes by order — rebalancing mid-run would corrupt that mapping.
  if (state.generationStatus === 'generating') {
    return { error: '课程仍在生成中，请等本次生成结束后再执行。' };
  }

  const learnerProfile = readStoredLearnerProfile();

  // 跨会话错题史（DeepTutor「出题喂历史」的提炼）：这个场景此前交卷漏掉过的
  // 要点，从证据账本读，与本次错题去重后随规划请求带上。账本读失败不拦补救——
  // 少这段历史只是规划少一份参考，不是错误。
  let historicalMissedPoints: string[] = [];
  try {
    const { evidenceAbout, readLedger: readEvidenceLedger } = await import('@/lib/evidence/ledger');
    const ledger = await readEvidenceLedger();
    const current = new Set(params.missedPoints);
    historicalMissedPoints = [
      ...new Set(
        evidenceAbout(ledger, params.anchorSceneId)
          .filter((e) => e.verdict.outcome !== 'correct')
          .flatMap((e) => e.verdict.because.missed),
      ),
    ]
      .filter((p) => !current.has(p))
      .slice(0, 5);
  } catch {
    // 无账本（新学习者/隐私清空）时照常走，不造历史。
  }

  try {
    params.onPhase?.('规划');
    const planResp = await fetch('/api/adaptive/remediation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: params.decision,
        sceneTitle: anchor.title,
        courseTitle: stage.name,
        missedPoints: params.missedPoints,
        ...(historicalMissedPoints.length > 0 ? { historicalMissedPoints } : {}),
        learnerProfile,
        order: anchor.order + 1,
      }),
    });
    if (!planResp.ok) {
      return { error: `补救内容规划失败（HTTP ${planResp.status}）。` };
    }
    const outline = ((await planResp.json()) as { outline?: SceneOutline }).outline;
    if (!outline) return { error: '补救内容规划返回为空。' };

    const allOutlines = [...state.outlines, outline];
    params.onPhase?.('生成正文');
    const contentResult = await fetchSceneContent({
      outline,
      allOutlines,
      stageId: stage.id,
      stageInfo: { name: stage.name, description: stage.description, style: stage.style },
      languageDirective: stage.languageDirective,
      usedTemplateIds: collectUsedTemplateIds(),
      ...(learnerProfile
        ? { requirements: { requirement: stage.name, learnerProfile } as UserRequirements }
        : {}),
    });
    if (!contentResult.success || !contentResult.content) {
      return { error: `补救内容生成失败：${contentResult.error ?? '未知错误'}` };
    }

    params.onPhase?.('事实审核');
    const auditResult = await fetchSceneAudit({
      outline,
      content: contentResult.content,
      stageId: stage.id,
      courseTitle: stage.name,
    });
    if (auditResult.success && auditResult.audit?.decision === 'block_pending_review') {
      return { error: `补救内容未过事实审核放行线：${auditResult.audit.rationale}` };
    }
    const auditedContent =
      auditResult.success && auditResult.content != null
        ? auditResult.content
        : contentResult.content;

    const previousSpeeches = (anchor.actions || [])
      .filter((a): a is SpeechAction => a.type === 'speech')
      .map((a) => a.text);

    params.onPhase?.('组织讲稿');
    const actionsResult = await fetchSceneActions({
      outline: contentResult.effectiveOutline || outline,
      allOutlines,
      content: auditedContent,
      stageId: stage.id,
      previousSpeeches,
      languageDirective: stage.languageDirective,
    });
    if (!actionsResult.success || !actionsResult.scene) {
      return { error: `补救场景组装失败：${actionsResult.error ?? '未知错误'}` };
    }
    const scene = actionsResult.scene;
    if (auditResult.success && auditResult.audit) {
      scene.audit = auditResult.audit;
    }

    const speechAudit = await auditSceneSpeech(scene, outline, stage.id, stage.name);
    if (speechAudit) {
      scene.audit = mergeAudits(scene.audit, speechAudit);
      if (speechAudit.decision === 'block_pending_review') {
        return { error: `补救讲稿未过事实审核放行线：${speechAudit.rationale}` };
      }
    }

    // TTS 已砍出生成主线（2026-08-04：语音与教具/导学同列最后可选项）。

    params.onPhase?.('插入课堂');
    useStageStore.getState().insertSceneAfter(anchor.id, scene);
    // insertSceneAfter no-ops (warn only) when the stage changed during the
    // minutes this took. Confirm the scene actually landed — reporting "已插入"
    // for a scene the classroom never received is the bug this whole path exists
    // to avoid.
    if (!useStageStore.getState().scenes.some((s) => s.id === scene.id)) {
      return { error: '课堂已切换到其它阶段，补救场景未插入。' };
    }
    log.info(`Remediation scene inserted after "${anchor.title}": ${scene.title}`);
    return { scene };
  } catch (err) {
    if (isAbortError(err)) return { error: '补救生成已取消。' };
    return { error: messageFromError(err, '补救生成失败') };
  }
}
