/**
 * Type definitions for the generation pipeline.
 */

// ==================== Agent Info ====================

/** Lightweight agent info passed to the generation pipeline */
export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  persona?: string;
}

// ==================== Cross-Page Context ====================

/** Cross-page context for maintaining speech coherence across scenes */
export interface SceneGenerationContext {
  pageIndex: number; // Current page (1-based)
  totalPages: number; // Total number of pages
  allTitles: string[]; // All page titles in order
  previousSpeeches: string[]; // Speech texts from the previous page only
  /**
   * 全课**已经用过的口播开头**（每条取前 12 字），按页序。
   *
   * 为什么单独开这一项：`previousSpeeches` 按设计只带上一页、且只截最后 150 字，
   * 是给「衔接上一页」用的。结果模型看不见自己在别的页用过什么开场，
   * 每页都独立挑了最顺口的那句——2026-08-13 实测 23 门课 557 条口播，
   * 「这一节的核心」17 次、「这一节的关键」12 次、「大家好，欢迎」23 次
   * （每门课开场一模一样），前 12 个开头覆盖 22% 的条目。
   * 判据与统计见 `lib/generation/speech-lint.ts` 头注。
   */
  usedOpenings?: string[];
}

// ==================== Generated Slide Data Interface ====================

/**
 * AI-generated slide data structure
 * Used to parse AI responses
 */
export interface GeneratedSlideData {
  elements: Array<{
    type: 'text' | 'image' | 'video' | 'shape' | 'chart' | 'latex' | 'line';
    left: number;
    top: number;
    width: number;
    height: number;
    [key: string]: unknown;
  }>;
  background?: {
    type: 'solid' | 'gradient';
    color?: string;
    gradient?: {
      type: 'linear' | 'radial';
      colors: Array<{ pos: number; color: string }>;
      rotate: number;
    };
  };
  remark?: string;
}

// ==================== Types ====================

export interface GenerationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export type AICallFn = (
  systemPrompt: string,
  userPrompt: string,
  images?: Array<{ id: string; src: string }>,
) => Promise<string>;
