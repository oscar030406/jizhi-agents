/**
 * ⚠ 本脚本的口径已被推翻，只保留用于复现旧数字。**新工作一律用
 * `scripts/learning_eval/run_eval.mjs`**（协议见 docs/05-evidence/learning_gain_protocol.md）。
 *
 * 三个硬伤：
 *   1. 判官既答题又给自己打分——这是自评，不是评测。
 *   2. 没有锚点。16/16 相对什么是 16/16 说不清；模型本来就会的那部分全算在了课头上。
 *   3. 四道全是记忆题，能背公式就满分。
 * 而且它的数复现不了：同一档重跑六轮拿到 10~16 分，跟上游的区间大面积重叠。
 *
 * ────────────────────────────────────────────────────────────
 *
 * 零先验学习成效评测。
 *
 * 判据不是「幻灯片有几个元素」「教具能不能点」，而是：**一个对 LLM 一无所知的人，
 * 光靠这门课生成出来的东西，能不能学明白。**
 *
 * 做法（对齐 Code2Video 的 TeachQuiz 思路）：
 *   1. 把一门课生成出的全部材料抽出来（幻灯片正文 + 讲稿 + 课堂对话 + 教具说明）
 *   2. 让一个**没参与生成**的模型只读这份材料，回答四个递进问题
 *   3. 强制规则：材料里没有的，必须回答「材料未提及」，不许用自己的知识补
 *   4. 按四个维度打分，比较不同版本
 *
 * 第 3 条是关键。不强制的话模型会用预训练知识答题，测的就变成模型知道多少，
 * 而不是这门课教会了多少。
 *
 * 用法：
 *   node scripts/zero_prior_eval.mjs --url http://localhost:3210 --label fork
 *   node scripts/zero_prior_eval.mjs --materials out/fork.json --judge-only
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const BASE = args.url || 'http://localhost:3210';
const LABEL = args.label || 'run';
const OUT_DIR = args.out || path.join(process.cwd(), 'data', 'eval', 'zero_prior');
const REQUIREMENT = args.requirement || '我想学注意力机制';
// 判官模型：必须与生成模型不同族，且不参与本次生成
const JUDGE_MODEL = args.judge || 'siliconflow:deepseek-ai/DeepSeek-V3.2';

/** 学习者真正要学会的四件事，从易到难 */
const QUESTIONS = [
  {
    id: 'Q1_concept',
    dim: '是什么',
    q: '注意力机制要解决什么问题？它的核心思想用一句话怎么说？',
    rubric: '需说明：传统做法对所有输入同等对待 / 注意力按相关性动态分配权重。',
  },
  {
    id: 'Q2_math',
    dim: '数学原理',
    q: '注意力机制的计算过程是什么？Q、K、V 各是什么，权重怎么算出来的？',
    rubric: '需说明：Q 与 K 算相似度 → softmax 归一化成权重 → 对 V 加权求和。给出公式加分。',
  },
  {
    id: 'Q3_apply',
    dim: '怎么落地',
    q: '注意力机制在真实系统里怎么用？举一个具体场景说明它带来什么。',
    rubric: '需给出至少一个具体应用（翻译/长文理解/检索等）并说明作用机制，不能只说"很重要"。',
  },
  {
    id: 'Q4_code',
    dim: '代码怎么写',
    q: '用代码实现一个最简单的注意力计算，需要哪几步？',
    rubric: '需能还原：算分 → 缩放 → softmax → 乘 V。有可运行代码片段加满分。',
  },
];

const SCORE_SCHEMA = `{
  "answers": [
    {
      "id": "Q1_concept",
      "answerable": true,
      "answer": "只依据材料作答的内容；材料没有就写 材料未提及",
      "score": 0,
      "missing": "材料缺了什么才导致答不全"
    }
  ]
}`;

async function callLLM(system, prompt, model = JUDGE_MODEL) {
  // 走硅基流动直连，避开产品自身的路由（判官不能被产品配置影响）
  const key = process.env.SILICONFLOW_API_KEY;
  if (!key) throw new Error('缺 SILICONFLOW_API_KEY');
  const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model.replace(/^siliconflow:/, ''),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (r.status === 429 || r.status >= 500) {
    // 限流不是「这门课没教会东西」，但静默重试也不行——会把失败伪装成慢。
    const wait = 20000;
    console.log(`      判官被限流（${r.status}），${wait / 1000}s 后重试…`);
    await new Promise((res) => setTimeout(res, wait));
    return callLLM(system, prompt, model);
  }
  const j = await r.json();
  const out = j.choices?.[0]?.message?.content ?? '';
  // 判官空返回会让四项全 0，看起来像「这门课什么都没教」——那是最坏的误报。
  // 宁可显式炸掉也不要静默返回空。
  if (!out) {
    throw new Error(
      `判官返回空：status=${r.status} ${JSON.stringify(j).slice(0, 200)}`,
    );
  }
  return out;
}

/** 从一门课的场景数组里抽出「学习者能看到的一切」 */
export function extractMaterials(scenes) {
  const parts = [];
  for (const [i, sc] of scenes.entries()) {
    parts.push(`\n===== 第 ${i + 1} 页：${sc.title ?? ''} =====`);
    const c = sc.content ?? sc;
    // 幻灯片正文
    const walk = (el) => {
      if (!el) return;
      if (typeof el.content === 'string') {
        const t = el.content.replace(/<[^>]+>/g, '').trim();
        if (t) parts.push(`[板书] ${t}`);
      }
      if (Array.isArray(el.elements)) el.elements.forEach(walk);
      if (el.type === 'table' && Array.isArray(el.data)) {
        for (const row of el.data) parts.push(`[表格] ${row.map((x) => x?.text ?? '').join(' | ')}`);
      }
      if (el.type === 'latex' && el.latex) parts.push(`[公式] ${el.latex}`);
    };
    (c.elements ?? []).forEach(walk);
    // 教具的结构化配置——这些是学习者在界面上真看得见的东西，
    // 尤其 code 教具的 starterCode 就显示在编辑器里。
    // 踩过的坑：只抽 html 并剥掉 <script>，代码教具的代码就整个消失了，
    // 评测据此判「材料没教代码」，其实是抽取器没抽到。
    const wc = c.widgetConfig ?? {};
    // 字段名不统一：见过 starterCode / solution / solutionCode 三种写法，
    // 缺哪个都会让代码在材料里凭空消失，全都收。
    if (wc.starterCode) parts.push(`[代码编辑器] ${wc.starterCode}`);
    if (wc.solution) parts.push(`[参考实现] ${wc.solution}`);
    if (wc.solutionCode) parts.push(`[参考实现] ${wc.solutionCode}`);
    for (const h of wc.hints ?? []) parts.push(`[提示] ${typeof h === 'string' ? h : h.text ?? ''}`);
    for (const t of wc.testCases ?? []) {
      parts.push(`[用例] ${t.description ?? ''} 输入=${t.input ?? ''} 期望=${t.expected ?? ''}`);
    }
    if (wc.description) parts.push(`[教具说明] ${wc.description}`);
    for (const v of wc.variables ?? []) {
      parts.push(`[可调参数] ${v.label ?? v.name ?? ''} ${v.description ?? ''}`);
    }
    // 教具：只取说明性文本，不取整页 HTML
    if (c.html) {
      const text = c.html
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<style[\s\S]*?<\/style>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) parts.push(`[教具界面文字] ${text.slice(0, 1200)}`);
    }
    // 测验
    for (const q of c.questions ?? []) {
      // 选项有两种形态：字符串数组，或 {text/label/content} 对象数组。
      // 直接 join 会把对象拼成 "[object Object]"，整道测验对学习者就等于空白——
      // 实测抽出来的材料里满屏 [object Object]，所有系统臂被同等压低了分。
      const opts = (q.options ?? []).map((o) =>
        typeof o === 'string' ? o : (o?.text ?? o?.label ?? o?.content ?? JSON.stringify(o)));
      parts.push(`[测验] ${q.question ?? ''} 选项：${opts.join(' / ')}`);
    }
    // 讲稿与课堂对话
    // 讲稿动作的正文字段是 text，不是 content（踩过一次）
    for (const a of sc.actions ?? []) {
      const spoken = a.text ?? a.content;
      if (a.type === 'speech' && spoken) parts.push(`[口播] ${spoken}`);
    }
    if (c.remark) parts.push(`[备注] ${c.remark}`);
  }
  return parts.join('\n');
}

async function judge(materials) {
  const system = [
    '你是一个对大语言模型技术一无所知的学习者。',
    '你**只有**下面这份课程材料，没有任何其他知识来源。',
    '',
    '铁律：',
    '1. 只能依据材料作答。材料里没有讲到的，必须写「材料未提及」，',
    '   **绝对不许**用你自己知道的知识补全——那样测的是你懂多少，不是这门课教会了多少。',
    '2. 材料讲了但讲得不完整，就答出材料讲到的部分，并在 missing 里写清缺什么。',
    '3. score 按 0-4 打：0=完全没提；1=提了名词但没解释；2=解释了但学完仍不会用；',
    '   3=能理解并复述清楚；4=能据此动手做。',
    '',
    `严格输出 JSON，形如：${SCORE_SCHEMA}`,
  ].join('\n');

  const prompt = [
    '===== 课程材料开始 =====',
    materials,
    '===== 课程材料结束 =====',
    '',
    '请依据以上材料回答四个问题：',
    ...QUESTIONS.map((q) => `${q.id}（${q.dim}）：${q.q}\n  评分参考：${q.rubric}`),
  ].join('\n');

  const raw = await callLLM(system, prompt);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { raw, answers: [] };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { raw, answers: [] };
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let materials;
  const matFile = path.join(OUT_DIR, `${LABEL}.materials.txt`);
  if (args.materials && existsSync(args.materials)) {
    materials = readFileSync(args.materials, 'utf8');
  } else if (existsSync(matFile) && args['judge-only']) {
    materials = readFileSync(matFile, 'utf8');
  } else {
    console.error('需要先用 capture_course.mjs 抓取材料，或用 --materials 指定文件');
    return 1;
  }

  console.log(`[${LABEL}] 材料长度 ${materials.length} 字符`);
  const result = await judge(materials);
  const rows = result.answers ?? [];
  const total = rows.reduce((s, r) => s + (r.score ?? 0), 0);

  console.log(`\n${'维度'.padEnd(10)}${'可答'.padEnd(6)}${'分'.padEnd(4)}缺什么`);
  console.log('-'.repeat(78));
  for (const q of QUESTIONS) {
    const r = rows.find((x) => x.id === q.id) ?? {};
    console.log(
      `${q.dim.padEnd(10)}${(r.answerable ? '是' : '否').padEnd(6)}${String(r.score ?? 0).padEnd(4)}${(r.missing ?? '').slice(0, 44)}`,
    );
  }
  console.log(`\n合计 ${total} / 16`);

  writeFileSync(path.join(OUT_DIR, `${LABEL}.result.json`), JSON.stringify({ label: LABEL, total, result }, null, 2), 'utf8');
  return 0;
}

// 被当模块 import 时 process.argv[1] 可能为空（node --input-type=module -e），
// 守卫必须容忍，否则 capture_course.mjs 一 import 就崩。
const invokedAs = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (invokedAs && import.meta.url.endsWith(invokedAs.split('/').pop() ?? ' ')) {
  main().then((c) => process.exit(c ?? 0));
}
