/**
 * Widget Configuration Types for Ultra Interaction Mode
 */

// ==================== Base Types ====================

export type WidgetType =
  | 'simulation'
  | 'diagram'
  | 'code'
  | 'game'
  | 'visualization3d'
  | 'procedural-skill'
  // 模板池参数化教具：LLM 选模板+填参数，站内 React 确定性渲染（不走 iframe）。
  // 'template' 不在上游 DSL 的 WIDGET_TYPES 里——同步上游 dsl/interactive.ts 会让
  // 存量课校验失败，tests/types/template-widget-mutex.test.ts 钉住此互斥。
  | 'template';

// ==================== Simulation Widget ====================

export interface SimulationVariable {
  name: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  step?: number;
}

export interface SimulationConfig {
  type: 'simulation';
  concept: string;
  description: string;
  variables: SimulationVariable[];
  presets?: Array<{
    name: string;
    variables: Record<string, number>;
  }>;
}

// ==================== Diagram Widget ====================

export interface DiagramNode {
  id: string;
  label: string;
  position?: { x: number; y: number };
  details?: string;
  type?: 'default' | 'decision' | 'start' | 'end';
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface DiagramConfig {
  type: 'diagram';
  diagramType: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  description: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  revealOrder?: string[]; // Node IDs in reveal sequence
}

// ==================== Code Widget ====================

export interface CodeTestCase {
  id: string;
  input: string;
  expected: string;
  description?: string;
  isHidden?: boolean;
}

export interface CodeConfig {
  type: 'code';
  language: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  description: string;
  starterCode: string;
  testCases: CodeTestCase[];
  hints: string[];
  solution: string;
}

// ==================== Game Widget ====================

export interface GameQuestion {
  id: string;
  question: string;
  type: 'single' | 'multiple';
  options: string[];
  correct: number | number[];
  explanation?: string;
  points?: number;
}

export interface GameConfig {
  type: 'game';
  gameType: 'quiz' | 'puzzle' | 'strategy' | 'card';
  description: string;
  questions?: GameQuestion[];
  scoring: {
    correctPoints: number;
    speedBonus?: number;
    comboMultiplier?: number;
    penalty?: number;
  };
  achievements?: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    condition: string;
  }>;
}

// ==================== 3D Visualization Widget ====================

export interface Visualization3DObject {
  id: string;
  type: 'sphere' | 'box' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'custom';
  name?: string;
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: number | { x: number; y: number; z: number };
  material?: {
    type: 'basic' | 'lambert' | 'phong' | 'standard' | 'emissive';
    color?: string;
    emissive?: string;
    wireframe?: boolean;
    transparent?: boolean;
    opacity?: number;
  };
  // For animated objects
  animation?: {
    type: 'orbit' | 'rotate' | 'bounce' | 'pulse';
    speed?: number;
    axis?: 'x' | 'y' | 'z';
  };
  // For hierarchical objects
  children?: Visualization3DObject[];
}

export interface Visualization3DInteraction {
  type: 'orbit' | 'zoom' | 'pan' | 'slider' | 'button' | 'toggle';
  target?: string; // Object ID or 'camera'
  label?: string;
  param?: string;
  min?: number;
  max?: number;
  default?: number;
  step?: number;
}

export interface Visualization3DConfig {
  type: 'visualization3d';
  visualizationType: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  description: string;
  objects: Visualization3DObject[];
  interactions?: Visualization3DInteraction[];
  camera?: {
    position?: { x: number; y: number; z: number };
    target?: { x: number; y: number; z: number };
    fov?: number;
  };
  lighting?: {
    ambient?: { color?: string; intensity?: number };
    directional?: Array<{
      color?: string;
      intensity?: number;
      position?: { x: number; y: number; z: number };
    }>;
    point?: Array<{
      color?: string;
      intensity?: number;
      position?: { x: number; y: number; z: number };
    }>;
  };
  presets?: Array<{
    name: string;
    description?: string;
    state: Record<string, unknown>;
  }>;
}

// ==================== Procedural Skill Widget ====================

export interface ProceduralSkillStep {
  id: string;
  title: string;
  description: string;
  tools?: string[];
  successCriteria?: string[];
}

export interface ProceduralSkillConfig {
  type: 'procedural-skill';
  task: string;
  description: string;
  tools?: string[];
  steps: ProceduralSkillStep[];
  successCriteria?: string[];
}

// ==================== Template Widget（模板池参数化教具） ====================
// 参数预制、交互数学确定性、断网可用；LLM 只负责「选模板 + 填参数」。
// 参数类型是模板组件（components/widgets/*）与生成校验（lib/generation/widget-templates.ts）
// 的共同契约，改字段要两头同步。

/** 注意力热区：点选 query token 看注意力权重分布，拖温度看 softmax 锐化 */
export interface AttentionTemplateParams {
  tokens: string[];
  /** scores[i][j] = token i 作为 query 时对 token j 的原始相容性分（softmax 前），方阵 */
  scores: number[][];
  /** 初始选中的 query token 下标 */
  focusDefault?: number;
}

/** BPE 合并步进器：逐步展示子词合并过程 */
export interface BpeTemplateParams {
  /** 每一步的分词状态，如 [["l","o","w"], ["lo","w"], ["low"]] */
  steps: string[][];
  /** 每步说明，与 steps 等长 */
  captions: string[];
}

/** 温度采样器：拖温度看下一个词概率分布变形，按分布抽样 */
export interface TemperatureTemplateParams {
  /** 上文，如「今天天气真」 */
  context: string;
  candidates: { token: string; logit: number }[];
}

/** RAG 检索沙盘：改 query 看召回排序实时变化（字符二元组 Dice 打分，可手算验证） */
export interface RagTemplateParams {
  chunks: { id: string; title: string; text: string }[];
  suggestedQueries: string[];
}

// ---- 主题无关模板（下面三个不绑定 LLM 题材，任何学科都能填参数） ----

/** 曲线族。系数 a/b/c 的含义随族变，公式写在界面上供核对。
 * x 只取 xAxis 范围内的值；power/logarithmic 要求 xAxis.min > 0（否则 NaN）。 */
export type CurveFamily =
  | 'linear' // y = a·x + b
  | 'quadratic' // y = a·x² + b·x + c
  | 'power' // y = a·x^b + c
  | 'exponential' // y = a·e^(b·x) + c
  | 'logarithmic' // y = a·ln(x) + b
  | 'logistic'; // y = a / (1 + e^(-b·(x - c)))

/** 参数曲线：拖滑块改系数，实时看曲线变形；可选切线看瞬时变化率。
 * 服务一切「有超参 / 有函数关系」的主题：学习率、量化位宽、批大小、导数、缩放律。 */
export interface ParameterCurveParams {
  curve: CurveFamily;
  /** 系数初值；滑块绑定的那个 key 的初值就是滑块默认位置 */
  coefficients: { a: number; b: number; c: number };
  /** 1-2 个可调系数。自由度故意压到这么小——滑块越多，学生越不知道在看什么 */
  sliders: { key: 'a' | 'b' | 'c'; label: string; min: number; max: number; step: number }[];
  xAxis: { label: string; min: number; max: number };
  yAxis: { label: string };
  /** 讲导数/瞬时变化率时开：多一个 x₀ 滑块，画切线并报斜率 */
  showTangent?: boolean;
  /** 2-4 条「拖到哪里、该看到什么」的观察提示 */
  observations: string[];
}

/** 步进流程：一步一步走完一条管线，看每步做什么、往下传什么。
 * 服务一切讲流程的主题：RAG 管线、训练流程、ROS2 话题通信、推理流水线、函数调用栈。 */
export interface ProcessStepperParams {
  /** 3-8 步；carries = 这一步交给下一步的东西（管线的「数据」） */
  steps: { title: string; detail: string; carries?: string }[];
}

/** 取舍矩阵：勾选自己在意的维度，选项按加权得分实时重排。
 * 服务一切讲权衡的主题：模型选型、部署方案、提示策略、评测指标取舍。 */
export interface TradeoffMatrixParams {
  /** 2-5 个比较维度（如「延迟」「成本」「可控性」） */
  dimensions: string[];
  /** 2-5 个选项；cells 与 dimensions 等长同序，rating 1-5 分（5 = 这一维表现最好） */
  options: { name: string; cells: { text: string; rating: number }[] }[];
}

/** 分层拓扑图：点节点看它连到谁。与 process_stepper 的分工是「有没有分叉」——
 * 线性的一条链用步进器，一对多 / 多对一 / 有回边的拓扑用这个。
 * 服务多 Agent 编排、ROS2 话题订阅、模块依赖、数据流向。
 *
 * 关键约束：层由 LLM 给，坐标永远不由 LLM 给。老 diagram widget 反复生成失败
 * 就是因为让模型自己排版；这里模型只说「谁在第几层、谁连谁」，布局是组件算的。 */
export interface LayeredGraphParams {
  /** 2-4 层，从左到右；每层 1-4 个节点，节点总数 ≤ 12 */
  layers: { title: string; nodes: { id: string; label: string; note?: string }[] }[];
  /** 边只能跨层（同层互连会让布局退化成一团麻）；指向左边的回边画成虚线 */
  edges: { from: string; to: string; label?: string }[];
}

export type WidgetTemplateId =
  | 'attention_playground'
  | 'bpe_merge_stepper'
  | 'temperature_sampler'
  | 'rag_retrieval_playground'
  | 'parameter_curve'
  | 'process_stepper'
  | 'tradeoff_matrix'
  | 'layered_graph';

export type TemplateWidgetConfig =
  | {
      type: 'template';
      templateId: 'attention_playground';
      name: string;
      guide?: string;
      params: AttentionTemplateParams;
    }
  | {
      type: 'template';
      templateId: 'bpe_merge_stepper';
      name: string;
      guide?: string;
      params: BpeTemplateParams;
    }
  | {
      type: 'template';
      templateId: 'temperature_sampler';
      name: string;
      guide?: string;
      params: TemperatureTemplateParams;
    }
  | {
      type: 'template';
      templateId: 'rag_retrieval_playground';
      name: string;
      guide?: string;
      params: RagTemplateParams;
    }
  | {
      type: 'template';
      templateId: 'parameter_curve';
      name: string;
      guide?: string;
      params: ParameterCurveParams;
    }
  | {
      type: 'template';
      templateId: 'process_stepper';
      name: string;
      guide?: string;
      params: ProcessStepperParams;
    }
  | {
      type: 'template';
      templateId: 'tradeoff_matrix';
      name: string;
      guide?: string;
      params: TradeoffMatrixParams;
    }
  | {
      type: 'template';
      templateId: 'layered_graph';
      name: string;
      guide?: string;
      params: LayeredGraphParams;
    };

// ==================== Union Types ====================

export type WidgetConfig =
  | SimulationConfig
  | DiagramConfig
  | CodeConfig
  | GameConfig
  | Visualization3DConfig
  | ProceduralSkillConfig
  | TemplateWidgetConfig;
