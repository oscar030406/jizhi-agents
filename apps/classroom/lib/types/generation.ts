/**
 * Generation Types - Two-Stage Content Generation System
 *
 * Stage 1: User requirements + documents → Scene Outlines (per-page)
 * Stage 2: Scene Outlines → Full Scenes (slide/quiz/interactive/pbl with actions)
 */

import type { ActionType } from './action';
import type { MediaGenerationRequest } from '@/lib/media/types';

// ==================== Pipeline Visibility (车间面板) ====================

/**
 * What the multi-agent pipeline actually did for one scene — returned by
 * /api/generate/scene-content alongside the content. Every field mirrors a
 * value the route already computed for generation; `null` means that stage
 * did not run (engine down, no profile, non-assembly mode). Never fabricated.
 */
export interface ScenePipelineMeta {
  /** 学情诊断 Agent 的蓝图摘要；null = 无画像或引擎未响应 */
  blueprint: {
    learnerType: string | null;
    difficulty: string | null;
    scaffold: string | null;
    analogyDomain: string | null;
    /** llm=真协同决策；deterministic=规则判定（面板如实标注） */
    engine: string | null;
  } | null;
  /** 检索 Agent 的证据命中；null = 未接地 */
  evidence: {
    hits: number;
    skippedCount: number;
    /** fringe 跳过理由，最多前 2 条 */
    skippedReasons: string[];
    matchedConcepts: string[];
    /** plain=全量；fringe=按掌握度跳过已会的块 */
    mode: string;
  } | null;
  /** 摘录拼装统计；null = 非拼装模式 */
  assembly: { injected: number; deduped: number } | null;
  /** 引擎桥真失败（配置了但调用炸了）的告警；未配置/零命中不算失败。
      有内容时车间面板必须出红行——静默降级成裸生成是彩排翻过的车。 */
  bridgeWarnings?: string[];
  /**
   * 生成端跨模型回落（WO-M2）：主模型 5xx/超时后这一页实际是谁生成的。
   * null = 没发生（开关默认关，默认路径永远是 null）。
   * `from`/`to` 是模型 id 原文，与 usage 账本同口径；**上屏前必须过
   * `lib/metrics/redact-caliber.ts`**，内部型号串不进 UI。
   */
  modelFallback?: { from: string; to: string; reason: string }[] | null;
  /** 可执行验证（KR2）：代码沙箱三态 + 数值等式复核；null = 无可验内容/未配置 */
  verification?: {
    codePassed: number;
    codeFailed: number;
    codeUnverifiable: number;
    arithmeticChecked: number;
    arithmeticPassed: number;
    arithmeticUnverifiable?: number;
    failures: string[];
    warnings?: string[];
  } | null;
}

// ==================== PDF Image Types ====================

/**
 * Image extracted from PDF with metadata
 */
export interface PdfImage {
  id: string; // e.g., "img_1", "img_2"
  src: string; // base64 data URL (empty when stored in IndexedDB)
  pageNumber: number; // Page number in PDF
  description?: string; // Optional description for AI context
  storageId?: string; // Reference to IndexedDB (session_xxx_img_1)
  width?: number; // Image width (px or normalized)
  height?: number; // Image height (px or normalized)
  originalId?: string; // ID assigned by the extractor before bundle-level normalization
  sourceDocumentId?: string; // DocumentBundle source ID
  sourceDocumentName?: string; // Original source filename for citation back to material
  sourceDocumentOrder?: number; // Upload order in the bundle
  visionPriority?: number; // Higher values are attached first when vision budget is limited
}

/**
 * Image mapping for post-processing: image_id → base64 URL
 */
export type ImageMapping = Record<string, string>;

export interface SelectedCourseMaterial {
  id: string;
  file: File;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  order: number;
}

export interface SessionDocumentSource {
  id: string;
  name: string;
  size: number;
  lastModified?: number;
  mimeType?: string;
  order: number;
  storageKey: string;
  providerId?: string;
}

// ==================== Stage 1 Input ====================

export interface UploadedDocument {
  id: string;
  name: string; // Original filename
  type: 'pdf' | 'docx' | 'pptx' | 'txt' | 'md' | 'image' | 'other';
  size: number; // Bytes
  uploadedAt: Date;
  contentSummary?: string; // Placeholder for parsing
  extractedTopics?: string[]; // Placeholder for parsing
  pageCount?: number;
  storageRef?: string;
}

/**
 * Simplified user requirements for course generation
 * All details (topic, duration, style, etc.) should be included in the requirement text
 */
export interface UserRequirements {
  requirement: string; // Single free-form text for all user input
  userNickname?: string; // Student nickname for personalization
  userBio?: string; // Student background for personalization
  webSearch?: boolean; // Enable web search for richer context
  interactiveMode?: boolean; // Enable Interactive Mode for interactive-first generation
  taskEngineMode?: boolean; // Enable vocational task-engine generation path
  /**
   * Structured learner profile for skill-training adaptation. Sent to the
   * multi-agent engine's diagnosis agent, which computes the difficulty tier,
   * scaffold depth, resource mix and analogy domain used by generation.
   * See lib/generation/learner-profile.ts.
   */
  learnerProfile?: LearnerProfileFields;
}

/**
 * Five-dimension prior-knowledge levels (0–4) plus background, mirroring the
 * engine rubric. The UI collects each level via a behavioral-fact question
 * (option index = level); the numeric shape here is unchanged for the engine.
 */
export interface LearnerProfileFields {
  domain?: string;
  /**
   * 证据检索用的知识库名（`odoo` / `iotdb` / `ai` …）。不填就跟着 `domain` 走。
   * 口径与解析见 `corpusOf`（lib/generation/learner-profile.ts）。
   */
  corpus?: string;
  education?: string;
  role?: string;
  programming_level?: number;
  python_level?: number;
  agent_level?: number;
  rag_level?: number;
  engineering_level?: number;
  /** Self-expected course performance, 0–4 (validated strong predictor). Optional: absent in old stored profiles. */
  expected_performance?: number;
  learning_preference?: string;
  time_budget_hours?: number;
  /** 动态层：quiz 决策写回的当前难度（L1-L4）。可选，旧画像无此字段。 */
  currentDifficulty?: string;
  /** 当前难度按课程领域隔离；送往引擎前只投影当前领域。 */
  currentDifficultyByDomain?: Record<string, string>;
  /** Elo 评级按课程领域隔离；送往引擎前只投影当前领域。 */
  eloRatingByDomain?: Record<string, number>;
  /**
   * 动态层：逐概念掌握度（键=场景标题或概念 id，值 0-1，EMA 累积）。
   * 引擎 evidence 端点吃它做 outer-fringe 选段（跳过已会内容）。可选。
   */
  conceptMastery?: Record<string, number>;
  /**
   * 按课程领域隔离的逐概念掌握度。首页与报告只读取当前有效领域对应的桶；
   * 旧的 `conceptMastery` 保留给尚未迁移的内部策略，不得作为跨域展示回退。
   */
  conceptMasteryByDomain?: Record<string, Record<string, number>>;
  /**
   * 项目带练进度：键 = `${corpus}/${projectId}`，值 = 已通过检查的里程碑序号与时间。
   * 随账户走（/api/profile update 合并写入），未登录只存本地。可选，旧画像无此字段。
   */
  practiceProgress?: Record<string, { done: number[]; updatedAt: string }>;
  /**
   * 动态层：逐概念置信度（0-1，来自证据折叠的有效样本量，profile-bridge 写回）。
   * 掌握判定的第二个条件——估计高但置信低不算掌握（证据封顶）。可选，旧画像无。
   */
  conceptConfidence?: Record<string, number>;
  conceptConfidenceByDomain?: Record<string, Record<string, number>>;
  /**
   * 动态层：逐概念可提取度（0-1，estimate × 时间衰减，profile-bridge 写回）。
   * 到期复习的判据。可选，旧画像无。
   */
  conceptRecall?: Record<string, number>;
  conceptRecallByDomain?: Record<string, Record<string, number>>;
  /**
   * 前测校准证据（键=维度 agent/rag/engineering，值=「答对x/y」）。
   * 存在即表示该维档位已被前测校正过。可选，旧画像无此字段。
   */
  pretestCalibrated?: Record<string, string>;
}

// ==================== Stage 1 Output: Scene Outlines (Simplified) ====================

/**
 * Widget outline configuration for interactive scenes
 * Unified for both normal and ultra modes
 */
export interface WidgetOutline {
  // Common field
  concept?: string;

  // Type-specific fields
  keyVariables?: string[]; // simulation
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system'; // diagram
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp'; // code
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action'; // game
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom'; // visualization3d
  objects?: string[]; // visualization3d
  interactions?: string[]; // visualization3d
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom'; // procedural-skill
  task?: string; // procedural-skill - task to perform
  tools?: string[]; // procedural-skill - tools or materials involved
  steps?: string[]; // procedural-skill - ordered procedure steps
  successCriteria?: string[]; // procedural-skill - checks for completion
  errorConsequences?: string[]; // procedural-skill - consequences for unsafe or incorrect actions
  challenge?: string; // game - description of what player does
  playerControls?: string[]; // game - what player controls
  nodeCount?: number; // diagram - approximate node count
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>; // diagram - prescribed nodes and optional hierarchy
  challengeType?: string; // code - type of coding challenge
}

/**
 * Simplified scene outline
 * Gives AI more freedom, only requiring intent description and key points
 */
export interface SceneOutline {
  id: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl';
  title: string;
  description: string; // 1-2 sentences describing the purpose
  keyPoints: string[]; // 3-5 core key points
  teachingObjective?: string;
  /** Machine-checked objective ids this scene must serve. */
  objectiveIds?: string[];
  /**
   * Validated objective contracts attached after outline review. Model-supplied
   * values are overwritten; content generators consume these exact contracts.
   */
  learningObjectives?: Array<{
    id: string;
    action: string;
    condition: string;
    successCriterion: string;
  }>;
  /** Validator-approved teaching duties for this scene. */
  learningPhaseRoles?: Array<
    | 'prerequisiteActivation'
    | 'demonstration'
    | 'learnerPractice'
    | 'feedbackRetry'
    | 'transferApplication'
    | 'assessment'
  >;
  estimatedDuration?: number; // seconds
  order: number;
  languageNote?: string; // LLM-inferred language note for this scene
  // Suggested image IDs (from PDF-extracted images)
  suggestedImageIds?: string[]; // e.g., ["img_1", "img_3"]
  // AI-generated media requests (when PDF images are insufficient)
  mediaGenerations?: MediaGenerationRequest[]; // e.g., [{ type: 'image', prompt: '...', elementId: 'gen_img_1' }]
  // Quiz-specific config
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'text')[];
  };
  /**
   * @deprecated Use widgetType + widgetOutline instead
   * Legacy interactive config - kept for backward compatibility only
   */
  interactiveConfig?: {
    conceptName: string;
    conceptOverview: string;
    designIdea: string;
    subject?: string;
  };
  // PBL-specific config
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    /** Opt into role-play scenario planning on top of the standard PBL v2 structure. */
    scenarioRoleplay?: boolean;
    /** Optional scenario brief used only when scenarioRoleplay is true. */
    scenarioBrief?: string;
  };
  // Widget fields (required for type === 'interactive' in unified mode)
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
  /**
   * 生成期算出的概念标签，由 `/api/generate/scene-content` 挂在回传的
   * `effectiveOutline` 上，`/api/generate/scene-actions` 再把它写进组装好的场景
   * （`Scene.concepts`）。走大纲这条现成的回传通道，是为了不改客户端生成循环。
   *
   * 大纲本身不消费它；检索没给证据时整个字段不写。
   */
  concepts?: import('@/lib/evidence/scene-concepts').SceneConcepts;
}

// ==================== Stage 3 Output: Generated Content ====================

import type { PPTElement, SlideBackground } from '@openmaic/dsl';
import type { QuizQuestion } from './stage';

/**
 * AI-generated slide content
 */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
}

/**
 * AI-generated quiz content
 */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

// ==================== PBL Generation Types ====================

import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

/**
 * AI-generated PBL content.
 *
 * PBL v2 generation returns a legacy-compatible `projectConfig` plus the full
 * v2 payload so existing storage/rendering paths can migrate incrementally.
 */
export interface GeneratedPBLContent {
  projectConfig: PBLProjectConfig;
  projectV2?: PBLProjectV2;
}

// ==================== Interactive Generation Types ====================

import type { WidgetConfig, WidgetType } from './widgets';

/**
 * Scientific model output from scientific modeling stage
 */
export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/**
 * AI-generated interactive content
 */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
}

// ==================== Legacy Types (for compatibility) ====================

export interface SuggestedSlideElement {
  type: 'text' | 'image' | 'shape' | 'chart' | 'latex' | 'line';
  purpose: 'title' | 'subtitle' | 'content' | 'example' | 'diagram' | 'formula' | 'highlight';
  contentHint: string;
  position?: 'top' | 'center' | 'bottom' | 'left' | 'right';
  chartType?: 'bar' | 'line' | 'pie' | 'radar';
  textOutline?: string[];
}

export interface SuggestedQuizQuestion {
  type: 'single' | 'multiple' | 'short_answer';
  questionOutline: string;
  suggestedOptions?: string[];
  targetConceptId?: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface SuggestedAction {
  type: ActionType;
  description: string;
  timing?: 'start' | 'middle' | 'end' | 'after-content';
}
