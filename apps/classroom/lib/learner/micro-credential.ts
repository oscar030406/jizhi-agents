/**
 * 技能徽章的判定规则（纯函数，无 I/O）。
 *
 * ## 徽章说明的是什么
 *
 * 一枚徽章只表示「这项技能的学习证据齐了」——课上留下的掌握度记录、测验判定、
 * 实操里程碑各有一条真实记录可查。**它不是能力认证**：我们没有考评标准、没有
 * 监考、没有第三方背书，说成「已掌握该技能」是替学习者作保，作不了。
 *
 * 字段面参考 1EdTech Open Badges 的四件套（发放对象 / 判据 / 证据 / 时间），
 * 但只做展示：不导出、不签名、不对接第三方发行方。
 *
 * ## 判据（一句话）
 *
 * 一项技能的徽章要三条证据同时齐备：
 *   ① 该技能对口的每一门课，其主概念的掌握度都过掌握门；
 *   ② 这些对口课里至少有一次测验判定过线；
 *   ③ 该岗位的配套实操项目里至少有一个通过了里程碑验收。
 *
 * 三条判据的门槛都不是本文件新定的：①、② 用的是 `lib/evidence/policy.ts` 的
 * `MASTERY_GATE` / `CONFIDENCE_FLOOR` 与 `lib/evidence/from-quiz.ts` 的过线口径，
 * 沿用证据模型既有的单一真源。
 *
 * ## 拿不到的记录一律不算进判定
 *
 * 三条判据各自可能「判不了」（`unavailable`）：账本这次没读到、对口课还没成课、
 * 该岗位还没有已发布的实操项目。判不了的那条**既不算达成，也不算学习者没做**，
 * 而是把缺的那一项写进 `gaps` 明说。不占位、不拿别的数据凑。
 *
 * 一个已知的口径限制写在这里，不藏在实现里：里程碑总数是带练路线按每个人的画像
 * 现拆的（`/api/practice-guide`，实测首次生成 90–150 秒），岗位技能页不发那次请求，
 * 所以 ③ 只数「已通过教练检查的里程碑段数」，不判「全部里程碑都做完了」。
 */

import { CONFIDENCE_FLOOR, MASTERY_GATE } from '@/lib/evidence/policy';

/** 判据原文。页面上给评委看的那一句，与本文件的实现同源，不各写一遍。 */
export const MICRO_CREDENTIAL_RULE =
  '三条证据齐备才亮徽章：该技能对口课的主概念掌握度都过门（估计 ≥0.90 且置信度 ≥0.25）、' +
  '对口课里至少一次测验判定过线（卷面 ≥80%）、该岗位的配套实操项目至少一个通过里程碑验收。';

/** 徽章只表示证据齐备。这句话跟着徽章走，别让它在界面上掉队。 */
export const MICRO_CREDENTIAL_DISCLAIMER =
  '徽章表示「这项技能的学习证据齐了」，不是能力认证，也不代表岗位胜任。';

export type BadgeStatus = 'earned' | 'in-progress' | 'not-started';

export type CriterionId = 'concept-mastery' | 'quiz-pass' | 'practice-acceptance';

export const CRITERION_TITLE: Record<CriterionId, string> = {
  'concept-mastery': '对口课主概念掌握度达标',
  'quiz-pass': '对口课测验判定过线',
  'practice-acceptance': '配套实操项目里程碑验收',
};

/** 一条可点回原处的证据。`href` 为空表示这条记录在本站没有单独的落点。 */
export interface BadgeEvidence {
  label: string;
  href?: string;
  /** ISO 8601。没有时间戳的记录不编一个。 */
  at?: string;
}

export interface CriterionResult {
  id: CriterionId;
  title: string;
  met: boolean;
  /** 判不了：这一条依赖的记录本页取不到。既不算达成，也不算学习者没做。 */
  unavailable: boolean;
  /** 有记录但还没到门槛（用来把「做了一半」和「一次都没做」分开）。 */
  started: boolean;
  detail: string;
  evidence: BadgeEvidence[];
}

export interface SkillBadge {
  skill: string;
  status: BadgeStatus;
  criteria: CriterionResult[];
  /** 达成了几条 / 一共几条。徽章上那个 n/m。 */
  metCount: number;
  totalCount: number;
  /** 判不了的那几条的原文。UI 直接显示，不改写。 */
  gaps: string[];
  /** 三条齐备时，最后一条证据的时间；否则 null。 */
  earnedAt: string | null;
}

export type BadgeReport =
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'ready';
      /** 发放对象（Open Badges 的 recipient 那一格）。 */
      issuedTo: string;
      badges: SkillBadge[];
    };

/** 没有学习者记录时的默认说明。访客（含不登录的评委）看到的就是这句。 */
export const NO_LEARNER_REASON =
  '登录后按你的学习记录判定。徽章只读你自己账本里的课程、测验与实操记录，未登录时不做任何判定。';

// ─────────────────────────────────────────────────────────────────────────────
// 输入
// ─────────────────────────────────────────────────────────────────────────────

/** 一项技能的接线面：它对口哪些课、哪些概念、哪些场景。全部来自人工学习路径与课文件。 */
export interface SkillEvidenceInput {
  skill: string;
  /** 对口课（`data/learning-path.json` 的 `jobSkillCourses` 映射到、且已成课的那些）。 */
  courses: ReadonlyArray<{ courseId: string; title: string }>;
  /** 相关概念键：每门对口课的主概念（该课全部场景引用的教材块投票选出），去重。 */
  concepts: readonly string[];
  /** 对口课里的场景，用来把账本里的测验判定认回这门课。 */
  scenes: ReadonlyArray<{ sceneId: string; courseId: string; courseTitle: string }>;
}

/** 账本里的一次测验判定（`lib/evidence` 的 quiz / review 证据）。 */
export interface QuizRecord {
  sceneId: string;
  /** ISO 8601，证据的 `source.at`。 */
  at: string;
  /** 卷面判定是不是过线（证据 `verdict.outcome === 'correct'`，即卷面 ≥80%）。 */
  passed: boolean;
  /** 0–1，证据 `verdict.score`。 */
  score: number;
  /** `quiz` = 首次作答，`review` = 讲评订正。两者都算一次测验判定。 */
  modality: string;
}

/** 一个实操项目的验收进度（画像里的 `practiceProgress`）。 */
export interface PracticeRecord {
  projectId: string;
  projectName: string;
  /** 带练页的路由要按域拼，项目 id 只在域内唯一。 */
  corpus: string;
  jobIds: readonly string[];
  /** 已通过教练检查的里程碑段数。总段数本页不知道，见文件头。 */
  doneMilestones: number;
  /** ISO 8601。 */
  updatedAt: string;
}

export interface LearnerEvidenceInput {
  /** 当前这张卡是哪个岗位。实操那条按岗位取项目。 */
  jobId: string;
  /** 当前领域的逐概念掌握度（画像 `conceptMasteryByDomain[domain]`）。 */
  mastery: Readonly<Record<string, number>>;
  /** 当前领域的逐概念置信度（画像 `conceptConfidenceByDomain[domain]`）。 */
  confidence: Readonly<Record<string, number>>;
  /** 这份掌握度是什么时候由账本折叠出来的（画像 `derivedFrom.at`）。 */
  derivedAt?: string;
  /** 账本这次读到了吗。`unavailable` 时测验那条判不了，而不是判成没做。 */
  ledger: 'ready' | 'unavailable';
  quizzes: readonly QuizRecord[];
  /** 已发布实操项目清单这次读到了吗。 */
  practiceSource: 'ready' | 'unavailable';
  practice: readonly PracticeRecord[];
}

export interface EvaluateInput {
  skills: readonly SkillEvidenceInput[];
  /** null = 没有学习者记录（未登录、或画像读不到）。 */
  learner: LearnerEvidenceInput | null;
  /** 发放对象的显示名。 */
  issuedTo?: string;
  /** 覆盖 {@link NO_LEARNER_REASON}，用来把上游的真实原因原样带出来。 */
  unavailableReason?: string;
  /** 概念 id → 中文名。默认原样返回，判定本身不依赖它。 */
  conceptLabel?: (concept: string) => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────────────

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** ① 对口课主概念掌握度：每一个相关概念都要过双条件门（估计 + 置信度）。 */
function conceptCriterion(
  skill: SkillEvidenceInput,
  learner: LearnerEvidenceInput,
  label: (concept: string) => string,
): CriterionResult {
  const base = {
    id: 'concept-mastery' as const,
    title: CRITERION_TITLE['concept-mastery'],
  };
  if (skill.concepts.length === 0) {
    return {
      ...base,
      met: false,
      unavailable: true,
      started: false,
      detail:
        '这项技能还没有对口课，或对口课的场景反推不出概念标签——掌握度没有可对应的概念键，本条不判定。',
      evidence: [],
    };
  }
  const rows = skill.concepts.map((concept) => ({
    concept,
    estimate: learner.mastery[concept],
    confidence: learner.confidence[concept],
  }));
  const scored = rows.filter((r) => typeof r.estimate === 'number');
  const passed = rows.filter(
    (r) => (r.estimate ?? 0) >= MASTERY_GATE && (r.confidence ?? 0) >= CONFIDENCE_FLOOR,
  );
  const evidence: BadgeEvidence[] = scored.map((r) => ({
    label:
      `概念「${label(r.concept)}」掌握度 ${round2(r.estimate ?? 0)}、` +
      `置信度 ${round2(r.confidence ?? 0)}（门槛 ${MASTERY_GATE} / ${CONFIDENCE_FLOOR}）`,
    href: '/report',
    ...(learner.derivedAt ? { at: learner.derivedAt } : {}),
  }));
  const met = passed.length === rows.length;
  return {
    ...base,
    met,
    unavailable: false,
    started: scored.length > 0,
    detail: met
      ? `${rows.length} 个相关概念全部过门。`
      : scored.length === 0
        ? `${rows.length} 个相关概念（${rows.map((r) => label(r.concept)).join('、')}）在账本里还没有作答记录。`
        : `${passed.length}/${rows.length} 个相关概念过门，其余还差估计或置信度。`,
    evidence,
  };
}

/** ② 对口课测验判定过线：账本里 scene 属于对口课、且卷面判定过线的那次交卷。 */
function quizCriterion(skill: SkillEvidenceInput, learner: LearnerEvidenceInput): CriterionResult {
  const base = { id: 'quiz-pass' as const, title: CRITERION_TITLE['quiz-pass'] };
  if (learner.ledger === 'unavailable') {
    return {
      ...base,
      met: false,
      unavailable: true,
      started: false,
      detail: '证据账本这次没读到，本条不判定——读不到不等于没做过。',
      evidence: [],
    };
  }
  if (skill.scenes.length === 0) {
    return {
      ...base,
      met: false,
      unavailable: true,
      started: false,
      detail: '这项技能的对口课还没成课（或课文件读不到），账本里没有可归属的测验场景。',
      evidence: [],
    };
  }
  const courseOf = new Map(skill.scenes.map((s) => [s.sceneId, s]));
  const mine = learner.quizzes
    .filter((q) => courseOf.has(q.sceneId))
    .sort((a, b) => a.at.localeCompare(b.at));
  const passed = mine.filter((q) => q.passed);
  const evidence: BadgeEvidence[] = (passed.length > 0 ? passed : mine).map((q) => {
    const scene = courseOf.get(q.sceneId)!;
    return {
      label:
        `${scene.courseTitle}：${q.modality === 'review' ? '讲评订正' : '测验'}判定` +
        `${q.passed ? '过线' : '未过线'}（卷面 ${Math.round(q.score * 100)}%）`,
      href: `/classroom/${scene.courseId}`,
      at: q.at,
    };
  });
  return {
    ...base,
    met: passed.length > 0,
    unavailable: false,
    started: mine.length > 0,
    detail:
      passed.length > 0
        ? `对口课的测验有 ${passed.length} 次判定过线。`
        : mine.length > 0
          ? `对口课的测验交过 ${mine.length} 次，还没有一次判定过线。`
          : '对口课的测验还没有交卷记录。',
    evidence,
  };
}

/** ③ 配套实操项目：该岗位下已发布的项目里，至少一个留下了通过教练检查的里程碑。 */
function practiceCriterion(learner: LearnerEvidenceInput): CriterionResult {
  const base = {
    id: 'practice-acceptance' as const,
    title: CRITERION_TITLE['practice-acceptance'],
  };
  if (learner.practiceSource === 'unavailable') {
    return {
      ...base,
      met: false,
      unavailable: true,
      started: false,
      detail: '本领域的实操项目清单这次没读到，本条不判定。',
      evidence: [],
    };
  }
  const mine = learner.practice.filter((p) => p.jobIds.includes(learner.jobId));
  if (mine.length === 0) {
    return {
      ...base,
      met: false,
      unavailable: true,
      started: false,
      detail: '这个岗位下还没有已生成并审核发布的实操项目，本条不判定。',
      evidence: [],
    };
  }
  const done = mine.filter((p) => p.doneMilestones > 0);
  const evidence: BadgeEvidence[] = done.map((p) => ({
    label: `${p.projectName}：已通过 ${p.doneMilestones} 个里程碑的教练检查`,
    href: `/practice/${encodeURIComponent(p.corpus)}/${encodeURIComponent(p.projectId)}`,
    at: p.updatedAt,
  }));
  return {
    ...base,
    met: done.length > 0,
    unavailable: false,
    started: done.length > 0,
    detail:
      done.length > 0
        ? `${done.length}/${mine.length} 个配套项目留下了里程碑验收记录（里程碑总数按个人画像现拆，本页不重算，只数已通过的段数）。`
        : `这个岗位有 ${mine.length} 个配套实操项目，还没有一个留下里程碑验收记录。`,
    evidence,
  };
}

/** 一项技能的徽章。`learner` 为空时不该走到这里——那是整页 unavailable。 */
export function evaluateSkillBadge(
  skill: SkillEvidenceInput,
  learner: LearnerEvidenceInput,
  conceptLabel: (concept: string) => string = (c) => c,
): SkillBadge {
  const criteria = [
    conceptCriterion(skill, learner, conceptLabel),
    quizCriterion(skill, learner),
    practiceCriterion(learner),
  ];
  const metCount = criteria.filter((c) => c.met).length;
  const status: BadgeStatus =
    metCount === criteria.length
      ? 'earned'
      : metCount > 0 || criteria.some((c) => c.started)
        ? 'in-progress'
        : 'not-started';
  const times = criteria.flatMap((c) => c.evidence.map((e) => e.at).filter(Boolean) as string[]);
  return {
    skill: skill.skill,
    status,
    criteria,
    metCount,
    totalCount: criteria.length,
    gaps: criteria.filter((c) => c.unavailable).map((c) => `${c.title}：${c.detail}`),
    earnedAt: status === 'earned' && times.length > 0 ? times.sort().at(-1)! : null,
  };
}

/** 整个岗位的徽章。没有学习者记录时整体返回 `unavailable`，不逐条编一个「未开始」。 */
export function evaluateSkillBadges(input: EvaluateInput): BadgeReport {
  if (!input.learner) {
    return { kind: 'unavailable', reason: input.unavailableReason ?? NO_LEARNER_REASON };
  }
  const learner = input.learner;
  return {
    kind: 'ready',
    issuedTo: input.issuedTo ?? '当前登录账户',
    badges: input.skills.map((skill) =>
      evaluateSkillBadge(skill, learner, input.conceptLabel ?? ((c) => c)),
    ),
  };
}

/** 技能名 → 徽章。视图按技能名查，不按下标。 */
export function indexBadges(report: BadgeReport): ReadonlyMap<string, SkillBadge> {
  if (report.kind !== 'ready') return new Map();
  return new Map(report.badges.map((b) => [b.skill, b]));
}
