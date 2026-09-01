import type { DomainRegistryEntry } from '@/lib/knowledge/domain-registry';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';

export type OutlineEngine = 'standard' | 'interactive' | 'task-engine';

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
  version: 1;
  plannedScenes: Array<{
    sceneId: string;
    type: SceneOutline['type'];
    widgetType?: SceneOutline['widgetType'];
  }>;
  required: Record<LearningContractPhase, string[]> & { assessment: string[] };
}

export interface LearningContractActualScene {
  outlineId?: string;
  type?: string;
  content?: unknown;
}

export interface LearningContractFulfillment {
  fulfilled: boolean;
  violations: string[];
}

const EXPLICIT_VOCATIONAL_INTENT =
  /(?:岗位实训|职业实训|技能实训|工单|标准作业|操作规程|巡检|点检|检修|维修|装配|调试|交接|上锁挂牌|岗位任务|\b(?:vocational|work order|standard operating procedure|SOP|hands-on training|inspection|maintenance|repair|assembly|commissioning|lockout)\b)/iu;

const OPERATION_ACTION =
  /(?:操作|执行|检查|确认|测量|记录|校准|排查|更换|安装|拆装|启动|停机|上电|断电|处置|复查|巡检|点检|检修|维修|装配|调试|交接|\b(?:operate|perform|inspect|measure|calibrate|troubleshoot|replace|install|start up|shut down|handoff)\b)/iu;

const WORKFLOW_OR_JUDGMENT =
  /(?:步骤|流程|工单|工具|设备|仪器|防护|风险|阈值|异常|合格|不合格|继续|停止|安全|复查|交接|GO\s*\/?\s*STOP|\b(?:procedure|workflow|tool|equipment|PPE|risk|threshold|pass|fail|safe|unsafe|recheck)\b)/iu;

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

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isAssessmentScene(outline: SceneOutline | undefined): boolean {
  return Boolean(
    outline &&
    (outline.type === 'quiz' ||
      outline.type === 'pbl' ||
      (outline.type === 'interactive' &&
        (outline.widgetType === 'game' || outline.widgetType === 'procedural-skill'))),
  );
}

function isActivityScene(outline: SceneOutline | undefined): boolean {
  return Boolean(
    outline &&
    (outline.type === 'interactive' || outline.type === 'pbl' || outline.type === 'quiz'),
  );
}

/** Persist only the facts needed to compare the generated course with its approved outline. */
export function buildLearningContractPlan(
  contract: LearningContract,
  outlines: readonly SceneOutline[],
): LearningContractPlan {
  return {
    version: 1,
    plannedScenes: outlines.map((outline) => ({
      sceneId: outline.id,
      type: outline.type,
      ...(outline.widgetType ? { widgetType: outline.widgetType } : {}),
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

function actualSceneMatchesPhase(
  phase: LearningContractPhase | 'assessment',
  scene: LearningContractActualScene,
): boolean {
  if (phase === 'prerequisiteActivation' || phase === 'demonstration') return true;
  if (phase === 'learnerPractice') return scene.type === 'interactive' || scene.type === 'pbl';
  if (phase === 'feedbackRetry' || phase === 'transferApplication') {
    return scene.type === 'interactive' || scene.type === 'pbl' || scene.type === 'quiz';
  }
  return (
    scene.type === 'quiz' ||
    scene.type === 'pbl' ||
    (scene.type === 'interactive' && ['game', 'procedural-skill'].includes(actualWidgetType(scene)))
  );
}

/**
 * Recheck the approved teaching plan against the exact scenes about to be published.
 * Missing or downgraded content is reported, never synthesized.
 */
export function validateLearningContractFulfillment(
  input: unknown,
  scenes: readonly LearningContractActualScene[],
): LearningContractFulfillment {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.plannedScenes)) {
    return { fulfilled: false, violations: ['learning contract plan is missing or invalid'] };
  }
  if (!isRecord(input.required)) {
    return { fulfilled: false, violations: ['learning contract required phases are missing'] };
  }

  const violations: string[] = [];
  const planned = new Map<
    string,
    { sceneId: string; type: SceneOutline['type']; widgetType?: SceneOutline['widgetType'] }
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
    planned.set(sceneId, {
      sceneId,
      type: type as SceneOutline['type'],
      ...(widgetType ? { widgetType: widgetType as SceneOutline['widgetType'] } : {}),
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
    if (expected.widgetType && actualWidgetType(scene) !== expected.widgetType) {
      violations.push(
        `planned scene widget changed: ${sceneId} expected ${expected.widgetType} got ${actualWidgetType(scene) || 'missing'}`,
      );
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
  const sceneById = new Map(outlines.map((outline) => [outline.id, outline] as const));
  const sceneIds = new Set(sceneById.keys());

  const objectives: LearningObjectiveContract[] = [];
  const seenObjectiveIds = new Set<string>();
  const rawObjectives = Array.isArray(input.objectives) ? input.objectives : [];
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

  if (
    practice.refs.some((id) => {
      const scene = sceneById.get(id);
      return scene?.type !== 'interactive' && scene?.type !== 'pbl';
    })
  ) {
    violations.push('learnerPractice must reference an interactive or pbl scene');
  }
  if (feedback.refs.some((id) => !isActivityScene(sceneById.get(id)))) {
    violations.push('feedbackRetry must reference an interactive, pbl, or quiz scene');
  }
  if (transfer.refs.some((id) => !isActivityScene(sceneById.get(id)))) {
    violations.push('transferApplication must reference an interactive, pbl, or quiz scene');
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
    violations.push('assessmentMap must reference quiz, pbl, game, or procedural-skill scenes');
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
