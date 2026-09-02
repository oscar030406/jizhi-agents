import type { DomainRegistryEntry } from '@/lib/knowledge/domain-registry';
import { pblProductionGaps } from '@/lib/pbl/v2/types';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import { extractContentVerifiables } from './content-verify';
import { validateTemplateParams } from './widget-templates';

export type OutlineEngine = 'standard' | 'interactive' | 'task-engine';

export const TEACHING_STRATEGIES = ['standard', 'ubd', 'feynman'] as const;
export type TeachingStrategy = (typeof TEACHING_STRATEGIES)[number];

export interface UbDStrategyEvidence {
  essentialQuestion: string;
  enduringUnderstanding: string;
  performanceEvidence: string;
  reflectionRevision: string;
  transfer: string;
}

export interface FeynmanStrategyEvidence {
  learnerExplanation: string;
  gapDiagnosis: string;
  diagnosedGapCount: 1 | 2;
  plainLanguageRebuild: string;
  analogyBoundary: string;
  transfer: string;
}

export type TeachingStrategyEvidence = UbDStrategyEvidence | FeynmanStrategyEvidence;

export interface OutlineEngineDecision {
  engine: OutlineEngine;
  reason: 'standard' | 'interactive' | 'request' | 'requirement' | 'domain-metadata';
}

export interface LearningObjectiveContract {
  id: string;
  /** Observable learner action, not "understand" or "know". */
  action: string;
  /** Conditions, inputs, tools, or context under which the action is performed. */
  condition: string;
  /** Observable pass criterion. */
  successCriterion: string;
}

export interface LearningContract {
  teachingStrategy: TeachingStrategy;
  strategyEvidence?: TeachingStrategyEvidence;
  objectives: LearningObjectiveContract[];
  prerequisiteActivation: string[];
  demonstration: string[];
  learnerPractice: string[];
  feedbackRetry: string[];
  transferApplication: string[];
  assessmentMap: Array<{ sceneId: string; objectiveIds: string[] }>;
  grounding: {
    sourceRefs: string[];
    claimPolicy: 'cite-or-mark-uncertain';
  };
}

export interface LearningContractValidation {
  contract: LearningContract | null;
  publishable: boolean;
  repaired: boolean;
  violations: string[];
}

export type LearningContractPhase =
  | 'prerequisiteActivation'
  | 'demonstration'
  | 'learnerPractice'
  | 'feedbackRetry'
  | 'transferApplication';

/**
 * 课程落盘时保留的最小教学契约。目标正文与依据已在大纲阶段验过；发布门只需要
 * 知道原计划有哪些场景、各教学环节依赖哪些场景，才能发现生成途中被跳过或降级的页。
 */
export interface LearningContractPlan {
  version: 2;
  teachingStrategy: TeachingStrategy;
  strategyEvidence?: TeachingStrategyEvidence;
  objectives: LearningObjectiveContract[];
  plannedScenes: Array<{
    sceneId: string;
    type: SceneOutline['type'];
    widgetType?: SceneOutline['widgetType'];
    objectiveIds: string[];
  }>;
  required: Record<LearningContractPhase, string[]> & { assessment: string[] };
}

export interface LearningContractActualScene {
  outlineId?: string;
  type?: string;
  content?: unknown;
  actions?: unknown;
}

export interface LearningContractFulfillment {
  fulfilled: boolean;
  violations: string[];
}

export interface LearningContractAlignmentProof {
  courseContentHash: string;
  learningContractHash: string;
  complete: boolean;
  aligned: boolean;
  violations: string[];
}

const EXPLICIT_VOCATIONAL_INTENT =
  /(?:岗位实训|职业实训|技能实训|工单|标准作业|操作规程|巡检|点检|检修|维修|装配|调试|交接|上锁挂牌|岗位任务|\b(?:vocational|work order|standard operating procedure|SOP|hands-on training|inspection|maintenance|repair|assembly|commissioning|lockout)\b)/iu;

const OPERATION_ACTION =
  /(?:操作|执行|检查|确认|测量|记录|校准|排查|更换|安装|拆装|启动|停机|上电|断电|处置|复查|巡检|点检|检修|维修|装配|调试|交接|\b(?:operate|perform|inspect|measure|calibrate|troubleshoot|replace|install|start up|shut down|handoff)\b)/iu;

const WORKFLOW_OR_JUDGMENT =
  /(?:步骤|流程|工单|工具|设备|仪器|防护|风险|阈值|异常|合格|不合格|继续|停止|安全|复查|交接|GO\s*\/?\s*STOP|\b(?:procedure|workflow|tool|equipment|PPE|risk|threshold|pass|fail|safe|unsafe|recheck)\b)/iu;

// 程序性/动手类动作动词：只在课程没有 pbl 场景时视为不可评（见目标校验处注释）
const PROCEDURAL_ACTION =
  /(执行|配置|操作|标定|安装|调试|上电|部署|搭建|接线|维修|更换|校准|停机|编写|写出.{0,8}代码|写代码|运行代码|调用.{0,6}工具完成|perform|configure|operate|install|calibrate|deploy|set up|write (the )?code|run (the )?code)/iu;
const NON_MEASURABLE_ACTION =
  /^(?:(?:理解|了解|掌握|熟悉|知道|认识|学习)(?:.+)?|(?:understand|know|learn|be familiar with|appreciate)(?:\s+.+)?)$/iu;
const OBSERVABLE_ACTION =
  /(?:解释|识别|列出|比较|区分|分析|计算|设计|构建|创建|编写|运行|执行|操作|检查|测量|记录|判断|选择|完成|排查|修复|展示|演示|应用|迁移|评估|验证|交付|组装|安装|配置|\b(?:explain|identify|list|compare|distinguish|analyze|calculate|design|build|create|write|run|perform|operate|inspect|measure|record|decide|select|complete|troubleshoot|repair|demonstrate|apply|assess|validate|deliver|assemble|install|configure|produce)\b)/iu;

function isProceduralRequirement(requirement: string): boolean {
  return OPERATION_ACTION.test(requirement) && WORKFLOW_OR_JUDGMENT.test(requirement);
}

/**
 * Pick the strongest existing outline engine without a per-domain content table.
 * The domain signal is the intake-authored `hands_on_safety` bit; requirement
 * matching only looks for general work-task structure, never domain facts.
 */
export function resolveOutlineEngine(
  requirements: UserRequirements,
  domainMetadata: Pick<DomainRegistryEntry, 'hands_on_safety'> | undefined,
  options: { vocationalEnabled: boolean },
): OutlineEngineDecision {
  if (options.vocationalEnabled) {
    if (requirements.taskEngineMode === true) {
      return { engine: 'task-engine', reason: 'request' };
    }
    if (
      domainMetadata?.hands_on_safety === true &&
      isProceduralRequirement(requirements.requirement)
    ) {
      return { engine: 'task-engine', reason: 'domain-metadata' };
    }
    if (EXPLICIT_VOCATIONAL_INTENT.test(requirements.requirement)) {
      return { engine: 'task-engine', reason: 'requirement' };
    }
  }

  return requirements.interactiveMode
    ? { engine: 'interactive', reason: 'interactive' }
    : { engine: 'standard', reason: 'standard' };
}

/** The only grounding identifiers the outline model may put in its contract. */
export function groundingRefsForOutline(
  requirements: UserRequirements,
  options: { hasUploadedMaterials: boolean; hasResearchContext: boolean },
): string[] {
  const corpus =
    requirements.learnerProfile?.corpus?.trim() ||
    requirements.learnerProfile?.domain?.trim() ||
    'ai';
  const refs = [`corpus:${corpus}`];
  if (options.hasUploadedMaterials) refs.push('uploaded-materials');
  if (options.hasResearchContext) refs.push('research-context');
  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizedString).filter(Boolean))];
}

function isTeachingStrategy(value: string): value is TeachingStrategy {
  return TEACHING_STRATEGIES.includes(value as TeachingStrategy);
}

function validateStrategyEvidence(
  raw: unknown,
  strategy: TeachingStrategy,
  scenes: ReadonlyMap<string, { type: SceneOutline['type'] }>,
  violations: string[],
): TeachingStrategyEvidence | undefined {
  if (strategy === 'standard') return undefined;
  if (!isRecord(raw)) {
    violations.push(`${strategy} strategyEvidence is missing`);
    return undefined;
  }

  if (strategy === 'ubd') {
    const evidence: UbDStrategyEvidence = {
      essentialQuestion: normalizedString(raw.essentialQuestion),
      enduringUnderstanding: normalizedString(raw.enduringUnderstanding),
      performanceEvidence: normalizedString(raw.performanceEvidence),
      reflectionRevision: normalizedString(raw.reflectionRevision),
      transfer: normalizedString(raw.transfer),
    };
    if (!evidence.essentialQuestion) violations.push('ubd essentialQuestion is missing');
    if (!evidence.enduringUnderstanding) violations.push('ubd enduringUnderstanding is missing');
    for (const field of ['performanceEvidence', 'reflectionRevision', 'transfer'] as const) {
      const sceneId = evidence[field];
      if (!sceneId) violations.push(`ubd ${field} sceneId is missing`);
      else if (!scenes.has(sceneId)) {
        violations.push(`ubd ${field} references an unknown scene: ${sceneId}`);
      }
    }
    for (const field of ['performanceEvidence', 'transfer'] as const) {
      const sceneId = evidence[field];
      if (sceneId && scenes.has(sceneId) && !isAssessmentScene(scenes.get(sceneId))) {
        violations.push(`ubd ${field} must reference a quiz or pbl scene`);
      }
    }
    const refs = [evidence.performanceEvidence, evidence.reflectionRevision, evidence.transfer];
    const positions = new Map([...scenes.keys()].map((sceneId, index) => [sceneId, index]));
    if (
      refs.every((sceneId) => positions.has(sceneId)) &&
      refs.some(
        (sceneId, index) =>
          index > 0 && positions.get(refs[index - 1]!)! >= positions.get(sceneId)!,
      )
    ) {
      violations.push(
        'ubd strategy scenes must be ordered: performanceEvidence -> reflectionRevision -> transfer',
      );
    }
    return evidence;
  }

  const gapCount = raw.diagnosedGapCount;
  const evidence = {
    learnerExplanation: normalizedString(raw.learnerExplanation),
    gapDiagnosis: normalizedString(raw.gapDiagnosis),
    plainLanguageRebuild: normalizedString(raw.plainLanguageRebuild),
    analogyBoundary: normalizedString(raw.analogyBoundary),
    transfer: normalizedString(raw.transfer),
  };
  if (gapCount !== 1 && gapCount !== 2) {
    violations.push('feynman diagnosedGapCount must be 1 or 2');
  }
  for (const field of [
    'learnerExplanation',
    'gapDiagnosis',
    'plainLanguageRebuild',
    'analogyBoundary',
    'transfer',
  ] as const) {
    const sceneId = evidence[field];
    if (!sceneId) violations.push(`feynman ${field} sceneId is missing`);
    else if (!scenes.has(sceneId)) {
      violations.push(`feynman ${field} references an unknown scene: ${sceneId}`);
    }
  }
  for (const field of ['learnerExplanation', 'gapDiagnosis', 'plainLanguageRebuild'] as const) {
    const sceneId = evidence[field];
    if (sceneId && scenes.has(sceneId) && !isLearnerInputScene(scenes.get(sceneId))) {
      violations.push(`feynman ${field} must reference an interactive or pbl scene`);
    }
  }
  if (
    evidence.transfer &&
    scenes.has(evidence.transfer) &&
    !isAssessmentScene(scenes.get(evidence.transfer))
  ) {
    violations.push('feynman transfer must reference a quiz or pbl scene');
  }
  const refs = [
    evidence.learnerExplanation,
    evidence.gapDiagnosis,
    evidence.plainLanguageRebuild,
    evidence.analogyBoundary,
    evidence.transfer,
  ];
  const positions = new Map([...scenes.keys()].map((sceneId, index) => [sceneId, index]));
  if (
    refs.every((sceneId) => positions.has(sceneId)) &&
    refs.some(
      (sceneId, index) => index > 0 && positions.get(refs[index - 1]!)! >= positions.get(sceneId)!,
    )
  ) {
    violations.push(
      'feynman strategy scenes must be ordered: learnerExplanation -> gapDiagnosis -> plainLanguageRebuild -> analogyBoundary -> transfer',
    );
  }
  return gapCount === 1 || gapCount === 2
    ? { ...evidence, diagnosedGapCount: gapCount }
    : undefined;
}

function strategySceneRefs(evidence: TeachingStrategyEvidence | undefined): string[] {
  if (!evidence) return [];
  return 'essentialQuestion' in evidence
    ? [evidence.performanceEvidence, evidence.reflectionRevision, evidence.transfer]
    : [
        evidence.learnerExplanation,
        evidence.gapDiagnosis,
        evidence.plainLanguageRebuild,
        evidence.analogyBoundary,
        evidence.transfer,
      ];
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isAssessmentScene(outline: { type: SceneOutline['type'] } | undefined): boolean {
  return outline?.type === 'quiz' || outline?.type === 'pbl';
}

function isLearnerInputScene(outline: { type: SceneOutline['type'] } | undefined): boolean {
  return outline?.type === 'interactive' || outline?.type === 'pbl';
}

function isActivityScene(outline: SceneOutline | undefined): boolean {
  return Boolean(
    outline &&
    (outline.type === 'interactive' || outline.type === 'pbl' || outline.type === 'quiz'),
  );
}

function objectiveIdsForOutline(
  outline: Pick<SceneOutline, 'objectiveIds' | 'teachingObjective'>,
  validObjectiveIds: ReadonlySet<string>,
  assessmentIds: readonly string[] = [],
): string[] {
  return [
    ...new Set([
      ...normalizedStrings(outline.objectiveIds),
      normalizedString(outline.teachingObjective),
      ...assessmentIds,
    ]),
  ].filter((id) => validObjectiveIds.has(id));
}

/** Attach only validator-approved objective contracts to the outlines used for scene generation. */
export function bindLearningObjectivesToOutlines(
  contract: LearningContract,
  outlines: readonly SceneOutline[],
): SceneOutline[] {
  const objectiveById = new Map(contract.objectives.map((objective) => [objective.id, objective]));
  const assessmentByScene = new Map<string, string[]>();
  for (const mapping of contract.assessmentMap) {
    assessmentByScene.set(mapping.sceneId, [
      ...new Set([...(assessmentByScene.get(mapping.sceneId) ?? []), ...mapping.objectiveIds]),
    ]);
  }
  const validIds = new Set(objectiveById.keys());
  const phaseScenes = {
    prerequisiteActivation: new Set(contract.prerequisiteActivation),
    demonstration: new Set(contract.demonstration),
    learnerPractice: new Set(contract.learnerPractice),
    feedbackRetry: new Set(contract.feedbackRetry),
    transferApplication: new Set(contract.transferApplication),
  };

  return outlines.map((outline) => {
    const objectiveIds = objectiveIdsForOutline(
      outline,
      validIds,
      assessmentByScene.get(outline.id),
    );
    return {
      ...outline,
      objectiveIds,
      ...(objectiveIds[0] ? { teachingObjective: objectiveIds[0] } : {}),
      learningObjectives: objectiveIds.map((id) => objectiveById.get(id)!),
      learningPhaseRoles: [
        ...(phaseScenes.prerequisiteActivation.has(outline.id)
          ? (['prerequisiteActivation'] as const)
          : []),
        ...(phaseScenes.demonstration.has(outline.id) ? (['demonstration'] as const) : []),
        ...(phaseScenes.learnerPractice.has(outline.id) ? (['learnerPractice'] as const) : []),
        ...(phaseScenes.feedbackRetry.has(outline.id) ? (['feedbackRetry'] as const) : []),
        ...(phaseScenes.transferApplication.has(outline.id)
          ? (['transferApplication'] as const)
          : []),
        ...(assessmentByScene.has(outline.id) ? (['assessment'] as const) : []),
      ],
    };
  });
}

/** Persist only the facts needed to compare the generated course with its approved outline. */
export function buildLearningContractPlan(
  contract: LearningContract,
  outlines: readonly SceneOutline[],
): LearningContractPlan {
  const objectiveIds = new Set(contract.objectives.map((objective) => objective.id));
  const assessmentByScene = new Map<string, string[]>();
  for (const mapping of contract.assessmentMap) {
    assessmentByScene.set(mapping.sceneId, [
      ...new Set([...(assessmentByScene.get(mapping.sceneId) ?? []), ...mapping.objectiveIds]),
    ]);
  }
  return {
    version: 2,
    teachingStrategy: contract.teachingStrategy,
    ...(contract.strategyEvidence ? { strategyEvidence: contract.strategyEvidence } : {}),
    objectives: contract.objectives.map((objective) => ({ ...objective })),
    plannedScenes: outlines.map((outline) => ({
      sceneId: outline.id,
      type: outline.type,
      ...(outline.widgetType ? { widgetType: outline.widgetType } : {}),
      objectiveIds: objectiveIdsForOutline(
        outline,
        objectiveIds,
        assessmentByScene.get(outline.id),
      ),
    })),
    required: {
      prerequisiteActivation: [...contract.prerequisiteActivation],
      demonstration: [...contract.demonstration],
      learnerPractice: [...contract.learnerPractice],
      feedbackRetry: [...contract.feedbackRetry],
      transferApplication: [...contract.transferApplication],
      assessment: [...new Set(contract.assessmentMap.map((mapping) => mapping.sceneId))],
    },
  };
}

function actualWidgetType(scene: LearningContractActualScene): string {
  return isRecord(scene.content) ? normalizedString(scene.content.widgetType) : '';
}

function plannedWidgetFulfilled(
  scene: LearningContractActualScene,
  expectedWidgetType: string,
): boolean {
  if (actualWidgetType(scene) === expectedWidgetType) return true;
  return (
    actualWidgetType(scene) === 'template' &&
    isRecord(scene.content) &&
    templateWidgetIsProductionReady(scene.content.widgetConfig)
  );
}

const MIN_SUBSTANTIVE_TEXT_CHARS = 12;

function normalizedTeachingText(scene: LearningContractActualScene): string {
  return extractContentVerifiables({ content: scene.content, actions: scene.actions })
    .texts.join(' ')
    .toLocaleLowerCase()
    .replace(/\p{N}+(?:[.,]\p{N}+)?/gu, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, '');
}

function textBigrams(text: string): Set<string> {
  const pairs = new Set<string>();
  for (let index = 0; index < text.length - 1; index++) pairs.add(text.slice(index, index + 2));
  return pairs;
}

function isNearDuplicateText(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < MIN_SUBSTANTIVE_TEXT_CHARS) return false;
  const leftPairs = textBigrams(left);
  const rightPairs = textBigrams(right);
  let shared = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) shared++;
  return shared / Math.min(leftPairs.size, rightPairs.size) >= 0.86;
}

const LEARNER_INPUT_EVENT =
  /(?:\bon(?:click|input|change|submit|mousedown|mouseup|pointerdown|pointerup|keydown|keyup|touchstart)\s*=|\.on(?:click|input|change|submit|mousedown|mouseup|pointerdown|pointerup|keydown|keyup|touchstart)\s*=|addEventListener\s*\(\s*['"](?:click|input|change|submit|mousedown|mouseup|pointerdown|pointerup|keydown|keyup|touchstart)['"])/iu;
const LEARNER_INPUT_CONTROL =
  /(?:<(?:button|input|select|textarea)\b|\bcontenteditable(?:\s*=|\b)|\brole\s*=\s*['"]?(?:button|slider|checkbox|radio|tab|switch)\b)/iu;
const VISIBLE_FEEDBACK_SURFACE =
  /(?:<(?:output|canvas|svg)\b|\baria-live\b|\b(?:id|class)\s*=\s*['"][^'"]*(?:feedback|result|status|output|score|progress|message|hint|error|success|反馈|结果|状态|输出|得分|进度|提示|错误|成功)[^'"]*['"])/iu;
const VISIBLE_FEEDBACK_UPDATE =
  /(?:\.(?:textContent|innerText|innerHTML|value)\s*=|\.classList\.(?:add|remove|toggle|replace)\s*\(|\.setAttribute\s*\(|\.style\.[a-z-]+\s*=|\b(?:fillText|strokeText|fillRect|strokeRect|drawImage|requestAnimationFrame)\s*\()/iu;

function templateWidgetIsProductionReady(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'template') return false;
  const templateId = normalizedString(value.templateId);
  const name = normalizedString(value.name);
  const guide = normalizedString(value.guide);
  return validateTemplateParams(templateId, value.params, {
    ...(name ? { name } : {}),
    ...(guide ? { guide } : {}),
  }).ok;
}

// 能承担「练习/反馈重试」的模板：必须收学习者作答并按对错给反馈。现有八个模板全是
// 探索型（滑杆/步进/矩阵/图），没有一个带答案判定——2026-09-02 双域真实生成里，
// process_stepper 被派去当练习屏和重试屏，机械检查放行、两位语义判官一致判「只是
// 点击看演示」。所以模板控件默认不算练习；日后加了带判定的模板再登记进来。
const PRACTICE_CAPABLE_TEMPLATES = new Set<string>([]);

function interactiveHasInputAndFeedback(content: Record<string, unknown>): boolean {
  if (templateWidgetIsProductionReady(content.widgetConfig)) {
    const cfg = content.widgetConfig as Record<string, unknown>;
    return PRACTICE_CAPABLE_TEMPLATES.has(normalizedString(cfg.templateId));
  }
  const html = normalizedString(content.html);
  if (!html) return false;
  return (
    (LEARNER_INPUT_CONTROL.test(html) || LEARNER_INPUT_EVENT.test(html)) &&
    LEARNER_INPUT_EVENT.test(html) &&
    VISIBLE_FEEDBACK_SURFACE.test(html) &&
    VISIBLE_FEEDBACK_UPDATE.test(html)
  );
}

function actualActivityContentViolation(
  sceneId: string,
  scene: LearningContractActualScene,
  requiresLearnerInput: boolean,
): string | null {
  if (!isRecord(scene.content)) {
    return `${scene.type} scene has no content: ${sceneId}`;
  }
  if (scene.type === 'quiz') {
    return Array.isArray(scene.content.questions) && scene.content.questions.length > 0
      ? null
      : `quiz scene has no questions: ${sceneId}`;
  }
  if (scene.type === 'interactive') {
    // 只有承担练习/反馈重试职责的 interactive 才必须收作答给反馈；示范/前置激活用的
    // 探索型模板控件，参数校验合法即可（否则模板控件在合同里就无处可用）。
    if (!requiresLearnerInput) {
      return templateWidgetIsProductionReady(scene.content.widgetConfig) ||
        normalizedString(scene.content.html).length > 0
        ? null
        : `interactive scene has no renderable widget: ${sceneId}`;
    }
    return interactiveHasInputAndFeedback(scene.content)
      ? null
      : `interactive scene is not learner-operable with visible feedback: ${sceneId}`;
  }
  if (scene.type === 'pbl') {
    const gaps = pblProductionGaps(scene.content.projectV2);
    return gaps.length === 0
      ? null
      : `pbl scene is not production-ready: ${sceneId} (${gaps.join('; ')})`;
  }
  return null;
}

function actualSceneMatchesPhase(
  phase: LearningContractPhase | 'assessment',
  scene: LearningContractActualScene,
): boolean {
  if (phase === 'prerequisiteActivation' || phase === 'demonstration') return true;
  if (phase === 'learnerPractice') {
    return scene.type === 'interactive' || scene.type === 'pbl' || scene.type === 'quiz';
  }
  if (phase === 'feedbackRetry' || phase === 'transferApplication') {
    return scene.type === 'interactive' || scene.type === 'pbl' || scene.type === 'quiz';
  }
  return scene.type === 'quiz' || scene.type === 'pbl';
}

/**
 * Recheck the approved teaching plan against the exact scenes about to be published.
 * Missing or downgraded content is reported, never synthesized.
 */
export function validateLearningContractFulfillment(
  input: unknown,
  scenes: readonly LearningContractActualScene[],
  options: {
    actualContentReady?: boolean;
    requireSemanticAlignment?: boolean;
    alignment?: LearningContractAlignmentProof;
    currentCourseContentHash?: string;
    currentLearningContractHash?: string;
  } = {},
): LearningContractFulfillment {
  if (
    !isRecord(input) ||
    (input.version !== 1 && input.version !== 2) ||
    !Array.isArray(input.plannedScenes)
  ) {
    return { fulfilled: false, violations: ['learning contract plan is missing or invalid'] };
  }
  if (!isRecord(input.required)) {
    return { fulfilled: false, violations: ['learning contract required phases are missing'] };
  }

  const violations: string[] = [];
  const legacyV1 = input.version === 1;
  const requestedTeachingStrategy = normalizedString(input.teachingStrategy);
  const teachingStrategy: TeachingStrategy = legacyV1
    ? 'standard'
    : isTeachingStrategy(requestedTeachingStrategy)
      ? requestedTeachingStrategy
      : 'standard';
  if (!legacyV1 && !isTeachingStrategy(requestedTeachingStrategy)) {
    violations.push(
      requestedTeachingStrategy
        ? `teachingStrategy must be one of: ${TEACHING_STRATEGIES.join(', ')}`
        : 'teachingStrategy is missing from learning contract v2',
    );
  }
  const objectiveById = new Map<string, LearningObjectiveContract>();
  if (!legacyV1) {
    const rawObjectives = Array.isArray(input.objectives) ? input.objectives : [];
    for (const candidate of rawObjectives) {
      if (!isRecord(candidate)) {
        violations.push('learning contract plan contains an invalid objective');
        continue;
      }
      const objective: LearningObjectiveContract = {
        id: normalizedString(candidate.id),
        action: normalizedString(candidate.action),
        condition: normalizedString(candidate.condition),
        successCriterion: normalizedString(candidate.successCriterion),
      };
      if (
        !objective.id ||
        !objective.action ||
        !objective.condition ||
        !objective.successCriterion ||
        objectiveById.has(objective.id)
      ) {
        violations.push('learning contract plan contains an invalid objective');
        continue;
      }
      objectiveById.set(objective.id, objective);
    }
    if (objectiveById.size === 0) violations.push('learning contract plan has no objectives');
  }
  const planned = new Map<
    string,
    {
      sceneId: string;
      type: SceneOutline['type'];
      widgetType?: SceneOutline['widgetType'];
      objectiveIds: string[];
    }
  >();
  for (const candidate of input.plannedScenes) {
    if (!isRecord(candidate)) {
      violations.push('learning contract contains an invalid planned scene');
      continue;
    }
    const sceneId = normalizedString(candidate.sceneId);
    const type = normalizedString(candidate.type);
    if (!sceneId || !['slide', 'quiz', 'interactive', 'pbl'].includes(type)) {
      violations.push('learning contract contains an invalid planned scene');
      continue;
    }
    if (planned.has(sceneId)) {
      violations.push(`planned scene is duplicated: ${sceneId}`);
      continue;
    }
    const widgetType = normalizedString(candidate.widgetType);
    const objectiveIds = legacyV1 ? [] : normalizedStrings(candidate.objectiveIds);
    if (
      !legacyV1 &&
      (objectiveIds.length === 0 ||
        objectiveIds.some((objectiveId) => !objectiveById.has(objectiveId)))
    ) {
      violations.push(`planned scene has invalid objectiveIds: ${sceneId}`);
    }
    planned.set(sceneId, {
      sceneId,
      type: type as SceneOutline['type'],
      ...(widgetType ? { widgetType: widgetType as SceneOutline['widgetType'] } : {}),
      objectiveIds,
    });
  }
  if (planned.size === 0) violations.push('learning contract has no planned scenes');

  const actual = new Map<string, LearningContractActualScene>();
  for (const scene of scenes) {
    const sceneId = normalizedString(scene.outlineId);
    if (!sceneId) continue;
    if (actual.has(sceneId)) {
      violations.push(`generated scene is duplicated: ${sceneId}`);
      continue;
    }
    actual.set(sceneId, scene);
  }

  // 承担练习 / 反馈重试职责的屏：v2 在 required 里，v1 在顶层数组
  const requiredRoles = isRecord(input.required) ? input.required : input;
  const learnerInputScenes = new Set([
    ...normalizedStrings(requiredRoles.learnerPractice),
    ...normalizedStrings(requiredRoles.feedbackRetry),
  ]);
  for (const [sceneId, expected] of planned) {
    const scene = actual.get(sceneId);
    if (!scene) {
      violations.push(`planned scene is missing: ${sceneId}`);
      continue;
    }
    if (scene.type !== expected.type) {
      violations.push(
        `planned scene type changed: ${sceneId} expected ${expected.type} got ${scene.type || 'missing'}`,
      );
    }
    if (expected.widgetType && !plannedWidgetFulfilled(scene, expected.widgetType)) {
      violations.push(
        `planned scene widget changed: ${sceneId} expected ${expected.widgetType} got ${actualWidgetType(scene) || 'missing'}`,
      );
    }
    const contentViolation =
      !legacyV1 &&
      options.actualContentReady !== false &&
      scene.type === expected.type &&
      ['quiz', 'interactive', 'pbl'].includes(expected.type) &&
      actualActivityContentViolation(sceneId, scene, learnerInputScenes.has(sceneId));
    if (contentViolation) violations.push(contentViolation);
  }

  const strategyEvidence = legacyV1
    ? undefined
    : validateStrategyEvidence(input.strategyEvidence, teachingStrategy, planned, violations);
  for (const sceneId of strategySceneRefs(strategyEvidence).filter(Boolean)) {
    if (!actual.has(sceneId)) {
      violations.push(`${teachingStrategy} strategy scene is missing: ${sceneId}`);
    }
  }

  const phases: Array<LearningContractPhase | 'assessment'> = [
    'prerequisiteActivation',
    'demonstration',
    'learnerPractice',
    'feedbackRetry',
    'transferApplication',
    'assessment',
  ];
  for (const phase of phases) {
    const rawRefs = input.required[phase];
    const refs = normalizedStrings(rawRefs);
    if (!Array.isArray(rawRefs) || refs.length === 0 || refs.length !== rawRefs.length) {
      violations.push(`learning contract phase is missing or invalid: ${phase}`);
      continue;
    }
    const phaseObjectiveIds = new Set<string>();
    for (const sceneId of refs) {
      if (!planned.has(sceneId)) {
        violations.push(`${phase} references an unplanned scene: ${sceneId}`);
        continue;
      }
      const scene = actual.get(sceneId);
      if (!scene) {
        violations.push(`${phase} scene is missing: ${sceneId}`);
      } else if (!actualSceneMatchesPhase(phase, scene)) {
        violations.push(`${phase} scene has the wrong teaching category: ${sceneId}`);
      }
      for (const objectiveId of planned.get(sceneId)?.objectiveIds ?? []) {
        phaseObjectiveIds.add(objectiveId);
      }
    }
    if (!legacyV1) {
      for (const objectiveId of objectiveById.keys()) {
        if (!phaseObjectiveIds.has(objectiveId)) {
          violations.push(
            `${phase} has no scene mapped to objective ${objectiveId} — add ${objectiveId} to objectiveIds of the scene that serves this phase (its description and items must genuinely address ${objectiveId}), or add such a scene`,
          );
        }
      }
    }
  }

  if (!legacyV1 && options.actualContentReady !== false) {
    const textByScene = new Map(
      [...actual].map(([sceneId, scene]) => [sceneId, normalizedTeachingText(scene)] as const),
    );
    for (const phase of ['prerequisiteActivation', 'demonstration'] as const) {
      for (const sceneId of normalizedStrings(input.required[phase])) {
        const text = textByScene.get(sceneId);
        if (text !== undefined && text.length < MIN_SUBSTANTIVE_TEXT_CHARS) {
          violations.push(`${phase} scene lacks substantive teaching evidence: ${sceneId}`);
        }
      }
    }

    const transferSources = [
      ...normalizedStrings(input.required.demonstration),
      ...normalizedStrings(input.required.learnerPractice),
    ]
      .map((sceneId) => textByScene.get(sceneId))
      .filter((text): text is string => Boolean(text));
    for (const sceneId of normalizedStrings(input.required.transferApplication)) {
      const transferText = textByScene.get(sceneId);
      if (
        transferText !== undefined &&
        (transferText.length < MIN_SUBSTANTIVE_TEXT_CHARS ||
          transferSources.some((sourceText) => isNearDuplicateText(transferText, sourceText)))
      ) {
        violations.push(`transferApplication scene does not establish a new context: ${sceneId}`);
      }
    }
  }

  if (!legacyV1 && options.actualContentReady !== false && options.requireSemanticAlignment) {
    const alignment = options.alignment;
    if (!alignment) {
      violations.push('learning contract semantic alignment audit is missing');
    } else {
      if (!alignment.complete) {
        violations.push('learning contract semantic alignment panel is incomplete');
      }
      if (!alignment.aligned) {
        violations.push(...alignment.violations.map((reason) => `semantic alignment: ${reason}`));
      }
      if (
        !options.currentCourseContentHash ||
        alignment.courseContentHash !== options.currentCourseContentHash
      ) {
        violations.push(
          'learning contract semantic alignment does not match current course content',
        );
      }
      if (
        !options.currentLearningContractHash ||
        alignment.learningContractHash !== options.currentLearningContractHash
      ) {
        violations.push('learning contract semantic alignment does not match current objectives');
      }
    }
  }

  return { fulfilled: violations.length === 0, violations };
}

function phaseRefs(
  raw: Record<string, unknown>,
  key: keyof Pick<
    LearningContract,
    | 'prerequisiteActivation'
    | 'demonstration'
    | 'learnerPractice'
    | 'feedbackRetry'
    | 'transferApplication'
  >,
  sceneIds: Set<string>,
  violations: string[],
): { refs: string[]; repaired: boolean } {
  const requested = normalizedStrings(raw[key]);
  const refs = requested.filter((id) => sceneIds.has(id));
  if (refs.length === 0) violations.push(`${key} must reference at least one generated scene`);
  return { refs, repaired: !sameStrings(requested, refs) };
}

/**
 * Validate the one-call teaching contract. Repairs are deliberately narrow:
 * normalize IDs/references and replace grounding refs with identifiers proven
 * by request context. Missing pedagogy is never synthesized by the validator.
 */
export function validateAndRepairLearningContract(
  input: unknown,
  outlines: readonly SceneOutline[],
  options: { allowedGroundingRefs: readonly string[] },
): LearningContractValidation {
  if (!isRecord(input)) {
    return {
      contract: null,
      publishable: false,
      repaired: false,
      violations: ['learningContract is missing'],
    };
  }

  const violations: string[] = [];
  let repaired = false;
  const requestedTeachingStrategy = normalizedString(input.teachingStrategy);
  const teachingStrategy = isTeachingStrategy(requestedTeachingStrategy)
    ? requestedTeachingStrategy
    : 'standard';
  if (!requestedTeachingStrategy) {
    violations.push('teachingStrategy is required: standard, ubd, or feynman');
  } else if (!isTeachingStrategy(requestedTeachingStrategy)) {
    violations.push(`teachingStrategy must be one of: ${TEACHING_STRATEGIES.join(', ')}`);
  }
  const sceneById = new Map(outlines.map((outline) => [outline.id, outline] as const));
  const sceneIds = new Set(sceneById.keys());
  const strategyEvidence = validateStrategyEvidence(
    input.strategyEvidence,
    teachingStrategy,
    sceneById,
    violations,
  );

  const objectives: LearningObjectiveContract[] = [];
  const seenObjectiveIds = new Set<string>();
  const rawObjectives = Array.isArray(input.objectives) ? input.objectives : [];
  const hasPbl = outlines.some((outline) => outline.type === 'pbl');
  const proceduralSkillIds = outlines
    .filter((outline) => outline.type === 'interactive' && outline.widgetType === 'procedural-skill')
    .map((outline) => outline.id);
  const handsOnAvailable = hasPbl || proceduralSkillIds.length > 0;
  for (const [index, candidate] of rawObjectives.entries()) {
    if (!isRecord(candidate)) {
      violations.push(`objective ${index + 1} must be an object`);
      continue;
    }
    const objective = {
      id: normalizedString(candidate.id),
      action: normalizedString(candidate.action),
      condition: normalizedString(candidate.condition),
      successCriterion: normalizedString(candidate.successCriterion),
    };
    if (!objective.id || !objective.action || !objective.condition || !objective.successCriterion) {
      violations.push(
        `objective ${index + 1} must include id, action, condition, and successCriterion`,
      );
      continue;
    }
    if (NON_MEASURABLE_ACTION.test(objective.action) && !OBSERVABLE_ACTION.test(objective.action)) {
      violations.push(`objective ${objective.id} action must be observable and measurable`);
    }
    // 没有 pbl 场景的课只有测验/控件可承载练习，「执行/完成/配置/操作/标定」这类程序性动作
    // 在浏览器里做不到，两位语义判官必然判「媒介无法承载」（2026-09-02 智造域第七跑：
    // 三个目标全是这种写法，全部 misaligned）。提示词规则模型不听，这里机械判：
    // 进修订，要求改写成测验可判定的认知动作（判定/排序/识别/说明/写出清单/补全关键步骤）。
    if (
      !handsOnAvailable &&
      (PROCEDURAL_ACTION.test(objective.action) || PROCEDURAL_ACTION.test(objective.successCriterion))
    ) {
      violations.push(
        `objective ${objective.id} action "${objective.action}" is a hands-on procedure but this course has no pbl scene — rephrase it as a quiz-gradable cognitive action (e.g. 判定/排序/识别错误步骤/写出检查清单/补全关键参数), and phrase successCriterion the same way`,
      );
    }
    if (seenObjectiveIds.has(objective.id)) {
      violations.push(`objective id ${objective.id} is duplicated`);
      continue;
    }
    seenObjectiveIds.add(objective.id);
    objectives.push(objective);
  }
  if (objectives.length === 0) violations.push('at least one measurable objective is required');

  const prerequisite = phaseRefs(input, 'prerequisiteActivation', sceneIds, violations);
  const demonstration = phaseRefs(input, 'demonstration', sceneIds, violations);
  const practice = phaseRefs(input, 'learnerPractice', sceneIds, violations);
  const feedback = phaseRefs(input, 'feedbackRetry', sceneIds, violations);
  const transfer = phaseRefs(input, 'transferApplication', sceneIds, violations);
  repaired ||= [prerequisite, demonstration, practice, feedback, transfer].some(
    (phase) => phase.repaired,
  );

  // 练习屏要能收作答并给反馈：quiz（可重试）、pbl，或真正收输入的 interactive。
  if (practice.refs.some((id) => !isActivityScene(sceneById.get(id)))) {
    violations.push('learnerPractice must reference a quiz, interactive, or pbl scene');
  }
  // 职教实训课：有 procedural-skill 实操控件却把练习丢给选择题，两位语义判官必判
  // 「测验承载不了执行」（2026-09-02 智造第七跑：三个实操台全被挂成 demonstration）。
  if (
    proceduralSkillIds.length > 0 &&
    !practice.refs.some((id) => proceduralSkillIds.includes(id))
  ) {
    violations.push(
      `learnerPractice must include the procedural-skill scene(s) ${proceduralSkillIds.join(', ')} — hands-on widgets are where the learner performs the objective action; quizzes alone cannot carry a procedural objective`,
    );
  }
  if (feedback.refs.some((id) => !isActivityScene(sceneById.get(id)))) {
    violations.push('feedbackRetry must reference an interactive, pbl, or quiz scene');
  }
  if (transfer.refs.some((id) => !isAssessmentScene(sceneById.get(id)))) {
    violations.push('transferApplication must reference a quiz or pbl scene');
  }

  const assessmentMap: LearningContract['assessmentMap'] = [];
  const rawAssessmentMap = Array.isArray(input.assessmentMap) ? input.assessmentMap : [];
  for (const mapping of rawAssessmentMap) {
    if (!isRecord(mapping)) {
      repaired = true;
      continue;
    }
    const sceneId = normalizedString(mapping.sceneId);
    const requestedObjectiveIds = normalizedStrings(mapping.objectiveIds);
    const objectiveIds = requestedObjectiveIds.filter((id) => seenObjectiveIds.has(id));
    if (!sceneIds.has(sceneId) || objectiveIds.length === 0) {
      repaired = true;
      continue;
    }
    if (!sameStrings(requestedObjectiveIds, objectiveIds)) repaired = true;
    assessmentMap.push({ sceneId, objectiveIds });
  }
  if (assessmentMap.length === 0) {
    violations.push('assessmentMap must map an assessment scene to every objective');
  }
  const assessedObjectiveIds = new Set(assessmentMap.flatMap((mapping) => mapping.objectiveIds));
  for (const objective of objectives) {
    if (!assessedObjectiveIds.has(objective.id)) {
      violations.push(`objective ${objective.id} has no assessment mapping`);
    }
  }
  if (assessmentMap.some((mapping) => !isAssessmentScene(sceneById.get(mapping.sceneId)))) {
    violations.push('assessmentMap must reference quiz or pbl scenes');
  }

  const positions = new Map(outlines.map((outline, index) => [outline.id, index]));
  const objectivesForScene = (scene: SceneOutline | undefined): string[] =>
    scene ? objectiveIdsForOutline(scene, seenObjectiveIds) : [];
  for (const [phase, refs] of [
    ['prerequisiteActivation', prerequisite.refs],
    ['demonstration', demonstration.refs],
    ['learnerPractice', practice.refs],
    ['feedbackRetry', feedback.refs],
    ['transferApplication', transfer.refs],
  ] as const) {
    const covered = new Set<string>();
    for (const sceneId of refs) {
      const objectiveIds = objectivesForScene(sceneById.get(sceneId));
      if (objectiveIds.length === 0) {
        violations.push(`${phase} scene ${sceneId} must name objectiveIds from the contract`);
      }
      for (const objectiveId of objectiveIds) covered.add(objectiveId);
    }
    for (const objective of objectives) {
      if (!covered.has(objective.id)) {
        violations.push(
          `${phase} has no scene mapped to objective ${objective.id} — add ${objective.id} to objectiveIds of the scene that serves this phase (its description and items must genuinely address ${objective.id}), or add such a scene`,
        );
      }
    }
  }
  for (const practiceId of practice.refs) {
    const practiceScene = sceneById.get(practiceId);
    if (!practiceScene || !isActivityScene(practiceScene)) continue;
    const practiceType = practiceScene.type;
    for (const objectiveId of objectivesForScene(practiceScene)) {
      const laterFeedback = feedback.refs.filter((sceneId) => {
        const scene = sceneById.get(sceneId);
        return (
          positions.get(sceneId)! > positions.get(practiceId)! &&
          objectivesForScene(scene).includes(objectiveId)
        );
      });
      if (laterFeedback.length === 0) {
        violations.push(
          `learnerPractice ${practiceType} ${practiceId} needs a later same-objective feedbackRetry scene`,
        );
        continue;
      }
      const closesLoop = laterFeedback.some((feedbackId) =>
        assessmentMap.some(
          (mapping) =>
            mapping.objectiveIds.includes(objectiveId) &&
            isAssessmentScene(sceneById.get(mapping.sceneId)) &&
            positions.get(mapping.sceneId)! > positions.get(feedbackId)!,
        ),
      );
      if (!closesLoop) {
        violations.push(
          `learnerPractice ${practiceType} ${practiceId} needs a later same-objective quiz or pbl assessment after feedbackRetry`,
        );
      }
    }
  }

  const rawGrounding = isRecord(input.grounding) ? input.grounding : {};
  const allowedGroundingRefs = [
    ...new Set(options.allowedGroundingRefs.map((ref) => ref.trim())),
  ].filter(Boolean);
  const requestedGroundingRefs = normalizedStrings(rawGrounding.sourceRefs);
  const validGroundingRefs = requestedGroundingRefs.filter((ref) =>
    allowedGroundingRefs.includes(ref),
  );
  const sourceRefs = validGroundingRefs.length > 0 ? validGroundingRefs : [...allowedGroundingRefs];
  if (!sameStrings(requestedGroundingRefs, sourceRefs)) repaired = true;
  if (sourceRefs.length === 0) violations.push('grounding must name at least one available source');
  if (rawGrounding.claimPolicy !== 'cite-or-mark-uncertain') repaired = true;

  const contract: LearningContract = {
    teachingStrategy,
    ...(strategyEvidence ? { strategyEvidence } : {}),
    objectives,
    prerequisiteActivation: prerequisite.refs,
    demonstration: demonstration.refs,
    learnerPractice: practice.refs,
    feedbackRetry: feedback.refs,
    transferApplication: transfer.refs,
    assessmentMap,
    grounding: { sourceRefs, claimPolicy: 'cite-or-mark-uncertain' },
  };

  return {
    contract,
    publishable: violations.length === 0,
    repaired,
    violations,
  };
}

/**
 * Compact port of OpenMAIC's machine-checkable vocational constraints. It
 * checks structure only; it never inserts domain examples or rewrites scenes.
 */
export function validateVocationalOutline(outlines: readonly SceneOutline[]): string[] {
  const violations: string[] = [];
  if (outlines[0]?.type !== 'slide') violations.push('vocational scene 1 must be a slide');

  const disallowed = [...new Set(outlines.map((outline) => outline.type))].filter(
    (type) => !['slide', 'quiz', 'interactive'].includes(type),
  );
  if (disallowed.length > 0) {
    violations.push(`vocational scene types not allowed: ${disallowed.join(', ')}`);
  }

  const interactive = outlines.filter((outline) => outline.type === 'interactive');
  if (interactive.length < 3) {
    violations.push(
      `vocational outline needs at least 3 interactive scenes; got ${interactive.length}`,
    );
  }
  const quizzes = outlines.filter((outline) => outline.type === 'quiz');
  if (quizzes.length < 1) {
    violations.push(`vocational outline needs at least 1 quiz scene; got ${quizzes.length}`);
  }
  const slides = outlines.filter((outline) => outline.type === 'slide');
  if (slides.length > 3) {
    violations.push(`vocational outline allows at most 3 slide scenes; got ${slides.length}`);
  }

  const procedural = interactive.filter((outline) => outline.widgetType === 'procedural-skill');
  if (procedural.length === 0) {
    violations.push('vocational outline must use procedural-skill');
  }
  for (const field of ['task', 'steps', 'successCriteria'] as const) {
    const missing = procedural.filter((outline) => {
      const value = outline.widgetOutline?.[field];
      return value == null || value === '' || (Array.isArray(value) && value.length === 0);
    });
    if (missing.length > 0) {
      violations.push(
        `widgetOutline.${field} missing on vocational scene(s) ${missing.map((outline) => outline.order).join(', ')}`,
      );
    }
  }
  return violations;
}
