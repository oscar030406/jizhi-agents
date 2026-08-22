/**
 * 交互教具模板池：目录、参数校验、LLM 选择结果解析。
 *
 * 背景（docs/03-design/widget-quality-workstream.md 病灶 3）：interactive 场景
 * 此前让 LLM 现场手写 27k HTML，模型常回 markdown 不回 HTML，extractHtml 失败
 * 反复重试卡死课程。此处改为「LLM 只从模板池选一个模板 + 填参数 JSON」，
 * 排版与交互数学由站内 React 模板确定性负责（与幻灯片槽位制同一教训）。
 *
 * 参数类型契约见 lib/types/widgets.ts；渲染组件见 components/widgets/。
 */

import { z } from 'zod';
import type { TemplateWidgetConfig, WidgetTemplateId } from '@/lib/types/widgets';
import { parseJsonResponse } from './json-repair';

// ==================== 模板目录（注入选择提示词） ====================

interface WidgetTemplateMeta {
  id: WidgetTemplateId;
  /** 默认教具名（LLM 未起名时兜底） */
  label: string;
  /** 适用主题一句话，供 LLM 判断选不选 */
  topic: string;
  /** 参数字段说明，直接拼进提示词。示例不写在这里——由 sample 生成，避免两处漂移 */
  paramsDoc: string;
  /**
   * 确定性默认参数：提示词里的 Example 由它序列化而来。每条 sample 都被
   * widget-template-selection 测试拿自己的校验器跑过，所以提示词里的示例
   * 永远是合法参数。
   * 注意它**不是**运行期降级形态——选不出模板 / 两次校验都不过时
   * generateTemplateWidgetContent 返回 null，由上游降级成讲义场景，
   * 不会拿 sample 顶上去（顶上去等于给学习者看一份与本课无关的示例教具）。
   */
  sample: TemplateWidgetConfig['params'];
}

export const WIDGET_TEMPLATES: readonly WidgetTemplateMeta[] = [
  {
    id: 'attention_playground',
    label: '注意力权重热区',
    topic:
      'Self-attention / attention weights / softmax sharpening — learner clicks a query token and sees its attention distribution over all tokens; a temperature slider shows softmax sharpening.',
    paramsDoc: `params:
- tokens: string[] (2-12 tokens forming one sentence/sequence)
- scores: number[][] (square matrix, scores[i][j] = raw compatibility of query token i to token j, pre-softmax; keep values roughly in [-3, 3])
- focusDefault: integer (optional, index of the initially selected query token)`,
    sample: {
      tokens: ['我', '去', '银行', '存钱'],
      scores: [
        [2.0, 0.8, 0.6, 0.3],
        [0.8, 2.0, 0.9, 0.7],
        [0.5, 0.7, 2.0, 1.8],
        [0.3, 0.6, 1.7, 2.0],
      ],
      focusDefault: 2,
    },
  },
  {
    id: 'bpe_merge_stepper',
    label: 'BPE 合并步进器',
    topic:
      'Tokenization / BPE / subword vocabulary — learner steps through merge operations and watches characters grow into subwords, with a caption explaining each merge. Only for token-sequence merging; a generic multi-stage process belongs in process_stepper.',
    paramsDoc: `params:
- steps: string[][] (2-12 tokenization states, from all-characters to final subwords; each later step merges adjacent units of the previous step)
- captions: string[] (same length as steps, one explanation per step)`,
    sample: {
      steps: [
        ['l', 'o', 'w', 'e', 'r'],
        ['lo', 'w', 'e', 'r'],
        ['low', 'e', 'r'],
        ['low', 'er'],
      ],
      captions: [
        '初始状态：全部拆成单字符',
        '(l,o) 出现最频繁 → 合并成 lo',
        '(lo,w) 次之 → 合并成 low',
        '(e,r) 合并成 er——常见后缀自己浮现',
      ],
    },
  },
  {
    id: 'temperature_sampler',
    label: '温度采样器',
    topic:
      'Sampling temperature / next-token probability / logits vs. probabilities — learner drags a temperature slider to reshape the next-token distribution and samples from it.',
    paramsDoc: `params:
- context: string (the prompt prefix, e.g. "今天天气真")
- candidates: {token: string, logit: number}[] (2-10 next-token candidates with raw logits, roughly in [-3, 4], ordered from most to least likely)`,
    sample: {
      context: '今天天气真',
      candidates: [
        { token: '不错', logit: 3.2 },
        { token: '好', logit: 2.8 },
        { token: '冷', logit: 1.5 },
        { token: '打雷', logit: -0.5 },
      ],
    },
  },
  {
    id: 'rag_retrieval_playground',
    label: 'RAG 检索沙盘',
    topic:
      'RAG / retrieval / recall ranking / evidence grounding — learner edits the query and watches which knowledge chunks are recalled and how the ranking changes.',
    paramsDoc: `params:
- chunks: {id: string, title: string, text: string}[] (3-8 knowledge-base chunks; text is 1-2 sentences each)
- suggestedQueries: string[] (1-5 suggested queries that recall different chunks)`,
    sample: {
      chunks: [
        {
          id: 'kb01',
          title: 'RAG 与幻觉抑制',
          text: '检索增强生成把外部知识接入生成过程，模型只基于召回证据作答。',
        },
        { id: 'kb02', title: '向量检索原理', text: '把文本编码为向量，用相似度找最近邻。' },
        {
          id: 'kb03',
          title: '引用与溯源',
          text: '生成结果为每条结论标注来源编号，读者可回溯核验。',
        },
      ],
      suggestedQueries: ['RAG 怎么减少幻觉', '向量检索的原理'],
    },
  },
  {
    id: 'parameter_curve',
    label: '参数曲线实验台',
    topic:
      'ANY subject where one number controls an outcome — learning rate, temperature, batch size, quantization bit-width, scaling laws, cost vs. throughput, a derivative/tangent, growth or decay. Learner drags a coefficient slider and watches the curve deform. Topic-agnostic: pick it whenever the lesson has a knob and a consequence.',
    paramsDoc: `params:
- curve: one of "linear" (a·x+b) | "quadratic" (a·x²+b·x+c) | "power" (a·x^b+c) | "exponential" (a·e^(b·x)+c) | "logarithmic" (a·ln(x)+b) | "logistic" (a/(1+e^(-b·(x-c))))
- coefficients: {a: number, b: number, c: number} (initial values; unused letters still required, set them to 0)
- sliders: {key: "a"|"b"|"c", label: string, min: number, max: number, step: number}[] (1-2 entries; label names the real-world quantity, e.g. "学习率 η"; the coefficient's initial value must sit inside [min, max])
- xAxis: {label: string, min: number, max: number} (min < max; for "power" and "logarithmic" min must be > 0)
- yAxis: {label: string}
- showTangent: boolean (optional; true adds an x₀ slider that draws the tangent and reports its slope — use it for derivative / instantaneous-rate lessons)
- observations: string[] (2-4 lines of "drag X to Y and you should see Z")`,
    sample: {
      curve: 'quadratic',
      coefficients: { a: 1, b: 0, c: 0 },
      sliders: [{ key: 'a', label: '开口系数 a', min: 0.2, max: 3, step: 0.1 }],
      xAxis: { label: '参数 x', min: -3, max: 3 },
      yAxis: { label: '损失 L(x)' },
      showTangent: true,
      observations: [
        '把 a 调大，谷底变陡——同样走一步，损失下降更多。',
        '拖切点到 x=0，斜率归零：这就是梯度下降要停的地方。',
      ],
    },
  },
  {
    id: 'process_stepper',
    label: '流程步进器',
    topic:
      'ANY multi-stage process or pipeline — RAG retrieval→rerank→generate, a training run, ROS2 topic publish→subscribe, an inference pipeline, an HTTP request lifecycle, a function call stack, a lab procedure. Learner walks the stages one at a time and sees what each stage hands to the next. Topic-agnostic: pick it whenever the lesson is "first this, then that".',
    paramsDoc: `params:
- steps: {title: string, detail: string, carries?: string}[] (3-8 stages in order; title is 2-8 chars, detail is 1-2 sentences on what this stage does, carries is the concrete artifact handed to the next stage, e.g. "3 个候选片段 + 相似度分数")`,
    sample: {
      steps: [
        {
          title: '提问',
          detail: '用户输入一个自然语言问题，系统先把它当成检索的 query，而不是直接丢给模型。',
          carries: '原始问题文本',
        },
        {
          title: '检索',
          detail: '在知识库里按相似度找出最相关的若干片段，这一步决定了模型能看到什么证据。',
          carries: 'top-k 片段 + 相似度分数',
        },
        {
          title: '拼装',
          detail: '把召回片段和问题拼成一个提示词，明确要求模型只依据给定证据作答。',
          carries: '带证据的完整提示词',
        },
        {
          title: '生成',
          detail: '模型基于提示词作答，并为每条结论标注它引用的片段编号，便于回溯核验。',
        },
      ],
    },
  },
  {
    id: 'tradeoff_matrix',
    label: '取舍矩阵',
    topic:
      'ANY lesson about choosing between alternatives — model selection, deployment options, prompting strategies, evaluation metrics, data structures, algorithms, framework choice. Learner toggles which dimensions they care about and the options re-rank live. Topic-agnostic: pick it whenever the honest answer is "it depends on what you care about".',
    paramsDoc: `params:
- dimensions: string[] (2-5 comparison axes, each 2-6 chars, phrased so that higher is better, e.g. "速度" "成本可控" "可解释")
- options: {name: string, cells: {text: string, rating: number}[]}[] (2-5 alternatives; every option's cells array must have exactly one entry per dimension, in the same order; text is a ≤14-char concrete fact, rating is an integer 1-5 where 5 = best on that dimension)`,
    sample: {
      dimensions: ['响应速度', '成本可控', '可定制'],
      options: [
        {
          name: '调用闭源 API',
          cells: [
            { text: '首字 200ms', rating: 4 },
            { text: '按 token 计费', rating: 2 },
            { text: '只能改提示词', rating: 2 },
          ],
        },
        {
          name: '自部署开源模型',
          cells: [
            { text: '受显卡限制', rating: 3 },
            { text: '一次性买卡', rating: 4 },
            { text: '可微调可改权重', rating: 5 },
          ],
        },
        {
          name: '小模型 + 检索',
          cells: [
            { text: '首字 80ms', rating: 5 },
            { text: '显存占用最小', rating: 5 },
            { text: '受限于知识库', rating: 3 },
          ],
        },
      ],
    },
  },
  {
    id: 'layered_graph',
    label: '分层拓扑图',
    topic:
      'ANY lesson about who talks to whom — multi-agent orchestration, ROS2 nodes and topics, module dependencies, microservice calls, data flow, a system block diagram. Learner clicks a node and sees what it feeds and what feeds it. Pick this over process_stepper when the structure BRANCHES (one stage fans out to several, several merge back, or something loops back); a single straight chain belongs in process_stepper.',
    paramsDoc: `params:
- layers: {title: string, nodes: {id: string, label: string, note?: string}[]}[] (2-4 layers left to right, e.g. "入口" / "编排" / "执行" / "汇总"; each layer holds 1-4 nodes; 12 nodes total at most; id is a short unique slug, label is <=8 chars shown in the box, note is one sentence shown when the node is clicked)
- edges: {from: string, to: string, label?: string}[] (1-14 edges; from/to are node ids that must exist and must sit in DIFFERENT layers; an edge pointing back to an earlier layer is drawn dashed as a feedback loop; label is <=6 chars, e.g. "派发")
Do not supply coordinates — the component computes the layout.`,
    sample: {
      layers: [
        { title: '入口', nodes: [{ id: 'user', label: '用户提问', note: '一句自然语言需求，还没有被拆解。' }] },
        {
          title: '编排',
          nodes: [
            {
              id: 'planner',
              label: '规划 Agent',
              note: '把需求拆成子任务，决定派给哪几个执行 Agent，并在结果不合格时重新规划。',
            },
          ],
        },
        {
          title: '执行',
          nodes: [
            { id: 'search', label: '检索 Agent', note: '查资料，只负责把证据找回来。' },
            { id: 'code', label: '代码 Agent', note: '写代码并跑通，产出可运行的结果。' },
            { id: 'review', label: '审校 Agent', note: '挑错，对前两个的产出做交叉检查。' },
          ],
        },
        { title: '汇总', nodes: [{ id: 'merge', label: '汇总输出', note: '把各路结果拼成最终答复。' }] },
      ],
      edges: [
        { from: 'user', to: 'planner' },
        { from: 'planner', to: 'search', label: '派发' },
        { from: 'planner', to: 'code', label: '派发' },
        { from: 'planner', to: 'review', label: '派发' },
        { from: 'search', to: 'merge' },
        { from: 'code', to: 'merge' },
        { from: 'review', to: 'merge' },
        { from: 'merge', to: 'planner', label: '不合格' },
      ],
    },
  },
];

/** 拼出提示词用的模板目录文本。Example 由 sample 序列化，与校验器同源。 */
export function buildTemplateCatalogText(): string {
  return WIDGET_TEMPLATES.map(
    (t) =>
      `### ${t.id}\nDefault name: ${t.label}\nUse when: ${t.topic}\n${t.paramsDoc}\nExample:\n${JSON.stringify(t.sample)}`,
  ).join('\n\n');
}

// ==================== 参数校验（LLM 输出是不可信输入） ====================

const attentionSchema = z.object({
  tokens: z.array(z.string().min(1)).min(2).max(12),
  scores: z.array(z.array(z.number().finite())).min(2),
  focusDefault: z.number().int().min(0).optional(),
});

const bpeSchema = z.object({
  steps: z.array(z.array(z.string().min(1)).min(1)).min(2).max(12),
  captions: z.array(z.string().min(1)).min(2),
});

const temperatureSchema = z.object({
  context: z.string().min(1),
  candidates: z
    .array(z.object({ token: z.string().min(1), logit: z.number().finite() }))
    .min(2)
    .max(10),
});

const ragSchema = z.object({
  chunks: z
    .array(z.object({ id: z.string().min(1), title: z.string().min(1), text: z.string().min(1) }))
    .min(3)
    .max(8),
  suggestedQueries: z.array(z.string().min(1)).min(1).max(5),
});

const CURVE_FAMILIES = [
  'linear',
  'quadratic',
  'power',
  'exponential',
  'logarithmic',
  'logistic',
] as const;

const curveSchema = z.object({
  curve: z.enum(CURVE_FAMILIES),
  coefficients: z.object({
    a: z.number().finite(),
    b: z.number().finite(),
    c: z.number().finite(),
  }),
  sliders: z
    .array(
      z.object({
        key: z.enum(['a', 'b', 'c']),
        label: z.string().min(1),
        min: z.number().finite(),
        max: z.number().finite(),
        step: z.number().finite().positive(),
      }),
    )
    .min(1)
    .max(2),
  xAxis: z.object({ label: z.string().min(1), min: z.number().finite(), max: z.number().finite() }),
  yAxis: z.object({ label: z.string().min(1) }),
  showTangent: z.boolean().optional(),
  observations: z.array(z.string().min(1)).min(2).max(4),
});

const stepperSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(1),
        detail: z.string().min(1),
        carries: z.string().min(1).optional(),
      }),
    )
    .min(3)
    .max(8),
});

const tradeoffSchema = z.object({
  dimensions: z.array(z.string().min(1)).min(2).max(5),
  options: z
    .array(
      z.object({
        name: z.string().min(1),
        cells: z.array(
          z.object({ text: z.string().min(1), rating: z.number().int().min(1).max(5) }),
        ),
      }),
    )
    .min(2)
    .max(5),
});

const graphSchema = z.object({
  layers: z
    .array(
      z.object({
        title: z.string().min(1),
        nodes: z
          .array(
            z.object({
              id: z.string().min(1),
              label: z.string().min(1).max(8),
              note: z.string().min(1).optional(),
            }),
          )
          .min(1)
          .max(4),
      }),
    )
    .min(2)
    .max(4),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().min(1).max(6).optional(),
      }),
    )
    .min(1)
    .max(14),
});

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

type ValidateResult =
  | { ok: true; config: TemplateWidgetConfig }
  | { ok: false; error: string };

/**
 * 按模板校验参数。结构校验交给 zod，跨字段一致性（方阵、等长）手工补。
 * 通过则返回可直接落库的 TemplateWidgetConfig。
 */
export function validateTemplateParams(
  templateId: string,
  params: unknown,
  meta?: { name?: string; guide?: string },
): ValidateResult {
  const template = WIDGET_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    return {
      ok: false,
      error: `unknown templateId "${templateId}"; must be one of: ${WIDGET_TEMPLATES.map((t) => t.id).join(', ')}`,
    };
  }

  const base = {
    type: 'template' as const,
    name: meta?.name?.trim() || template.label,
    ...(meta?.guide?.trim() ? { guide: meta.guide.trim() } : {}),
  };

  switch (template.id) {
    case 'attention_playground': {
      const parsed = attentionSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      const { tokens, scores, focusDefault } = parsed.data;
      if (scores.length !== tokens.length || scores.some((row) => row.length !== tokens.length)) {
        return { ok: false, error: `scores must be a ${tokens.length}x${tokens.length} square matrix matching tokens length` };
      }
      if (focusDefault !== undefined && focusDefault >= tokens.length) {
        return { ok: false, error: `focusDefault (${focusDefault}) out of range for ${tokens.length} tokens` };
      }
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
    case 'bpe_merge_stepper': {
      const parsed = bpeSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      if (parsed.data.captions.length !== parsed.data.steps.length) {
        return { ok: false, error: `captions length (${parsed.data.captions.length}) must equal steps length (${parsed.data.steps.length})` };
      }
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
    case 'temperature_sampler': {
      const parsed = temperatureSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
    case 'rag_retrieval_playground': {
      const parsed = ragSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
    case 'parameter_curve': {
      const parsed = curveSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      const { curve, coefficients, sliders, xAxis } = parsed.data;
      if (xAxis.min >= xAxis.max) {
        return { ok: false, error: `xAxis.min (${xAxis.min}) must be less than xAxis.max (${xAxis.max})` };
      }
      // x ≤ 0 时 ln(x) 和非整数次幂都是 NaN，整条曲线会消失——拦在生成端
      if ((curve === 'power' || curve === 'logarithmic') && xAxis.min <= 0) {
        return {
          ok: false,
          error: `curve "${curve}" is undefined for x <= 0; xAxis.min must be greater than 0`,
        };
      }
      for (const s of sliders) {
        if (s.min >= s.max) {
          return { ok: false, error: `slider "${s.key}": min (${s.min}) must be less than max (${s.max})` };
        }
        const initial = coefficients[s.key];
        if (initial < s.min || initial > s.max) {
          return {
            ok: false,
            error: `coefficients.${s.key} (${initial}) must sit inside its slider range [${s.min}, ${s.max}]`,
          };
        }
      }
      if (sliders.length === 2 && sliders[0].key === sliders[1].key) {
        return { ok: false, error: `two sliders bound to the same coefficient "${sliders[0].key}"` };
      }
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
    case 'process_stepper': {
      const parsed = stepperSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
    case 'tradeoff_matrix': {
      const parsed = tradeoffSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      const { dimensions, options } = parsed.data;
      const bad = options.find((o) => o.cells.length !== dimensions.length);
      if (bad) {
        return {
          ok: false,
          error: `option "${bad.name}" has ${bad.cells.length} cells but there are ${dimensions.length} dimensions; every option needs exactly one cell per dimension, in the same order`,
        };
      }
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
    case 'layered_graph': {
      const parsed = graphSchema.safeParse(params);
      if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
      const { layers, edges } = parsed.data;

      // id → 层号，同时查重复 id（重复会让边指向哪个节点变成掷骰子）
      const layerOf = new Map<string, number>();
      for (const [li, layer] of layers.entries()) {
        for (const node of layer.nodes) {
          if (layerOf.has(node.id)) {
            return { ok: false, error: `duplicate node id "${node.id}"; every node id must be unique across all layers` };
          }
          layerOf.set(node.id, li);
        }
      }
      if (layerOf.size > 12) {
        return { ok: false, error: `${layerOf.size} nodes is too many; keep the whole graph to 12 nodes or fewer` };
      }
      for (const e of edges) {
        const from = layerOf.get(e.from);
        const to = layerOf.get(e.to);
        if (from === undefined || to === undefined) {
          const missing = from === undefined ? e.from : e.to;
          return { ok: false, error: `edge references unknown node id "${missing}"; both ends must be ids declared in layers` };
        }
        // 同层互连没有左右可走，线会横在框上——布局是确定性的，所以只能在这里拦
        if (from === to) {
          return { ok: false, error: `edge "${e.from}" -> "${e.to}" joins two nodes in the same layer; edges must cross layers` };
        }
      }
      return { ok: true, config: { ...base, templateId: template.id, params: parsed.data } };
    }
  }
}

// ==================== LLM 选择结果解析 ====================

export type TemplateSelectionResult =
  | { status: 'selected'; config: TemplateWidgetConfig }
  | { status: 'none'; reason: string }
  | { status: 'invalid'; error: string };

const selectionSchema = z.object({
  templateId: z.union([z.string(), z.null()]),
  name: z.string().optional(),
  guide: z.string().optional(),
  reason: z.string().optional(),
  params: z.unknown().optional(),
});

/**
 * 解析「选模板 + 填参数」的 LLM 输出。
 * templateId 为 null = 模板池没有合适的（走讲义降级）；
 * 解析/校验失败 = invalid（调用方带错误信息重试一次）。
 */
export function parseTemplateSelection(response: string): TemplateSelectionResult {
  const raw = parseJsonResponse<unknown>(response);
  if (raw === null) {
    return { status: 'invalid', error: 'response is not parseable JSON; output a single JSON object only' };
  }

  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'invalid', error: formatZodError(parsed.error) };
  }

  if (parsed.data.templateId === null) {
    return { status: 'none', reason: parsed.data.reason || 'no suitable template' };
  }

  const validated = validateTemplateParams(parsed.data.templateId, parsed.data.params, {
    name: parsed.data.name,
    guide: parsed.data.guide,
  });
  if (!validated.ok) return { status: 'invalid', error: validated.error };
  return { status: 'selected', config: validated.config };
}
