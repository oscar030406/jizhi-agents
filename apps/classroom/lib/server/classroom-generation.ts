import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
} from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { AgentInfo } from '@/lib/generation/pipeline-types';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageModel } from '@/lib/server/model-routes';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { persistClassroom } from '@/lib/server/classroom-storage';
import { getParallelSceneConcurrency } from '@/lib/server/provider-config';
import { boundedRunner } from '@/lib/utils/concurrency';
import { corpusUnavailableReason } from '@/lib/server/knowledge-center';
import {
  fetchEvidence,
  evidenceDirective,
  evidenceForJudge,
  excerptDirective,
  injectExcerpts,
  type ExcerptPlacement,
} from '@/lib/generation/evidence-grounding';
import {
  corpusOf,
  fetchLearnerBlueprint,
  blueprintDirective,
  excerptDifficultyCap,
  excerptCodeLineCap,
  presentationTier,
  type LearnerBlueprint,
} from '@/lib/generation/learner-profile';
import { sceneConceptsFromChunks } from '@/lib/evidence/scene-concepts';
import type { CourseGenerationMeta } from '@/lib/server/classroom-storage';
import { auditSceneContent } from '@/lib/generation/hallucination-audit';
import { buildAuditPanel } from '@/lib/server/audit-panel';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import {
  isRetryableGenerationError,
  withGenerationRetry,
} from '@/lib/generation/generation-retry';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { LearnerProfileFields, SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { Scene, ScenePatch, Stage } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';
import { usageAttribution } from '@/lib/ai/usage-context';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
  /**
   * 目标学习者画像。给了才会去问引擎要蓝图——这条路径上的画像分支
   * （`excerptDifficultyCap` / `excerptCodeLineCap` / `fetchLearnerBlueprint`）
   * 本来就写好了，只是从来没有入口把画像喂进来，于是恒走通用生成。
   *
   * `app/api/generate-classroom/route.ts` 从 2026-08-16 起转发这个字段，
   * 走 HTTP 的批量生成也能指定知识库与档位。
   */
  learnerProfile?: LearnerProfileFields;
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
  /**
   * 课程 id。**第一次上报就带上**，不等生成结束。
   *
   * 原来它只在 job 成功时才出现在 `result.classroomId` 里，于是「生成中能不能进课堂」
   * 这个问题在协议层就是无解的——前端连课号都不知道。id 在 `generateClassroom` 开头
   * 就铸出来了（`nanoid(10)`，用于 usage 归因），一直有，只是没往外报。
   */
  classroomId?: string;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  languageDirective: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  // 课程 id 提前铸出来，好让**整段生成**（大纲、画像、场景、审核）的 token 账
  // 都归到这门课。原来它在函数中段才生成，那之前的三次 LLM 调用就永远归不了因。
  //
  // 生成中途失败时，usage 里会留下一个指向「没落库的课」的 classroomId——
  // 这是有意的：那次尝试的成本是真花掉的，抹掉它等于少报成本。
  // 管理端按 courseId 精确 join，join 不上的行自然不进按课成本。
  const stageId = nanoid(10);
  return usageAttribution.run({ classroomId: stageId }, () =>
    generateClassroomInner(input, options, stageId),
  );
}

async function generateClassroomInner(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
  stageId: string,
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;

  // 与交互式路径同一道闸：显式选了没建索引的库，一开始就说清楚，不许跑到一半空手而归。
  const corpusBlock = await corpusUnavailableReason(input.learnerProfile?.corpus);
  if (corpusBlock) throw new Error(corpusBlock);

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } = await resolveModel({ stage: 'generate-classroom' });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  // 判官团解析一次，全部场景复用。此前这条路径把生成器自己当判官（自评），
  // 与客户端主链的异族三方口径不一致——课程卡上的"独立判官"数字就是从这里来的。
  const auditPanel = await buildAuditPanel({
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } as Parameters<typeof buildAuditPanel>[0]);
  log.info(`Audit panel for batch generation: ${auditPanel.describe}`);

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
      undefined,
      classroomThinking,
    );
    return result.text;
  };

  const sceneAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
        maxRetries: 0,
      },
      'generate-classroom-scene',
      undefined,
      classroomThinking,
    );
    return result.text;
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: searchQueryModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
      undefined,
      searchQueryThinking,
    );
    return result.text;
  };

  const requirements: UserRequirements = {
    requirement,
    ...(input.learnerProfile ? { learnerProfile: input.learnerProfile } : {}),
  };
  const vocationalActive = resolveVocationalActive(requirements);
  const pdfText = pdfContent?.text || undefined;

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const webSearchConfig = resolveClassroomWebSearchConfig(input);
    if (webSearchConfig) {
      // Re-resolve the query-rewrite model only when explicitly routed. If
      // resolution itself fails (e.g. unknown provider in the route), fall back
      // to the classroom model here; a route with a missing key resolves fine
      // and surfaces only later in callLLM, which the outer try/catch below
      // degrades gracefully — either way the pipeline still works.
      const rewriteRoute = getStageModel('web-search-query-rewrite');
      if (rewriteRoute) {
        try {
          const rewriteResolved = await resolveModel({ stage: 'web-search-query-rewrite' });
          searchQueryModel = rewriteResolved.model;
          searchQueryThinking = rewriteResolved.thinkingConfig;
        } catch (err) {
          log.warn(
            `web-search-query-rewrite route "${rewriteRoute}" unavailable; using classroom model for query rewrite`,
            err,
          );
        }
      }
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWeb({
          providerId: webSearchConfig.providerId,
          query: searchQuery.query,
          apiKey: webSearchConfig.apiKey,
          baseUrl: webSearchConfig.baseUrl,
          baiduSubSources: webSearchConfig.baiduSubSources,
        });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no web search API key configured, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const outlinesResult = await generateSceneOutlinesFromRequirements(
    requirements,
    pdfText,
    undefined,
    aiCall,
    {
      imageGenerationEnabled: input.enableImageGeneration,
      videoGenerationEnabled: input.enableVideoGeneration,
      researchContext,
      // NO teacherContext — agents haven't been generated yet
    },
  );

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const { languageDirective, courseTitle, outlines } = outlinesResult.data;
  log.info(
    `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
  );

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      agents = await generateAgentProfiles(requirement, languageDirective, aiCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  const stage: Stage = {
    id: stageId,
    name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    languageDirective,
    videoManifest: buildVideoManifestFromOutlines(outlines),
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // 这门课出自哪个域/库，随课落盘。
    // 不记的话客户端生成的课只能靠 source_id 前缀反推归属，而那张前缀表是
    // 手工维护的 AI 域清单——投币建的新库生成的课必然反推错，
    // 在首页「本域课程」里永远看不见（P0-A）。
    ...(input.learnerProfile?.corpus?.trim() || input.learnerProfile?.domain
      ? {
          origin: {
            ...(input.learnerProfile?.corpus?.trim()
              ? { corpus: input.learnerProfile.corpus.trim() }
              : {}),
            ...(input.learnerProfile?.domain ? { domain: input.learnerProfile.domain } : {}),
          },
        }
      : {}),
    // For LLM-generated agents, embed full configs so the client can
    // hydrate the agent registry without prior IndexedDB data.
    // For default agents, just record IDs — the client already has them.
    ...(agentMode === 'generate'
      ? {
          generatedAgentConfigs: agents.map((a, i) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            persona: a.persona || '',
            avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
            color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
            priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
          })),
        }
      : {
          agentIds: agents.map((a) => a.id),
        }),
  };

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  /** 骨架落盘失败时的原因。非空 = 这门课可能存不住，要让学习者看见。 */
  let skeletonPersistError: string | null = null;

  // 骨架先落盘：大纲一出来就把课程文件写出去，`scenes` 还是空的，但课已经存在了。
  //
  // 首屏 572 秒里有 128 秒花在大纲阶段，这段时间课程文件根本不存在，学习者只能
  // 对着首页进度条等。骨架落下去之后，两分钟就能进课堂看见标题与整份目录，
  // 然后看着每一屏一个个长出来——等待本身变成了可看的东西。
  //
  // 写失败只 warn：骨架是锦上添花，炸掉整门课不值得。
  try {
    await persistClassroom(
      {
        id: stageId,
        stage,
        scenes: [],
        generating: {
          done: 0,
          total: outlines.length,
          plannedTitles: outlines.map((o) => o.title),
        },
      },
      options.baseUrl,
    );
    log.info(`Skeleton persisted: ${stageId} (${outlines.length} planned scenes)`);
  } catch (error) {
    // **失败要让人看见。** 原来这里只 warn——落盘链一直失败也没人知道，
    // 学习者关掉标签页才发现课没了，而排查时服务端日志里连一行都没有
    // （2026-08-23 查了半宿才分清是「没走这条链」还是「走了但失败」）。
    // 现在把它挂进进度消息：课照常生成，但当场说清它可能存不住。
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`Skeleton persist failed: ${detail}`);
    skeletonPersistError = detail;
  }

  // 课号立刻往外报，前端据此就能跳进课堂——不等第一屏。
  await options.onProgress?.({
    step: 'generating_scenes',
    progress: 30,
    message: skeletonPersistError
      ? `大纲已就绪（${outlines.length} 屏），但这门课没能存到服务器上——` +
        `现在可以正常学，关掉页面后可能找不回来。原因：${skeletonPersistError}`
      : `Course skeleton ready: ${outlines.length} scenes planned`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
    classroomId: stageId,
  });

  log.info('Stage 2: Generating scene content and actions...');
  let generatedScenes = 0;
  // 全课共享：同一段教材原文只整段贴一次，之后的场景换成一行回指
  const usedExcerpts = new Set<string>();
  // 课级元数据的来源：整门课用同一份画像问蓝图，取第一次真的拿到的那份。
  // 引擎离线 / 没有画像时它一直是 null，落库时整个 generation 字段不写。
  let courseBlueprint: LearnerBlueprint | null = null;

  /** 第一段（串行）产出、第二段（并发审核）消费的中间态。 */
  type PreparedScene = {
    index: number;
    safeOutline: SceneOutline;
    content: NonNullable<Awaited<ReturnType<typeof generateSceneContent>>>;
    sceneEvidence: Awaited<ReturnType<typeof fetchEvidence>>;
    sceneCorpus: string | undefined;
    grounding: { placements: ExcerptPlacement[]; candidates?: number } | undefined;
  };
  // 每屏一个槽位：生产者（串行的内容生成循环）填，消费者（落盘循环）从第一个开始等。
  // 两者**同时跑**——这是首屏时间的最后一道坎。
  //
  // 上一版把落盘循环写在生产循环之后，于是即便审核已在后台并发，落盘也要等
  // 全部屏的内容生成完才开始：2026-08-21 实测 5 屏课首屏 659 秒 / 全课 885 秒，
  // 首屏占了全课的 74%，等于没改。用槽位解耦之后，第 1 屏只等「内容₁ + 审核₁」。
  type SceneSlot = {
    promise: Promise<Awaited<ReturnType<typeof auditAndBuildScene>> | undefined>;
    fill: (v: Promise<Awaited<ReturnType<typeof auditAndBuildScene>> | undefined>) => void;
  };
  /** 这门课已经用过的教具模板 id，逐屏累积（同课形态去重）。 */
  const usedTemplateIds = new Set<string>();

  const sceneSlots: SceneSlot[] = outlines.map(() => {
    let fill!: SceneSlot['fill'];
    const promise = new Promise<Awaited<ReturnType<typeof auditAndBuildScene>> | undefined>(
      (resolve) => {
        // 收下的是 promise，await 会自动透传到它的结果
        fill = (v) => resolve(v);
      },
    );
    return { promise, fill };
  });

  // 并发度沿用上游那个已有的旋钮 `PARALLEL_SCENE_CONCURRENCY`（`getParallelSceneConcurrency()`，
  // 钳在 [0,10]，**0 = 关**）。客户端逐场景路径（`use-scene-generator.ts`）早就用它了，
  // 批量路径一直没接。默认关 ⇒ 行为与改动前逐字一致：一次一屏，顺序不变。
  const auditConcurrency = Math.max(1, getParallelSceneConcurrency());
  // 审核相位必须自己上报进度：任务存活由 `classroom-job-store` 的看门狗判定，
  // **30 分钟没有进度更新就判 stale 并杀掉任务**（`classroom-job-store.ts:87`）。
  // 串行版里每屏审完就顺手报一次，天然不会静默；改成分段之后审核整段一声不吭，
  // 20 屏那轮的审核相位超过 30 分钟，任务被看门狗判死——2026-08-18 实测栽过。
  // 这里按「审完几屏」计数上报，并发下「第几屏在跑」没有单一答案，只有完成数还成立。
  let auditedCount = 0;
  const runAudit = boundedRunner(auditConcurrency, async (p: PreparedScene) => {
    try {
      return await auditAndBuildScene(p);
    } catch (error) {
      // 一屏炸掉不许炸整门课。`mapWithConcurrency` 底下是 `Promise.all`，
      // 任何一个 reject 会让整批 reject——2026-08-18 首次并发实测就栽在这里：
      // 上游回 `{"code":50508,"System is too busy now"}`，第 1 屏 actions 重试 6 次耗尽抛出，
      // 整门课 failed，前面 8 屏的生成与审核全白花。
      // 串行版里内容生成失败是 `continue` 跳过那一屏的，并发版要保持同样的止损半径。
      //
      // **但只兜可重试那一类**（超时 / 429 / 5xx——是这一屏这一次的运气）。
      // 401/403 这种是钥匙不对、配额没了，属于整个任务的前提塌了：吞掉它只会把
      // 「Unauthorized」变成一句莫名其妙的「No scenes were generated」，
      // 让人对着日志猜半天。判据直接借 `isRetryableGenerationError`，
      // 与 `withGenerationRetry` 用同一套，不另立第二份口径。
      if (!isRetryableGenerationError(error)) throw error;
      log.warn(
        `Skipping scene "${p.safeOutline.title}" — audit/actions failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    } finally {
      // 审完一屏就报一次，成败都报（`finally`）。
      auditedCount += 1;
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(30 + Math.floor((auditedCount / Math.max(outlines.length, 1)) * 55), 89),
        message: `Auditing scenes ${auditedCount}/${outlines.length}`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    }
  });

  async function auditAndBuildScene(p: PreparedScene) {
    const { audit: sceneAudit, content: auditedContent } = await auditSceneContent({
      sceneTitle: p.safeOutline.title,
      content: p.content,
      judgeCalls: auditPanel.judgeCalls,
      ...(auditPanel.arbiterCall ? { arbiterCall: auditPanel.arbiterCall } : {}),
      reviseCall: auditPanel.reviseCall,
      defendCall: auditPanel.defendCall,
      judgeModel: auditPanel.judgeModel,
      judgeModels: auditPanel.judgeModels,
      ...(auditPanel.arbiterModel ? { arbiterModel: auditPanel.arbiterModel } : {}),
      sceneType: p.safeOutline.type,
      ...(p.sceneEvidence
        ? {
            evidence: evidenceForJudge(p.sceneEvidence),
            evidenceCount: p.sceneEvidence.chunks.length,
            // 取材来源随审核结论入库（与交互路径同一口径）。用画像解析出来的库名，
            // 不用 bundle.corpus——后者没选库时是引擎那侧的 'default'，上屏不是人话。
            ...(p.sceneCorpus ? { corpus: p.sceneCorpus } : {}),
            // Without the pool the judge's cited ids cannot be bound back to a
            // title, and the badge renders a bare id with fallback hover text.
            sources: p.sceneEvidence.chunks.map((c) => ({
              source_id: c.source_id,
              title: c.title,
            })),
          }
        : {}),
    });
    log.info(
      `Scene "${p.safeOutline.title}" audit: ${sceneAudit.verdict} / ${sceneAudit.decision} ` +
        `(${sceneAudit.totalClaims} claims, ${sceneAudit.flaggedCount} flagged)`,
    );
    // 服务端批量路径同样不丢场景：审核结论随场景入库当徽标，不再 continue 跳过。
    if (sceneAudit.decision === 'block_pending_review') {
      log.warn(
        `Scene "${p.safeOutline.title}" flagged for human review (kept): ${sceneAudit.rationale}`,
      );
    }

    // The audit returns the (possibly revised) content as `unknown`; it is the
    // same shape it was handed, so narrow it back to the generator's union.
    const gatedContent = auditedContent as typeof p.content;

    const actions = await withGenerationRetry(
      () =>
        generateSceneActions(p.safeOutline, gatedContent, sceneAiCall, {
          agents,
          languageDirective,
        }),
      {
        label: `scene ${p.index + 1}/${outlines.length} actions`,
        onRetry: (event) => reportSceneRetry(p.index, p.safeOutline.title, 'actions', event),
      },
    );
    log.info(`Scene "${p.safeOutline.title}": ${actions.length} actions`);
    return { p, sceneAudit, gatedContent, actions };
  }



  // 重试进度上报：原来定义在循环体内闭包吃 index / safeOutline，审核搬出循环后
  // actions 那一路也要用它，所以提到外面显式收下标与屏题。
  const reportSceneRetry = async (
    index: number,
    title: string,
    phase: 'content' | 'actions',
    event: { attempt: number; maxAttempts: number; reason: string },
  ) => {
    const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
    const message = `Retrying scene ${index + 1}/${outlines.length} ${phase} (${nextAttempt}/${event.maxAttempts}): ${title}`;
    log.warn(`${message} — ${event.reason}`);
    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(30 + Math.floor((index / Math.max(outlines.length, 1)) * 60), 31),
      message,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });
  };

  // 落盘消费者**与生产者同时起跑**。写成后台任务而不是生产循环之后的 for，
  // 是因为放在后面就等于又加了一道 barrier：实测 5 屏课首屏 659s / 全课 885s，
  // 首屏占 74%，增量落盘等于白做。
  const draining = (async () => {
    // ── 第三段：按大纲顺序**边跑边落盘** ────────────────────────────────────
    // 场景在 store 里的顺序就是 createSceneWithActions 的调用顺序，所以这一段必须串行、
    // 按 index 走：并发落盘会把课的屏序打乱。
    //
    // 与改动前的差别只有一处：遍历的是 promise 而不是已完成的结果。第 i 屏的 await
    // 只挡住「第 i 屏还没跑完」，第 i+1..n 屏在后台照跑。于是第 1 屏一落盘课堂就存在，
    // 学习者可以进去看着后面的屏一屏屏长出来，而不是对着进度条等整门课。
    // 屏序仍由这个循环保证——先 await 到的不一定先落，落的顺序永远是大纲顺序。
    for (const slot of sceneSlots) {
      const item = await slot.promise;
      if (!item) continue;
      const { p, sceneAudit, gatedContent, actions } = item;
      const { safeOutline, sceneEvidence, grounding } = p;
      const sceneId = createSceneWithActions(safeOutline, gatedContent, actions, api);
      if (sceneId) {
        // Carry the audit trail onto the persisted scene so the classroom badge
        // and the agent console see the same evidence the gate ruled on.
        //
        // `grounding` 与 `audit` **一起写但各是各的**（设计稿 §4.3：依据与审计成对不合并）：
        // 依据答「这句话哪来的」，是检索贴进正文的那几条出处，判官跑不跑都在；
        // 审计答「这句话对不对」，是判官的判词。此前只有后者，于是「资源的依据」
        // 这个值要等判官跑完才存在——那是把检索的产物寄存在判官身上。
        // 概念标签同理，第三样各是各的：概念答「这一页讲什么」，由检索块的
        // concept_tags 计票得出（口径与 derive_scene_concepts.py 同源）。
        // 没有证据就整个字段不写——空对象会让读的人以为算出来是空的。
        const concepts = sceneEvidence ? sceneConceptsFromChunks(sceneEvidence.chunks) : null;
        api.scene.update(sceneId, {
          audit: sceneAudit,
          ...(grounding ? { grounding } : {}),
          ...(concepts ? { concepts } : {}),
        } as ScenePatch);
      }
      if (!sceneId) {
        log.warn(`Skipping scene "${safeOutline.title}" — scene creation failed`);
        continue;
      }

      generatedScenes += 1;

      // 每落一屏就把课程文件写一次盘，带 `generating` 标记。
      //
      // 光把场景推进内存 store 是不够的：课堂页读的是 `data/classrooms/<id>.json`，
      // 而原来 `persistClassroom` 只在全课跑完后调一次——生成中那门课在磁盘上根本不存在，
      // 学习者只能对着进度条等（实测 7 屏 2416 秒，评委现场等不起）。
      // 现在第 1 屏一落盘课程文件就有了，可以进去看着后面的屏一屏屏长出来。
      //
      // 代价是整文件重写 N 次（一门 20 屏的课 20 次，单文件几百 KB，可忽略）。
      // 写失败不许打断生成——半成品少一次快照是小事，把整门课炸掉是大事。
      try {
        await persistClassroom(
          {
            id: stageId,
            stage,
            scenes: store.getState().scenes,
            generating: {
            done: generatedScenes,
            total: outlines.length,
            plannedTitles: outlines.map((o) => o.title),
          },
          },
          options.baseUrl,
        );
      } catch (error) {
        log.warn(
          `Incremental persist failed at scene ${generatedScenes}/${outlines.length}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // 进度改成完成计数：审核并发之后「第几屏在跑」不再是单一的了，只有「跑完几屏」还成立。
      const progressEnd = 30 + Math.floor((generatedScenes / Math.max(outlines.length, 1)) * 60);
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(progressEnd, 90),
        message: `Generated ${generatedScenes}/${outlines.length} scenes`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
        classroomId: stageId,
      });
    }
  })();

  try {
  for (const [index, outline] of outlines.entries()) {
    const safeOutline = applyOutlineFallbacks(outline, true, {
      allowProceduralSkill: vocationalActive,
    });
    const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(progressStart, 31),
      message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });

    // Same multi-agent graft as the client pipeline: the retrieval agent fences
    // facts to the controlled KB and the diagnosis agent sets depth/analogy
    // domain. Without this the server batch path silently produced ungrounded,
    // one-size-fits-all scenes while the UI implied otherwise.
    // 显式选的知识库优先，否则沿用培训领域；未建的库返回空而不是拿别的领域
    // 语料顶上（见 fetchEvidence）。检索、审核标注共用这一个值。
    const sceneCorpus = corpusOf(requirements.learnerProfile);
    const [sceneEvidence, scenePlan] = await Promise.all([
      fetchEvidence(
        `${courseTitle ?? ''} ${safeOutline.title} ${safeOutline.description ?? ''}`.trim(),
        sceneCorpus,
        undefined,
        undefined,
        // 摘录难度跟姿态档走（2A 纯净测 beginner 44.4% 病根修复）
        requirements.learnerProfile ? excerptDifficultyCap(requirements.learnerProfile) : undefined,
        // 摘录代码形态也跟姿态档走：难度档管不住代码长度，零基础档限 5 行
        requirements.learnerProfile ? excerptCodeLineCap(requirements.learnerProfile) : undefined,
      ),
      requirements.learnerProfile
        ? fetchLearnerBlueprint(requirement, requirements.learnerProfile)
        : Promise.resolve(null),
    ]);
    const assemblyMode = sceneEvidence != null && process.env.EXCERPT_ASSEMBLY !== '0';
    if (sceneEvidence) {
      safeOutline.description =
        (safeOutline.description ?? '') +
        evidenceDirective(sceneEvidence) +
        (assemblyMode ? excerptDirective(sceneEvidence) : '');
    }
    if (scenePlan) {
      safeOutline.description =
        (safeOutline.description ?? '') +
        blueprintDirective(scenePlan, requirements.learnerProfile!);
      courseBlueprint ??= scenePlan;
    }

    const content = await withGenerationRetry(
      () =>
        generateSceneContent(safeOutline, sceneAiCall, {
          agents,
          languageDirective,
          allowProceduralSkill: vocationalActive,
          // 这门课前面几屏用过的教具形态。不传的话选模板时不知道用过什么，
          // 同题材自然选到同一个——制造域一门课两个教具全是步进器，
          // 这是其中一半原因（另一半是模板池 8 个里 5 个 AI 域专属）。
          usedTemplateIds: [...usedTemplateIds],
          // PBL 场景走的是 Vercel AI SDK 的 agentic loop（`lib/pbl/generate-pbl.ts`），
          // 它要的是 LanguageModel 实例本身，不是这里的 `sceneAiCall` 闭包。
          // 这三个字段批量路径此前一个都没传，于是**任何 pbl 大纲在这条路上必然失败**：
          // `generatePBLSceneContent` 第一行就 `if (!languageModel) return null`，
          // 重试 6 次全空，最后 `Skipping scene …` 把那一屏丢掉。
          // 症状是课程墙 32 门课一个 pbl 场景都没有——不是大纲从不选它，
          // 是选了也落不了地（2026-08-18 实测：一门课的大纲第 8 屏就是 pbl，
          // 日志里 6 条 `LanguageModel required for PBL generation`，落盘只剩 8 屏）。
          // 逐场景那条 HTTP 路径（`app/api/generate/scene-content/route.ts`）一直传得对，
          // 所以这是批量路径独有的漏接。
          languageModel,
          thinkingConfig: classroomThinking,
          userRequirements: requirements,
        }),
      {
        label: `scene ${index + 1}/${outlines.length} content`,
        shouldRetryResult: (result) => result === null,
        onRetry: (event) => reportSceneRetry(index, safeOutline.title, 'content', event),
      },
    );
    if (!content) {
      log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
      continue;
    }
    // 记下这屏用了哪个模板，下一屏选的时候避开。`config.templateId` 只有
    // 模板池那条路会写；上游自由 HTML 与讲义降级都没有，正好不必去重。
    const usedId = (content as { config?: { templateId?: unknown } } | null)?.config?.templateId;
    if (typeof usedId === 'string' && usedId) usedTemplateIds.add(usedId);

    // 摘录占位符 → 教材原文，机械替换（位置模型排、内容机器贴——模型手抄必漂移）。
    // 客户端主链在 scene-content 路由里做这一步；批量路径此前漏了，落盘的课正文里
    // 直接露出 {{摘录:xxx}} 原样占位符。usedExcerpts 跨场景去重，同一段教材不重复贴。
    let grounding: { placements: ExcerptPlacement[]; candidates?: number } | undefined;
    if (assemblyMode && sceneEvidence) {
      const stats = await injectExcerpts(content, sceneEvidence, usedExcerpts);
      // 依据子盒落盘：贴了哪几条教材出处，跟着资源走。判官跑不跑都在。
      grounding = {
        placements: stats.placements,
        candidates: sceneEvidence.chunks.length,
      };
      if (Object.values(stats).some((n) => typeof n === 'number' && n > 0)) {
        log.info(
          `Excerpt injection "${safeOutline.title}": ${stats.injected} injected` +
            (stats.swapped ? `, ${stats.swapped} swapped(换更咬合的候选)` : '') +
            (stats.deduped ? `, ${stats.deduped} deduped` : '') +
            (stats.capped ? `, ${stats.capped} capped` : '') +
            (stats.unknown ? `, ${stats.unknown} unknown dropped` : '') +
            (stats.rejected ? `, ${stats.rejected} rejected(不自包含)` : '') +
            (stats.irrelevant ? `, ${stats.irrelevant} irrelevant(与前文不咬合)` : '') +
            (stats.noLead ? `, ${stats.noLead} noLead(无引导句)` : ''),
        );
      }
    }

    // 到这里为止（检索 → 内容 → 摘录注入）必须留在串行段：`usedExcerpts` 是跨屏
    // 去重的共享状态，顺序决定哪一屏拿到哪一段教材，并发会让课的内容变样。
    // 审核与 actions 没有任何跨屏依赖，收集完统一并发跑（见循环后的第二段）。
    // 内容一好就立刻交给审核，**不等其余屏**。
    //
    // 这一句是首屏时间的关键。原来这里是 `prepared.push(...)`，整个串行循环跑完才进
    // 第二段——于是第 1 屏要等「全部 N 屏的内容生成 + 自己的审核」才落盘。
    // 2026-08-21 实测 5 屏课：job 全程 `scenesGenerated=0`，直到最后一刻才跳 5，
    // 增量落盘等于没生效，因为压根没有可落的东西。
    //
    // 改成边产边审之后，第 1 屏只等「内容₁ + 审核₁」。三个性质一个没丢：
    //   · 摘录顺序——这个循环本身仍是串行的，`usedExcerpts` 的分配顺序一字不变；
    //   · 审核并发——`runAudit` 内部走同一个信号量，在飞数仍受 auditConcurrency 钳制；
    //   · 落盘有序——第三段照 `pendingScenes` 的下标顺序 await。
    sceneSlots[index].fill(runAudit({ index, safeOutline, content, sceneEvidence, sceneCorpus, grounding }));
  }

  // ── 第二段：审核 + actions 并发 ──────────────────────────────────────────
  //
  // 为什么这一段是大头：WO-L2 五轮体检的 20 屏实测，单屏生成中位 74s、**审核中位 191s**，
  // 审核占单屏总耗时 73.6%。原来整个循环（生成+审核+actions）逐屏串行，
  // 一门 9 屏的课 ≈ 45 分钟，实测吻合。审核每屏独立——`auditSceneContent` 只吃这一屏的
  // content 与 evidence，没有跨屏状态——所以这一段可以直接并发。
  //
  } finally {
    // 无论生产者是正常跑完还是中途抛出，都要做这两件事：
    //   ① 补齐没填的槽——不补的话消费者会永久挂在那一格上，整个任务假死；
    //   ② 等消费者收工——不等的话 `draining` 就是个没人 await 的孤儿 promise，
    //      它内部的异常会变成未处理拒绝，而且已落盘的屏可能写到一半。
    // `fill` 底下是 `resolve`，对已填的槽再调一次是无操作，先到的那个值算数。
    for (const slot of sceneSlots) slot.fill(Promise.resolve(undefined));
    await draining;
  }

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  // Phase: Media generation (after all scenes generated)
  if (input.enableImageGeneration || input.enableVideoGeneration) {
    await options.onProgress?.({
      step: 'generating_media',
      progress: 90,
      message: 'Generating media files',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl);
      replaceMediaPlaceholders(scenes, mediaMap);
      log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
    } catch (err) {
      log.warn('Media generation phase failed, continuing:', err);
    }
  }

  // Phase: TTS generation
  if (input.enableTTS) {
    await options.onProgress?.({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      await generateTTSForClassroom(scenes, stageId, options.baseUrl);
      log.info('TTS generation complete');
    } catch (err) {
      log.warn('TTS generation phase failed, continuing:', err);
    }
  }

  await options.onProgress?.({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  // 课级元数据：档位 + 目标画像摘要。蓝图缺席（无画像 / 引擎离线）就不写这个字段，
  // 而不是写一份 null 占位——参考 usage-storage.ts 里 classroomId 的同款理由。
  const profile = requirements.learnerProfile;
  const generation: CourseGenerationMeta | undefined =
    courseBlueprint && profile
      ? {
          recommendedDifficulty: courseBlueprint.recommended_difficulty,
          presentationTier: presentationTier(courseBlueprint, profile),
          ...(courseBlueprint.engine ? { engine: courseBlueprint.engine } : {}),
          ...(courseBlueprint.blueprint?.learner_type
            ? { learnerType: courseBlueprint.blueprint.learner_type }
            : {}),
          // 脱敏（赛题第(5)款）：只带领域、学历档与五维自评，
          // 不带 role（身份自述）与 learning_preference（自由文本）。
          profile: {
            ...(profile.domain ? { domain: profile.domain } : {}),
            // 取材的知识库：显式选了才写（没选就是跟着培训领域走，domain 已经记了）。
            ...(profile.corpus?.trim() ? { corpus: profile.corpus.trim() } : {}),
            ...(profile.education ? { education: profile.education } : {}),
            ...(typeof profile.programming_level === 'number'
              ? { programmingLevel: profile.programming_level }
              : {}),
            ...(typeof profile.python_level === 'number'
              ? { pythonLevel: profile.python_level }
              : {}),
            ...(typeof profile.agent_level === 'number'
              ? { agentLevel: profile.agent_level }
              : {}),
            ...(typeof profile.rag_level === 'number' ? { ragLevel: profile.rag_level } : {}),
            ...(typeof profile.engineering_level === 'number'
              ? { engineeringLevel: profile.engineering_level }
              : {}),
          },
        }
      : undefined;

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
      ...(generation ? { generation } : {}),
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
