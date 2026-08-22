/**
 * 题库生成器：给定一个主题 + 一份参考教材，产出四层题库。
 *
 * 为什么要生成器而不是手写题：注意力机制只是第一个试验品。我们真正要评的是
 * 「大模型应用开发岗位群」整条培训线——RAG、Agent 编排、护栏、评测、部署。
 * 手写一套题只能证明一门课，换个主题就得从头来。所以出题这一步必须能复算、能换主题。
 *
 * 四层，权重压在后两层（岗位培训不是考概念）：
 *   recall   复述  —— 材料里直接写了的。底线，这层塌了后面不用看
 *   transfer 迁移  —— 材料多半没直说，学明白了就该会答
 *   operate  实操  —— 给具体的代码/配置/故障现象，判断哪错了、会怎样、怎么改
 *   deliver  交付  —— 给一个岗位任务，要求产出能验收的东西（方案/代码/检查单）
 *
 * 流程：四层并行出题 → 三个独立视角审题（可答性 / 防蒙 / 判分可操作性）→ 定稿。
 * 「三个视角至少两票判废」才砍，单票不砍——单判官判决会翻转，我们在审核门那边
 * 已经吃过一次亏（13.6% 翻转率）。
 *
 * 用法：
 *   node scripts/learning_eval/build_bank.mjs --config data/eval/banks/attention.config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { callLLM as rawCall, extractJSON } from './llm.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const ROOT = path.resolve(process.cwd(), '../..');
const CONFIG_PATH = args.config;
if (!CONFIG_PATH) throw new Error('必须给 --config');
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const MODEL = args.model || 'deepseek-ai/DeepSeek-V3.2';
const AUDIT_MODEL = args['audit-model'] || 'zai-org/GLM-5.2';   // 审题换厂商，避免自己审自己
const OUT = args.out || path.join(ROOT, 'data/eval/banks', `${cfg.slug}.json`);

const LAYER_SPEC = {
  recall: {
    cn: '复述',
    brief: `材料里直接写了的东西。这层是底线：连这层都答不好，材料就是没写清楚。
题干要具体到能判分，不要「简述 X」这种大而空的题。`,
  },
  transfer: {
    cn: '迁移',
    brief: `材料多半不会直说，但真学明白了就该会答。这层是这套评测的核心信号。
判据：一份「把结论念一遍」的浅材料应该答不出来，一份讲透了原理的材料应该答得出来。
**如果一道题浅材料也能蒙到 3 分，它就是废题，别写。**
典型形态：把某个参数改掉会怎样、为什么是这个做法而不是那个、规模变大之后哪里先崩。`,
  },
  operate: {
    cn: '实操',
    brief: `给一段具体的东西——有 bug 的代码、写错的配置、线上报出来的现象、
一组具体数字——问哪里错了、会导致什么、怎么改。
硬要求：题干必须自带具体材料，不能只是「请解释…」。
判分要能靠「他有没有指出那个具体的错」来判，不靠感觉。
这层直接对应岗位上「排查一次事故」这类任务。`,
  },
  deliver: {
    cn: '交付',
    brief: `给一个真实岗位任务，要求产出能验收的东西：一份方案、一段能跑的代码、
一张上线检查单、一套评测口径。
硬要求：必须写清**验收标准**（交付物里必须出现哪些要素才算合格），
否则判官只能凭感觉给分。
这层是岗位培训的终点——学完能不能上手干活，只有这层能回答。`,
  },
};

/** 走流式（见 llm.mjs），并把返回解析成 JSON。解析不出来直接炸，不要静默返回空题。 */
async function callLLM(model, system, prompt, { maxTokens = 4000, temperature = 0.4 } = {}) {
  const raw = await rawCall(model, system, prompt, { maxTokens, temperature, json: true });
  const j = extractJSON(raw);
  if (!j) throw new Error(`不是 JSON：${raw.slice(0, 200)}`);
  return j;
}

function loadReference() {
  const parts = [];
  for (const rel of cfg.reference ?? []) {
    const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!existsSync(p)) throw new Error(`参考材料不存在：${p}`);
    parts.push(`\n────── 参考材料：${path.basename(p)} ──────\n${readFileSync(p, 'utf8')}`);
  }
  return parts.join('\n');
}

const COMMON = (ref) => `
【场景】${cfg.domain}
【主题】${cfg.topic}
【岗位背景】${cfg.job_context ?? '（未指定）'}

我们要衡量「一个人只靠某份学习材料，能不能学会这个主题、能不能上手干活」。
做法是让一个 LLM 扮演学习者，只读给它的材料答题，不同材料互相比。

【出题的两条铁律】
1. **可答性锚点是参考材料。** 每道题的答案都必须能从下面这份参考材料里推出来。
   参考材料是我们的满分上限锚点——它答不出来的题，会把锚点自己打低，整把尺子就废了。
   所以 textbook_evidence 字段必须填参考材料里真有的依据，编不出来就换题。
2. **答题的是 LLM，它自己就懂这个领域。** 所以题目要尽量做到：
   材料浅的时候它答不好。测的是材料的质量，不是模型的知识。
   （我们另外跑一个「什么都不给」的对照臂来量化剩余的泄漏，但题本身要先尽力）

【参考材料】${ref}
`;

const PROPOSE_SCHEMA_HINT = `严格输出 JSON：
{"questions":[{
  "id":"层前缀+短英文名，如 T1_scaling",
  "layer":"recall|transfer|operate|deliver",
  "question":"问给学习者的原话，中文。实操/交付层要把代码、配置、现象、任务写进题干",
  "must_hit":["满分必须命中的具体要点，3-6 条，每条是可检查的名词或因果关系，不要写「理解深刻」"],
  "rubric":{"s0":"什么样的回答给0分","s1":"…","s2":"…","s3":"…","s4":"…"},
  "textbook_evidence":"参考材料里支持这道题可答的依据，引原文或指明在哪一节",
  "prior_leak_risk":"低|中|高（一个懂这个领域的模型不看材料能不能答对）",
  "why_not_shallow":"为什么一份只念结论的浅材料答不出这道题"
}]}`;

const BATCH = 3;   // 流式之后不再有 5 分钟超时，但一次 3 道仍是最稳的：
                   // 输出越长，模型越容易在 JSON 中途跑偏，整批作废

/** 每批换一个切入角度，否则分批出题会出一堆同质的 */
const ANGLES = ['原理为什么这么设计', '参数或规模变化带来的后果', '实现细节与最常写错的地方',
                '线上跑起来才暴露的问题', '选型与取舍'];

async function proposeBatch(layer, n, ref, seed) {
  const spec = LAYER_SPEC[layer];
  const sys = `你是这个领域的资深工程师兼命题人。你出的题要能区分「背过」和「会干」。`;
  const prompt = [
    COMMON(ref),
    `【你负责的层：${layer}（${spec.cn}）】`,
    spec.brief,
    '',
    `出 ${n} 道题。id 前缀用 ${layer[0].toUpperCase()}，编号从 ${seed} 开始。`,
    `本批聚焦这个角度：${ANGLES[seed % ANGLES.length]}。`,
    cfg.concept_hints ? `\n【本主题的考点参考（仅供选材，不必全覆盖）】\n${cfg.concept_hints}` : '',
    '',
    PROPOSE_SCHEMA_HINT,
  ].join('\n');
  const r = await callLLM(MODEL, sys, prompt);
  return (r.questions ?? []).map((q) => ({ ...q, layer }));
}

async function propose(layer, n, ref) {
  const batches = [];
  for (let i = 0; i < n; i += BATCH) batches.push([Math.min(BATCH, n - i), i + 1]);
  const out = await Promise.all(
    batches.map(([k, seed]) =>
      proposeBatch(layer, k, ref, seed).catch((e) => {
        console.log(`    ${LAYER_SPEC[layer].cn} 第 ${seed} 批失败：${e.message}`);
        return [];
      }),
    ),
  );
  // 分批出题必然撞 id，撞了加后缀，别静默覆盖掉一道题
  const seen = new Set();
  return out.flat().map((q) => {
    let id = q.id;
    for (let k = 2; seen.has(id); k++) id = `${q.id}_${k}`;
    seen.add(id);
    return { ...q, id };
  });
}

const AUDIT_LENSES = [
  {
    key: '可答性',
    brief: `你只审一件事：**这道题的答案，参考材料里到底有没有？**
逐题去参考材料里找依据。找不到就判「废」——参考材料是满分锚点，
它答不出来的题会把锚点自己打低，整把尺子报废。
textbook_evidence 写得含糊、或者引的原文根本不支持这道题的，判「废」或「改后留用」。`,
  },
  {
    key: '防蒙',
    brief: `你只审一件事：**一份只把结论念了一遍的浅材料，能不能靠「复述 + 常识」把这道题蒙到 3 分？**
能蒙过的就是废题——它区分不出好材料和坏材料，留着只会稀释信号。
注意区分：题目能被「模型自己的预训练知识」答出来不必然是废题
（我们有对照臂扣掉这部分）；只有当**浅材料也能拿高分**时才是真废题。

另外必查一条（实测踩过）：**题干是不是自带了全部输入？**
「现在有 3 个词元，x1=[1,0]、x2=[0,1]、x3=[1,1]，算出注意力权重矩阵」这种题，
题干里已经把该算的东西全给了，会算术就能答，跟材料一点关系没有——
空材料对照臂在这道题上拿了 2/4 分。
实操层特别容易出这种题。判据：**把材料整个拿掉，这道题还答得出来吗？答得出来就是废题**，
除非题干里材料相关的那部分（「材料里打印过的那个矩阵，第几行的对角线不是最大值」）
本身就占满分要点的一半以上。`,
  },
  {
    key: '判分',
    brief: `你只审一件事：**这个 rubric 能不能让两个不同的判官打出同一个分？**
判据：must_hit 是不是可检查的具体要点（名词、因果关系、数值），
而不是「理解深刻」「解释清楚」这种要判官发挥的东西。
s0/s1/s2/s3/s4 之间界线是否明确。
另查：题干有没有把答案漏进去、有没有一题问两件事（必须拆或砍一半）。
写得含糊的判「改后留用」并给出改好的 must_hit 和 rubric。`,
  },
];

async function auditChunk(lens, questions, ref) {
  const sys = `你是对抗式审题员。**默认每道题都有问题，除非它经得起你这个视角的推敲。**
废掉一半是正常的，不要为了显得出题有用而放水。`;
  const prompt = [
    COMMON(ref),
    `【你的审题视角：${lens.key}】`,
    lens.brief,
    '',
    `待审题目（${questions.length} 道）：`,
    JSON.stringify(questions.map(({ id, layer, question, must_hit, rubric, textbook_evidence, prior_leak_risk, why_not_shallow }) =>
      ({ id, layer, question, must_hit, rubric, textbook_evidence, prior_leak_risk, why_not_shallow })), null, 1),
    '',
    `严格输出 JSON：{"audits":[{"id":"…","verdict":"留用|改后留用|废","reason":"一句话，具体点出问题",` +
    `"fixed_question":"改后留用时给出改好的题干，否则空串","fixed_must_hit":["改好的要点，否则空数组"],` +
    `"fixed_rubric":{"s0":"","s1":"","s2":"","s3":"","s4":""}}]}`,
  ].join('\n');
  const r = await callLLM(AUDIT_MODEL, sys, prompt, { temperature: 0.2 });
  return r.audits ?? [];
}

const AUDIT_BATCH = 6;

async function audit(lens, questions, ref) {
  const chunks = [];
  for (let i = 0; i < questions.length; i += AUDIT_BATCH) chunks.push(questions.slice(i, i + AUDIT_BATCH));
  const out = await Promise.all(
    chunks.map((c, i) =>
      auditChunk(lens, c, ref).catch((e) => {
        console.log(`    ${lens.key} 第 ${i + 1} 批失败：${e.message}`);
        return [];
      }),
    ),
  );
  return out.flat();
}

async function main() {
  const ref = loadReference();
  console.log(`主题「${cfg.topic}」  参考材料 ${ref.length} 字  出题模型 ${MODEL}  审题模型 ${AUDIT_MODEL}`);

  const plan = cfg.layers ?? { recall: 5, transfer: 7, operate: 6, deliver: 4 };
  console.log(`计划：${Object.entries(plan).map(([k, v]) => `${LAYER_SPEC[k].cn} ${v}`).join(' / ')}\n`);

  console.log('出题…');
  const drafts = (await Promise.all(
    Object.entries(plan).map(([layer, n]) =>
      propose(layer, Math.ceil(n * 1.6), ref)      // 多出 60%，留给审题砍
        .then((qs) => { console.log(`  ${LAYER_SPEC[layer].cn} 出了 ${qs.length} 道`); return qs; })
        .catch((e) => { console.log(`  ${LAYER_SPEC[layer].cn} 失败：${e.message}`); return []; }),
    ),
  )).flat();
  if (!drafts.length) throw new Error('一道题都没出来');

  console.log(`\n审题（${AUDIT_LENSES.length} 个视角 × ${drafts.length} 道）…`);
  const audits = await Promise.all(
    AUDIT_LENSES.map((L) =>
      audit(L, drafts, ref)
        .then((a) => { console.log(`  ${L.key} 回了 ${a.length} 条`); return a.map((x) => ({ ...x, lens: L.key })); })
        .catch((e) => { console.log(`  ${L.key} 失败：${e.message}`); return []; }),
    ),
  );

  const votes = new Map();
  for (const a of audits.flat()) {
    if (!votes.has(a.id)) votes.set(a.id, []);
    votes.get(a.id).push(a);
  }

  const kept = [];
  const dropped = [];
  for (const q of drafts) {
    const vs = votes.get(q.id) ?? [];
    const dead = vs.filter((v) => v.verdict === '废');
    // 单票不砍：单判官判决会翻转，我们在审核门那边实测过 13.6%。两票才砍。
    if (dead.length >= 2) {
      dropped.push(`${q.id}（${q.layer}）：${dead.map((d) => `[${d.lens}] ${d.reason}`).join('；')}`);
      continue;
    }
    // 采纳修正：优先「判分」视角给的 rubric，它专门管这件事
    const fixes = vs.filter((v) => v.verdict === '改后留用');
    const rubricFix = fixes.find((f) => f.lens === '判分' && f.fixed_rubric?.s4) ?? fixes.find((f) => f.fixed_rubric?.s4);
    const qFix = fixes.find((f) => f.fixed_question);
    const hitFix = fixes.find((f) => f.fixed_must_hit?.length);
    kept.push({
      ...q,
      question: qFix?.fixed_question || q.question,
      must_hit: hitFix?.fixed_must_hit?.length ? hitFix.fixed_must_hit : q.must_hit,
      rubric: rubricFix?.fixed_rubric?.s4 ? rubricFix.fixed_rubric : q.rubric,
      audit_trail: vs.map((v) => `[${v.lens}] ${v.verdict}: ${v.reason}`),
    });
  }

  // 按计划数截断：每层留分数最高的那些。这里用「三票全留用」优先。
  const final = [];
  for (const [layer, n] of Object.entries(plan)) {
    const pool = kept.filter((q) => q.layer === layer)
      .sort((a, b) => (b.audit_trail.filter((t) => t.includes('留用') && !t.includes('改后')).length)
                    - (a.audit_trail.filter((t) => t.includes('留用') && !t.includes('改后')).length));
    if (pool.length < n) console.log(`⚠ ${LAYER_SPEC[layer].cn} 只剩 ${pool.length} 道，少于计划的 ${n}`);
    final.push(...pool.slice(0, n));
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  const bank = {
    slug: cfg.slug,
    topic: cfg.topic,
    domain: cfg.domain,
    version: cfg.version ?? '1',
    built_with: { model: MODEL, audit_model: AUDIT_MODEL, reference: cfg.reference },
    layers: Object.fromEntries(Object.keys(plan).map((l) => [l, final.filter((q) => q.layer === l).length])),
    questions: final,
    dropped,
  };
  writeFileSync(OUT, JSON.stringify(bank, null, 2), 'utf8');
  console.log(`\n出稿 ${drafts.length} → 砍 ${dropped.length} → 留 ${final.length}`);
  console.log(Object.entries(bank.layers).map(([k, v]) => `  ${LAYER_SPEC[k].cn} ${v}`).join('\n'));
  console.log(`\n题库 → ${OUT}`);
  return 0;
}

main().then((c) => process.exit(c ?? 0)).catch((e) => { console.error(e); process.exit(1); });
