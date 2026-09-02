/**
 * Stage 1: Generate scene outlines from user requirements.
 * Also contains outline fallback logic.
 */

import { nanoid } from 'nanoid';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type {
  UserRequirements,
  SceneOutline,
  PdfImage,
  ImageMapping,
} from '@/lib/types/generation';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { formatImageDescription, formatImagePlaceholder } from './prompt-formatters';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import { parseJsonResponse } from './json-repair';
import { uniquifyMediaElementIds } from './scene-builder';
import type { AICallFn, GenerationResult } from './pipeline-types';
import { createLogger } from '@/lib/logger';
import {
  bindLearningObjectivesToOutlines,
  groundingRefsForOutline,
  validateAndRepairLearningContract,
  validateVocationalOutline,
  type LearningContract,
  type OutlineEngine,
} from './learning-contract';
import { blueprintDirective, type LearnerBlueprint } from './learner-profile';
const log = createLogger('Generation');
// 每轮修订 1-2 分钟，一门课 45 分钟；模型在严格合同上单条规则的掉落是随机的，
// 两轮不够（2026-09-02 智造域：迁移屏漏挂 O1/O2 两轮都没补上）。三轮仍不合格照旧拒绝。
const MAX_OUTLINE_QUALITY_REVISIONS = 3;
const STANDARD_WIDGET_TYPES = new Set(['simulation', 'diagram', 'code', 'game', 'visualization3d']);

type OutlineGenerationData = {
  languageDirective: string;
  courseTitle?: string;
  outlines: SceneOutline[];
  learningContract?: LearningContract;
};

const OUTLINE_QUALITY_REVISION_SYSTEM = `You are the course-outline quality revision stage.
Return one complete JSON object with exactly languageDirective, courseTitle, learningContract, and outlines. Do not return prose or markdown.
Repair the rejected draft pedagogically: keep sound domain content and learner adaptation, but change objectives, scene mappings, scene types, ordering, descriptions, or phase references when the validator proves they are inconsistent.
Every objective must have a genuine prerequisite, demonstration, learner action, later actionable feedback and retry, and later unseen quiz or PBL assessment. Do not mechanically attach every objective to every scene; a scene may name an objective only when its description and keyPoints actually serve that objective.
Every learnerPractice and feedbackRetry ID must be a quiz or PBL scene (a quiz collects answers, shows analysis and allows retry); the prebuilt interactive widget templates do not grade learner input, so never map a template interactive to learnerPractice or feedbackRetry. Every transferApplication ID and assessmentMap sceneId must be a quiz or PBL scene after feedback; in task-engine outlines this means quiz because PBL is not allowed.
If the validator rejects strategyEvidence (ubd/feynman ordering or scene-type rules) and the course cannot honestly satisfy that cycle, set teachingStrategy to "standard" and omit strategyEvidence instead of forcing an impossible ordering; the six-phase contract still applies in full.
learnerPractice is a minimal contract map, not an inventory of every interactive scene. For every listed practice, verify the strict same-objective order practice.order < feedbackRetry.order < assessment.order. Remove a redundant late practice reference instead of keeping an impossible loop.
For task-engine outlines, the first item in the outlines array must be a slide with no widgetType. Use only slide, quiz, and interactive scenes; include at least three interactive scenes, at least one quiz, no more than three slides, and at least one complete procedural-skill scene.
Interactive scenes must use a supported widgetType and a widgetOutline. PBL scenes must contain a complete pblConfig and must not contain widgetType. Non-interactive scenes must not contain widgetType.
A scene reported as having no supporting evidence in the knowledge base must be reworked to teach content the reference materials cover (reuse their terms and topics from the 知识库术语基准 block), or merged into a covered scene; never keep or rename a scene whose subject the knowledge base does not contain.
Use only the allowed grounding refs. Recheck every listed violation before returning the full corrected JSON.`;

function outlineGenerationViolations(
  outlines: readonly SceneOutline[],
  outlineEngine: OutlineEngine,
): string[] {
  const violations: string[] = [];
  for (const outline of outlines) {
    const scene = outline.id || `scene ${outline.order}`;
    if (!['slide', 'quiz', 'interactive', 'pbl'].includes(outline.type)) {
      violations.push(`${scene} has unsupported scene type: ${String(outline.type)}`);
      continue;
    }
    if (outline.type !== 'interactive' && outline.widgetType) {
      violations.push(`${scene} ${outline.type} scene must not include widgetType`);
    }
    if (outline.type === 'interactive') {
      const allowed =
        STANDARD_WIDGET_TYPES.has(String(outline.widgetType)) ||
        (outlineEngine === 'task-engine' && outline.widgetType === 'procedural-skill');
      if (!allowed) {
        violations.push(
          `${scene} interactive widgetType must be one of: ${[
            ...STANDARD_WIDGET_TYPES,
            ...(outlineEngine === 'task-engine' ? ['procedural-skill'] : []),
          ].join(', ')}`,
        );
      }
      if (
        !outline.widgetOutline ||
        typeof outline.widgetOutline !== 'object' ||
        Array.isArray(outline.widgetOutline)
      ) {
        violations.push(`${scene} interactive scene must include widgetOutline`);
      }
    }
    if (outline.type === 'pbl') {
      const config = outline.pblConfig;
      if (
        typeof config?.projectTopic !== 'string' ||
        !config.projectTopic.trim() ||
        typeof config.projectDescription !== 'string' ||
        !config.projectDescription.trim() ||
        !Array.isArray(config.targetSkills) ||
        config.targetSkills.filter((skill) => typeof skill === 'string' && skill.trim()).length <
          2 ||
        !Number.isInteger(config.issueCount) ||
        (config.issueCount ?? 0) < 2 ||
        (config.issueCount ?? 0) > 5
      ) {
        violations.push(
          `${scene} pblConfig must include projectTopic, projectDescription, 2-5 targetSkills, and issueCount 2-5`,
        );
      }
    }
  }
  return violations;
}

/**
 * Used when the outline stage fails to produce an explicit directive (LLM
 * schema regression, empty response, upstream error). Downstream prompts
 * still need *something* that steers the model toward the requirement's
 * language rather than defaulting to the training-distribution prior.
 */
export const DEFAULT_LANGUAGE_DIRECTIVE =
  'Teach in the language that matches the user requirement.';

/**
 * Generate scene outlines from user requirements
 * Now uses simplified UserRequirements with just requirement text and language
 */
export async function generateSceneOutlinesFromRequirements(
  requirements: UserRequirements,
  pdfText: string | undefined,
  pdfImages: PdfImage[] | undefined,
  aiCall: AICallFn,
  options?: {
    visionEnabled?: boolean;
    imageMapping?: ImageMapping;
    imageGenerationEnabled?: boolean;
    videoGenerationEnabled?: boolean;
    researchContext?: string;
    teacherContext?: string;
    outlineEngine?: OutlineEngine;
    learnerBlueprint?: LearnerBlueprint;
    /** Production callers enable this to block structurally incomplete courses. */
    enforceLearningContract?: boolean;
    /**
     * 逐屏证据覆盖预检：给每个 outline 回答「知识库里有没有能支撑这一屏的材料」。
     * 返回 false 的屏作为 validator violation 进入同一套两轮修订循环——大纲编出语料不覆盖的屏
     * （需求点名「安全前置」而库里只有 ROS2/PLC 文档）以前要到 40% 才被屏级证据闸击杀。
     * 探针自身异常按「覆盖」处理，不拦车（与 zeroEvidenceReason 同口径）。
     */
    sceneEvidenceProbe?: (outline: SceneOutline, courseTitle: string) => Promise<boolean>;
  },
): Promise<GenerationResult<OutlineGenerationData>> {
  // Build available images description for the prompt
  let availableImagesText = 'No images available';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (pdfImages && pdfImages.length > 0) {
    if (options?.visionEnabled && options?.imageMapping) {
      // Vision mode: split into vision images (first N) and text-only (rest)
      const sortedImages = sortDocumentImagesForVision(pdfImages);
      const allWithSrc = sortedImages.filter((img) => options.imageMapping![img.id]);
      const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = sortedImages.filter((img) => !options.imageMapping![img.id]);

      const visionDescriptions = visionSlice.map((img) => formatImagePlaceholder(img));
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
        formatImageDescription(img),
      );
      availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((img) => ({
        id: img.id,
        src: options.imageMapping![img.id],
        width: img.width,
        height: img.height,
      }));
    } else {
      // Text-only mode: full descriptions
      availableImagesText = pdfImages.map((img) => formatImageDescription(img)).join('\n');
    }
  }

  // Build user profile string for prompt injection
  const learnerDirective =
    requirements.learnerProfile && options?.learnerBlueprint
      ? blueprintDirective(options.learnerBlueprint, requirements.learnerProfile) +
        `\n课程编排要求：难度档 ${options.learnerBlueprint.recommended_difficulty} 的学习者，` +
        '场景序列必须覆盖讲解、实操、测验和反馈重试；薄弱概念要单独成场景补足。'
      : '';
  const userProfileText =
    requirements.userNickname || requirements.userBio || learnerDirective
      ? `## Student Profile\n\nStudent: ${requirements.userNickname || '目标学习者'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.${learnerDirective}\n\n---`
      : '';

  // Build media snippet conditions based on enabled flags.
  const imageEnabled = options?.imageGenerationEnabled ?? false;
  const videoEnabled = options?.videoGenerationEnabled ?? false;
  const mediaEnabled = imageEnabled || videoEnabled;
  const hasSourceImages = (pdfImages?.length ?? 0) > 0;
  const outlineEngine =
    options?.outlineEngine ??
    (requirements.taskEngineMode
      ? 'task-engine'
      : requirements.interactiveMode
        ? 'interactive'
        : 'standard');
  const promptId =
    outlineEngine === 'task-engine'
      ? PROMPT_IDS.TASK_ENGINE_OUTLINES
      : outlineEngine === 'interactive'
        ? PROMPT_IDS.INTERACTIVE_OUTLINES
        : PROMPT_IDS.REQUIREMENTS_TO_OUTLINES;
  const groundingRefs = groundingRefsForOutline(requirements, {
    hasUploadedMaterials: Boolean(pdfText?.trim() || pdfImages?.length),
    hasResearchContext: Boolean(options?.researchContext?.trim()),
  });

  // Use simplified prompt variables
  const prompts = buildPrompt(promptId, {
    // New simplified variables
    requirement: requirements.requirement,
    pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
    availableImages: availableImagesText,
    userProfile: userProfileText,
    hasSourceImages,
    imageEnabled,
    videoEnabled,
    mediaEnabled,
    researchContext: options?.researchContext || 'None',
    // Server-side generation populates this via options; client-side populates via formatTeacherPersonaForPrompt
    teacherContext: options?.teacherContext || '',
    groundingRefs,
  });

  if (!prompts) {
    return { success: false, error: 'Prompt template not found' };
  }

  const evaluateResponse = (
    response: string,
  ): { result: GenerationResult<OutlineGenerationData>; violations?: string[] } => {
    const parsed = parseJsonResponse<
      | {
          languageDirective: string;
          courseTitle?: string;
          learningContract?: unknown;
          outlines: SceneOutline[];
        }
      | SceneOutline[]
    >(response);

    let languageDirective: string;
    let courseTitle: string | undefined;
    let rawOutlines: SceneOutline[];
    let rawLearningContract: unknown;

    if (Array.isArray(parsed)) {
      // Fallback: LLM returned old flat array format
      languageDirective = DEFAULT_LANGUAGE_DIRECTIVE;
      rawOutlines = parsed;
    } else if (parsed && parsed.outlines) {
      languageDirective = parsed.languageDirective || DEFAULT_LANGUAGE_DIRECTIVE;
      // courseTitle is optional — only honor a non-empty string, and cap its
      // length defensively (the prompt asks for ≤30 chars, but older/hallucinating
      // models may return far more). The downstream Stage.name column is bounded too.
      const rawTitle = parsed.courseTitle;
      courseTitle =
        typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : undefined;
      rawOutlines = parsed.outlines;
      rawLearningContract = parsed.learningContract;
    } else {
      return { result: { success: false, error: 'Failed to parse scene outlines response' } };
    }

    if (!Array.isArray(rawOutlines)) {
      return { result: { success: false, error: 'Failed to parse scene outlines response' } };
    }

    // Ensure IDs and order
    const enriched = rawOutlines.map((outline, index) => ({
      ...outline,
      id: outline.id || nanoid(),
      order: index + 1,
    }));

    // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
    let result = uniquifyMediaElementIds(enriched);

    if (options?.enforceLearningContract) {
      // Ordinary generation must not accidentally publish a gated procedural
      // widget merely because the model emitted one. Validate the effective
      // outlines that downstream generation will actually receive.
      if (outlineEngine !== 'task-engine') {
        result = result.map((outline) =>
          outline.widgetType === 'procedural-skill'
            ? sanitizeProceduralSkillOutline(outline)
            : outline,
        );
      }

      let contractResult = validateAndRepairLearningContract(rawLearningContract, result, {
        allowedGroundingRefs: groundingRefs,
      });
      // 策略证据（UbD/Feynman 的 strategyEvidence）是规划元数据，不是学生可见内容，也不是
      // 六阶段门禁的一部分。模型常常选了 ubd 却排不出 performanceEvidence → reflectionRevision
      // → transfer 的严格顺序，两轮修订仍栽在同一条上，整门课因此拒绝生成（2026-09-02 AI 域实测）。
      // 当**仅剩**策略证据违规时，确定性降级到 standard 并重新校验：六阶段、练习/反馈/迁移/
      // 评价的全部规则一条不减；降级如实写日志。其他任何违规照旧拒绝。
      const onlyStrategyViolations =
        contractResult.violations.length > 0 &&
        contractResult.violations.every((v) => /^(ubd|feynman) /.test(v)) &&
        rawLearningContract !== null &&
        typeof rawLearningContract === 'object' &&
        !Array.isArray(rawLearningContract);
      if (onlyStrategyViolations) {
        const { strategyEvidence: _dropped, ...rest } = rawLearningContract as Record<
          string,
          unknown
        >;
        const downgraded = validateAndRepairLearningContract(
          { ...rest, teachingStrategy: 'standard' },
          result,
          { allowedGroundingRefs: groundingRefs },
        );
        if (downgraded.publishable && downgraded.contract && downgraded.violations.length === 0) {
          log.info(
            `Learning contract strategy downgraded to standard (strategy evidence rejected: ${contractResult.violations.join('; ')})`,
          );
          contractResult = downgraded;
        }
      }
      const violations = [
        ...contractResult.violations,
        ...outlineGenerationViolations(result, outlineEngine),
        ...(outlineEngine === 'task-engine' ? validateVocationalOutline(result) : []),
      ];
      if (!contractResult.publishable || !contractResult.contract || violations.length > 0) {
        return {
          result: {
            success: false,
            error: `Teaching-quality contract rejected: ${violations.join('; ')}`,
          },
          violations,
        };
      }

      return {
        result: {
          success: true,
          data: {
            languageDirective,
            courseTitle,
            outlines: bindLearningObjectivesToOutlines(contractResult.contract, result),
            learningContract: contractResult.contract,
          },
        },
      };
    }

    return {
      result: { success: true, data: { languageDirective, courseTitle, outlines: result } },
    };
  };

  // 结构校验通过后再问证据：每屏探一次，零命中的屏变成 violation 走同一条修订路。
  const evaluateWithEvidence = async (
    response: string,
  ): Promise<{ result: GenerationResult<OutlineGenerationData>; violations?: string[] }> => {
    const evaluated = evaluateResponse(response);
    const probe = options?.sceneEvidenceProbe;
    if (!probe || !evaluated.result.success || !evaluated.result.data) return evaluated;
    const { outlines: drafted, courseTitle: title } = evaluated.result.data;
    const uncovered: string[] = [];
    for (const outline of drafted) {
      let covered = true;
      try {
        covered = await probe(outline, title ?? '');
      } catch {
        covered = true;
      }
      if (!covered) {
        uncovered.push(
          `${outline.id} 「${outline.title}」 has no supporting evidence in the knowledge base (0 chunks). ` +
            'Rework this scene so it teaches something the reference materials actually cover, or merge it into a covered scene; ' +
            'do not invent content the knowledge base lacks.',
        );
      }
    }
    if (uncovered.length === 0) return evaluated;
    return {
      result: {
        success: false,
        error: `Teaching-quality contract rejected: ${uncovered.join('; ')}`,
      },
      violations: uncovered,
    };
  };

  try {
    let response = await aiCall(prompts.system, prompts.user, visionImages);
    let evaluated = await evaluateWithEvidence(response);
    for (let revision = 0; revision < MAX_OUTLINE_QUALITY_REVISIONS; revision += 1) {
      if (evaluated.result.success || !evaluated.violations?.length) return evaluated.result;
      const revisionPrompt = [
        `Course requirement: ${requirements.requirement}`,
        `Outline engine: ${outlineEngine}`,
        `Allowed grounding refs: ${JSON.stringify(groundingRefs)}`,
        'Validator violations:',
        ...evaluated.violations.map((violation) => `- ${violation}`),
        'Previous complete draft JSON:',
        response,
      ].join('\n');
      response = await aiCall(OUTLINE_QUALITY_REVISION_SYSTEM, revisionPrompt);
      evaluated = await evaluateWithEvidence(response);
    }
    if (!evaluated.result.success && evaluated.violations?.length) {
      return {
        success: false,
        error: `Teaching-quality contract rejected after ${MAX_OUTLINE_QUALITY_REVISIONS} quality revisions: ${evaluated.violations.join('; ')}`,
      };
    }
    return evaluated.result;
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Apply type fallbacks for outlines that can't be generated as their declared type.
 * - interactive without interactiveConfig OR widgetType+widgetOutline → slide
 * - pbl without pblConfig or languageModel → slide
 */
export function sanitizeProceduralSkillOutline(outline: SceneOutline): SceneOutline {
  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}

export function applyOutlineFallbacks(
  outline: SceneOutline,
  hasLanguageModel: boolean,
  options: { allowProceduralSkill?: boolean } = {},
): SceneOutline {
  // Ultra Mode: interactive scenes with widgetType + widgetOutline are valid
  const hasWidgetConfig = outline.widgetType && outline.widgetOutline;

  if (outline.widgetType === 'procedural-skill' && !options.allowProceduralSkill) {
    log.warn(`Procedural-skill outline "${outline.title}" is not enabled, falling back to diagram`);
    return sanitizeProceduralSkillOutline(outline);
  }

  if (outline.type === 'interactive' && !outline.interactiveConfig && !hasWidgetConfig) {
    log.warn(
      `Interactive outline "${outline.title}" missing interactiveConfig and widget config, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  if (outline.type === 'pbl' && (!outline.pblConfig || !hasLanguageModel)) {
    log.warn(
      `PBL outline "${outline.title}" missing pblConfig or languageModel, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  return outline;
}
