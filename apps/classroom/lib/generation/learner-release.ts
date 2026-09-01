import { hashCourseScenes, type SceneAudit } from './hallucination-audit';
import {
  extractContentVerifiables,
  hasVerifiableContent,
  verificationHasFailures,
  type VerificationMeta,
} from './content-verify';
import { validateLearningContractFulfillment } from './learning-contract';

/**
 * 学习者发布资格只认这里。审核分数与历史报表继续按原公式计算；本模块只回答
 * 「这份已落盘内容现在能不能给学习者消费」，不回写、修订或删除任何草稿。
 */
export type LearnerReleaseBlockReason =
  | 'audit_missing'
  | 'audit_failed'
  | 'pending_review'
  | 'incorrect_claim'
  | 'ungrounded_factual_claims'
  | 'verification_missing'
  | 'verification_failed';

export interface LearnerReleaseScene {
  id?: string;
  outlineId?: string;
  title?: string;
  type?: string;
  audit?: SceneAudit | null;
  content?: unknown;
  actions?: unknown;
  verification?: VerificationMeta | null;
}

export interface SceneLearnerReleaseDecision {
  eligible: boolean;
  reasons: LearnerReleaseBlockReason[];
}

export function decideSceneLearnerRelease(scene: LearnerReleaseScene): SceneLearnerReleaseDecision {
  const audit = scene.audit;
  if (!audit) return { eligible: false, reasons: ['audit_missing'] };

  const claims = Array.isArray(audit.claims) ? audit.claims : [];
  const declaredClaims =
    typeof audit.totalClaims === 'number' && Number.isFinite(audit.totalClaims)
      ? Math.max(0, audit.totalClaims)
      : 0;
  const hasFactualClaims = Math.max(declaredClaims, claims.length) > 0;
  const hasIncorrectClaim =
    (typeof audit.incorrectCount === 'number' && audit.incorrectCount > 0) ||
    claims.some((claim) => claim.verdict === 'incorrect');
  const evidenceCount =
    typeof audit.evidenceCount === 'number' && Number.isFinite(audit.evidenceCount)
      ? Math.max(0, audit.evidenceCount)
      : 0;
  const reasons: LearnerReleaseBlockReason[] = [];

  // hallucination-audit 的既有契约里，flagged + 0 claims 是审核基础设施失败。
  // 其他 flagged 结果也不是可发布终态；显式 incorrect 会在下面给出更具体原因。
  if (audit.verdict === 'flagged' && !hasIncorrectClaim) reasons.push('audit_failed');
  if (audit.decision === 'block_pending_review') reasons.push('pending_review');
  if (hasIncorrectClaim) reasons.push('incorrect_claim');
  if (hasFactualClaims && (!audit.grounded || evidenceCount <= 0)) {
    reasons.push('ungrounded_factual_claims');
  }

  const { codeBlocks, texts } = extractContentVerifiables(scene.content);
  const needsVerification = hasVerifiableContent(codeBlocks, texts);
  if (needsVerification && !scene.verification) reasons.push('verification_missing');
  if (scene.verification && verificationHasFailures(scene.verification)) {
    reasons.push('verification_failed');
  }

  return { eligible: reasons.length === 0, reasons };
}

export type CourseLearnerReleaseBlockReason =
  | 'course_incomplete'
  | 'course_empty'
  | 'course_fact_review_failed'
  | 'learning_contract_missing'
  | 'learning_contract_unfulfilled';

export interface CourseLearnerReleaseDecision {
  eligible: boolean;
  courseReasons: CourseLearnerReleaseBlockReason[];
  contractViolations: string[];
  blockedScenes: Array<{ sceneId: string; reasons: LearnerReleaseBlockReason[] }>;
}

export function decideCourseLearnerRelease(course: {
  scenes?: readonly LearnerReleaseScene[];
  generating?: unknown;
  stage?: { learningContract?: unknown; courseAudit?: SceneAudit | null };
}): CourseLearnerReleaseDecision {
  const scenes = Array.isArray(course.scenes) ? course.scenes : [];
  const courseReasons: CourseLearnerReleaseBlockReason[] = [];
  if (course.generating) courseReasons.push('course_incomplete');
  if (scenes.length === 0) courseReasons.push('course_empty');

  const courseAudit = course.stage?.courseAudit;
  const contract = course.stage?.learningContract;
  const contractV2 =
    !!contract && typeof contract === 'object' && (contract as { version?: unknown }).version === 2;
  const hashMismatch = Boolean(
    courseAudit?.courseContentHash && courseAudit.courseContentHash !== hashCourseScenes(scenes),
  );
  if (
    (contractV2 && (!courseAudit || !courseAudit.courseContentHash)) ||
    (contractV2 && courseAudit?.panelComplete !== true) ||
    hashMismatch ||
    (courseAudit &&
      (courseAudit.verdict === 'flagged' ||
        courseAudit.decision === 'block_pending_review' ||
        courseAudit.claims?.some((claim) => claim.verdict !== 'supported')))
  ) {
    courseReasons.push('course_fact_review_failed');
  }

  let contractViolations: string[] = [];
  if (!course.stage?.learningContract) {
    courseReasons.push('learning_contract_missing');
  } else {
    const fulfillment = validateLearningContractFulfillment(course.stage.learningContract, scenes);
    contractViolations = fulfillment.violations;
    if (!fulfillment.fulfilled) courseReasons.push('learning_contract_unfulfilled');
  }

  const blockedScenes = scenes.flatMap((scene, index) => {
    const decision = decideSceneLearnerRelease(scene);
    return decision.eligible
      ? []
      : [
          {
            sceneId: scene.id?.trim() || `scene-${index + 1}`,
            reasons: decision.reasons,
          },
        ];
  });

  return {
    eligible: courseReasons.length === 0 && blockedScenes.length === 0,
    courseReasons,
    contractViolations,
    blockedScenes,
  };
}

export function isCourseLearnerReleased(course: {
  scenes?: readonly LearnerReleaseScene[];
  generating?: unknown;
  stage?: { learningContract?: unknown; courseAudit?: SceneAudit | null };
}): boolean {
  return decideCourseLearnerRelease(course).eligible;
}
