// Stage and Scene data types.
//
// The universal lesson skeleton (Stage / Scene / SceneContent / Whiteboard /
// VideoManifest / SlideContent / QuizContent / …) now lives in `@openmaic/dsl` and
// is re-exported below. `Scene` is generic there: the contract owns only the
// structure + the slide/quiz content kinds, while the playback `Action` set and
// the richer feature content (interactive widgets, PBL) are app-side and get
// composed in here.
//
// `Scene` is re-exported as an alias of the app's fully-instantiated
// `Scene<Action, AppSceneContent>`, so existing `import { Scene }` callers keep
// the same semantics (actions are `Action[]`, content spans all four kinds).
import type { Scene as DslScene, SceneContent as DslSceneContent } from '@openmaic/dsl';
import type { Action } from '@/lib/types/action';
import type { WidgetType, WidgetConfig } from '@/lib/types/widgets';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export type {
  SceneType,
  StageMode,
  Whiteboard,
  VideoManifestEntry,
  VideoManifest,
  GeneratedAgentConfig,
  MultiAgentConfig,
  SlideContent,
  QuizOption,
  QuizQuestion,
  QuizContent,
} from '@openmaic/dsl';

import type { Stage as DslStage } from '@openmaic/dsl';

/**
 * 一门课的出身：它是用哪个知识库、按哪个培训领域生成的。
 *
 * **app 层标注，不是 `@openmaic/dsl` 的 Stage 契约的一部分**——与
 * `AppScene` 上的 `outlineId` / `audit` 同一个做法。
 *
 * 为什么要落盘：客户端生成的课只存在本机文档库里，而那份 schema 原本
 * 一个域字段都没有（`id/name/languageDirective/videoManifest/style/
 * createdAt/updatedAt/agentIds`）。课程归属只能靠 source_id 前缀反推，
 * 而那张前缀表是手工维护的 AI 域清单——**新域的课必然反推错**，
 * 于是投币建的新库生成的课在首页「本域课程」里永远看不见。
 */
export interface CourseOrigin {
  /** 生成时选定的知识库（画像 `corpus`）。跟随培训领域时缺省。 */
  corpus?: string;
  /** 生成时的培训领域（画像 `domain`）。 */
  domain?: string;
}

/**
 * app 层的 Stage：DSL 契约 + 本应用自己的标注。
 *
 * 与 `AppScene` 对称——`Stage` 这个名字仍然指向它，既有 `import { Stage }`
 * 的调用方语义不变，只是多了几个可选字段。
 */
export type AppStage = DslStage & {
  /** 这门课出自哪个域/库。生成时写入，落盘时随课带走。 */
  origin?: CourseOrigin;
  /** 大纲阶段批准的最小教学契约；发布前用它核对实际生成场景。 */
  learningContract?: import('@/lib/generation/learning-contract').LearningContractPlan;
  /** 全课程断言账本与可见动作语义的跨页事实终审；含最终场景载荷哈希。 */
  courseAudit?: import('@/lib/generation/hallucination-audit').SceneAudit;
};

export type Stage = AppStage;

// The two discriminant guards are runtime functions, so they must be value
// re-exported — a bare `export type {}` erases them and leaves the import as
// `undefined` at runtime / "cannot be used as a value" at the type level.
export { isSlideContent, isQuizContent } from '@openmaic/dsl';

// `@openmaic/dsl` inlines the question-type union on `QuizQuestion.type` rather than
// exporting a named alias; derive it here so editor quiz code can keep importing
// `QuizQuestionType` from `@/lib/types/stage`.
export type QuizQuestionType = import('@openmaic/dsl').QuizQuestion['type'];

// The contract's `SceneContent` is the universal subset (slide | quiz). Reach it
// under a distinct name; the app's own `SceneContent` (declared below) is the
// full four-way union so existing `switch (content.type)` call sites keep all
// four cases.
export type { SceneContent as SceneContentBase } from '@openmaic/dsl';

// The raw, generic contract Scene is reachable under a distinct name for
// callers (e.g. read-only renderers) that want the feature-free skeleton.
export type { Scene as SceneShape } from '@openmaic/dsl';

/**
 * Interactive content - Interactive web page (iframe).
 *
 * App-level feature surface: kept here rather than in `@openmaic/dsl` because it
 * couples to Ultra-mode widget configs (`WidgetType` / `WidgetConfig`).
 */
export interface InteractiveContent {
  type: 'interactive';
  url: string; // URL of the interactive page
  // Optional: embedded HTML content
  html?: string;
  // Ultra Mode widget fields
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
}

/**
 * PBL content - Project-based learning.
 *
 * App-level feature surface: kept here rather than in `@openmaic/dsl` because it
 * couples to the project-based-learning config (`PBLProjectConfig`).
 */
export interface PBLContent {
  type: 'pbl';
  projectConfig: PBLProjectConfig;
  /** PBL v2 payload used by the new web-PBL runtime, while preserving v1 compatibility. */
  projectV2?: PBLProjectV2;
}

/**
 * The app's full scene-content union: the contract's universal kinds plus the
 * app-only feature kinds. This is what `@/lib/types/stage` callers have always
 * known as `SceneContent` (all four cases).
 */
export type AppSceneContent = DslSceneContent | InteractiveContent | PBLContent;

/**
 * The app's `SceneContent` — the full four-way union. Overrides the contract's
 * narrower `SceneContentBase` (slide | quiz) so call sites that switch on all
 * four `content.type` cases keep compiling.
 */
export type SceneContent = AppSceneContent;

/**
 * The app's concrete scene type: the contract skeleton instantiated with the
 * app's playback action set and full content union.
 *
 * Aliased as `Scene` so existing `import { Scene } from '@/lib/types/stage'`
 * callers keep their original semantics (actions are `Action[]`, content spans
 * all four kinds).
 */
export type AppScene = DslScene<Action, SceneContent> & {
  /**
   * Stable id of the generation outline this scene was built from. Lets editor
   * agent tools resolve a scene's outline by identity instead of by the mutable
   * `order`, which Pro-mode insert / reorder / delete rebalances (matching by
   * `order` after a reorder attaches another slide's outline). An app-layer
   * annotation only — not part of the `@openmaic/dsl` Scene contract. Absent on
   * inserted scenes and pre-existing data, where callers fall back to a
   * scene-derived outline.
   */
  outlineId?: string;
  /**
   * Hallucination-audit verdict trail attached at generation time (app-layer
   * annotation; absent on pre-existing data). See lib/generation/hallucination-audit.
   */
  audit?: import('@/lib/generation/hallucination-audit').SceneAudit;
  /**
   * 对最终正文执行的代码/数值机械验算。没有可验内容时不写；存在可验内容却缺失
   * 该字段时，学习者发布门禁会按“尚未验算”拦截。
   */
  verification?: import('@/lib/generation/content-verify').VerificationMeta;
  /**
   * 检索侧的**依据**（设计稿 §4.3 的依据子盒）：这一页真的贴进正文的教材出处。
   *
   * 与 `audit` 平级但不合并——**依据答「这句话哪来的」，由检索产出；
   * 审计答「这句话对不对」，由判官产出。** 此前依据只存在于 audit 里，
   * 等于把检索的产物寄存在判官身上：判官没跑，这一页就「没有依据」。
   * 分开之后，「无依据段落占比」不必等判官就能算。
   */
  grounding?: {
    placements: import('@/lib/generation/evidence-grounding').ExcerptPlacement[];
    /** 生成时挂上的证据条数（`EvidenceBundle` 给了几条候选）。 */
    candidates?: number;
  };
  /**
   * 这一页讲的是哪个知识点——**生成时**从检索到的教材块的 `concept_tags` 算出来
   * （口径见 `lib/evidence/scene-concepts.ts` 的 `sceneConceptsFromChunks`）。
   *
   * 应用层标注，不进 `@openmaic/dsl` 契约。此前场景只有标题，证据归拢得靠
   * `derive_scene_concepts.py` 事后从审核判词的 `sourceIds` 反推，只覆盖已落库的课
   * （160/212 = 75.5%），新课一律退回按标题归拢。生成时写进去才是根治。
   *
   * **可选，且检索没给证据时整个字段不写**（不落空对象占位）：存量 23 门课都没有
   * 这个字段，读取方一律容缺——见 `resolveConcept` 的分级。
   */
  concepts?: import('@/lib/evidence/scene-concepts').SceneConcepts;
};
export type Scene = AppScene;

/**
 * A partial update for {@link AppScene} — the patch shape used by `updateScene` /
 * `applyScenePatchInSync` / the regenerate-apply plan.
 *
 * `Partial<AppScene>` is unusable here: `AppScene` is a discriminated union, and
 * `Partial<>` *distributes* over it into a union of per-kind partials
 * (`Partial<SlideScene> | Partial<QuizScene> | …`). A generic patch such as
 * `{ content }`, where `content: SceneContent` spans all four kinds, then matches
 * none of those members. `ScenePatch` is a single (non-distributive) object type
 * that keeps `type` and `content` as independently-optional wide unions, which is
 * exactly what a shallow-merge patch needs.
 */
export type ScenePatch = Partial<Omit<AppScene, 'type' | 'content'>> & {
  type?: SceneContent['type'];
  content?: SceneContent;
};

/**
 * Build an {@link AppScene} from its kind-independent {@link SceneCore} plus a
 * concrete content payload, binding `type` to `content.type`.
 *
 * The lone `as` is unavoidable and is the *only* cast in the scene-construction
 * path: `AppScene` is a distributive discriminated union, and TS cannot prove
 * that the freshly-built `{ ...core, type, content }` literal lands in the member
 * matching `content`'s kind when that kind is only known through a generic. The
 * generic return type re-narrows the result to the single member whose `type`
 * equals `content.type`, so every call site still sees a correctly discriminated
 * scene. `type` is always derived from `content.type`, which makes the binding
 * impossible to violate at a call site.
 */
export function makeScene<C extends SceneContent>(
  core: Omit<AppScene, 'type' | 'content'>,
  content: C,
): Extract<AppScene, { type: C['type'] }> {
  return { ...core, type: content.type, content } as Extract<AppScene, { type: C['type'] }>;
}
