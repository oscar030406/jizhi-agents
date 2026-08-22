/**
 * 学习成效评测（多臂对照 + 归一化达成率）。
 *
 * 回答的问题：一个零基础的人只靠这份材料，能不能学会？跟读教材比差多少？
 *
 * 旧版（zero_prior_eval.mjs）的三个洞，这里逐个堵上：
 *   1. 判官既答题又给自己打分 —— 改成两段式：学生模型答题（看材料、不看 rubric），
 *      判官模型判分（看 rubric、**不看材料**）。判官看不到材料就没法被材料的
 *      篇幅和排版影响，只能对着答案本身判。
 *   2. 没有锚点 —— 加两个对照臂：
 *      blank（同样约束但材料是空的）= 下限，量化"模型守不守约束"；
 *      textbook（教材原章节）= 上限。分数报**相对达成率**，不报裸分。
 *   3. 只有记忆题 —— 题库分四层（复述/迁移/实操/交付），后三层才是真信号。
 *
 * 还加了一个 placebo 臂（喂同等长度的**无关**教材章节）。如果 placebo 也能拿高分，
 * 说明判官在给"看起来像教学材料"的东西送分，整套尺子作废。这是尺子的自检。
 *
 * 题库是外部 JSON，与主题解耦（见 build_bank.mjs）。换成 agent 培训的知识点时
 * 只换题库和参考教材，这个脚本不用改。
 *
 * 用法：
 *   node scripts/learning_eval/run_eval.mjs --bank data/eval/banks/attention.json --runs 3
 *   node scripts/learning_eval/run_eval.mjs --bank ... --arms blank,textbook --runs 1
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callLLM, extractJSON } from './llm.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const ROOT = path.resolve(process.cwd(), '../..');       // 仓库根
const BANK_PATH = args.bank || path.join(ROOT, 'data/eval/banks/attention.json');
const OUT_DIR = args.out || path.join(ROOT, 'data/eval/learning_gain');
const RUNS = Number(args.runs || 3);
const CONCURRENCY = Number(args.concurrency || 6);

// 学生与判官必须异厂商：同族模型互判会自我偏好（FACTS Grounding 实测 +3.23%）。
const STUDENT_MODEL = args.student || 'deepseek-ai/DeepSeek-V3.2';
const JUDGE_MODEL = args.judge || 'zai-org/GLM-5.2';
// 可选的第二判官，只用来算判分信度（换个判官结论会不会翻），不参与出分。
const JUDGE2_MODEL = args.judge2 || '';
// 接地率核对：默认开。关掉能省一半调用，但省掉的正是「学生有没有守约束」这个证据。
const CHECK_GROUND = args['no-groundedness'] ? false : true;
// 闭卷两阶段：先读材料写笔记（看不到题），再换新会话只拿笔记答题。
// 开卷（默认）测的是「材料里查不查得到」，闭卷测的才是「学没学会」。
// 两个都跑，差值就是「能查到但内化不了」的量。
const CLOSED_BOOK = !!args['closed-book'];
// 学生画像条件化（2×2 匹配/错配实验用）：--student-persona zero|backend。
// 学生系统提示前缀化一个身份描述——TutorBench（2026）的 persona-conditioned
// 模拟学生先例。缓存键含 persona，不同画像的作答互不污染。
const STUDENT_PERSONAS = {
  zero: '你是非计算机专业出身、刚决定转行的零基础学习者：没写过程序，' +
    '没接触过任何 AI 开发概念，专业术语需要材料解释了才懂。',
  backend: '你是有三年经验的后端开发工程师：熟悉服务端架构、接口契约、部署与日志排查，' +
    '但 LLM/Agent/RAG 这些概念是新的。你习惯用工程直觉理解新东西。',
};
const STUDENT_PERSONA_KEY = args['student-persona'] || '';
const STUDENT_PERSONA = STUDENT_PERSONAS[STUDENT_PERSONA_KEY] ?? '';
if (STUDENT_PERSONA_KEY && !STUDENT_PERSONA) throw new Error(`未知学生画像：${STUDENT_PERSONA_KEY}`);
/** 给系统提示加画像前缀。画像放最前面——身份先于规则，规则约束的是这个身份的人 */
function withPersona(system) {
  return STUDENT_PERSONA ? `${STUDENT_PERSONA}

${system}` : system;
}

// capture_course.mjs 用 process.cwd() 落盘，从 apps/agent-engine 跑就写在引擎自己的 data 下，
// 不是仓库根的 data。这里跟着它走，别为了「看起来整齐」把它改到别处——
// 改了 capture 的落盘路径会连带影响上一轮已经存下来的材料。
const MATERIAL_DIR = args['materials-dir'] || path.join(process.cwd(), 'data/eval/zero_prior');

/**
 * 实验臂。
 *
 * 这里有个冒烟测才发现的坑，记下来免得再踩：一开始「无材料」臂是让模型**自由作答**的，
 * 结果它拿 4.00/4，比读教材的 2.50 还高。原因不是教材差，是口径不对等——
 * 其他臂被要求「只依据材料作答，材料没有就写材料未提及」，无材料臂却没这个约束，
 * 等于让一个人开卷考跟另一个人闭卷考比分数。
 *
 * 改法：下限锚点必须是**同样的约束 + 空材料**。这样它测的不是「模型知道多少」，
 * 而是「模型守不守约束」——守约束就该答不出来（0 分），答出来了就是在偷用先验。
 * 这才是我们要控的那个变量。
 *
 * 「模型自己知道多少」另开一个 prior 臂单独报，它不进达成率公式，只用来说明
 * 「这道题对这个模型毫无难度，所以防泄漏只能靠约束，指望题目难倒它是没用的」。
 */
/** 被测材料各有多长，用来定篇幅对照臂截多少字 */
function systemMaterialLengths(prefixes) {
  if (!existsSync(MATERIAL_DIR)) return [];
  const re = new RegExp(`^(${prefixes.join('|')})(\\d+|_r\\d+)?\\.materials\\.txt$`);
  return readdirSync(MATERIAL_DIR)
    .filter((f) => re.test(f))
    .map((f) => readFileSync(path.join(MATERIAL_DIR, f), 'utf8').length);
}

/**
 * 把一份课程材料机械剥成「只念结论」的版本：留标题、公式、定义句，
 * 把讲解、类比、口播、过程叙述全部丢掉。
 *
 * 用途是 `stripped` 臂——真正的安慰剂。`placebo`（无关章节）太好赢了，
 * 它必过，当不了门。剥皮版讲的是同一个主题、留着同样的术语和公式，
 * 只是不解释。**如果被测材料赢不了自己的剥皮版，说明这把尺子测到的是
 * 「这个主题出现过没有」，不是「教得好不好」，那一轮全部作废。**
 *
 * 必须是机械规则不能用 LLM 改写：用模型剥皮等于引入第三个模型的偏好，
 * 剥出来什么样说不清楚。
 */
function stripToConclusions(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('=====')) { out.push(s); continue; }              // 页标题留着
    if (s.startsWith('[公式]')) { out.push(s); continue; }             // 公式留着
    if (s.startsWith('[代码编辑器]') || s.startsWith('[参考实现]')) { out.push(s); continue; }
    if (s.startsWith('[口播]') || s.startsWith('[提示]') || s.startsWith('[备注]')) continue;  // 讲解全丢
    if (s.startsWith('[教具界面文字]') || s.startsWith('[教具说明]')) continue;
    if (s.startsWith('[板书]')) {
      // 板书只留第一句（通常是结论），后面的展开丢掉
      const body = s.slice(4).trim();
      const first = body.split(/[。！？；\n]/)[0];
      if (first && first.length >= 4) out.push(`[板书] ${first}`);
      continue;
    }
    if (s.startsWith('[测验]') || s.startsWith('[表格]') || s.startsWith('[用例]')) { out.push(s); continue; }
  }
  return out.join('\n');
}

/** 组装实验臂（设计理由见上方注释） */
function buildArms(bank) {
  // 基线文件从题库里读，不写死路径——换主题时（注意力 → RAG 分块）这几个臂必须跟着换。
  // 写死了就会拿注意力的教材去当 RAG 课程的上限锚点，而且不会报错，只会给出一个错的数。
  const rel = (x) => (path.isAbsolute(x) ? x : path.join(ROOT, x));
  const refFile = rel(args.textbook || bank.built_with?.reference?.[0] || 'data/eval/baseline/textbook_ch3.txt');
  const placeboFile = rel(args.placebo || bank.built_with?.placebo || 'data/eval/baseline/placebo.txt');
  const forkPrefix = args['fork-prefix'] || 'fork';
  const upstreamPrefix = args['upstream-prefix'] ?? 'upstream';

  const arms = [
    // 同样的「只依据材料」约束，材料是空的。得分应当≈0，高了说明约束失效。
    { name: 'blank', kind: 'floor', material: null, constrained: true },
    // 不加约束、也不给材料。纯先验，不进公式，只作对照说明。
    { name: 'prior', kind: 'reference', material: null, constrained: false },
    { name: 'placebo', kind: 'placebo', file: placeboFile },
    { name: 'textbook', kind: 'ceiling', file: refFile },
  ];

  // 篇幅对照：把参考教材截到跟被测材料一样长。长度在运行时算，
  // 免得换了主题还留着上一个主题的截断文件。
  const lens = systemMaterialLengths([forkPrefix]).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const refText = existsSync(refFile) ? readFileSync(refFile, 'utf8') : '';
  if (median > 0 && refText.length > median) {
    arms.push({ name: 'textbook_short', kind: 'ceiling_matched',
                text: refText.slice(0, median),
                source: `${path.basename(refFile)}[前 ${median} 字]` });
  }

  // 命名有两代：手跑的 fork/fork2/fork3 和批量的 fork_r1…。都收，
  // 每行都记 source，事后能按来源切片看是不是某一批拖了后腿。
  if (upstreamPrefix) {
    arms.push({ name: 'upstream', kind: 'system',
                glob: new RegExp(`^${upstreamPrefix}(\\d+|_r\\d+)?\\.materials\\.txt$`) });
  }
  const forkGlob = new RegExp(`^${forkPrefix}(\\d+|_r\\d+)?\\.materials\\.txt$`);
  arms.push({ name: 'fork', kind: 'system', glob: forkGlob });
  // 剥皮版：跟 fork 同源同主题，只是把讲解剥光。它是真正的门。
  arms.push({ name: 'stripped', kind: 'gate', glob: forkGlob, derive: stripToConclusions });

  const want = args.arms ? String(args.arms).split(',') : null;
  return arms.filter((a) => !want || want.includes(a.name));
}

/**
 * 取第 run 轮该臂的材料。
 * 固定材料（教材/安慰剂）每轮都一样，变的是学生模型的采样；
 * 系统臂每轮取一次独立生成的课，这样方差里同时包含"生成随机性"和"作答随机性"——
 * 这才是我们真正想报的那个方差。
 */
function materialFor(arm, run) {
  if (arm.text != null) return { text: arm.text, source: arm.source ?? '(内联)' };
  if (arm.material === null && !arm.file && !arm.glob) return { text: '', source: '(无材料)' };
  if (arm.file) {
    if (!existsSync(arm.file)) throw new Error(`臂 ${arm.name} 的材料不存在：${arm.file}`);
    return { text: readFileSync(arm.file, 'utf8'), source: arm.file };
  }
  const files = existsSync(MATERIAL_DIR)
    ? readdirSync(MATERIAL_DIR).filter((f) => arm.glob.test(f)).sort()
    : [];
  if (!files.length) throw new Error(`臂 ${arm.name} 没有抓到的课程材料，先跑 capture_course.mjs`);
  // 轮数超过已抓的课程数就循环复用，并在结果里标出来——复用会低估方差，不能瞒着。
  const f = files[(run - 1) % files.length];
  const raw = readFileSync(path.join(MATERIAL_DIR, f), 'utf8');
  return {
    text: arm.derive ? arm.derive(raw) : raw,
    source: arm.derive ? `${f}（剥皮版）` : f,
    reused: run > files.length,
  };
}

const STUDENT_SYSTEM_WITH = [
  '你是一个刚接触这个领域的学习者。你**只有**下面这份学习材料，没有任何其他知识来源。',
  '',
  '铁律：',
  '1. 只能依据材料作答。材料里没讲到的，写「材料未提及」，',
  '   **不许**用你自己知道的知识补全——那样测的是你懂多少，不是这份材料教会了多少。',
  '2. 材料讲了但不完整，就答材料讲到的部分，并说明还缺什么。',
  '3. 不要复述题干，直接答。答不出来就说答不出来，编造会被判 0 分。',
].join('\n');

const STUDENT_SYSTEM_NONE = [
  '回答下面的问题。这是对照组，用来量化"不给任何材料时能答到什么程度"。',
  '正常作答即可，答不出来就说答不出来。',
].join('\n');

/**
 * 闭卷两阶段接力：先读材料写笔记（**看不到题**），再换个新会话只拿笔记答题。
 *
 * 为什么必须这样：开卷答题测的是「材料里查不查得到」，不是「学没学会」。
 * 这跟旧评测栽的是同一个跟头——判据停在检索层，一份把结论列成清单的浅材料
 * 照样能让人在里面查到关键词。两阶段一隔，材料必须把事情讲到**能被记住并复用**
 * 的程度才拿得到分。
 *
 * 副产物同样有用：开卷分 − 闭卷分 = 「能查到但内化不了」的量。
 */
const NOTE_SYSTEM = [
  '你在上课。下面是这堂课的全部材料。',
  '',
  '课后会有考试，但**你现在看不到考题**，考试时也拿不到这份材料，只能带走你现在写的笔记。',
  '所以请写一份不超过 600 字的课堂笔记，把这份材料里你认为最该记住的东西记下来。',
  '',
  '要求：',
  '1. 只记材料里有的。材料没讲的不要自己补——补进去的东西考试时会被判为编造。',
  '2. 优先记「为什么」和可复用的过程，不要只抄结论和名词。',
  '3. 材料本身很空的话，笔记就短，不要为了凑字数编。',
  '4. 直接输出笔记正文，不要写「以下是我的笔记」这类开场白。',
].join('\n');

async function takeNotes(model, materialText) {
  const body = materialText || '（本次没有提供任何材料）';
  return callLLM(model, NOTE_SYSTEM, ['===== 课堂材料 =====', body, '===== 材料结束 ====='].join('\n'),
    { temperature: 0.3, maxTokens: 1200 });
}

const EXAM_SYSTEM = [
  '你在考试。这是闭卷考试——你手上只有自己上课时写的笔记，原始材料已经收走了。',
  '',
  '铁律：',
  '1. 只能依据笔记作答。笔记里没有的，写「笔记里没有」，',
  '   **不许**用你自己知道的知识补全——那样测的是你懂多少，不是这堂课教会了多少。',
  '2. 笔记记到一半的，就答记到的部分，并说明还缺什么。',
  '3. 不要复述题干，直接答。编造会被判 0 分。',
].join('\n');

async function examFromNotes(model, notes, q) {
  return callLLM(model, withPersona(EXAM_SYSTEM),
    ['===== 我的课堂笔记 =====', notes || '（这堂课我没记下任何东西）', '===== 笔记结束 =====',
     '', `问题：${q.question}`].join('\n'),
    { temperature: 0.3, maxTokens: 2000 });
}

async function studentAnswer(model, materialText, q, constrained = true) {
  const system = withPersona(constrained ? STUDENT_SYSTEM_WITH : STUDENT_SYSTEM_NONE);
  // 约束臂即使材料为空也要把空材料摆出来——空的材料框和「没有材料这回事」
  // 对模型是两种情境，前者才是我们要的那个对照。
  const prompt = constrained
    ? ['===== 学习材料开始 =====', materialText || '（本次没有提供任何材料）',
       '===== 学习材料结束 =====', '', `问题：${q.question}`].join('\n')
    : `问题：${q.question}`;
  // temperature 不设 0：设 0 会让"作答随机性"这一项方差消失，报出来的 sd 是假的。
  return callLLM(model, system, prompt, { temperature: 0.3, maxTokens: 2000 });
}

// 判官提示版本号。改了提示必须 +1——不同版本判出来的分不能直接比，
// 报告里落这个号才看得出两份报告是不是同一把尺子判的。
// v1 初版；v2 补「含糊比划不给分，不许高于诚实说未提及」（实测含糊作答能多拿 1 分）。
const JUDGE_PROMPT_VERSION = 'v2';

const JUDGE_SYSTEM = [
  '你是阅卷人。你看到的是一个学习者的作答，以及这道题的评分标准。',
  '',
  '**你看不到他学的材料，这是故意的**——你只能对着答案本身判，',
  '不许猜他读的是什么、不许因为答案长就给高分。',
  '',
  '判分方法（必须按顺序做）：',
  '1. 逐条核对 must_hit 要点，判断答案里**是否真的讲到了**这一点。',
  '   只是提到名词不算命中，要有对应的解释或推理才算。',
  '2. 数出命中条数，再对照 0-4 档描述给分。两者冲突时以档位描述为准。',
  '3. 答案里有**事实错误**的，即使命中要点也要扣：错一处降一档。',
  '4. 「材料未提及」是诚实的作答，不是错误，但该点不算命中。',
  '5. **含糊比划不给分。** 答案朝着正确概念绕圈但说不出机制的',
  '   （「材料指出会导致问题，虽然没有直接解释原因，但从名称可以看出…」这类），',
  '   一律按未命中处理，**不许判得比干脆承认「材料未提及」的答案高**。',
  '   实测过：不加这条，含糊作答能比诚实作答多拿 1 分，等于奖励和稀泥。',
  '',
  '严格输出 JSON：{"hits":["命中的要点原文",...],"errors":["事实错误",...],"score":0,"why":"一句话"}',
].join('\n');

async function judgeAnswer(model, q, answer) {
  const rub = q.rubric ?? {};
  const prompt = [
    `【题目】${q.question}`,
    '',
    `【满分必须命中的要点】`,
    ...(q.must_hit ?? []).map((m, i) => `  ${i + 1}. ${m}`),
    '',
    '【分档标准】',
    `  0 分：${rub.s0 ?? '完全没答到'}`,
    `  1 分：${rub.s1 ?? ''}`,
    `  2 分：${rub.s2 ?? ''}`,
    `  3 分：${rub.s3 ?? ''}`,
    `  4 分：${rub.s4 ?? ''}`,
    '',
    '【学习者的作答】',
    answer,
  ].join('\n');
  const raw = await callLLM(model, JUDGE_SYSTEM, prompt, { temperature: 0, maxTokens: 1500 });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, why: 'JSON 解析失败', raw: raw.slice(0, 300) };
  try {
    const j = JSON.parse(m[0]);
    const s = Number(j.score);
    // 判官返回越界分数说明它没按 rubric 判，标 null 让上层剔除，别默默截断成 4
    return { ...j, score: Number.isFinite(s) && s >= 0 && s <= 4 ? s : null };
  } catch {
    return { score: null, why: 'JSON 解析失败', raw: raw.slice(0, 300) };
  }
}

/**
 * 接地率：学生的回答里，有几条关键论断能在材料里找到依据。
 *
 * 为什么必须测：我们在 system prompt 里写了「只能依据材料作答」，但那只是一句话，
 * 模型听不听是另一回事。如果它嘴上说着看材料、实际在用预训练知识答题，
 * 那这门课的分数就是白捡的。**这一条不测，整套评测的效度就建立在一句祈使句上。**
 *
 * **只能按层解读。** 迁移题和实操题的答案按定义就包含材料里没写的推理步骤，
 * 接地率天然偏低——拿「接地率低 = 靠预训练蒙的」一刀切，会把我们最想要的那类答案误杀
 * （这是 RAG 评测里 faithfulness 指标的经典误用）。
 * 复述层接地率应当接近 1；迁移/实操层只用它查「被当成材料给的那些具体数字和代码是不是真有」。
 * 泄漏的直接测量是 blank 臂的得分，不是接地率。
 */
const GROUND_SYSTEM = [
  '你在做溯源核对。给你一份学习材料和一段基于它的回答。',
  '',
  '把回答拆成若干条**关键论断**（事实性陈述、公式、因果关系、代码逻辑），',
  '逐条判断材料里有没有依据：',
  '  supported —— 材料里有明确对应的内容',
  '  partial   —— 材料只沾了个边，论断里的关键细节材料没有',
  '  unsupported —— 材料里完全没有，是答题者自己补的',
  '',
  '「材料未提及」这种坦白不算论断，不计入。',
  '严格输出 JSON：{"total":0,"supported":0,"partial":0,"unsupported":0,"examples":["最典型的一条无依据论断"]}',
].join('\n');

async function groundedness(model, materialText, answer) {
  if (!materialText) return null;
  const raw = await callLLM(
    model,
    GROUND_SYSTEM,
    ['===== 材料开始 =====', materialText, '===== 材料结束 =====', '', '===== 回答 =====', answer].join('\n'),
    { temperature: 0, maxTokens: 1200 },
  );
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const t = Number(j.total);
    if (!Number.isFinite(t) || t <= 0) return null;
    return { total: t, supported: Number(j.supported) || 0, unsupported: Number(j.unsupported) || 0 };
  } catch {
    return null;
  }
}

/** 简单并发池 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
/** 分层自助法置信区间：对题目重采样，反映"换一批题会不会翻盘" */
function bootstrapCI(perQuestion, iters = 2000, seed = 42) {
  if (!perQuestion.length) return [NaN, NaN];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ms = [];
  for (let k = 0; k < iters; k++) {
    const samp = Array.from({ length: perQuestion.length }, () => perQuestion[Math.floor(rnd() * perQuestion.length)]);
    ms.push(mean(samp));
  }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(iters * 0.025)], ms[Math.floor(iters * 0.975)]];
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const bank = JSON.parse(readFileSync(BANK_PATH, 'utf8'));
  const questions = bank.questions ?? [];
  if (!questions.length) throw new Error(`题库为空：${BANK_PATH}`);
  const arms = buildArms(bank);

  console.log(`题库 ${path.basename(BANK_PATH)}：${questions.length} 题` +
    `（${[...new Set(questions.map((q) => q.layer))].map((l) => `${l} ${questions.filter((q) => q.layer === l).length}`).join(' / ')}）`);
  console.log(`实验臂 ${arms.map((a) => a.name).join(' / ')}，每臂 ${RUNS} 轮`);
  console.log(`学生 ${STUDENT_MODEL}  判官 ${JUDGE_MODEL}(${JUDGE_PROMPT_VERSION})\n`);

  // 任务展开成一张平表，方便并发和断点续跑
  const tasks = [];
  for (const arm of arms) {
    for (let run = 1; run <= RUNS; run++) {
      let mat;
      try {
        mat = materialFor(arm, run);
      } catch (e) {
        console.log(`  跳过 ${arm.name} r${run}：${e.message}`);
        continue;
      }
      for (const q of questions) tasks.push({ arm: arm.name, kind: arm.kind, run, q, mat,
                                              constrained: arm.constrained !== false });
    }
  }

  // 缓存按题库分文件。共用一个文件的话，两个评测并行跑会互相覆盖对方的缓存
  // （各自持有内存副本，最后写的赢）——不影响本次结果，但下次全都要重答。
  const cacheFile = path.join(OUT_DIR, `answers.${bank.slug ?? 'default'}.cache.json`);
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const cacheKey = (t) =>
    createHash('sha1')
      .update([t.arm, t.run, t.q.id, STUDENT_MODEL, t.mat.text.length, t.constrained,
               CLOSED_BOOK ? 'closed' : 'open', STUDENT_PERSONA_KEY, bank.version ?? '0'].join('|'))
      .digest('hex')
      .slice(0, 16);

  const notes = {};          // 「臂|轮次」→ 这一轮的课堂笔记（闭卷模式用，落盘给人抽读）
  const notePromises = {};   // 同键的记笔记调用只发一次
  let done = 0;
  let failed = 0;
  const results = await mapLimit(tasks, CONCURRENCY, async (t) => {
    try {
      return await runOne(t);
    } catch (e) {
      // 单个任务失败不能掀翻整轮。标成无效行，最后统一报剔了多少条。
      // 踩过：一次 15 分钟超时把跑到一半的 357 个任务整个带崩。
      failed++;
      return { arm: t.arm, kind: t.kind, run: t.run, id: t.q.id, layer: t.q.layer,
               source: t.mat.source, score: null, why: `任务失败：${e.message}` };
    }
  });

  async function runOne(t) {
    const ck = cacheKey(t);
    let answer = cache[ck];
    if (!answer) {
      if (CLOSED_BOOK && t.constrained !== false) {
        // 笔记按「臂 × 轮次」缓存，一份笔记答这一轮的全部题目——
        // 每题重记一次笔记既贵又不符合上课的样子（人不会为每道题重上一次课）。
        const nk = `notes|${t.arm}|${t.run}|${STUDENT_MODEL}|${t.mat.text.length}|${STUDENT_PERSONA_KEY}`;
        // 存的是 promise 不是结果：同一臂的多个任务是并发进来的，
        // 存结果的话「查了发现没有就自己记一份」会并发触发好几次，
        // 同一轮里不同题目用上不同的笔记，等于偷偷多了一个变量。
        if (!notePromises[nk]) notePromises[nk] = takeNotes(STUDENT_MODEL, t.mat.text);
        const myNotes = await notePromises[nk];
        notes[nk] = myNotes;
        answer = await examFromNotes(STUDENT_MODEL, myNotes, t.q);
      } else {
        answer = await studentAnswer(STUDENT_MODEL, t.mat.text, t.q, t.constrained !== false);
      }
      cache[ck] = answer;
    }
    // 判分、第二判官、接地率互不依赖，并发发出去。
    // 串行跑的话单个任务要四次往返，357 个任务就是三小时。
    const [verdict, verdict2, g] = await Promise.all([
      judgeAnswer(JUDGE_MODEL, t.q, answer),
      // 第二判官只为算信度：不参与出分，只用来回答「换个判官结论会不会翻」。
      JUDGE2_MODEL ? judgeAnswer(JUDGE2_MODEL, t.q, answer) : Promise.resolve(null),
      CHECK_GROUND && t.mat.text ? groundedness(JUDGE_MODEL, t.mat.text, answer) : Promise.resolve(null),
    ]);
    done++;
    // 缓存边跑边落盘。只在最后写的话，中途一挂几十分钟的作答全丢。
    if (done % 20 === 0) {
      writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
      process.stdout.write(`  ${done}/${tasks.length}\n`);
    }
    return { arm: t.arm, kind: t.kind, run: t.run, id: t.q.id, layer: t.q.layer,
             source: t.mat.source, reused: !!t.mat.reused, answer, ...verdict,
             score2: verdict2?.score ?? null,
             ground: g ? g.supported / g.total : null, groundTotal: g?.total ?? null };
  }

  writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
  if (CLOSED_BOOK) writeFileSync(path.join(OUT_DIR, `notes_${args.stamp || 'latest'}.json`),
    JSON.stringify(notes, null, 2), 'utf8');
  console.log(`  ${done}/${tasks.length} 完成${failed ? `（${failed} 条调用失败）` : ''}      \n`);

  const valid = results.filter((r) => r.score !== null);
  const dropped = results.length - valid.length;
  if (dropped) console.log(`⚠ ${dropped} 条无效（判官没按 rubric 输出或调用失败），已剔除\n`);

  // 失败率一高，剩下的表就是幸存者偏差——而且失败通常按臂聚集
  // （任务是按臂展开的，跑到某个臂被限流之后，它后面的臂全灭）。
  // 踩过：开卷那轮 158/272 失败，textbook 臂只剩 12 条，后面四个臂一条没有，
  // 但表照印不误，看上去像个正常结果。
  const failRate = dropped / Math.max(results.length, 1);
  if (failRate > 0.2) {
    console.log('═'.repeat(70));
    console.log(`⚠⚠ 失败率 ${(failRate * 100).toFixed(0)}%，**本轮结果不可用**。`);
    console.log('   失败按臂聚集，剩下的臂是幸存者，横向比较没有意义。');
    const perArm = {};
    for (const r of results) {
      perArm[r.arm] ??= { ok: 0, bad: 0 };
      perArm[r.arm][r.score === null ? 'bad' : 'ok']++;
    }
    console.log('   逐臂存活：' + Object.entries(perArm)
      .map(([k, v]) => `${k} ${v.ok}/${v.ok + v.bad}`).join('  '));
    console.log('   下面的表只作排错用，不许引用。');
    console.log('═'.repeat(70) + '\n');
  }

  // ── 汇总 ──
  // 层名从题库里推，别写死：两套题库的层名不一样（一套 operate/deliver，一套 diagnose），
  // 写死会让某一层的分数整个消失在报表里，而且不报错。
  const ORDER = ['recall', 'transfer', 'operate', 'diagnose', 'deliver'];
  const present = new Set(questions.map((q) => q.layer));
  const LAYERS = ORDER.filter((l) => present.has(l));
  const byArm = {};
  for (const a of arms) {
    const rows = valid.filter((r) => r.arm === a.name);
    if (!rows.length) continue;
    const perRun = [...new Set(rows.map((r) => r.run))].map((run) =>
      mean(rows.filter((r) => r.run === run).map((r) => r.score)));
    byArm[a.name] = {
      kind: a.kind,
      n: rows.length,
      overall: mean(rows.map((r) => r.score)),
      sd_between_runs: sd(perRun),
      ci: bootstrapCI(rows.map((r) => r.score)),
      byLayer: Object.fromEntries(
        LAYERS.map((l) => [l, mean(rows.filter((r) => r.layer === l).map((r) => r.score))]),
      ),
    };
  }

  const head = `${'臂'.padEnd(12)}${'n'.padEnd(5)}${'总分/4'.padEnd(16)}${'95%CI'.padEnd(16)}` +
    LAYERS.map((l) => l.padEnd(11)).join('');
  console.log(head);
  console.log('─'.repeat(head.length));
  for (const [name, s] of Object.entries(byArm)) {
    console.log(
      name.padEnd(12) + String(s.n).padEnd(5) +
      `${s.overall.toFixed(2)}±${s.sd_between_runs.toFixed(2)}`.padEnd(16) +
      `[${s.ci[0].toFixed(2)},${s.ci[1].toFixed(2)}]`.padEnd(16) +
      LAYERS.map((l) => (Number.isNaN(s.byLayer[l]) ? '—' : s.byLayer[l].toFixed(2)).padEnd(11)).join(''),
    );
  }

  // ── 归一化达成率 ──
  // g = (本臂 − 空材料下限) / (教材上限 − 空材料下限)
  // 借的是物理教育里的 normalized gain（Hake 1998）：把"模型本来就会的"扣掉，
  // 剩下的才是材料真正带来的增量，再除以教材能带来的增量。
  let floorReport = null;
  const floor = byArm.blank?.overall;
  const ceil = byArm.textbook?.overall;
  if (floor != null && ceil != null) {
    console.log(`\n相对教材达成率  g = (本臂 − 空材料 ${floor.toFixed(2)}) / (教材 ${ceil.toFixed(2)} − 空材料)`);
    if (ceil - floor < 0.3) {
      console.log('⚠ 教材与空材料的差距 < 0.3 分，分母太小，达成率不可信。');
      console.log('  说明题目区分度不够——模型不看材料也能答出来。先修题库，别看下面的数。');
    }
    for (const [name, s] of Object.entries(byArm)) {
      if (name === 'blank' || name === 'prior') continue;
      const g = (s.overall - floor) / (ceil - floor);
      const gl = Object.fromEntries(LAYERS.map((l) => {
        const f = byArm.blank?.byLayer[l], c = byArm.textbook?.byLayer[l];
        return [l, f != null && c != null && c - f > 0.2 ? ((s.byLayer[l] - f) / (c - f)) : NaN];
      }));
      console.log(`  ${name.padEnd(12)}${(g * 100).toFixed(0).padStart(4)}%    ` +
        LAYERS.map((l) => `${l} ${Number.isNaN(gl[l]) ? '—' : (gl[l] * 100).toFixed(0) + '%'}`).join('  '));
    }
  } else {
    console.log('\n（缺 blank 或 textbook 臂，算不了达成率。裸分不要单独引用）');
  }

  // ── 逐题区分度：不给材料就能答对的题是废题 ──
  // 心理测量里这叫 item discrimination。我们没有真人样本算点二列相关，
  // 但有一个更直接的判据：blank 臂（同样约束、空材料）在这道题上拿了几分。
  // 它拿到分只有一个解释：模型没守住「只依据材料」的约束，在偷用先验。
  // 拿满分说明这道题问的是模型本来就会的东西，留着只会把所有臂的差距抹平。
  if (byArm.blank) {
    const floorById = {};
    for (const q of questions) {
      const xs = valid.filter((r) => r.arm === 'blank' && r.id === q.id).map((r) => r.score);
      if (xs.length) floorById[q.id] = mean(xs);
    }
    const DISCRIM_MAX = Number(args['floor-max'] ?? 1.5);
    const weak = Object.entries(floorById).filter(([, v]) => v > DISCRIM_MAX).map(([k]) => k);
    console.log(`\n逐题约束泄漏（空材料臂得分 > ${DISCRIM_MAX} 判为泄漏）：` +
      `${questions.length - weak.length}/${questions.length} 题守住了约束`);
    if (weak.length) {
      console.log(`  泄漏题：${weak.map((id) => `${id}(${floorById[id].toFixed(1)})`).join(' ')}`);
      const keep = new Set(questions.filter((q) => (floorById[q.id] ?? 0) <= DISCRIM_MAX).map((q) => q.id));
      console.log('\n  只用有区分度的题重算：');
      for (const a of arms) {
        const rows = valid.filter((r) => r.arm === a.name && keep.has(r.id));
        if (rows.length) console.log(`    ${a.name.padEnd(12)}${mean(rows.map((r) => r.score)).toFixed(2)}`);
      }
      const f2 = mean(valid.filter((r) => r.arm === 'blank' && keep.has(r.id)).map((r) => r.score));
      const c2 = mean(valid.filter((r) => r.arm === 'textbook' && keep.has(r.id)).map((r) => r.score));
      if (Number.isFinite(f2) && Number.isFinite(c2) && c2 - f2 > 0.3) {
        console.log('    达成率（剔掉泄漏题）：');
        for (const a of arms) {
          if (a.name === 'blank' || a.name === 'prior') continue;
          const rows = valid.filter((r) => r.arm === a.name && keep.has(r.id));
          if (rows.length) console.log(`      ${a.name.padEnd(12)}${(((mean(rows.map((r) => r.score)) - f2) / (c2 - f2)) * 100).toFixed(0)}%`);
        }
      }
    }
    floorReport = floorById;
  }

  // ── 判分信度 ──
  if (JUDGE2_MODEL) {
    const pairs = valid.filter((r) => r.score2 !== null).map((r) => [r.score, r.score2]);
    if (pairs.length) {
      const exact = pairs.filter(([a, b]) => a === b).length / pairs.length;
      const within1 = pairs.filter(([a, b]) => Math.abs(a - b) <= 1).length / pairs.length;
      const bias = mean(pairs.map(([a, b]) => a - b));
      // 有序类别用二次加权 kappa：差 2 档比差 1 档罚得更重，比原始一致率诚实。
      const K = 5;
      const o = Array.from({ length: K }, () => new Array(K).fill(0));
      for (const [a, b] of pairs) o[a][b]++;
      const ra = new Array(K).fill(0), cb = new Array(K).fill(0);
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { ra[i] += o[i][j]; cb[j] += o[i][j]; }
      let num = 0, den = 0;
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
        const w = ((i - j) ** 2) / ((K - 1) ** 2);
        num += w * o[i][j];
        den += w * (ra[i] * cb[j]) / pairs.length;
      }
      const kappa = den > 0 ? 1 - num / den : NaN;
      console.log(`
判分信度（${JUDGE_MODEL} vs ${JUDGE2_MODEL}，n=${pairs.length}）：`);
      console.log(`  完全一致 ${(exact * 100).toFixed(0)}%   差 ≤1 档 ${(within1 * 100).toFixed(0)}%   ` +
        `二次加权 kappa ${Number.isNaN(kappa) ? '—' : kappa.toFixed(2)}   系统偏移 ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}`);
      if (kappa < 0.6) console.log('  ⚠ kappa < 0.6，两个判官分歧太大，分数不该单独引用');
    }
  }

  // ── 非劣效检验：课程能不能替代教材 ──
  // 「达到教材的效果」不是比一下均值就完了。均值低一点可能只是噪声，
  // 高一点也可能只是运气。临床试验里判「新疗法不比老疗法差」用的是非劣效检验：
  // 看 (教材 − 课程) 的置信区间上界有没有落在可接受的容差 δ 之内。
  // 按题配对做自助法——同一道题在两个臂之间比，把题目难度这个共同因素消掉，
  // 比各算各的均值再相减检出力高得多。
  const DELTA = Number(args.delta ?? 0.4);   // 容差：4 分制上差 0.4 分以内算「没差」
  if (byArm.textbook) {
    const perQ = (arm) => {
      const m = {};
      for (const q of questions) {
        const xs = valid.filter((r) => r.arm === arm && r.id === q.id).map((r) => r.score);
        if (xs.length) m[q.id] = mean(xs);
      }
      return m;
    };
    const tb = perQ('textbook');
    console.log(`
非劣效检验（容差 δ=${DELTA} 分，按题配对自助法 2000 次）：`);
    for (const a of arms) {
      if (a.name === 'textbook' || a.name === 'blank' || a.name === 'prior') continue;
      const mine = perQ(a.name);
      const diffs = questions.filter((q) => tb[q.id] != null && mine[q.id] != null)
        .map((q) => tb[q.id] - mine[q.id]);          // 正数 = 教材更好
      if (diffs.length < 3) continue;
      const [lo, hi] = bootstrapCI(diffs);
      const verdict = hi < DELTA ? '非劣（可以说没比教材差）'
        : lo > DELTA ? '劣于教材，且差距超过容差'
        : '判不了（区间跨过容差，样本不够或方差太大）';
      console.log(`  教材 − ${a.name.padEnd(10)}${mean(diffs).toFixed(2)} 分  ` +
        `95%CI [${lo.toFixed(2)}, ${hi.toFixed(2)}]  → ${verdict}`);
    }
    console.log(`  δ 是我们自己定的，不是算出来的。改 δ 会改结论，报数字时必须一起报 δ。`);
  }

  // ── 要点命中率 ──
  // 0-4 档位判分要判官自己拿捏档位边界，二元清单（这条要点命中没有）比它稳得多
  // （CheckEval, arXiv:2403.18771 的实测结论：换成二元 checklist 比调 prompt 更能提一致性）。
  // 判官本来就要逐条勾 must_hit，这里把勾中的比例单独报一遍，当档位分的交叉验证。
  {
    const byId = Object.fromEntries(questions.map((q) => [q.id, (q.must_hit ?? []).length]));
    const rate = (r) => {
      const total = byId[r.id] ?? 0;
      return total > 0 && Array.isArray(r.hits) ? Math.min(1, r.hits.length / total) : null;
    };
    const rows = valid.map((r) => ({ arm: r.arm, v: rate(r) })).filter((x) => x.v !== null);
    if (rows.length) {
      console.log('\n要点命中率（判官逐条勾中的 must_hit 占比，与档位分互为交叉验证）：');
      for (const a of arms) {
        const xs = rows.filter((r) => r.arm === a.name).map((r) => r.v);
        if (xs.length) console.log(`  ${a.name.padEnd(15)}${(mean(xs) * 100).toFixed(0)}%`);
      }
    }
  }

  // ── 接地率：学生到底有没有真的只用材料 ──
  if (CHECK_GROUND) {
    const rows = valid.filter((r) => r.ground !== null && r.ground !== undefined);
    if (rows.length) {
      console.log('\n接地率（回答里能在材料中找到依据的论断占比）：');
      for (const a of arms) {
        const xs = rows.filter((r) => r.arm === a.name).map((r) => r.ground);
        if (xs.length) console.log(`  ${a.name.padEnd(12)}${(mean(xs) * 100).toFixed(0)}%   n=${xs.length}`);
      }
      console.log('  接地率低而分数高 = 分是模型自己挣的，不是材料教的。两个数要一起看。');
    }
  }

  // ── 剥皮门 ──
  // 判据不能只是「赢没赢过剥皮版」。赢不过有两种完全不同的成因，
  // 要拿教材臂当分辨器才分得开：
  //   教材 ≈ 剥皮 → 尺子分不出深浅，它只认「这个主题出现过没有」，本轮作废
  //   教材 ≫ 剥皮 → 尺子是好的，问题在被测材料：讲解相对自己的结论清单没有增量
  // 第一次跑就撞上第二种（fork 1.17 / stripped 1.60 / textbook 3.50），
  // 所以这个分辨器不是防御性设计，是实测逼出来的。
  const stripped = byArm.stripped?.overall;
  const forkScore = byArm.fork?.overall;
  const ceilScore = byArm.textbook?.overall;
  if (stripped != null && forkScore != null) {
    const d = forkScore - stripped;
    console.log(`\n剥皮门：fork ${forkScore.toFixed(2)} vs 同源剥皮版 ${stripped.toFixed(2)}（差 ${d.toFixed(2)}）`);
    if (d > 0.2) {
      console.log('  过。讲解本身挣到了分，不只是术语出现过。');
    } else if (ceilScore != null && ceilScore - stripped > 0.8) {
      console.log(`  ⚠ 赢不过自己的剥皮版，但教材 ${ceilScore.toFixed(2)} 比剥皮版高 ` +
        `${(ceilScore - stripped).toFixed(2)} 分——**尺子是能分深浅的**。`);
      console.log('    所以问题不在尺子，在被测材料：它的讲解相对自己的结论清单没有可测的增量。');
      console.log('    这是产品结论，不是评测故障。');
    } else {
      console.log('  ⚠ 赢不过自己的剥皮版，而且教材也拉不开差距。');
      console.log('    尺子测到的是「这个主题出现过没有」，不是「教得好不好」——**本轮结论作废**。');
    }
  }

  const placebo = byArm.placebo?.overall;
  if (placebo != null && floor != null && placebo - floor > 0.5) {
    console.log(`\n⚠ 安慰剂臂比空材料高 ${(placebo - floor).toFixed(2)} 分。` +
      `喂无关材料也能涨分，说明判官在给"像教材的东西"送分，这把尺子有问题。`);
  }

  const stamp = args.stamp || 'latest';
  writeFileSync(path.join(OUT_DIR, `report_${stamp}.json`),
    JSON.stringify({ bank: path.basename(BANK_PATH), bankVersion: bank.version, runs: RUNS,
                     student: STUDENT_MODEL, judge: JUDGE_MODEL, judge2: JUDGE2_MODEL || null,
                     judgePromptVersion: JUDGE_PROMPT_VERSION,
                     studentPersona: STUDENT_PERSONA_KEY || null,
                     // δ 落盘：报表里没有 δ 的非劣效结论是不可复算的
                     mode: CLOSED_BOOK ? 'closed_book' : 'open_book',
                     delta: Number(args.delta ?? 0.4),
                     byArm, floorByQuestion: floorReport, rows: valid }, null, 2), 'utf8');
  console.log(`\n明细 → ${path.join(OUT_DIR, `report_${stamp}.json`)}`);
  return 0;
}

// 只有被直接执行时才跑。没有这个守卫的话，别的脚本一 import 进来
// （比如想复用 stripToConclusions）就会用默认参数跑起一整轮评测——
// 刚才手滑触发过一次，糊了一份空报告出来。
const invokedAs = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (invokedAs.endsWith('run_eval.mjs')) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { stripToConclusions };
