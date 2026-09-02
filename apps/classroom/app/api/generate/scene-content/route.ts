/**
 * Scene Content Generation API
 *
 * Generates scene content (slides/quiz/interactive/pbl) from an outline.
 * This is the first half of the two-step scene generation pipeline.
 * Does NOT generate actions — use /api/generate/scene-actions for that.
 */

import { NextRequest } from 'next/server';
import { callLLM, streamLLM } from '@/lib/ai/llm';
import {
  applyOutlineFallbacks,
  generateSceneContent,
  buildVisionUserContent,
} from '@/lib/generation/generation-pipeline';
import {
  buildLecturePrompts,
  lectureContentFromMd,
  scrubScaffoldElements,
} from '@/lib/generation/scene-generator';
import { cleanLectureMarkdown } from '@/lib/generation/md-to-elements';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
  ScenePipelineMeta,
} from '@/lib/types/generation';
import { extractVerifiables, verifyContent } from '@/lib/generation/content-verify';
import {
  coherenceDirective,
  coherenceFromOutlines,
  emptyProgress,
} from '@/lib/generation/course-coherence';
import { isCourseCoherenceEnabled } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';

// 跨场景摘录去重：同一门课（stageId）里每段教材原文只整段出现一次，后续场景回指。
// 进程内 Map 足够——dev/演示都是单进程；条目上限防泄漏。
const usedExcerptsByStage = new Map<string, Set<string>>();
const MAX_TRACKED_STAGES = 100;
function usedExcerptsFor(stageId: string): Set<string> {
  let set = usedExcerptsByStage.get(stageId);
  if (!set) {
    if (usedExcerptsByStage.size >= MAX_TRACKED_STAGES) {
      const oldest = usedExcerptsByStage.keys().next().value;
      if (oldest !== undefined) usedExcerptsByStage.delete(oldest);
    }
    set = new Set();
    usedExcerptsByStage.set(stageId, set);
  }
  return set;
}
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import {
  fetchEvidence,
  requireEvidenceWhenConfigured,
  evidenceDirective,
  excerptDirective,
  injectExcerpts,
  type ExcerptStats,
} from '@/lib/generation/evidence-grounding';
import {
  corpusOf,
  fetchLearnerBlueprint,
  blueprintDirective,
  excerptDifficultyCap,
  excerptCodeLineCap,
  beginnerCodeFormOnly,
} from '@/lib/generation/learner-profile';
import { sceneConceptsFromChunks } from '@/lib/evidence/scene-concepts';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import { usageAttribution } from '@/lib/ai/usage-context';
import type { ModelFallbackEvent } from '@/lib/ai/model-fallback';

const log = createLogger('Scene Content API');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let outlineTitle: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();
    const {
      outline: rawOutline,
      allOutlines,
      pdfImages,
      imageMapping,
      stageInfo: _stageInfo,
      stageId,
      agents,
      languageDirective,
      requirements,
      stream,
      usedTemplateIds: rawUsedTemplateIds,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      stageInfo: {
        name: string;
        description?: string;
        style?: string;
      };
      stageId: string;
      agents?: AgentInfo[];
      languageDirective?: string;
      requirements?: UserRequirements;
      /** 讲义流式分支（SSE 增量），slide 专用；不合格自动回落非流式 */
      stream?: boolean;
      /** 本课已用过的教具模板 id（同课形态去重信号） */
      usedTemplateIds?: unknown;
    };

    const usedTemplateIds = Array.isArray(rawUsedTemplateIds)
      ? rawUsedTemplateIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

    // Validate required fields
    if (!rawOutline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
      );
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }
    const corpus = corpusOf(requirements?.learnerProfile) ?? 'ai';
    const access = await requireCorpusVisible(corpus);
    if (!access.ok) return access.response;
    // 交互式生成的 token 账也归到这门课。批量路径在 `classroom-generation.ts` 里
    // 用 `run()` 把整段包住；这条是**逐场景的单次请求**，一个请求就是一门课，
    // 所以用 `enterWith` 就地进上下文——不用把整个 handler 缩进一层重排。
    // `stageId` 请求体里本来就有，上面刚校验过。
    // `fallbacks` 是本次请求的回落留痕收集器（WO-M2）：callLLM 换了模型就往里追加，
    // 下面 finalizeContent 原样读出来填进产物元数据。开关默认关时永远是空数组。
    const attribution = { classroomId: stageId, fallbacks: [] as ModelFallbackEvent[] };
    usageAttribution.enterWith(attribution);

    const outline: SceneOutline = { ...rawOutline };

    // ── Model resolution from request headers/body ──
    // Route per scene-content type (e.g. `scene-content:quiz`); getStageModel
    // falls back to the base `scene-content` route when the type is unrouted.
    const stage = outline.type ? (`scene-content:${outline.type}` as const) : 'scene-content';
    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, stage);
    outlineTitle = rawOutline?.title;
    resolvedModelString = modelString;

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // Vision-aware AI call function
    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
      images?: Array<{ id: string; src: string }>,
    ): Promise<string> => {
      if (images?.length && hasVision) {
        const result = await callLLM(
          {
            model: languageModel,
            system: systemPrompt,
            messages: [
              {
                role: 'user' as const,
                content: buildVisionUserContent(userPrompt, images),
              },
            ],
            maxOutputTokens: modelInfo?.outputWindow,
            maxRetries: 0,
          },
          'scene-content',
          undefined,
          thinkingConfig,
        );
        return result.text;
      }
      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: modelInfo?.outputWindow,
          maxRetries: 0,
        },
        'scene-content',
        undefined,
        thinkingConfig,
      );
      return result.text;
    };

    // ── Apply fallbacks ──
    const vocationalActive = resolveVocationalActive(requirements);
    const effectiveOutline = applyOutlineFallbacks(outline, !!languageModel, {
      allowProceduralSkill: vocationalActive,
    });

    // ── Multi-agent graft: diagnosis agent plans, retrieval agent fences facts ──
    // Both fold into outline.description (zero schema intrusion). A configured
    // evidence bridge is mandatory; only an unconfigured local runtime is optional.
    const courseTitle = _stageInfo?.name ?? '';
    // 桥真失败（配了但调用炸了）收进 pipeline.bridgeWarnings → 车间面板红行。
    // 未配置不进来；配置后的零命中或故障会阻断本课。
    const bridgeWarnings: string[] = [];
    const onBridgeFailure = (msg: string) => bridgeWarnings.push(msg);
    const [evidenceResult, learnerPlan] = await Promise.all([
      // Course title anchors the query — scene titles alone (e.g. "角色扮演模拟")
      // are often metaphorical and retrieve the wrong concepts.
      fetchEvidence(
        `${courseTitle} ${effectiveOutline.title} ${effectiveOutline.description ?? ''}`.trim(),
        // 显式选的知识库优先，否则沿用培训领域；未建的库返回空而不是拿 AI 语料
        // 顶上（见 fetchEvidence）。
        corpus,
        // 掌握度触发 outer-fringe 选段：已会概念的块被引擎跳过（带理由）。
        requirements?.learnerProfile?.conceptMastery,
        onBridgeFailure,
        // 摘录难度跟姿态档走——超档摘录会把 L1 讲义整段拖硬（2A 纯净测病根）。
        requirements?.learnerProfile
          ? excerptDifficultyCap(requirements.learnerProfile)
          : undefined,
        // 摘录代码形态也跟姿态档走：难度档管不住代码长度，零基础档限 5 行。
        requirements?.learnerProfile ? excerptCodeLineCap(requirements.learnerProfile) : undefined,
        // 长度也管不住**结构**：零基础档再加一道 import/def/class 闸。
        requirements?.learnerProfile
          ? beginnerCodeFormOnly(requirements.learnerProfile)
          : undefined,
      ),
      requirements?.learnerProfile
        ? fetchLearnerBlueprint(
            `${courseTitle} ${requirements.requirement ?? ''}`.trim() || effectiveOutline.title,
            requirements.learnerProfile,
            onBridgeFailure,
          )
        : Promise.resolve(null),
    ]);
    for (const w of bridgeWarnings) {
      log.warn(`Engine bridge degraded for "${effectiveOutline.title}": ${w}`);
    }
    const evidence = requireEvidenceWhenConfigured(evidenceResult);

    // 拼装模式（路线实验 E3 落地）：有证据时默认开。EXCERPT_ASSEMBLY=0 关掉回纯生成。
    const assemblyMode = evidence != null && process.env.EXCERPT_ASSEMBLY !== '0';
    if (evidence) {
      effectiveOutline.description =
        (effectiveOutline.description ?? '') +
        evidenceDirective(evidence) +
        (assemblyMode ? excerptDirective(evidence) : '');
      log.info(
        `Grounded "${effectiveOutline.title}" with ${evidence.chunks.length} evidence chunks (${evidence.matchedConcepts.join(',')})${assemblyMode ? ' [assembly]' : ''}` +
          (evidence.skipped?.length ? ` [fringe: ${evidence.skipped.length} 块已会跳过]` : ''),
      );
    }
    // 这一页讲什么，生成时就定下来：按检索到的教材块的 concept_tags 计票
    // （口径见 sceneConceptsFromChunks，与 derive_scene_concepts.py 同源）。
    // 挂在回传的 effectiveOutline 上，由 scene-actions 写进组装好的场景——
    // 客户端生成循环原样把 effectiveOutline 传给 scene-actions，不必改它。
    // 没有证据就不写这个字段，下游据此保持旧的按标题归拢行为。
    const sceneConcepts = evidence ? sceneConceptsFromChunks(evidence.chunks) : null;
    if (sceneConcepts) {
      effectiveOutline.concepts = sceneConcepts;
    }
    if (learnerPlan) {
      // 逐屏路的一致性状态从 allOutlines 现算（`coherenceFromOutlines`）。
      // 不接这一步，类比换喻体、同一数字例反复推演在这条路上照旧——
      // 批量路治好了，逐屏路没治，同一个坑位第三次。
      // 消融开关：`COURSE_COHERENCE=0` 时不算状态、也不拼指令。
      const coherenceOn = isCourseCoherenceEnabled();
      const { frame, progress } = coherenceOn
        ? coherenceFromOutlines(allOutlines, effectiveOutline.id)
        : { frame: {}, progress: emptyProgress() };
      progress.widgets = usedTemplateIds;
      effectiveOutline.description =
        (effectiveOutline.description ?? '') +
        blueprintDirective(learnerPlan, requirements!.learnerProfile!) +
        (coherenceOn ? coherenceDirective(frame, progress) : '');
      const mix = learnerPlan.blueprint?.resource_mix;
      log.info(
        `Adapted "${effectiveOutline.title}" for ${learnerPlan.blueprint?.learner_type} ` +
          `(难度 ${learnerPlan.recommended_difficulty}, 支架 ${mix?.scaffold_level}, 类比 ${mix?.analogy_domain?.slice(0, 12)})`,
      );
    }

    // ── Filter images assigned to this outline ──
    let assignedImages: PdfImage[] | undefined;
    if (
      pdfImages &&
      pdfImages.length > 0 &&
      effectiveOutline.suggestedImageIds &&
      effectiveOutline.suggestedImageIds.length > 0
    ) {
      const suggestedIds = new Set(effectiveOutline.suggestedImageIds);
      assignedImages = sortDocumentImagesForVision(
        pdfImages.filter((img) => suggestedIds.has(img.id)),
      );
    }

    // ── Media generation is handled client-side in parallel (media-orchestrator.ts) ──
    // The content generator receives placeholder IDs (gen_img_1, gen_vid_1) as-is.
    // resolveImageIds() in generation-pipeline.ts will keep these placeholders in elements.
    const generatedMediaMapping: ImageMapping = {};

    // ── 生成后处理（两条分支共用）：摘录注入 + KR2 验算 + 车间面板数据 ──
    const finalizeContent = async (content: unknown): Promise<ScenePipelineMeta> => {
      // 摘录占位符 → 教材原文，机械替换（位置模型排，内容机器贴——模型手抄必漂移）
      let assemblyStats: ExcerptStats | null = null;
      if (assemblyMode && evidence) {
        const stats = await injectExcerpts(
          content,
          evidence,
          typeof stageId === 'string' && stageId ? usedExcerptsFor(stageId) : undefined,
        );
        assemblyStats = stats;
        if (Object.values(stats).some((n) => n > 0)) {
          log.info(
            `Excerpt injection "${effectiveOutline.title}": ${stats.injected} injected` +
              (stats.swapped ? `, ${stats.swapped} swapped(换更咬合的候选)` : '') +
              (stats.deduped ? `, ${stats.deduped} deduped` : '') +
              (stats.capped ? `, ${stats.capped} capped` : '') +
              (stats.unknown ? `, ${stats.unknown} unknown dropped` : '') +
              (stats.rejected ? `, ${stats.rejected} rejected(不自包含)` : '') +
              (stats.irrelevant ? `, ${stats.irrelevant} irrelevant(与前文不咬合)` : '') +
              (stats.noLead ? `, ${stats.noLead} noLead(无引导句)` : ''),
          );
        } else {
          // 模型整节没写占位符也要留痕——「弃引」与「被拒」必须可区分
          log.info(
            `Excerpt injection "${effectiveOutline.title}": 0 placeholders written by model`,
          );
        }
      }

      // ── 可执行验证（KR2）：交付前机械验算代码块与数值等式（引擎侧零 LLM）──
      let verification: ScenePipelineMeta['verification'] = null;
      const contentElements = (content as { elements?: unknown[] }).elements;
      if (Array.isArray(contentElements)) {
        const { codeBlocks, texts } = extractVerifiables(contentElements);
        verification = await verifyContent(codeBlocks, texts, onBridgeFailure);
        if (verification) {
          log.info(
            `Verified "${effectiveOutline.title}": code ${verification.codePassed}✓/${verification.codeFailed}✗/${verification.codeUnverifiable}? ` +
              `arith ${verification.arithmeticPassed}/${verification.arithmeticChecked}` +
              (verification.failures.length ? ` failures=${verification.failures.join('；')}` : ''),
          );
        }
      }

      // 车间面板数据：全部来自已算出的变量，没跑的阶段就是 null，不编造。
      return {
        blueprint: learnerPlan
          ? {
              learnerType: learnerPlan.blueprint?.learner_type ?? null,
              difficulty: learnerPlan.recommended_difficulty ?? null,
              scaffold: learnerPlan.blueprint?.resource_mix?.scaffold_level ?? null,
              analogyDomain: learnerPlan.blueprint?.resource_mix?.analogy_domain ?? null,
              engine: learnerPlan.engine ?? null,
            }
          : null,
        evidence: evidence
          ? {
              hits: evidence.chunks.length,
              skippedCount: evidence.skipped?.length ?? 0,
              skippedReasons: (evidence.skipped ?? []).slice(0, 2).map((s) => s.reason),
              matchedConcepts: evidence.matchedConcepts,
              mode: evidence.selectionMode ?? 'plain',
            }
          : null,
        assembly: assemblyStats
          ? { injected: assemblyStats.injected, deduped: assemblyStats.deduped }
          : null,
        ...(bridgeWarnings.length ? { bridgeWarnings } : {}),
        // 本页真是备胎生成的就说是备胎生成的。没发生 = null，不编。
        modelFallback: attribution.fallbacks.length ? [...attribution.fallbacks] : null,
        verification,
      };
    };

    // ── 讲义流式分支（2026-08-04 提速批三段：边生成边读）──
    // slide 且无媒体时走 SSE：md 增量实时推给等待界面，收尾在服务端完成
    // md→DSL/摘录注入/KR2 验算，final result 事件与非流式响应同构。
    // 讲义 md 不合格发 fallback 事件，客户端回落非流式（槽位/自由版面链）。
    const lectureStreamEligible =
      stream === true &&
      effectiveOutline.type === 'slide' &&
      process.env.LECTURE_SCENE_MODE !== '0' &&
      !(assignedImages?.length ?? 0) &&
      !(effectiveOutline.mediaGenerations?.length ?? 0);
    if (lectureStreamEligible) {
      const prompts = buildLecturePrompts(effectiveOutline, languageDirective);
      if (prompts) {
        log.info(`Streaming lecture content: "${effectiveOutline.title}" [model=${modelString}]`);
        const encoder = new TextEncoder();
        const sse = new ReadableStream({
          async start(controller) {
            // 客户端断开（换页/HMR）后 controller 关闭，再 enqueue 会抛
            // "Controller is already closed"——孤儿流静默收场，不打 500 噪音。
            let closed = false;
            const send = (obj: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
              } catch {
                closed = true;
              }
            };
            try {
              const result = streamLLM(
                {
                  model: languageModel,
                  system: prompts.system,
                  prompt: prompts.user,
                  maxOutputTokens: modelInfo?.outputWindow,
                  maxRetries: 0,
                },
                'scene-content',
                thinkingConfig,
              );
              let full = '';
              for await (const delta of result.textStream) {
                full += delta;
                send({ type: 'delta', text: delta });
              }
              const md = cleanLectureMarkdown(full, effectiveOutline.title);
              // 流式成稿是第三条出口——它既不经过 `generateSlideContent`（那条挂着
              // 脚手架清除）也不经过 `runAdaptationLintLoop`。第三代对照课实测：
              // 首屏 6 处「导读：」上屏，第 2/4/6 屏全干净，差别就在这一行。
              const content = scrubScaffoldElements(
                md ? lectureContentFromMd(md, effectiveOutline) : null,
                effectiveOutline.title,
              );
              if (!content) {
                log.warn(
                  `Streamed lecture markdown unusable for "${effectiveOutline.title}", client will fall back`,
                );
                send({ type: 'fallback' });
              } else {
                const pipeline = await finalizeContent(content);
                log.info(`Content generated successfully (stream): "${effectiveOutline.title}"`);
                send({ type: 'result', payload: { content, effectiveOutline, pipeline } });
              }
            } catch (err) {
              log.error(`Lecture stream failed for "${effectiveOutline.title}":`, err);
              send({ type: 'fallback' });
            }
            if (!closed) {
              try {
                controller.close();
              } catch {
                /* already closed by disconnect */
              }
            }
          },
        });
        return new Response(sse, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        });
      }
    }

    // ── Generate content ──
    log.info(
      `Generating content: "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`,
    );

    const userLocale = req.headers?.get('x-user-locale') ?? '';

    const content = await generateSceneContent(effectiveOutline, aiCall, {
      assignedImages,
      imageMapping,
      languageModel: effectiveOutline.type === 'pbl' ? languageModel : undefined,
      visionEnabled: hasVision,
      generatedMediaMapping,
      agents,
      languageDirective,
      thinkingConfig,
      targetLanguage: userLocale || undefined,
      userRequirements: requirements,
      allowProceduralSkill: vocationalActive,
      usedTemplateIds,
    });

    if (!content) {
      log.error(`Failed to generate content for: "${effectiveOutline.title}"`);

      return apiError(
        'GENERATION_FAILED',
        500,
        `Failed to generate content: ${effectiveOutline.title}`,
      );
    }

    const pipeline = await finalizeContent(content);
    log.info(`Content generated successfully: "${effectiveOutline.title}"`);

    return apiSuccess({ content, effectiveOutline, pipeline });
  } catch (error) {
    log.error(
      `Scene content generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error);
  }
}
