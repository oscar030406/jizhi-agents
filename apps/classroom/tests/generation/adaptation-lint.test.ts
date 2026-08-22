/**
 * 生成后机械 lint 的回归。
 *
 * 用例文本全部是 `apps/agent-engine/data/eval/adaptation_probe/resources/` 里的真实片段
 * （54 份纯净快照，run 20260810-172357），断言里的数值由参考实现
 * `apps/agent-engine/scripts/calibrate_adaptation_lint.py` 在同一段字符串上算出，
 * 不是手工估的。规格：`docs/03-design/adaptation-lint-spec-20260811.md`。
 *
 * **口径**：快照是摘录**注入后**的成品，而 lint 跑在注入之前，看到的是 `{{摘录:id}}`
 * 占位符。所以整份用例的原文（B1_TOOL_OWN / T2_KV_OWN）取的是脚本 `strip_excerpts()`
 * 还原出的自撰区形态，片段用例本身就不含摘录。断言数值同样出自 `--zone own` 的参考实现。
 *
 * 全量对拍（54 份 × 5 项 + 裸符号表 + 术语表 + 代码块划分逐项一致）在实现时跑过一次，
 * 那份对拍脚本依赖引擎侧数据目录，不进常驻测试；这里留的是能自证的片段级用例。
 */
import { describe, expect, it } from 'vitest';

import {
  computeAdaptationMetrics,
  lintAdaptation,
  tierFromDirective,
  buildRewriteDirective,
  checkRewriteIntegrity,
  THRESHOLDS,
  BROAD_TIER_SWEEP,
} from '@/lib/generation/adaptation-lint';
import { runAdaptationLintLoop } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { SceneOutline } from '@/lib/types/generation';

// ── 真实片段（逐字取自快照） ──────────────────────────────────────────────

/** b1-gradient 全文：beginner 命中样本。生活化类比 + 4 行逐行注释代码。 */
const B1_GRADIENT = `想象你在雾天下山，看不清谷底在哪里。你只能用脚试探地面的倾斜程度。这个倾斜程度就是梯度（Gradient），大白话就是当前点最陡的上坡方向。

它是一个向量，大白话就是既有大小又有方向的箭头，指示了当前函数增长最快的方向。函数大白话就是输入一个数能吐出另一个数的计算规则。

为了减小误差，大白话就是预测结果和真实结果之间的差距，我们需要朝相反方向走。

知道方向后，每一步迈多大？这个步长就是学习率（Learning Rate），大白话就是每次更新参数时走的步子大小。这里的参数，大白话就是模型里需要调整的未知数。

它是控制模型更新幅度的超参数。模型大白话就是用来模拟现实的数学程序，超参数大白话就是在训练前人工设定好、训练过程中不变的参数。

步长太大容易跨过谷底，导致无法收敛，大白话就是结果无法最终稳定下来。太小则下山太慢，训练时间过长。

我们通过手算验证学习率的影响。假设当前参数值 w=10，计算出的梯度 g=2。简单来说，新位置等于旧位置减去步长乘以坡度。更新公式为：wnew​=w−η×g，其中 η 是学习率。这里减去梯度是因为我们要朝下坡方向移动。

若 η=0.1，则 wnew​=10−0.1×2=9.8。参数小幅调整，稳定靠近最优值，大白话就是让误差最小的那个最佳结果。

若 η=5，则 wnew​=10−5×2=0。假设真实最低点在 8，这一步直接跨过了目标，导致下次计算梯度方向反转，产生震荡，大白话就是像在秋千上来回晃动，停不到中心。这证明了选择合适的学习率对模型训练至关重要。

在代码中，这一过程非常简洁：

lr = 0.1  # 设定每次走的步长大小
grad = 2  # 设定当前坡度的陡缓程度
w = 10    # 设定当前站位的具体数值
w = w - lr * grad  # 新站位等于旧站位减去步长乘坡度

每次迭代执行这段逻辑，大白话就是反复重复这个过程，模型误差就会逐渐降低，直到找到最佳参数。`;

/** a2-attention 的工程实现段：生产域词密集、代码 9 行只有 1 条注释。 */
const A2_PROD_CODE = `工程实现需注意矩阵运算效率与显存占用。以下是生产级 Attention 计算核心代码：

import torch
import math

def scaled_dot_product_attention(query, key, value, dropout=None):
    d_k = query.size(-1)
    # 转置并计算点积，缩放防止梯度消失
    scores = torch.matmul(query, key.transpose(-2, -1)) / math.sqrt(d_k)
    p_attn = scores.softmax(dim=-1)
    if dropout is not None:
        p_attn = dropout(p_attn)
    return torch.matmul(p_attn, value), p_attn

在高并发推理服务中，QKT 矩阵大小为 [seq_len,seq_len]，长序列会导致显存 O(n2) 级增长。优化方案通常采用 FlashAttention 或稀疏注意力掩码，避免全量矩阵实例化。自注意力机制中 Q、K、V 同源，适用于 Encoder 建模内部依赖；Cross-Attention 中 Q 来自 Decoder，K、V 来自 Encoder，用于融合编码信息。`;

/** t1-attention 的实现段：transition 命中样本，块级注释比 3/7。 */
const T1_CODE_TAIL = `以下是基于 PyTorch 的核心实现，输入为矩阵 Q, K, V，输出为加权后的向量及注意力权重分布：

import torch
import math

def attention(query, key, value):
    d_k = query.size(-1)
    # 计算相似度并缩放
    scores = torch.matmul(query, key.transpose(-2, -1)) / math.sqrt(d_k)
    # 归一化为概率分布
    p_attn = scores.softmax(dim=-1)
    # 加权求和
    return torch.matmul(p_attn, value), p_attn

代码中 d_k 即向量维度，sqrt(d_k) 用于防止数值过大导致梯度消失。p_attn 即为每个位置分配的注意力权重，类似数据库查询命中率的分布。`;

/** a2-attention 开头两段：11 个术语 / 109 中文字，零基础档看就是术语连发。 */
const A2_OPENING = `注意力机制通过 Query、Key 和 Value 三个变量的交互拟合序列依赖。在 RAG 检索增强场景中，Query 代表用户意图向量，Key 匹配知识库片段，Value 携带实际语义信息。核心计算流程为点积相似度打分后加权求和。

注意力机制的核心计算公式包含缩放因子，教材对此的公式推导与缩放必要性有明确说明：`;

/** a1-tool-calling 的工程段：advanced 命中样本，12 行无注释生产代码。 */
const A1_TOOL_TAIL = `上述格式约定了动作指令的序列化标准，将非结构化文本转化为可解析的结构化信号。工程实现的核心在于 _run_with_tools 中的迭代控制逻辑，这直接关系到系统的可用性与成本。

关键在于 max_tool_iterations 参数的设定。若去掉该限制，当模型陷入“调用 - 参数错误 - 重试”的局部最优时，循环步数 N 会无限增长，导致上下文窗口溢出且 Token 消耗线性发散。例如设定阈值为 5，若单次工具平均耗时 200ms，最坏情况延迟控制在 1s 内，避免线上服务雪崩。若将该参数翻倍至 10，虽然提升了复杂任务的完成率，但长尾延迟 P99 将显著恶化。生产级代码需显式处理这一边界：

def execute_tool_loop(agent, query, max_steps=5):
    messages = [{"role": "user", "content": query}]
    for step in range(max_steps):
        response = agent.chat(messages)
        if not has_tool_call(response):
            return response
        try:
            tool_msg = parse_and_run(response)
        except ToolError as e:
            tool_msg = format_error(e)
        messages.extend([response, tool_msg])
    raise TimeoutError("Tool execution limit exceeded")

异常处理需捕获工具执行 Error，将其转化为自然语言错误信息回传模型，而非直接抛出异常中断会话。若工具返回空结果，需注入兜底提示打破死循环，防止模型因重复相同参数而陷入无限递归，确保状态机总能收敛至终止态。`;

// ── 边界用例（阈值两侧各一份，期望值同样由参考实现算出） ──────────────────

/** 自撰区 4 行代码 / 1 条注释 = 注释比恰好 0.25，L3 参照带的最大观测就是这个数。 */
const RATIO_QUARTER = `下面这段是生产形态的实现，只在关键处留一句取舍说明：

def attn(q, k, v):
    scores = q @ k
    # 缩放后再归一化，避免数值溢出
    w = softmax(scores)
    return w @ v

线上按 batch 维度切分，显存占用与吞吐的取舍看并发量。`;

/** 同一段多加一条注释 → 0.5，越过 0.25。 */
const RATIO_TWOFIFTH = `下面这段是生产形态的实现：

def attn(q, k, v):
    scores = q @ k
    # 缩放后再归一化，避免数值溢出
    w = softmax(scores)
    # 加权求和得到输出
    return w @ v

线上按 batch 维度切分，显存占用与吞吐的取舍看并发量。`;

/** 「torch是…」紧贴中文：Python `\b` 在 h 与 是 之间不成立 → 不算交代过 → 仍是裸符号（2 个）。 */
const MENTION_ADJACENT = `这一页讲怎么把一串数字装进程序里，跟着敲一遍就懂了。
torch是一个深度学习的工具箱，我们用它来做这个容器。

x = torch.zeros(3)

建好之后就可以往里填数了。`;

/** 只差一个空格：「torch 是…」算交代过 → 裸符号剩 1 个，恰好落在 L1-BARE 阈值下方。 */
const MENTION_SPACED = MENTION_ADJACENT.replace('torch是', 'torch 是');

/** 摘录区里的逐行手把手代码（注释比 1.0）：改写环无权动，不该触发 A 类。 */
const EXCERPT_HANDHOLD = `这一页讲注意力，教材里已经写清楚了：

📖 教材原话如下。

\`\`\`python
# 先算相似度
s = q @ k
# 再归一化
w = softmax(s)
# 最后加权求和
out = w @ v
# 返回结果
print(out)
\`\`\`
—— 摘自《某书》[hl02s01#s3]

我们照着教材的写法走一遍就好。`;

// ── 整份真实输入（摘录已还原成占位符 = lint 在生成期真正看到的形态） ──────────

/**
 * b1-tool-calling 的自撰区。原成品里那 17 行生产级 `class HelloAgentsLLM` 全在摘录块内，
 * 剥掉后模型自己写的代码只剩 2 行——上一轮 L1-CODE 报的注释比 0.14 量的是教材，
 * 不是模型。这一份是「lint 只对自撰区负责」的对照原件。
 */
const B1_TOOL_OWN = `智能体如何调用工具

想象你在餐厅点餐。你是顾客，服务员是Agent（智能体），即能听懂指令并办事的程序。厨房是Tool（工具），即具体执行做菜任务的模块。服务员不能直接炒菜，他需要通过一部专用电话通知厨房。

这部电话就是Client（客户端），用来发送消息的软件包。如果不把电话封装好，每次厨房换号码，服务员就得重新学习拨号流程。为了隔离这种变化，我们需要定义一个标准的拨号模具。教材对此的原文表述是：

{{摘录:ha04s01#s2}}

这里定义了一个Class（类），即造对象的模具。它把复杂的拨号细节藏在了内部。假如 API 地址（网络门牌号） 变了，只需修改模具内部的一行配置，所有服务员都能自动用上新号码。

若不封装（把细节藏起来），假设你有 10 个服务员，就需要手动修改 10 处代码。若每处修改出错概率为 1%，这意味着只要有一处改错，整个系统就出问题，算下来大概每 10 次就有 1 次出错，整体出错率将升至 1−(0.99)10≈9.6%。

调用过程只需三步。首先准备菜单，即消息列表（记着顾客需求的单子），然后拨号，最后听回复。代码逻辑如下：

messages = [{"role": "user", "content": "查天气"}]  # 准备消息：告诉模型要做什么
client = HelloAgentsLLM()  # 创建客户端：拿起电话
print(client.think(messages))  # 发送并打印：拨号并听取结果

这样，智能体就通过标准接口（统一的规定动作）完成了第一次工具触发（让工具开始工作）的准备。`;

/** t2-kv-cache 的自撰区：判官把它判成了 advanced。自撰区域偏置 13.09，越过本档上限 6.5。 */
const T2_KV_OWN = `上下文窗口与 KV 缓存机制

上下文窗口类似前端组件的 state 存储容量，决定了能携带多少历史数据参与渲染。注意力机制（Attention，计算 token 间关联权重的算法）要求生成新 token 时，必须查询之前所有 token 的特征。若不优化，每生成一个字，都要把前文重新算一遍，类似每次 State 更新都重新渲染整个组件树，耗时随序列长度平方级增长。

教材对此的加速机制原理有明确说明：

{{摘录:em06s06#s4}}

引入 KV 缓存（KV Cache，存储历史 Key 和 Value 中间结果的字典）后，历史 token 的 K/V 值直接复用。假设序列长度从 2 增至 3，注意力矩阵元素从 2×2=4 个变为 3×3=9 个。无缓存需重算所有 9 个位置的关联；有缓存仅需计算新 token 与前 2 个 token 的 3 个关联位置。计算量从 O(n2) 降为 O(n)，类似 HTTP 缓存命中直接返回响应，跳过后端查询。

但上下文并非无限资源。随着长度增加，模型表现会出现特定退化现象。

这一点教材里有更完整的展开：

{{摘录:ha09s02#s1}}

工程实现上，缓存类似数组追加操作，只维护新增部分。以下代码演示缓存更新逻辑：

# cache_k 形状：(batch, seq_len, head_dim)
# k_new 形状：(batch, 1, head_dim)
cache_k = torch.cat([cache_k, k_new], dim=1)

输入为历史缓存张量与新 token 的 K 值张量，输出为合并后的新缓存。dim=1 表示在序列维度拼接，类似 JavaScript 数组的 concat 方法。显存占用随序列线性增加，需监控以防溢出。`;

const ids = (list: Array<{ ruleId: string }>): string[] => list.map((x) => x.ruleId).sort();

// ── 指标：与参考实现逐项对齐 ────────────────────────────────────────────

describe('computeAdaptationMetrics 与 Python 参考实现同值', () => {
  it('b1-gradient：裸代码行成块，逐行注释 → 注释比 1.0', () => {
    const m = computeAdaptationMetrics(B1_GRADIENT);
    expect(m.codeMinCommentRatio).toBe(1);
    expect(m.codeMinCommentRatioOwn).toBe(1);
    expect(m.codeLines).toBe(4);
    expect(m.codeMaxBlock).toBe(4);
    expect(m.uniqTermPer100).toBeCloseTo(1.005025, 6);
    expect(m.bareSymbolN).toBe(0);
    expect(m.domainSkew).toBeCloseTo(-5.025126, 6);
    expect(m.cjkChars).toBe(597);
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]).toMatchObject({ first: 21, last: 24, codeLines: 4, excerpt: false });
  });

  it('a2 工程段：围栏外的 import/def 也算代码，块内单空行不断块', () => {
    const m = computeAdaptationMetrics(A2_PROD_CODE);
    expect(m.codeLines).toBe(9);
    expect(m.codeMinCommentRatio).toBeCloseTo(1 / 9, 6);
    expect(m.uniqTermPer100).toBeCloseTo(14.285714, 6);
    expect(m.domainSkew).toBeCloseTo(39.68254, 5);
    // 散文里没交代过的外部符号，去重后 10 个，全在自撰区
    expect(m.bare.own).toEqual([
      'dropout', 'key', 'math', 'matmul', 'query', 'size', 'softmax', 'sqrt', 'torch', 'transpose',
    ]);
    expect(m.bare.excerpt).toEqual([]);
  });

  it('注释比只在 ≥3 行的代码块上算（1 行代码 1 条注释 = 1.00 是噪声）', () => {
    const m = computeAdaptationMetrics('看这里：\n\n# 说明\nx = foo(1)\n');
    expect(m.codeMinCommentRatio).toBeNull();
    expect(m.codeLines).toBe(1);
  });

  it('占位符形态（lint 的真实输入）：摘录整块不在文本里，指标只算自撰区', () => {
    const m = computeAdaptationMetrics(B1_TOOL_OWN);
    expect(m.cjkChars).toBe(426);
    // 成品里那块 29 行代码（注释比 0.138）整个在摘录里，占位符形态下根本不存在
    expect(m.codeLines).toBe(2);
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]).toMatchObject({ first: 16, last: 17, codeLines: 2, excerpt: false });
    expect(m.codeMinCommentRatio).toBeNull();
    expect(m.uniqTermPer100).toBeCloseTo(0.938967, 6);
    expect(m.domainSkew).toBeCloseTo(-53.990610, 5);
    expect(m.bare).toEqual({ own: ['HelloAgentsLLM', 'think'], excerpt: [] });
  });

  it('$$ 公式块不当代码，摘录区单独归区', () => {
    const m = computeAdaptationMetrics(
      '公式如下：\n$$\nattention(Q,K,V) = softmax(QK^T)V\n$$\n结束。\n\n' +
        '📖 教材原话，注意力机制是指对信息加权。\n```python\nimport torch\nx = torch.zeros(3)\ny = x.sum()\n```\n—— 摘自《某书》[hl02s01#s3]',
    );
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0].excerpt).toBe(true);
    expect(m.bare.own).toEqual([]);
    expect(m.bare.excerpt).toEqual(['torch', 'zeros']);
  });
});

// ── 三档正例：命中样本不该被误触发 ──────────────────────────────────────

describe('三档正例（判官判对的样本）不触发 A 类', () => {
  /**
   * 2026-08-13 起这几条只断言**分档规则**零触发，不再断言 violations 全空。
   *
   * 新加的 BODY-* 三条（概念密度 / 段落长度 / 无出处声称数字）是 B 类，量的是
   * **正文形态**，与判官判的「难度适配」正交——判官认可一页的难度档，不等于
   * 那一页的概念密度也在教材带内。实测 29% 的页超教材 P95 概念数，
   * 所以它在正例上触发是预期内的，不是误报。
   *
   * 分档规则仍然必须零触发：那是这几条用例本来要钉的东西（A 类要花改写调用）。
   */
  const tierIds = (r: ReturnType<typeof lintAdaptation>) =>
    r.violations.filter((v) => /^L[123]-/.test(v.ruleId)).map((v) => v.ruleId);

  it('L1：b1-gradient 零 A 类，省掉今天无条件多花的那次调用', () => {
    const r = lintAdaptation(B1_GRADIENT, 'L1');
    expect(r.a).toEqual([]);
    expect(tierIds(r)).toEqual([]);
  });

  it('L2：t1-attention 实现段零分档违规（块级注释比 0.43，在带内）', () => {
    const r = lintAdaptation(T1_CODE_TAIL, 'L2');
    expect(tierIds(r)).toEqual([]);
    expect(r.metrics.codeMinCommentRatioOwn).toBeCloseTo(3 / 7, 6);
  });

  it('L3：a1-tool-calling 工程段零分档违规（12 行生产代码 + 域偏置 10.1）', () => {
    const r = lintAdaptation(A1_TOOL_TAIL, 'L3');
    expect(tierIds(r)).toEqual([]);
    expect(r.metrics.codeLines).toBe(12);
    expect(r.metrics.domainSkew).toBeCloseTo(10.10101, 5);
  });
});

// ── 逐条规则 ────────────────────────────────────────────────────────────

describe('规则触发', () => {
  it('L1-TERM：术语密度超上限，违规里点名超出的首现术语和行号', () => {
    const r = lintAdaptation(A2_OPENING, 'L1');
    expect(ids(r.a)).toEqual(['L1-TERM']);
    const hit = r.a[0];
    expect(hit.value).toBeCloseTo(10.09, 2);
    expect(hit.threshold).toBe(THRESHOLDS.L1_TERM_PER100);
    expect(hit.line).toBe(1);
    // 2.3/百字 × 109 字 = 允许 2 个（注意力机制、Query），之后的首现术语全部点名
    expect(hit.quote).toContain('Key（第 1 行）');
    expect(hit.quote).not.toContain('Query（第 1 行）');
    expect(hit.message).toContain('本档上限 2.3');
    expect(hit.fix).toContain('二选一');
  });

  it('L1-BARE / L1-SOFT-DOMAIN / L1-CODE / L1-CODE-FORM：生产段落拿给零基础档', () => {
    const r = lintAdaptation(A2_PROD_CODE, 'L1');
    // 2026-08-13 新增 L1-CODE-FORM 后这条 fixture 多命中一条：它本来就是
    // `import torch` + `def scaled_dot_product_attention(...)` 的生产代码，
    // 结构闸抓它是对的——期望值跟着补，不是放宽。
    expect(ids(r.a)).toEqual(['L1-BARE', 'L1-CODE-FORM', 'L1-SOFT-DOMAIN', 'L1-TERM']);
    // B 类里除了 L1-CODE，还会有新加的 BODY-* 形态规则——这条 fixture 是
    // 生产段落，概念确实密。只钉分档那条。
    expect(ids(r.b).filter((x) => x.startsWith('L1-'))).toEqual(['L1-CODE']);
    const bare = r.a.find((x) => x.ruleId === 'L1-BARE')!;
    expect(bare.value).toBe(10);
    expect(bare.zone).toBe('own');
    expect(bare.quote).toContain('torch');
    expect(bare.message).toContain('没有交代过');
    // 注释比 1/9 < 0.8 → B 类，只记警告不调模型
    const code = r.b[0];
    expect(code.value).toBeCloseTo(0.11, 2);
    expect(code.threshold).toBe(THRESHOLDS.L1_CODE_RATIO);
    expect(code.line).toBe(3);
  });

  it('L1：b1-tool-calling 自撰区只剩 L1-BARE，摘录里那块 29 行代码报不出来', () => {
    // 上一轮在注入后成品上报的是 L1-CODE（注释比 0.138，zone=excerpt）——量的是教材，
    // 而改写 prompt 明令摘录原样保留，那条警告没有对应动作。真实输入里它不存在。
    const r = lintAdaptation(B1_TOOL_OWN, 'L1');
    expect(ids(r.a)).toEqual(['L1-BARE']);
    // B 类里只钉分档那几条。BODY-* 是 2026-08-13 加的正文形态规则（概念密度 /
    // 段落长度 / 无出处数字），量的东西与分档正交，在真实页面上触发是预期内的。
    expect(ids(r.b).filter((x) => x.startsWith('L1-'))).toEqual([]);
    expect(r.a[0].quote).toBe('HelloAgentsLLM、think');
    expect(r.a[0].zone).toBe('own');
  });

  it('L2-SOFT-CODE：逐行手把手注释 = 掉回 L1 姿态', () => {
    const r = lintAdaptation(B1_GRADIENT, 'L2');
    expect(ids(r.a)).toEqual(['L2-SOFT-CODE']);
    expect(r.a[0].value).toBe(1);
    expect(r.a[0].threshold).toBe(THRESHOLDS.L2_OWN_RATIO);
    expect(r.a[0].zone).toBe('own');
  });

  it('L2-HARD-DOMAIN：t2-kv-cache 自撰区域偏置 13.09，越过本档上限 6.5', () => {
    const r = lintAdaptation(T2_KV_OWN, 'L2');
    expect(ids(r.a)).toEqual(['L2-HARD-DOMAIN']);
    expect(r.metrics.domainSkew).toBeCloseTo(13.089005, 5);
    expect(r.a[0].threshold).toBe(THRESHOLDS.L2_HARD_SKEW);
    expect(r.a[0].quote).toBe('退化');
    expect(r.a[0].fix).toContain('二选一');
  });

  it('L3 过软：逐行注释 + 生活域类比，A/B 分开落', () => {
    const r = lintAdaptation(B1_GRADIENT, 'L3');
    expect(ids(r.a)).toEqual(['L3-SOFT-COMMENT', 'L3-SOFT-LIFE']);
    // 素材厚度（原 L3-THIN-CODE）已从 lint 移出：自撰区代码行数分不开 t/a，归检索侧
    expect(ids(r.b).filter((x) => x.startsWith('L3-'))).toEqual(['L3-THIN-DOMAIN']);
    const soft = r.a.find((x) => x.ruleId === 'L3-SOFT-COMMENT')!;
    expect(soft.value).toBe(1);
    expect(soft.threshold).toBe(THRESHOLDS.L3_OWN_RATIO);
  });

  it('FENCE-UNBALANCED：围栏数为奇数记结构告警（B 类）', () => {
    const r = lintAdaptation('讲一下：\n```python\nimport torch\nx = torch.zeros(3)\n', 'L2');
    expect(ids(r.b)).toContain('FENCE-UNBALANCED');
  });
});

// ── 阈值边界：每条都取阈值两侧各一份，期望值出自 Python 参考实现 ──────────
//
// 这一组是给「改错一个不等号还全绿」兜底的。原来的用例全部落在阈值远端
// （术语密度 10.09 对 1.7、注释比 1.00 对 0.25），把 > 写成 >=、把 3 写成 2
// 都照样通过。带号的边界是规格里写死的语义，不是四舍五入出来的。

describe('阈值边界', () => {
  it('L3-SOFT-COMMENT：注释比 0.25 在带内不报，0.5 才报', () => {
    const inBand = lintAdaptation(RATIO_QUARTER, 'L3');
    expect(inBand.metrics.codeMinCommentRatioOwn).toBeCloseTo(0.25, 6);
    expect(ids(inBand.a)).toEqual([]);

    const over = lintAdaptation(RATIO_TWOFIFTH, 'L3');
    expect(over.metrics.codeMinCommentRatioOwn).toBeCloseTo(0.5, 6);
    expect(ids(over.a)).toEqual(['L3-SOFT-COMMENT']);
  });

  it('L1-TERM：术语密度 2.33 报、2.27 不报（阈值 2.3 = 本档命中样本最大观测上取整）', () => {
    // 一个术语（梯度）+ 43 中文字 = 2.326；同一句多一个字 → 44 字 = 2.273，落回带内。
    const over = '这一页只讲梯度这一个词，其余都用大白话说，不再抛新名词出来吓人。读完自己能复述出来就算过关了。';
    const inBand = over.replace('就算过关了', '就算是过关了');
    expect(computeAdaptationMetrics(over).uniqTermPer100).toBeCloseTo(2.325581, 6);
    expect(computeAdaptationMetrics(inBand).uniqTermPer100).toBeCloseTo(2.272727, 6);
    expect(ids(lintAdaptation(over, 'L1').a)).toEqual(['L1-TERM']);
    expect(ids(lintAdaptation(inBand, 'L1').a)).toEqual([]);
  });

  it('L2-HARD-DOMAIN：域偏置 6.58 报、6.45 不报（阈值 6.5 = 本档命中样本最大观测上取整）', () => {
    const unit = '先说数据从哪来，再说它怎么被处理，最后说结果怎么回到调用方。';
    const over = `这一段只提一次吞吐，其余都是流程描述。${unit.repeat(5)}`;
    const inBand = `${over}就这样。`;
    expect(computeAdaptationMetrics(over).domainSkew).toBeCloseTo(6.578947, 6);
    expect(computeAdaptationMetrics(inBand).domainSkew).toBeCloseTo(6.451613, 6);
    expect(ids(lintAdaptation(over, 'L2').a)).toEqual(['L2-HARD-DOMAIN']);
    expect(ids(lintAdaptation(inBand, 'L2').a)).toEqual([]);
  });

  it('L1-BARE：自撰区裸符号恰好 2 个就报，1 个不报（阈值是 ≥2 不是 >2）', () => {
    const two = lintAdaptation(MENTION_ADJACENT, 'L1');
    expect(two.metrics.bare.own).toEqual(['torch', 'zeros']);
    expect(ids(two.a)).toEqual(['L1-BARE']);

    const one = lintAdaptation(MENTION_SPACED, 'L1');
    expect(one.metrics.bare.own).toEqual(['zeros']);
    expect(ids(one.a)).toEqual([]);
  });

  it('裸符号的散文提及按 Python `\\b` 口径：紧贴中文的「torch是」不算交代过', () => {
    // 只差一个空格，结论相反。JS 原生 `\b` 只认 ASCII，会把这两种都算成交代过，
    // 于是 M4 与参考实现对不上——isWordChar 存在的唯一理由。
    expect(computeAdaptationMetrics(MENTION_ADJACENT).bare.own).toContain('torch');
    expect(computeAdaptationMetrics(MENTION_SPACED).bare.own).not.toContain('torch');
  });

  it('注释比的 ≥3 行门槛：2 行代码块不出比值', () => {
    const m = computeAdaptationMetrics('先看两行代码：\n\nlr = 0.1  # 步长\nw = w - lr  # 走一步\n\n就这么简单。');
    expect(m.blocks[0]).toMatchObject({ codeLines: 2, commentUnits: 2, ratioOk: false });
    expect(m.codeMinCommentRatio).toBeNull();
    // 不设这条门槛，1-2 行代码配注释会被当成「逐行手把手 = L1 姿态」误告警
    expect(lintAdaptation('先看两行代码：\n\nlr = 0.1  # 步长\nw = w - lr  # 走一步\n\n就这么简单。', 'L2').a).toEqual([]);
  });

  it('摘录区的逐行注释代码块不触发 A 类：改写环无权动那半篇', () => {
    const m = computeAdaptationMetrics(EXCERPT_HANDHOLD);
    expect(m.blocks[0]).toMatchObject({ ratio: 1, ratioOk: true, excerpt: true });
    expect(m.codeMinCommentRatioOwn).toBeNull();
    expect(ids(lintAdaptation(EXCERPT_HANDHOLD, 'L2').a)).toEqual([]);
    expect(ids(lintAdaptation(EXCERPT_HANDHOLD, 'L3').a)).toEqual([]);
  });
});

// ── 档位识别与改写指令 ──────────────────────────────────────────────────

describe('tierFromDirective', () => {
  it('认蓝图硬指令里的三个档位标记', () => {
    expect(tierFromDirective('- 【零基础硬要求】每个专业术语第一次出现必须立刻用一句大白话定义')).toBe('L1');
    expect(tierFromDirective('- 【转行者硬要求】前置假设：读者会编程、没有任何 AI 背景')).toBe('L2');
    expect(tierFromDirective('- 【进阶硬要求】术语直接使用不再定义')).toBe('L3');
  });

  it('没有画像通道时返回 null（不跑 lint、不多花调用）', () => {
    expect(tierFromDirective('普通场景描述')).toBeNull();
    expect(tierFromDirective(undefined)).toBeNull();
  });
});

describe('buildRewriteDirective', () => {
  const report = lintAdaptation(A2_PROD_CODE, 'L1');
  const directive = buildRewriteDirective(report, A2_PROD_CODE);

  it('只喂 A 类，B 类不进 prompt（模型改不了摘录，写进去只会诱导它去动摘录）', () => {
    expect(directive).toContain('[L1-BARE]');
    expect(directive).toContain('[L1-TERM]');
    expect(directive).not.toContain('[L1-CODE]');
  });

  it('每条带原文片段与改法二选一，并附完整原文', () => {
    expect(directive).toContain('torch');
    expect(directive).toContain('改法二选一');
    expect(directive).toContain('教材摘录');
    expect(directive).toContain(A2_PROD_CODE);
  });
});

// ── 完整性检查与兜底 ────────────────────────────────────────────────────

describe('checkRewriteIntegrity', () => {
  const original = `# 注意力机制入门

{{摘录:hl02s01#s3}}

正文继续讲解，说明它怎么工作。

\`\`\`python
import torch
\`\`\``;

  it('只改正文的版本通过', () => {
    const revised = original.replace('正文继续讲解，说明它怎么工作。', '正文继续讲解。它怎么工作，下面拆开说。');
    expect(checkRewriteIntegrity(original, revised)).toEqual({ ok: true });
  });

  it('长度不足原稿 60% → 作废', () => {
    // 断言到 reason：只断言 ok=false 的话，这一版同时也丢了摘录，
    // 把长度阈值改成 5% 照样红不了——那样这条用例等于没测长度。
    expect(checkRewriteIntegrity(original, '# 注意力机制入门')).toEqual({
      ok: false,
      reason: '长度不足原稿 60%',
    });
  });

  it('讲义没有标题行时不冻结第一段正文', () => {
    const noTitle = '正文起手就讲机制，一共两段。\n\n第二段继续讲，说明它怎么工作。';
    const revised = '正文起手就讲机制，先给个直觉。\n\n第二段继续讲，说明它怎么工作。';
    expect(checkRewriteIntegrity(noTitle, revised)).toEqual({ ok: true });
  });

  it('摘录被吃掉 → 作废（接地徽标事故比档位判错严重）', () => {
    const eaten = original.replace('{{摘录:hl02s01#s3}}', '教材里讲得很清楚。教材里讲得很清楚。教材里讲得很清楚。');
    const r = checkRewriteIntegrity(original, eaten);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('摘录块数量变了');
  });

  it('出处标记被改 → 作废', () => {
    const r = checkRewriteIntegrity(original, original.replace('hl02s01#s3', 'hl99s99#s9'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('出处标记集合变了');
  });

  it('围栏配对变差 → 作废', () => {
    const r = checkRewriteIntegrity(original, original.replace('\n```', '\n'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('代码围栏配对变差');
  });

  it('标题行被改 → 作废', () => {
    const r = checkRewriteIntegrity(original, original.replace('注意力机制入门', '注意力机制详解'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('标题行被改');
  });
});

describe('runAdaptationLintLoop', () => {
  const outline = { title: '注意力机制', description: '', keyPoints: [] } as unknown as SceneOutline;
  const callCount = (fn: AICallFn & { n?: number }) => fn.n ?? 0;

  const counting = (impl: (system: string, user: string) => string): AICallFn & { n: number } => {
    const fn = (async (system: string, user: string) => {
      fn.n += 1;
      return impl(system, user);
    }) as AICallFn & { n: number };
    fn.n = 0;
    return fn;
  };

  it('未触发：A 类为空时一次调用都不发', async () => {
    const ai = counting(() => 'never called');
    const out = await runAdaptationLintLoop(B1_GRADIENT, 'L1', outline, ai);
    expect(out).toBe(B1_GRADIENT);
    expect(callCount(ai)).toBe(0);
  });

  it('触发已修：一轮改写把 A 类清零后停手，不发第二轮', async () => {
    // L2 档的 b1-gradient 只触发 L2-SOFT-CODE（逐行注释）。模拟一次真改到位的改写：
    // 逐行注释合并成块级说明，代码本身不动。
    const fixed = B1_GRADIENT.replace(
      `lr = 0.1  # 设定每次走的步长大小
grad = 2  # 设定当前坡度的陡缓程度
w = 10    # 设定当前站位的具体数值
w = w - lr * grad  # 新站位等于旧站位减去步长乘坡度`,
      `下面四行按「设步长、取坡度、定起点、走一步」的顺序执行，输出是更新后的参数：

lr = 0.1
grad = 2
w = 10
w = w - lr * grad`,
    );
    expect(lintAdaptation(B1_GRADIENT, 'L2').a).toHaveLength(1);
    const ai = counting(() => fixed);
    const out = await runAdaptationLintLoop(B1_GRADIENT, 'L2', outline, ai);
    expect(out).toBe(fixed);
    expect(lintAdaptation(out, 'L2').a).toEqual([]);
    expect(callCount(ai)).toBe(1);
  });

  it('触发未修好：定向改写没改善则不发第二轮，改发一次整篇审校；仍没救回就退回原稿', async () => {
    const ai = counting(() => A2_PROD_CODE);
    const out = await runAdaptationLintLoop(A2_PROD_CODE, 'L1', outline, ai);
    expect(out).toBe(A2_PROD_CODE);
    // 1 次定向（没改善，不进第二轮）+ 1 次整篇审校回落。
    // 回落是 2A 复测 beginner 27.8% 的修复：lint 取代自查环后 7/18 场景净空档。
    expect(callCount(ai)).toBe(2);
  });

  it('定向失手→整篇审校救回：A 类减少则采用审校版', async () => {
    const ai = counting((system: string) =>
      system === BROAD_TIER_SWEEP.L1 ? B1_GRADIENT : A2_PROD_CODE,
    );
    const out = await runAdaptationLintLoop(A2_PROD_CODE, 'L1', outline, ai);
    expect(out).toBe(B1_GRADIENT);
    expect(lintAdaptation(out, 'L1').a.length).toBeLessThan(
      lintAdaptation(A2_PROD_CODE, 'L1').a.length,
    );
    expect(callCount(ai)).toBe(2);
  });

  it('整篇审校也要过完整性检查：吃掉摘录的审校版作废，退回原稿', async () => {
    const withExcerpt = `${A2_PROD_CODE}\n\n{{摘录:hl02s01#s3}}`;
    const ai = counting((system: string) =>
      // 审校版把 A 类清零了，但顺手吃掉了摘录占位符——不许采用
      system === BROAD_TIER_SWEEP.L1 ? B1_GRADIENT : A2_PROD_CODE,
    );
    const out = await runAdaptationLintLoop(withExcerpt, 'L1', outline, ai);
    expect(out).toBe(withExcerpt);
  });

  it('兜底不丢内容：改写产物短到 cleanLectureMarkdown 都不认时保留原稿', async () => {
    const ai = counting(() => '好的，我把这段改短了。');
    const out = await runAdaptationLintLoop(A2_PROD_CODE, 'L1', outline, ai);
    expect(out).toBe(A2_PROD_CODE);
  });

  it('完整性检查未过的改写不参与选版：吃掉摘录占位符的那版作废，退回原稿', async () => {
    // 上一条走的是 cleanLectureMarkdown 的 50 字下限，根本没走到完整性检查。
    // 这一条的改写产物字数够、能过清洗，只是把 {{摘录}} 换成了自己的话——
    // 摘录被吃掉是接地徽标的事故，必须在这一层拦住。
    const withExcerpt = `${MENTION_ADJACENT}

{{摘录:hl02s01#s3}}

教材那段讲的是同一件事，读完再回来看这几行代码就更清楚了。`;
    const eaten = withExcerpt.replace(
      '{{摘录:hl02s01#s3}}',
      '教材里说这个容器就是一排格子，每个格子放一个数，一开始全是零。',
    );
    expect(lintAdaptation(withExcerpt, 'L1').a).toHaveLength(1);
    expect(checkRewriteIntegrity(withExcerpt, eaten).ok).toBe(false);

    const ai = counting(() => eaten);
    const out = await runAdaptationLintLoop(withExcerpt, 'L1', outline, ai);
    expect(out).toBe(withExcerpt);
    // 1 次定向（产物作废）+ 1 次整篇审校回落（同样返回吃掉摘录的版本，同样被拦）
    expect(callCount(ai)).toBe(2);
  });

  it('兜底不丢内容：改写调用抛错时保留原稿', async () => {
    const ai = (async () => {
      throw new Error('provider down');
    }) as AICallFn;
    const out = await runAdaptationLintLoop(A2_PROD_CODE, 'L1', outline, ai);
    expect(out).toBe(A2_PROD_CODE);
  });

  // ── 轮次上限与中途失败：两条都要「越改越好也得停」「停了也不丢已修好的」 ──
  //
  // 下面三段是同一篇讲义的三个版本，L1 档 A 类违规逐版递减 3 → 2 → 1：
  // 每一版都还剩违规，所以「A 类清零」这个自然刹车永远踩不到，只剩 for 的硬上限拦着。
  // 上面那批用例走的都是一轮就结束的路径，覆不到第 2 轮之后。
  const L1_STEP0 = `注意力机制的打分靠点积完成，softmax 把 logits 变成概率分布，掩码控制可见范围。

工程实现的约束是吞吐与显存：线上高并发时，生产级部署会因为 batch 扩容出现性能退化。

scores = torch.matmul(query, key.transpose(-2, -1))
p_attn = scores.softmax(dim=-1)
out = torch.matmul(p_attn, value)`;

  /** 只动域偏置那一条：生产场景换成生活场景，L1-SOFT-DOMAIN 消失，另外两条原样。 */
  const L1_STEP1 = L1_STEP0.replace(
    '工程实现的约束是吞吐与显存：线上高并发时，生产级部署会因为 batch 扩容出现性能退化。',
    '就像在图书馆找书：你先看书架上的标签，再翻抽屉里的目录卡，一层层缩小范围。',
  );

  /** 再动裸符号那一条：散文里交代了三个外部名字，L1-BARE 消失，只剩 L1-TERM。 */
  const L1_STEP2 = L1_STEP1.replace(
    '\n\nscores =',
    '\n\n下面三行里的 torch 是一个算库，matmul 是把两个表格相乘，transpose 是把行和列对调。\n\nscores =',
  );

  it('轮次硬上限：模型每轮都在改好，也只发两次调用就收手', async () => {
    // 前置：三版的 A 类计数严格递减且都非零 —— 断在这里说明是用例文本漂了，不是循环坏了
    expect(lintAdaptation(L1_STEP0, 'L1').a).toHaveLength(3);
    expect(lintAdaptation(L1_STEP1, 'L1').a).toHaveLength(2);
    expect(lintAdaptation(L1_STEP2, 'L1').a).toHaveLength(1);

    const ai = counting((_system, user) => (user.includes('图书馆') ? L1_STEP2 : L1_STEP1));
    const out = await runAdaptationLintLoop(L1_STEP0, 'L1', outline, ai);

    expect(callCount(ai)).toBe(2); // 不是 3、不是无限
    expect(out).toBe(L1_STEP2); // 收手时交出的是最好的那版，不是最后一版恰好等于它的巧合
  });

  it('中途失败不回退到原稿：第 2 轮超时，保留第 1 轮已经修好的那版', async () => {
    const ai = counting((_system, user) => {
      if (user.includes('图书馆')) throw Object.assign(new Error('ETIMEDOUT'), { name: 'TimeoutError' });
      return L1_STEP1;
    });
    const out = await runAdaptationLintLoop(L1_STEP0, 'L1', outline, ai);

    expect(callCount(ai)).toBe(2);
    expect(out).toBe(L1_STEP1); // 不是 L1_STEP0——已修好的改进不能被后一轮的故障连坐
    expect(lintAdaptation(out, 'L1').a).toHaveLength(2);
  });
});
