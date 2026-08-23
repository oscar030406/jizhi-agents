/**
 * D. 数字扰动检出率（第二版，2026-08-23 重写）
 *
 * ============================================================================
 * 上一版是怎么被推翻的——两条都是真跑出来的，不是推演
 * ============================================================================
 *
 * 2026-08-22 用第一版真跑了 200 次判官调用（¥0.29），结论：**这批数不能用**。
 *
 * 【失败一】评测器与被测对象不匹配，不是产品漏检。
 *   200 条里有 118 条（59%）判官一条断言都没抽出来。抽样看回复，它反过来说
 *   「您没有提供教学正文」。原因是第一版把**单句**喂给判官
 *   （例：「参数向减小损失的方向移动了 0.2 个单位。」），
 *   而 JUDGE_SYSTEM 是为**整屏教学文本**写的——喂它一句话，它判定输入缺失。
 *   把这 118 条算成「产品没检出」，量到的是喂法不对，不是产品的毛病。
 *
 * 【失败二】只统计「标出来了」没有分辨力。
 *   剔掉无回复后剩 82 条：扰动句标出 88.5%，**原句误标 87.1%**。
 *   原句一个字没改，判官照样几乎全标。根因是这些句子本身就带数字，
 *   而 JUDGE_SYSTEM 写着「宁严勿松……编造的具体数字至少判 uncertain」——
 *   带数字的句子一律至少 uncertain。所以第一版量的是「这句有没有数字」，
 *   不是「这个数改错了没」。88.5% 这个数在 87.1% 的底噪上，等于零。
 *
 * ============================================================================
 * 第二版改了什么
 * ============================================================================
 *
 * 【改一】扰动句放进一屏完整教学文本里再喂。
 *   判官输入用产品 runJudge 的原样形态（hallucination-audit.ts:464）：
 *     场景标题：{title}\n教学文本：\n{整屏正文}
 *   整屏正文由产品的 `extractTeachingText(scene.content)` 现抠，不自己写一份。
 *   两档之间除了那一个数，整屏一字不动——这条在每一对上运行时断言，不是口头承诺。
 *
 * 【改二】判据改成配对比较，问「判官能不能分辨这两屏」。
 *   同一屏的原版与扰动版各判一次：
 *     detected    = 扰动版被判 incorrect/uncertain **且** 原版判 supported ← 唯一算成功的格子
 *     bothFlagged = 两版都被标 → 没有分辨力（第一版量到的就是这个格子，只是它没显出来）
 *     bothClean   = 两版都放过 → 漏检
 *     inverted    = 原版被标、扰动版放过 → 反了
 *   只报「扰动版标出率」等于把 bothFlagged 算成成功，那正是第一版的错。
 *
 * 【改三】样本不再取自冻结集 numeric_perturbation_set.jsonl。
 *   实测：那 100 条里只有 21 条能定位回教学正文（脚本会现算这个数并落进报告）。
 *   其余 79 条的出处是 `scenes[].audit.rationale` / `audit.claims[].claim` 一类——
 *   **审核日志本身**（「修订后事实性 0.89 ≥ 放行线 0.62」），根本不是教学正文。
 *   起因是 build_numeric_perturbation_set.py 的 collect_strings 遍历整份课程 JSON
 *   的每一个字符串，不区分教学内容和元数据。
 *   所以第二版改成从 `extractTeachingText` 的输出里现采：扰动规则与那份 py 完全同一套
 *   （value_x2 / unit_swap / consequence_flip），只是作用对象换成真教学正文，
 *   于是「能不能替回原文」这件事**由构造保证**，配对率 100%。
 *   冻结集不作废，脚本每次跑都对它做一次溯源体检并把结果写进报告。
 *
 * 跑法（cwd 必须是 apps/classroom，tsx 装在那边）：
 *   node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --selftest
 *   node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --dry-run
 *   node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --n 90 --budget 1
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Budget,
  BudgetStop,
  CLASSROOM,
  ENGINE,
  VERDICTS,
  arg,
  flag,
  loadApiKey,
  callModel,
  parseJsonObject,
  productJudgeSystem,
  assertBlind,
  bootstrapCoverage,
  mulberry32,
  emit,
  stamp,
  stripProxyEnv,
} from './common.mjs';
import { productFns } from './course.mjs';

// claimSimilarity 不在 productFns 里，单独取。模块已被 course.mjs 加载过，这里拿的是缓存。
const { claimSimilarity } = await import(
  pathToFileURL(path.join(CLASSROOM, 'lib/generation/hallucination-audit.ts')).href
);

const COURSES = arg('courses', path.join(CLASSROOM, 'data/classrooms'));
const SET = arg('set', path.join(ENGINE, 'data/eval/numeric_perturbation_set.jsonl'));
const N = Number(arg('n', 90));
const JUDGE = arg('judge', 'MiniMaxAI/MiniMax-M2.5');
const DRY = flag('dry-run');
const BUDGET = Number(arg('budget', 1));
const MAX_TOKENS = Number(arg('max-tokens', 2048));

/**
 * 禁词表只放**我们自己的机器标识**。
 * 「扰动」「原句」这类中文词不能进：语料是 AI 域课程，「扰动」在那里是正经术语
 * （对抗扰动、输入扰动），拿它当禁词会把好样本判成盲评泄漏，脚本当场死在自检上。
 */
const BANNED = ['value_x2', 'unit_swap', 'consequence_flip', 'arm:orig', 'arm:pert'];

/** 判官抽到的断言算不算「盖住了这一句」。用产品自己的相似度和产品自己的阈值。 */
const LINK_MIN = 0.6; // = hallucination-audit.ts 里 crossValidate 的 MATCH_THRESHOLD
const SEVERITY = { supported: 0, uncertain: 1, incorrect: 2 };

// ---------------------------------------------------------------- 一、扰动规则

/**
 * 三类扰动，与 scripts/build_numeric_perturbation_set.py 同一套规则、同一个顺序。
 * 这里重写成 JS 不是为了改判据，是因为要**就地作用在整屏文本里的那一句**上——
 * 那份 py 只产句对，产完就和原文断了联系（这正是第一版没法把句子放回屏的原因）。
 */
const NUM_RE = /\d+(?:\.\d+)?/;
const CJK_RE = /[一-鿿]/;
const UNIT_RE =
  /\d+(?:\.\d+)?\s*(?:ms|毫秒|秒|分钟|小时|天|%|％|倍|次|轮|步|层|维|个|条|道|GB|MB|KB|token|tokens|epoch)/;
const NUM_PREFIX = String.raw`(\d+(?:\.\d+)?\s*)`;

const UNIT_SWAPS = [
  ['毫秒', '秒'], ['秒', '毫秒'], ['ms', 's'],
  ['分钟', '小时'], ['小时', '分钟'],
  ['GB', 'MB'], ['MB', 'GB'], ['KB', 'MB'],
];
const CONSEQUENCE_SWAPS = [
  ['大于', '小于'], ['小于', '大于'], ['高于', '低于'], ['低于', '高于'],
  ['增大', '减小'], ['减小', '增大'], ['增加', '减少'], ['减少', '增加'],
  ['上升', '下降'], ['下降', '上升'], ['升高', '降低'], ['降低', '升高'],
  ['更快', '更慢'], ['更慢', '更快'], ['变快', '变慢'], ['变慢', '变快'],
  ['越大', '越小'], ['越小', '越大'], ['越多', '越少'], ['越少', '越多'],
  ['提高', '降低'], ['超过', '低于'],
];

/** 数值×2：只改句中第一个数字。 */
function perturbValue(s) {
  const m = NUM_RE.exec(s);
  if (!m) return null;
  const doubled = Number.parseFloat(m[0]) * 2;
  const out = s.slice(0, m.index) + String(doubled) + s.slice(m.index + m[0].length);
  return out === s ? null : out;
}

/** 单位替换：ms↔s 一类，单位必须紧跟数字（否则「秒懂」也会被换）。 */
function perturbUnit(s) {
  for (const [oldU, newU] of UNIT_SWAPS) {
    const re = new RegExp(NUM_PREFIX + oldU);
    if (re.test(s)) return s.replace(re, (_m, lead) => lead + newU);
  }
  return null;
}

/** 后果反转：大于→小于一类，只换第一处。 */
function perturbConsequence(s) {
  for (const [oldW, newW] of CONSEQUENCE_SWAPS) {
    if (s.includes(oldW)) return s.replace(oldW, newW);
  }
  return null;
}

const PERTURBATIONS = [
  ['value_x2', perturbValue],
  ['unit_swap', perturbUnit],
  ['consequence_flip', perturbConsequence],
];

// ---------------------------------------------------------------- 二、采样

/** 一门课的所有屏。正文用产品的 extractTeachingText，不自己再写一份抽取。 */
function screensOf(file) {
  const course = JSON.parse(readFileSync(file, 'utf8'));
  const sourceId = path.basename(file, '.json');
  return (course.scenes || [])
    .map((scene) => ({
      sourceId,
      sceneId: scene.id,
      sceneType: scene.type,
      title: String(scene.title || '').trim() || '（无标题）',
      // 只归一化行内空白：换行是 extractTeachingText 拼接字段的分隔符，抹掉会把两个字段黏成一句。
      text: productFns.extractTeachingText(scene.content).replace(/[ \t]+/g, ' '),
    }))
    .filter((s) => s.text.length > 0);
}

/**
 * 从真课程里采配对样本。
 *
 * 一条样本 = 一屏正文 + 屏里的一句 + 那句的一种扰动。扰动版整屏 = 原版整屏把那一句替换掉，
 * **其余一字不动**——这条在下面运行时断言，不靠人相信。
 * 句子在同一屏出现不止一次的直接丢弃：替换会歧义，两档就不只差一个数了。
 */
function harvestPairs(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const pairs = [];
  const stats = { courses: files.length, screens: 0, sentences: 0, ambiguous: 0 };

  for (const f of files) {
    for (const screen of screensOf(path.join(dir, f))) {
      stats.screens += 1;
      // 切句口径与 py 一致：句末标点 + 换行（extractTeachingText 的字段分隔符）。
      for (const raw of screen.text.split(/(?<=[。！？!?；;\n])/)) {
        const sentence = raw.trim();
        if (sentence.length < 12 || sentence.length > 160) continue;
        if (!CJK_RE.test(sentence) || !UNIT_RE.test(sentence)) continue;
        if (screen.text.split(sentence).length !== 2) {
          stats.ambiguous += 1;
          continue; // 这句在本屏出现不止一次，替换位置有歧义
        }
        let used = false;
        for (const [type, fn] of PERTURBATIONS) {
          const perturbed = fn(sentence);
          if (!perturbed || perturbed === sentence) continue;
          const pertScreen = screen.text.replace(sentence, perturbed);
          // 运行时断言：两屏除了这一句必须完全相同。把各自的那一句抠成同一个占位符再比，
          // 只要多改了一个标点就对不上。这是整个设计的地基，不许靠「应该没问题」。
          if (screen.text.replace(sentence, '§') !== pertScreen.replace(perturbed, '§')) {
            throw new Error(`替换污染了正文以外的部分：${screen.sourceId}#${screen.sceneId}「${sentence}」`);
          }
          pairs.push({
            sourceId: screen.sourceId,
            sceneId: screen.sceneId,
            sceneType: screen.sceneType,
            title: screen.title,
            type,
            original: sentence,
            perturbed,
            origScreen: screen.text,
            pertScreen,
          });
          used = true;
        }
        if (used) stats.sentences += 1;
      }
    }
  }
  return { pairs, stats };
}

/**
 * 轮转发牌取 n 条：稀有类先取满，不让 value_x2 把表淹掉。
 * 确定性——文件名、屏、句序都是排过序的，没有随机数，别人重跑拿到同一批。
 */
function roundRobin(pairs, n) {
  const buckets = new Map();
  for (const p of pairs) {
    if (!buckets.has(p.type)) buckets.set(p.type, []);
    buckets.get(p.type).push(p);
  }
  const keys = [...buckets.keys()].sort();
  const out = [];
  for (let i = 0; out.length < n; i++) {
    let moved = false;
    for (const k of keys) {
      const b = buckets.get(k);
      if (i >= b.length) continue;
      out.push(b[i]);
      moved = true;
      if (out.length >= n) break;
    }
    if (!moved) break;
  }
  return out;
}

// ---------------------------------------------------------------- 三、冻结集体检

/** 一个字符串出现在 JSON 的哪些路径下。数组下标归一成 `[]`，只看形状。 */
function pathsOf(node, needle, trail = []) {
  if (typeof node === 'string') {
    return node.replace(/\s+/g, '').includes(needle) ? [trail.join('.')] : [];
  }
  if (Array.isArray(node)) return node.flatMap((v, i) => pathsOf(v, needle, [...trail, `[${i}]`]));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => pathsOf(v, needle, [...trail, k]));
  }
  return [];
}

/**
 * 冻结集 numeric_perturbation_set.jsonl 的溯源体检：100 条里有几条能定位回教学正文，
 * 定位不了的出自哪个字段。零 API。
 *
 * 这一步不是装饰：它是「为什么第二版不用这份冻结集」的证据，
 * 而且下次有人重建冻结集时，这个分布直接告诉他 collect_strings 该收紧到哪。
 */
function auditFrozenSet(setPath, coursesDir) {
  if (!existsSync(setPath)) return null;
  const rows = readFileSync(setPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const norm = (s) => String(s).replace(/\s+/g, '');
  const cache = new Map();
  const loadCourse = (id) => {
    if (!cache.has(id)) {
      const f = path.join(coursesDir, `${id}.json`);
      cache.set(id, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
    }
    return cache.get(id);
  };

  const locatable = {};
  const unlocatable = {};
  const whereFrom = {};
  let noCourseFile = 0;

  for (const r of rows) {
    const course = loadCourse(r.source_id);
    if (!course) {
      noCourseFile += 1;
      whereFrom['（课程文件已不在盘上）'] = (whereFrom['（课程文件已不在盘上）'] || 0) + 1;
      unlocatable[r.perturbation_type] = (unlocatable[r.perturbation_type] || 0) + 1;
      continue;
    }
    const needle = norm(r.original);
    const hit = (course.scenes || []).some((s) =>
      norm(productFns.extractTeachingText(s.content)).includes(needle),
    );
    if (hit) {
      locatable[r.perturbation_type] = (locatable[r.perturbation_type] || 0) + 1;
      continue;
    }
    unlocatable[r.perturbation_type] = (unlocatable[r.perturbation_type] || 0) + 1;
    const found = pathsOf(course, needle).map((p) => p.replace(/\[\d+\]/g, '[]')).sort();
    const key = found[0] || '（整份课程 JSON 里都找不到）';
    whereFrom[key] = (whereFrom[key] || 0) + 1;
  }

  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return { total: rows.length, locatable, unlocatable, whereFrom, noCourseFile, nLocatable: sum(locatable) };
}

// ---------------------------------------------------------------- 四、判官与配对判据

/** 判官 user 消息，与产品 runJudge 同形（无参考资料档）。 */
function judgeBody(title, text) {
  return `${title}\n教学文本：\n${text}`;
}

/**
 * 这一屏的断言池里，盖住目标句的那几条判成了什么。
 * 取最重的一条：同一句被拆成几条断言时，只要有一条说不对，这句就算被标了。
 * 一条都没盖住返回 `none`——那是「这句没进池」，与「进了池判 supported」是两回事，
 * 分开记：前者是抽取漏了（旁路要治的就是它），后者是判定放行。
 */
function armVerdict(claims, sentence) {
  const linked = claims.filter((c) => claimSimilarity(c.claim, sentence) >= LINK_MIN);
  if (!linked.length) return { verdict: 'none', linked: [] };
  const worst = linked.reduce(
    (acc, c) => (SEVERITY[c.verdict] > SEVERITY[acc] ? c.verdict : acc),
    'supported',
  );
  return { verdict: worst, linked };
}

/** 判官对这句「提了异议」没有。none（没进池）算没提——它确实没说这句有问题。 */
const objected = (v) => v === 'uncertain' || v === 'incorrect';

/** 配对判据。detected 是唯一算成功的格子。 */
function outcomeOf(pertV, origV) {
  if (objected(pertV) && !objected(origV)) return 'detected';
  if (objected(pertV) && objected(origV)) return 'bothFlagged';
  if (!objected(pertV) && !objected(origV)) return 'bothClean';
  return 'inverted';
}

/** 一对样本的两档打分：旁路关 = 判官原池；旁路开 = 再过一遍产品的 mergeNumericBypass。 */
function scorePair(pair, pertClaims, origClaims) {
  const bypass = (claims, text) =>
    productFns.mergeNumericBypass(claims, text, undefined, (claim, reason) => ({
      claim,
      verdict: 'uncertain',
      reason,
    })).claims;

  const arm = (claims, text, sentence) => {
    const off = armVerdict(claims, sentence);
    const on = armVerdict(bypass(claims, text), sentence);
    return { off: off.verdict, on: on.verdict, offLinked: off.linked.length, onLinked: on.linked.length };
  };

  const pert = arm(pertClaims, pair.pertScreen, pair.perturbed);
  const orig = arm(origClaims, pair.origScreen, pair.original);
  return {
    pert,
    orig,
    outcomeOff: outcomeOf(pert.off, orig.off),
    outcomeOn: outcomeOf(pert.on, orig.on),
  };
}

// ---------------------------------------------------------------- 五、统计

const OUTCOMES = ['detected', 'bothFlagged', 'bothClean', 'inverted'];

function tally(rows, pick) {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of rows) counts[pick(r)] += 1;
  const n = rows.length;
  return { n, ...counts, rate: n ? counts.detected / n : null };
}

/**
 * 自助重抽的 95% 分位区间。小格子（unit_swap / consequence_flip 各几十条）
 * 的点估计单看没有意义，这条给它配的诚实说明。
 */
function bootCI(values, { iters = 2000, seed = 20260823 } = {}) {
  if (values.length < 2) return null;
  const rnd = mulberry32(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[Math.floor(rnd() * values.length)];
    means.push(s / values.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)], n: values.length };
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

// ---------------------------------------------------------------- 六、主流程

async function main() {
  const killed = stripProxyEnv();
  const budget = new Budget(BUDGET, { dry: DRY });
  const apiKey = DRY ? null : loadApiKey();
  const ctx = { budget, apiKey };
  const system = productJudgeSystem().full;

  console.log('=== D 数字扰动检出率（第二版：整屏 + 配对比较）===');
  console.log('第一版被推翻的两条实测原因见文件头。这一版：扰动句进整屏正文，判据改成配对分辨。');

  // 冻结集体检——顺带给出「为什么不用它」的证据
  const frozen = auditFrozenSet(SET, COURSES);
  if (frozen) {
    console.log(`\n冻结集溯源体检 ${SET}`);
    console.log(`  ${frozen.total} 条里 ${frozen.nLocatable} 条能定位回教学正文，其余 ${frozen.total - frozen.nLocatable} 条定位不了。`);
    for (const [k, v] of Object.entries(frozen.whereFrom).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(3)}  ${k}`);
    }
    console.log('  → 定位不了的多数出自审核日志字段，不是教学正文。所以这一版改成从教学正文现采。');
  }

  const { pairs: all, stats } = harvestPairs(COURSES);
  const pairs = roundRobin(all, N);
  const byType = {};
  for (const p of pairs) byType[p.type] = (byType[p.type] || 0) + 1;
  const allByType = {};
  for (const p of all) allByType[p.type] = (allByType[p.type] || 0) + 1;

  console.log(`\n采样 ${COURSES}`);
  console.log(`  ${stats.courses} 门课 / ${stats.screens} 屏有正文 / ${stats.sentences} 句可扰动（${stats.ambiguous} 句因在同屏重复出现被丢弃）`);
  console.log(`  可造 ${all.length} 对（${Object.entries(allByType).map(([k, v]) => `${k}=${v}`).join('  ')}）`);
  console.log(`  本次轮转取 ${pairs.length} 对（${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join('  ')}），稀有类优先取满`);
  console.log('  每一对都通过了「两屏除那一句外逐字相同」的运行时断言。');

  // 判官输入去重：同一屏的原版被多对样本共用，只调一次（temperature 0，同输入同输出）。
  const inbox = new Map(); // body -> { title, text }
  for (const p of pairs) {
    inbox.set(judgeBody(p.title, p.origScreen), { key: `${p.sourceId}#${p.sceneId}:orig` });
    inbox.set(judgeBody(p.title, p.pertScreen), { key: `${p.sourceId}#${p.sceneId}:${p.type}` });
  }
  const jobs = [...inbox.entries()].map(([body, meta], i) => ({
    sid: `S${String(i + 1).padStart(3, '0')}`,
    key: meta.key,
    body,
    message: `场景标题：${body}`,
  }));

  const chars = jobs.reduce((a, j) => a + j.body.length, 0);
  console.log(`\n共 ${jobs.length} 次判官调用（${pairs.length} 屏扰动版 + ${jobs.length - pairs.length} 屏原版；原版按屏去重共用）。`);
  console.log(`  判官 ${JUDGE}，max_tokens ${MAX_TOKENS}，无参考资料档。`);
  console.log(`  判官输入平均 ${Math.round(chars / jobs.length)} 字/次（第一版是单句，约 30 字——这就是它被判「没给正文」的原因）。`);
  console.log(`  成本上限 ¥${BUDGET}${DRY ? '（dry-run，一次请求都不发）' : ''}`);
  if (killed.length) console.log(`  已剥代理变量：${killed.map((k) => k.split('=')[0]).join(', ')}`);

  // 盲：两档的判官输入除正文外完全同形，标题也在正文里一起送，不额外多一句话。
  const check = assertBlind(jobs, BANNED);
  console.log(`  盲评自检通过：${check.n} 条输入同形（骨架 ${check.skeletonChars} 字符），原版/扰动版/扰动类型都不进输入。`);

  const results = new Map(); // body -> { claims, parseFailed, snippet }
  let stopped = null;
  try {
    for (const [i, job] of jobs.entries()) {
      const res = await callModel(
        { model: JUDGE, system, user: job.message, tag: '判定-整屏', maxTokens: MAX_TOKENS },
        ctx,
      );
      if (res.dry) {
        if (i === 0) console.log(`\n  [dry] 每次约 ${res.estIn} prompt token + ${res.estOut} completion token（估）`);
        continue;
      }
      let claims = [];
      let parseFailed = false;
      let snippet = '';
      try {
        const o = parseJsonObject(res.text);
        claims = (o.claims || [])
          .filter((c) => c && typeof c.claim === 'string' && VERDICTS.includes(c.verdict))
          .map((c) => ({ claim: c.claim, verdict: c.verdict, reason: String(c.reason || '') }));
      } catch (e) {
        // 判官没吐出可解析的 JSON，与「判官看了但没检出」是两回事。混在一起算，
        // 工具的毛病会被算成产品的漏检。单记一格，从所有率的分母里剔除。
        // 顺手留 200 字回复原文：第一版是靠人工抽样才发现它在说「您没有提供教学正文」，
        // 那种发现不该靠运气。
        parseFailed = true;
        snippet = String(res.text || '').slice(0, 200).replace(/\s+/g, ' ');
        console.log(`  ${job.sid} 判官回复解析不了：${e.message}｜回复开头：${snippet.slice(0, 80)}`);
      }
      results.set(job.body, { claims, parseFailed, snippet });
      if ((i + 1) % 10 === 0) console.log(`  已跑 ${i + 1}/${jobs.length}，累计 ¥${budget.spent.toFixed(4)}`);
    }
  } catch (err) {
    if (err instanceof BudgetStop) {
      stopped = err.message;
      console.log(`\n${err.message}`);
    } else throw err;
  }

  // 打分。两档都拿到回复的才算一对；缺一档的记 incomplete（成本闸中途停会产生这种）。
  const rows = [];
  let incomplete = 0;
  for (const p of pairs) {
    const o = results.get(judgeBody(p.title, p.origScreen));
    const x = results.get(judgeBody(p.title, p.pertScreen));
    if (!o || !x) {
      incomplete += 1;
      continue;
    }
    const parseFailed = o.parseFailed || x.parseFailed;
    const scored = parseFailed ? null : scorePair(p, x.claims, o.claims);
    rows.push({
      script: 'd_numeric_perturbation',
      sourceId: p.sourceId,
      sceneId: p.sceneId,
      sceneType: p.sceneType,
      type: p.type,
      original: p.original,
      perturbed: p.perturbed,
      screenChars: p.origScreen.length,
      parseFailed,
      parseFailedWhich: parseFailed ? [o.parseFailed && 'orig', x.parseFailed && 'pert'].filter(Boolean) : [],
      judgeSnippet: o.parseFailed ? o.snippet : x.parseFailed ? x.snippet : '',
      origClaims: o.claims,
      pertClaims: x.claims,
      ...(scored || {}),
    });
  }
  // dry-run 下一条回复都没有，「缺一档」是必然而非异常，不报。
  if (incomplete && !DRY) console.log(`\n${incomplete} 对因成本闸中途停、缺一档回复，未计入。`);

  const name = `d_numeric_perturbation-${stamp()}${DRY ? '-dryrun' : ''}`;
  const { jsonl, report } = emit(name, {
    rows,
    md: reportMd({
      frozen, stats, all, allByType, pairs, byType, jobs, chars, rows,
      incomplete: DRY ? 0 : incomplete,
      budget, stopped,
    }),
  });
  console.log(`\n明细 ${jsonl}\n报告 ${report}`);
  console.log(`\n${budget.markdown()}`);
  if (DRY) {
    console.log(
      '\n[dry-run] 以上是「会做什么、会花多少」。判官单次实测参考值 ¥0.0014（第一版单句档），' +
        '本设计喂的是整屏，prompt 长了一个量级，上表按 cost_meter.py 单价重估。' +
        '本脚本不生成课程，整课生成实测 ¥0.94/门那一项在这里是 ¥0。',
    );
  }
}

// ---------------------------------------------------------------- 七、报告

function reportMd(c) {
  const usable = c.rows.filter((r) => !r.parseFailed);
  const failed = c.rows.length - usable.length;
  const types = Object.keys(c.byType).sort();

  const row = (label, rs) => {
    const off = tally(rs, (r) => r.outcomeOff);
    const on = tally(rs, (r) => r.outcomeOn);
    const ci = bootCI(rs.map((r) => (r.outcomeOff === 'detected' ? 1 : 0)));
    return `| ${label} | ${off.n} | ${off.detected} | ${pct(off.rate)} | ${
      ci ? `${pct(ci.lo)}–${pct(ci.hi)}` : '—'
    } | ${off.bothFlagged} | ${off.bothClean} | ${off.inverted} | ${pct(on.rate)} |`;
  };

  const detectVals = usable.map((r) => (r.outcomeOff === 'detected' ? 1 : 0));
  const boot = detectVals.length ? bootstrapCoverage(detectVals, 0.5) : null;

  // 断言池覆盖：这句到底有没有进池。旁路要治的就是「没进池」。
  const inPool = (rs, arm, key) => {
    const n = rs.length;
    if (!n) return '—';
    return pct(rs.filter((r) => r[arm]?.[key] !== 'none').length / n);
  };

  const frozenBlock = c.frozen
    ? `冻结集 \`numeric_perturbation_set.jsonl\` 共 **${c.frozen.total}** 条，
其中 **${c.frozen.nLocatable}** 条能在 \`extractTeachingText\` 的输出里定位到，
**${c.frozen.total - c.frozen.nLocatable}** 条定位不了。定位不了的出处：

| 出处字段 | 条数 |
|---|---:|
${Object.entries(c.frozen.whereFrom)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `| \`${k}\` | ${v} |`)
  .join('\n')}

可定位的那部分按类型：${Object.entries(c.frozen.locatable).map(([k, v]) => `${k}=${v}`).join('、') || '（无）'}。
**结论：这份冻结集大半不是教学正文，是审核日志。** 起因在
\`scripts/build_numeric_perturbation_set.py\` 的 \`collect_strings\`——它遍历整份课程 JSON 的
每一个字符串，把 \`audit.rationale\`（「修订后事实性 0.89 ≥ 放行线 0.62」）这类元数据
也当成课文抽走了。第一版拿它去问判官，等于让判官去核对审核系统自己的日志。
就算只用可定位的那 ${c.frozen.nLocatable} 条，类型分布也塌成一格，per-type 表没法看。
所以第二版改成从教学正文现采，扰动规则与那份 py 一模一样。`
    : '冻结集文件不在盘上，跳过溯源体检。';

  return `# D 数字扰动检出率（第二版，${stamp()}）

${DRY ? '> **DRY-RUN 产物：一次请求都没发。** 率表全空，只证明采样、盲评自检、成本口径跑得通。\n' : ''}${
    c.stopped ? `> 成本闸中途触发：${c.stopped}\n` : ''
  }
## 〇、第一版是怎么被推翻的

2026-08-22 第一版真跑了 200 次调用（¥0.29），两条实测结论让那批数作废：

1. **判官对 200 条里的 118 条（59%）一条断言都没抽出来**，抽样看回复它反过来说
   「您没有提供教学正文」。第一版喂的是**单句**，而 \`JUDGE_SYSTEM\` 是为整屏教学文本写的。
   这是评测器与被测对象不匹配，不是产品漏检。
2. 剔掉无回复后剩 82 条，**扰动句标出 88.5%，原句误标 87.1%**——判官对没改过的原句
   也几乎全标。根因是这些句子本身带数字，而判官被要求「宁严勿松……编造的具体数字至少判
   uncertain」。第一版量的是「有没有数字」，不是「改错了没」。

第二版针对这两条改：**整屏喂** + **配对判据**。

## 一、冻结集溯源体检（零 API）

${frozenBlock}

## 二、这一版的样本怎么造的

${c.stats.courses} 门真课程 / ${c.stats.screens} 屏有教学正文 / ${c.stats.sentences} 句带可扰动的数字
（另有 ${c.stats.ambiguous} 句因在同屏出现不止一次被丢弃——替换位置有歧义，两档就不只差一个数了）。

可造 **${c.all.length}** 对：${Object.entries(c.allByType).map(([k, v]) => `${k}=${v}`).join('、')}。
本次轮转发牌取 **${c.pairs.length}** 对（稀有类先取满）：${types.map((t) => `${t}=${c.byType[t]}`).join('、')}。

一对样本 = 一屏正文（平均 ${Math.round(c.chars / Math.max(c.jobs.length, 1))} 字）+ 屏里的一句 + 那句的一种扰动。
扰动版整屏 = 原版整屏把那一句换掉，**其余一字不动**——这条在每一对上跑了运行时断言
（把各自的那一句抠成同一个占位符再逐字比），不是口头承诺。
配对率 100%：样本本来就是从整屏里采的，不存在「定位不回原文」。

判官输入用产品 \`runJudge\` 的原样形态（\`hallucination-audit.ts:464\`）：
\`场景标题：{title}\\n教学文本：\\n{整屏正文}\`。整屏正文由产品的 \`extractTeachingText\` 现抠。
原版整屏按屏去重共用一次调用（temperature 0，同输入同输出），所以 ${c.pairs.length} 对只花了
${c.jobs.length} 次调用。

## 三、主表：判官能不能分辨这两屏

判据：**扰动版被判 incorrect/uncertain 且原版判 supported** 才算一次成功检出（\`detected\`）。
两版都被标（\`bothFlagged\`）不算成功——那正是第一版量到却没显出来的那一格。

判官回复解析失败 **${failed}/${c.rows.length}** 对，已从下面所有率的分母里剔除
（明细 jsonl 里留了回复开头 200 字，直接能看出它在说什么）。${
    c.incomplete ? `另有 ${c.incomplete} 对因成本闸中途停、缺一档回复，未计入。` : ''
  }

| 扰动类型 | 配对数 | detected | 分辨率(旁路关) | 自助 95% 区间 | bothFlagged | bothClean | inverted | 分辨率(旁路开) |
|---|---:|---:|---:|:--:|---:|---:|---:|---:|
${types.map((t) => row(t, usable.filter((r) => r.type === t))).join('\n')}
${row('**合计**', usable)}

${
  boot
    ? `自助重抽（2000 次，判据线 0.5）：**${(boot.coverage * 100).toFixed(1)}%** 的重抽分辨率仍在 0.5 以上，n=${boot.n}。`
    : '（dry-run，无重抽）'
}

小格子（unit_swap / consequence_flip）的点估计**不能单独看**，看区间。

## 四、附表：这句到底进没进断言池

分辨率算的是「判官说了什么」。这张表算的是「判官有没有看这一句」——
一条断言都没盖住这句（\`none\`）说明抽取环节就漏了，后面整条链都碰不到它。
旁路（\`mergeNumericBypass\`）要治的正是这一格。

| 档 | 扰动版进池率 | 原版进池率 |
|---|---:|---:|
| 旁路关 | ${inPool(usable, 'pert', 'off')} | ${inPool(usable, 'orig', 'off')} |
| 旁路开 | ${inPool(usable, 'pert', 'on')} | ${inPool(usable, 'orig', 'on')} |

旁路补进来的断言一律 \`uncertain\`，意思是「这条没被真正判过」，不是「这条错了」。
所以旁路开会把两档一起推向 \`bothFlagged\`——**分辨率大概率不升反降**。
这不是旁路变差了，是它本来就不做分辨：它做的是把漏抽的数字标出来让人看见（第四节那张表）。
报告里不许把旁路开的数读成准确率提升。

## 五、成本

${c.budget.markdown()}

参考值：判官单次实测 ¥0.0014（第一版单句档）。第二版喂整屏，prompt 长了一个量级，
上表按 \`cost_meter.py\` 单价重估。本脚本**不生成课程**——整课生成实测 ¥0.94/门那一项在这里是 ¥0。
注意 \`${JUDGE}\` 在 \`cost_meter.py\` 的价格表里没有前缀命中，走的是兜底 Qwen 档单价，以账单为准。

## 六、没做到的

- **每档只判一次**。判官在 temperature 0 下仍有抖动，一对样本的差里混着这份抖动。
  要压掉得每档重复 3 次取多数，成本×3。判官自身的抖动幅度见 \`c_judge_stability\`。
- **无参考资料档**。线上审核链会带 RAG 检索到的参考资料，判官口径会更严
  （\`EVIDENCE_ADDENDUM\` 要求 supported 必须回填 sourceId）。这里没有资料，
  量到的是「无资料档」的分辨力，比线上宽松。
- **value_x2 里混着「翻倍之后仍然正确」的句子**，例如枚举性的数字（「第 3 章」翻成「第 6 章」
  在只看这一屏时未必判得出对错）。这部分会被算成漏检，要更准得人工过一遍标真值。
- **单判官、无仲裁、无答辩**，与线上审核链不是一个东西。这是内部回归尺，不对外报。
- **采样的确定性只在语料快照固定时成立**。取样没有随机数（文件名、屏、句序都排过），
  但 \`data/classrooms\` 会随生产往里加课——课多了轮转发牌的结果就变。
  要跨批次比同一批样本，把这份报告第二节的对数与类型分布抄下来对账。
- **冻结集没有重建**。本脚本不改 \`build_numeric_perturbation_set.py\`（不在可动范围内）。
  第一节那张出处表就是给重建的人的输入：\`collect_strings\` 应当只走
  \`scenes[].content\`，把 \`audit\` / \`actions\` 整棵剪掉。
`;
}

// ---------------------------------------------------------------- 八、自检

/** 零 API 自检：扰动规则、就地替换、配对判据、连边判据。dry-run 盯不到这一层。 */
function selftest() {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`自检失败：${msg}`);
    console.log(`  ok  ${msg}`);
  };

  // 1. 三类扰动
  ok(perturbValue('阈值设为 150 毫秒。') === '阈值设为 300 毫秒。', 'value_x2 只改第一个数字');
  ok(perturbUnit('每次调用耗时 2 秒。') === '每次调用耗时 2 毫秒。', 'unit_swap 换紧跟数字的单位');
  ok(perturbUnit('他 2 秒懂了这 3 个概念。') === '他 2 毫秒懂了这 3 个概念。', 'unit_swap 不误伤「秒懂」以外的字');
  ok(perturbConsequence('学习率越大收敛越快，超过 0.5 会震荡。') === '学习率越小收敛越快，超过 0.5 会震荡。', 'consequence_flip 只换第一处');
  ok(perturbUnit('批大小 32 个样本。') === null, '没有可换单位时返回 null，不硬造');

  // 2. 就地替换：两屏除那一句外逐字相同
  const screen = '第一屏讲梯度下降。\n阈值设为 150 毫秒就停机。\n下一屏讲学习率。';
  const sent = '阈值设为 150 毫秒就停机。';
  const pert = perturbValue(sent);
  const pertScreen = screen.replace(sent, pert);
  ok(pertScreen.includes('300 毫秒'), '扰动句替进了整屏');
  ok(pertScreen.includes('第一屏讲梯度下降。') && pertScreen.includes('下一屏讲学习率。'), '屏里其余内容原样保留');
  ok(
    screen.replace(sent, '§') === pertScreen.replace(pert, '§'),
    '抠掉各自那一句后两屏逐字相同（这是整个设计的地基）',
  );
  ok(screen.length !== pertScreen.length || screen !== pertScreen, '两屏确实不同');

  // 3. 连边：判官引用整句 / 引用片段 / 引用别的句子
  const pool = [
    { claim: '阈值设为 300 毫秒就停机', verdict: 'incorrect', reason: '' },
    { claim: '梯度下降是一种优化算法', verdict: 'supported', reason: '' },
  ];
  ok(armVerdict(pool, pert).verdict === 'incorrect', '判官引用了这句，取它的判定');
  ok(armVerdict(pool, '完全无关的另一句教学文本内容').verdict === 'none', '没有断言盖住这句时判 none');
  ok(armVerdict([], pert).verdict === 'none', '空池判 none');
  ok(
    armVerdict(
      [
        { claim: '阈值设为 300 毫秒就停机', verdict: 'supported', reason: '' },
        { claim: '阈值设为 300 毫秒就停机（条件）', verdict: 'uncertain', reason: '' },
      ],
      pert,
    ).verdict === 'uncertain',
    '同一句被拆成几条时取最重的一条',
  );

  // 4. 配对判据
  ok(outcomeOf('incorrect', 'supported') === 'detected', '扰动版判错 + 原版放行 = 检出');
  ok(outcomeOf('uncertain', 'supported') === 'detected', 'uncertain 也算提了异议');
  ok(outcomeOf('uncertain', 'uncertain') === 'bothFlagged', '两版都标 = 没有分辨力（第一版的真相）');
  ok(outcomeOf('supported', 'supported') === 'bothClean', '两版都放 = 漏检');
  ok(outcomeOf('none', 'none') === 'bothClean', '两版都没进池也算漏检');
  ok(outcomeOf('supported', 'incorrect') === 'inverted', '原版被标扰动版放行 = 反了');
  ok(outcomeOf('incorrect', 'none') === 'detected', '原版没进池不算「提了异议」');

  // 5. 旁路那一档：判官全没抽到时，旁路把带单位的数字补进池并标 uncertain
  const pair = { origScreen: screen, pertScreen, original: sent, perturbed: pert, type: 'value_x2' };
  const blind = scorePair(pair, [], []);
  ok(blind.outcomeOff === 'bothClean', '判官一条没抽到时，旁路关这档两版都是漏检');
  ok(blind.outcomeOn === 'bothFlagged', '旁路开把两版一起推成 bothFlagged——旁路不做分辨');
  const real = scorePair(pair, pool, [{ claim: sent, verdict: 'supported', reason: '' }]);
  ok(real.outcomeOff === 'detected', '判官真分辨出来时记 detected');

  // 6. 轮转发牌：稀有类先取满
  const fake = [
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'value_x2', i })),
    ...Array.from({ length: 2 }, (_, i) => ({ type: 'unit_swap', i })),
  ];
  const picked = roundRobin(fake, 6);
  ok(picked.length === 6, '取够 6 条');
  ok(picked.filter((p) => p.type === 'unit_swap').length === 2, '稀有类 2 条全进');

  // 7. 自助区间
  const ci = bootCI([1, 1, 0, 1, 0, 1, 1, 0]);
  ok(ci && ci.lo < 0.625 && ci.hi > 0.625, `自助 95% 区间 ${pct(ci.lo)}–${pct(ci.hi)} 罩住点估计 62.5%`);

  console.log('\nd_numeric_perturbation 第二版自检全过（零 API）。');
}

if (flag('selftest')) selftest();
else
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
