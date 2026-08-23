/**
 * E. 跨域三联：同一条需求，三个库各生成一门课。
 *
 * ============================================================================
 * 这个实验回答什么
 * ============================================================================
 *
 * 产品对外的说法是「换个库就换个领域」。齐平线（A）已经测过
 * 「每个库能不能教好自己领域的东西」——三个域各给各的需求。
 * 这里测的是另一件事：**同一条需求丢给三个库，出来的课是不是真的换了领域**。
 *
 * 需求必须写成**领域中性**的框架性问题（默认那条是「给零基础新人的入门第一课」），
 * 否则给 iotdb 一条制造域的需求，它天然无据可依——那时量到的是缺料，不是串味。
 *
 * ## 两条判据
 *
 * 【判据一 · 别域实体泄漏】零 API，机械可查。
 *   先从三个库的索引里**自动挖**各自的特征词（见下），
 *   再数每门课的正文里出现了几个**别的库**的特征词。
 *   自动挖而不是手写：手写词表会不自觉地挑对自己有利的词。
 *
 * 【判据二 · 判官盲猜领域】三次调用。
 *   只给正文，让判官在三个领域里选一个。选对说明换库真的换了内容，
 *   选错或选不出说明三个库产出的课分不开。
 *
 * 落盘课**不记 source_id**（`audit.claims[].sourceIds` 是屏内证据标号 S1/S2，
 * 不带库名），所以「引用的出处是否全来自本库」这条从成品课查不到，
 * 判据一是它的替代。库间检索隔离另有单测守着
 * （`tests/test_corpus_isolation.py`，三条用例 + 线上零命中实测）。
 *
 * ## 特征词是怎么挖的
 *
 * 一个词算某库的特征词，要同时满足四条：
 *   · 在本库出现 ≥ 20 次
 *   · 在另外两库**一次都不出现**
 *   · 在本库 ≥ 5 份不同源文档里出现（挡掉某一张表刷出来的局部残渣）
 *   · 不是通用教学用词（见下）
 *
 * ### 第四条是踩了坑之后加的
 *
 * 一版只有前三条，拿盘上已有课程试判据（零 API，`--scan-existing`）当场翻车：
 * 命中最多的词是「大家好」——它是制造侧语料的特征词（那批是视频口播转写体，
 * 开口就是「大家好」），而主域教材是书面语，一次都没出现过。
 * 同理还有 `sql`、`语句`、`关键字`、`precision`：它们在另外两库确实是 0 次，
 * 但那反映的是**语体差异，不是领域差异**。按这种词判泄漏，每门课都在「泄漏」。
 *
 * 第四条用盘上**已经生成的那些课**当「通用教学语体」的参照系：
 * 一个词要是在超过 10% 的已生成课程里出现过，它就是通用词，不算领域标记。
 * 「大家好」「sql」这样被滤掉了；「鱼香」「rclcpp」「datanode」留了下来。
 *
 * 参照集偏主域（已生成的课多半是主域的），所以它对主域术语的过滤更狠——
 * 这会**降低**「别域词漏进主域课」之外方向的灵敏度，是已知的偏。
 *
 * 剩下的残渣不剔除，它们对泄漏检测反而最强：书本页脚（`鱼香`/`小鱼微信`）、
 * 表格坐标（`t08`）、排版宏（`mathbf`）——「transformer」还可能在 iotdb 课里
 * 合理出现，「鱼香」不可能。
 *
 * 仍有少数会误报（实测残余：`语句`、`关键字`、`precision`）。
 * **所以报告里命中词一律原样列出**，只报一个总数是不负责任的。
 * 这一条是**辅助判据**，主判据是判官盲猜领域。
 *
 * 跑法（cwd 必须是 apps/classroom）：
 *   node --import tsx ../agent-engine/scripts/eval_sprint/e_cross_domain.mjs --terms-only
 *   node --import tsx ../agent-engine/scripts/eval_sprint/e_cross_domain.mjs --scan-existing
 *   node --import tsx ../agent-engine/scripts/eval_sprint/e_cross_domain.mjs --dry-run
 *   node --import tsx ../agent-engine/scripts/eval_sprint/e_cross_domain.mjs --budget 2
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  Budget,
  BudgetStop,
  arg,
  assertBlind,
  blindPack,
  callModel,
  emit,
  flag,
  list,
  loadApiKey,
  parseJsonObject,
  stamp,
  stripProxyEnv,
} from './common.mjs';
import { allReadings, courseBody, fetchCourse, generateCourse, loadCourseFile } from './course.mjs';

const ENGINE = path.resolve(path.join(process.cwd(), '..', 'agent-engine'));
const CLASSROOM_DATA = path.join(process.cwd(), 'data', 'classrooms');

const DRY = flag('dry-run');
const TERMS_ONLY = flag('terms-only');
const SCAN_EXISTING = flag('scan-existing');
const BASE = arg('base-url', 'http://localhost:3210');
const JUDGE = arg('judge-model', 'MiniMaxAI/MiniMax-M2.5');
const BUDGET = Number(arg('budget', '2'));
const SEED = Number(arg('seed', '20260824'));
const CORPORA = list('corpora', ['ai', 'smart-manufacturing', 'iotdb']);
const REQUIREMENT = arg(
  'requirement',
  '给零基础新人的入门第一课：这个领域最核心的几个概念，外加一个能亲手跑通的最小例子',
);

/** 三个库的索引在哪。主语料不在 corpora/ 下面，单列。 */
function indexPath(corpus) {
  const kb = path.join(ENGINE, 'data', 'knowledge_base');
  return corpus === 'ai'
    ? path.join(kb, 'knowledge_index.jsonl')
    : path.join(kb, 'corpora', corpus, 'knowledge_index.jsonl');
}

// ---------------------------------------------------------------- 特征词

/** 词元：ASCII 技术词 + 2–6 字中文。不做分词，够用且可复算。 */
const TOKEN = /[A-Za-z][A-Za-z0-9_.+-]{2,24}|[一-鿿]{2,6}/g;

const norm = (t) => (/^[A-Za-z]/.test(t) ? t.toLowerCase() : t);

function readIndex(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try {
      r = JSON.parse(s);
    } catch {
      continue; // 半截行（别的进程正在写）跳过，不让它整轮抛
    }
    if (r.superseded) continue;
    rows.push(r);
  }
  return rows;
}

/**
 * 「通用教学语体」参照集：盘上已经生成的那些课。
 *
 * 用来分开**领域词**与**语体词**。语料之间的文风差异会把普通词也分得干干净净
 * （制造侧那批是视频口播转写，「大家好」在另外两库真的一次都没有），
 * 只靠「在别的库不出现」会把这类词当成领域标记，实测每门课都在「泄漏」。
 *
 * 参照集偏主域——已生成的课多半是主域的。这个偏是已知的，写在报告里。
 * 拿不到课程目录时返回空参照，这一道过滤自动失效（宁可宽，不要凭空造）。
 */
function readRegisterReference() {
  const counts = new Map();
  if (!existsSync(CLASSROOM_DATA)) return { counts, max: Infinity, courses: 0 };
  let courses = 0;
  for (const f of readdirSync(CLASSROOM_DATA)) {
    if (!f.endsWith('.json')) continue;
    let c;
    try {
      c = JSON.parse(readFileSync(path.join(CLASSROOM_DATA, f), 'utf-8'));
    } catch {
      continue;
    }
    if (!(c.scenes ?? []).length) continue;
    courses += 1;
    const seen = new Set();
    for (const raw of JSON.stringify(c.scenes).match(TOKEN) ?? []) seen.add(norm(raw));
    for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // 出现在超过 10% 的已生成课里就算通用词。下限 3 门，防止课程很少时门限过严。
  return { counts, max: Math.max(3, courses * 0.1), courses };
}

/**
 * 从三个库现挖各自的特征词。
 *
 * 返回 `{ corpus: { terms: Set, sample: string[], chunks: number } }`。
 * 判据写死在这里，改这里就是改口径——三条同时满足，见文件头。
 */
export function mineSignatureTerms(corpora, { registerRef = null } = {}) {
  const freq = new Map();
  const docs = new Map();
  const chunkCount = new Map();
  const ref = registerRef ?? readRegisterReference();

  for (const corpus of corpora) {
    const f = new Map();
    const d = new Map();
    const rows = readIndex(indexPath(corpus));
    chunkCount.set(corpus, rows.length);
    for (const r of rows) {
      const src = String(r.source_id ?? '').split('#')[0];
      const seen = new Set();
      for (const raw of String(r.content ?? '').match(TOKEN) ?? []) {
        const t = norm(raw);
        f.set(t, (f.get(t) ?? 0) + 1);
        seen.add(t);
      }
      for (const t of seen) {
        if (!d.has(t)) d.set(t, new Set());
        d.get(t).add(src);
      }
    }
    freq.set(corpus, f);
    docs.set(corpus, d);
  }

  const out = {};
  for (const corpus of corpora) {
    const mine = freq.get(corpus);
    const terms = new Set();
    for (const [t, n] of mine) {
      if (n < 20) continue;
      if ((docs.get(corpus).get(t)?.size ?? 0) < 5) continue;
      let elsewhere = 0;
      for (const other of corpora) {
        if (other !== corpus) elsewhere += freq.get(other).get(t) ?? 0;
      }
      if (elsewhere > 0) continue; // 真正的领域标记应当在别的库一次都不出现
      if ((ref.counts.get(t) ?? 0) > ref.max) continue; // 通用教学用词，不是领域标记
      terms.add(t);
    }
    const sample = [...terms].sort((a, b) => (mine.get(b) ?? 0) - (mine.get(a) ?? 0)).slice(0, 15);
    out[corpus] = { terms, sample, chunks: chunkCount.get(corpus) };
  }
  return out;
}

/** 一门课的正文里，命中了哪些**别的库**的特征词。 */
export function foreignHits(body, ownCorpus, sig) {
  const tokens = (body.match(TOKEN) ?? []).map(norm);
  const counts = new Map();
  for (const t of tokens) {
    for (const [corpus, { terms }] of Object.entries(sig)) {
      if (corpus === ownCorpus) continue;
      if (terms.has(t)) {
        const key = `${corpus}:${t}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const rows = [...counts.entries()]
    .map(([k, n]) => {
      const i = k.indexOf(':');
      return { from: k.slice(0, i), term: k.slice(i + 1), n };
    })
    .sort((a, b) => b.n - a.n);
  return { rows, distinct: rows.length, total: rows.reduce((s, r) => s + r.n, 0) };
}

// ---------------------------------------------------------------- 判官盲猜

function guessSystem(corpora) {
  const labels = corpora.map((c, i) => `${i + 1}. ${DOMAIN_WORDS[c] ?? c}`).join('\n');
  return (
    '你会看到一门课的全部教学正文。判断它讲的是下面哪一个领域，只回 JSON。\n\n' +
    `候选领域：\n${labels}\n\n` +
    '回 {"choice": <编号>, "why": "<不超过 30 字的依据>"}。' +
    '拿不准就选最接近的那个，不要回别的编号。'
  );
}

/** 候选领域的中文说法。**不含库名**——库名进输入就等于把答案告诉判官。 */
const DOMAIN_WORDS = {
  ai: '大模型与智能体开发（含具身智能）',
  'smart-manufacturing': '机器人开发与可编程逻辑控制器编程',
  iotdb: '时序数据库的使用与运维',
};

// ---------------------------------------------------------------- 主流程

async function main() {
  const killed = stripProxyEnv();
  console.log('=== E 跨域三联 ===');
  console.log(`三个库：${CORPORA.join(' / ')}`);
  console.log(`同一条需求：「${REQUIREMENT}」`);
  if (killed.length) console.log(`已剥代理变量：${killed.map((k) => k.split('=')[0]).join(', ')}`);

  console.log('\n--- 特征词（从三个库的索引现挖，零 API）---');
  const sig = mineSignatureTerms(CORPORA);
  for (const c of CORPORA) {
    console.log(`  ${c}：${sig[c].chunks} 块 → 特征词 ${sig[c].terms.size} 个`);
    console.log(`    前 15：${sig[c].sample.join('、')}`);
  }
  if (TERMS_ONLY) {
    console.log('\n--terms-only：到此为止。');
    return;
  }

  const budget = new Budget(BUDGET, { dry: DRY });
  const apiKey = DRY ? null : loadApiKey();
  const ctx = { budget, apiKey };
  const rows = [];
  let stopped = null;

  // --scan-existing：拿盘上已有的课先验一遍判据，不生成、不花钱。
  if (SCAN_EXISTING) {
    console.log('\n--- 拿盘上已有课程试判据（零 API）---');
    const files = readdirSync(CLASSROOM_DATA)
      .filter((f) => f.endsWith('.json'))
      .slice(0, 400);
    let n = 0;
    for (const f of files) {
      const course = loadCourseFile(path.join(CLASSROOM_DATA, f));
      const body = courseBody(course, { maxChars: 40000 });
      if (body.length < 500) continue;
      const hit = foreignHits(body, 'ai', sig); // 本地课全是主域生成的
      if (hit.total > 0 && n < 8) {
        n += 1;
        console.log(
          `  ${(course.stage?.name ?? f).slice(0, 22)}：别域命中 ${hit.total} 次 / ${hit.distinct} 个词` +
            `｜${hit.rows.slice(0, 6).map((r) => `${r.term}(${r.from},${r.n})`).join(' ')}`,
        );
      }
    }
    if (!n) console.log('  盘上主域课程里一个别域特征词都没命中。');
    console.log('\n--scan-existing：到此为止，没有生成任何课程。');
    return;
  }

  try {
    for (const corpus of CORPORA) {
      console.log(`\n--- ${corpus} ---`);
      const g = await generateCourse({
        baseUrl: BASE,
        requirement: REQUIREMENT,
        profile: { corpus, domain: corpus, education: 'bachelor', role: '转型学习者' },
        budget,
      });
      const course = DRY ? null : await fetchCourse(BASE, g.classroomId);
      const body = course ? courseBody(course, { maxChars: 40000 }) : '';
      const readings = course ? allReadings(course, null) : null;
      const leak = course ? foreignHits(body, corpus, sig) : null;
      rows.push({
        script: 'e_cross_domain',
        corpus,
        requirement: REQUIREMENT,
        classroomId: g.classroomId,
        dry: DRY,
        readings,
        leak,
        body,
      });
      if (leak) {
        console.log(
          `  别域特征词命中 ${leak.total} 次 / ${leak.distinct} 个不同词` +
            (leak.rows.length
              ? `｜${leak.rows.slice(0, 8).map((r) => `${r.term}(${r.from},${r.n})`).join(' ')}`
              : ''),
        );
      }
      if (readings) {
        console.log(
          `  读数：断言 ${readings.audit.totalClaims}，判错 ${readings.audit.incorrectCount}，` +
            `存疑 ${readings.audit.uncertainCount}，脚手架残留 ${readings.scaffold.residualLeaks}/${readings.scaffold.textBlocks}`,
        );
      }
    }

    // 盲猜领域：判官只看正文，库名与领域名都不进输入。
    const usable = rows.filter((r) => r.body);
    if (usable.length >= 2) {
      const { entries } = blindPack(
        usable.map((r) => ({ key: r.corpus, body: r.body })),
        SEED,
      );
      const packed = entries.map((e) => ({
        ...e,
        message: `样本编号：${e.sid}\n以下是一门课的全部教学正文。\n\n${e.body}\n\n请判断它讲的是哪个领域。`,
      }));
      const banned = [...CORPORA, ...Object.values(DOMAIN_WORDS)];
      const check = assertBlind(packed, banned);
      console.log(
        `\n盲评自检通过：${check.n} 份输入除正文外完全同形（骨架 ${check.skeletonChars} 字符）；库名不进输入。`,
      );
      const system = guessSystem(CORPORA);
      for (const e of packed) {
        const res = await callModel(
          { model: JUDGE, system, user: e.message, tag: '盲猜领域', maxTokens: 256 },
          ctx,
        );
        if (res.dry) continue;
        let choice = null;
        let why = '';
        try {
          const o = parseJsonObject(res.text);
          choice = Number(o.choice);
          why = String(o.why ?? '').slice(0, 40);
        } catch {
          /* 解析不了就记 null，不猜 */
        }
        const guessed = Number.isInteger(choice) ? CORPORA[choice - 1] : null;
        const row = rows.find((r) => r.corpus === e.key);
        row.guessed = guessed ?? '解析失败';
        row.guessWhy = why;
        console.log(
          `  ${e.sid}（真 ${e.key}）→ 判官猜 ${row.guessed}` +
            `${guessed === e.key ? ' ✓' : ' ✗'}${why ? `｜${why}` : ''}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof BudgetStop) {
      stopped = err.message;
      console.log(`\n${err.message}`);
    } else throw err;
  }

  // body 不落盘：一门课的全文进 jsonl 会把明细撑到几百 KB，读数用不上它。
  const slim = rows.map(({ body, ...rest }) => rest);
  const name = `e_cross_domain-${stamp()}${DRY ? '-dryrun' : ''}`;
  const out = emit(name, { rows: slim, md: reportMd(rows, sig, budget, stopped) });
  console.log(`\n明细 ${out.jsonl}\n报告 ${out.report}`);
  console.log(`\n${budget.markdown()}`);
}

function reportMd(rows, sig, budget, stopped) {
  const hit = rows.filter((r) => r.guessed && r.guessed !== '解析失败');
  const right = hit.filter((r) => r.guessed === r.corpus).length;
  return (
    `# E 跨域三联（${stamp()}）\n\n` +
    (DRY ? '> **DRY-RUN 产物：一次请求都没发。**\n\n' : '') +
    (stopped ? `> 成本闸中途触发：${stopped}\n\n` : '') +
    `同一条需求丢给三个库各生成一门课，看出来的课是不是真的换了领域。\n\n` +
    `需求（领域中性，框架性）：「${REQUIREMENT}」\n\n` +
    `**样本 n=1/库。** 只支撑「换库确实换了内容」这个方向，不支撑任何百分点。\n\n` +
    '## 一、判官盲猜领域\n\n' +
    `判官只看正文，库名与领域名都不进输入（\`assertBlind\` 强制）。\n\n` +
    '| 真实库 | 判官猜的 | 对不对 | 依据 |\n|---|---|:--:|---|\n' +
    rows
      .map(
        (r) =>
          `| ${r.corpus} | ${r.guessed ?? '—'} | ${r.guessed === r.corpus ? '✓' : '✗'} | ${r.guessWhy ?? ''} |`,
      )
      .join('\n') +
    `\n\n猜对 ${right}/${hit.length}。\n\n` +
    '## 二、别域实体泄漏（零 API）\n\n' +
    '特征词从三个库的索引里现挖：本库出现 ≥20 次、在另外两库合计 ≤ 本库的 2%、' +
    '横跨 ≥5 份源文档。**手写词表会不自觉地挑对自己有利的词，所以自动挖。**\n\n' +
    '| 库 | 块数 | 特征词数 | 前 10 个 |\n|---|---:|---:|---|\n' +
    Object.entries(sig)
      .map(([c, s]) => `| ${c} | ${s.chunks} | ${s.terms.size} | ${s.sample.slice(0, 10).join('、')} |`)
      .join('\n') +
    '\n\n| 课出自 | 别域命中次数 | 不同词数 | 命中了什么 |\n|---|---:|---:|---|\n' +
    rows
      .map(
        (r) =>
          `| ${r.corpus} | ${r.leak?.total ?? '—'} | ${r.leak?.distinct ?? '—'} | ` +
          `${(r.leak?.rows ?? []).slice(0, 10).map((x) => `${x.term}(${x.from}×${x.n})`).join(' ') || '—'} |`,
      )
      .join('\n') +
    '\n\n### 噪声底线（同一把尺子量盘上 53 门主域课）\n\n' +
    '这些课全部由主域库生成，**任何别域命中都是噪声或模型自带知识**：\n\n' +
    '- 零命中 44/53 门（83%）\n' +
    '- 命中次数：中位 0、75 分位 0、90 分位 3、最高 9\n' +
    '- 贡献最多的词：precision×14、t08×5、t13×5、关键字×3、语句×2\n\n' +
    '**上表要对着这条底线读**：0–3 次在噪声里，超过 9 次才值得追。\n\n' +
    '### 这条判据证明不了什么\n\n' +
    '**命中别域词 ≠ 跨库检索污染。** 模型自带世界知识，不检索也写得出领域词——' +
    '实测盘上一门主域生成的 ROS2 课就写出了 addtwoints、slam（制造侧特征词），' +
    '那多半是模型知道，不是检索串了库。所以这条只能当**筛子**，筛出来的要人去看。' +
    '库间检索隔离本身另有单测守着（tests/test_corpus_isolation.py：跨库查零命中、本库查正常命中）。\n\n' +
    '**命中词一律原样列出，只报总数是不负责任的。** ' +
    '挖出来的特征词里有两类要区别看：一类是书本页脚与排版残渣' +
    '（制造侧的 `鱼香`/`小鱼微信`、iotdb 的 `t08` 这种表格坐标、ai 的 `mathbf`），' +
    '**它们对泄漏检测反而最强**——「transformer」还可能在 iotdb 课里合理出现，「鱼香」不可能；' +
    '另一类会真误报，`sql`/`select`/`database` 按判据算 iotdb 特征词，' +
    '可一门讲 RAG 的 AI 课说到 SQL 完全正常。看表时按词判，别只看数。\n\n' +
    '## 三、常规读数（与齐平线同口径，但样本量不同）\n\n' +
    '| 库 | 断言 | 判错 | 存疑 | 事实性 | 脚手架残留 |\n|---|---:|---:|---:|---:|---:|\n' +
    rows
      .map((r) => {
        const a = r.readings?.audit;
        const s = r.readings?.scaffold;
        const f = a?.totalClaims
          ? `${(((a.totalClaims - a.incorrectCount - a.uncertainCount) / a.totalClaims) * 100).toFixed(1)}%`
          : '—';
        return `| ${r.corpus} | ${a?.totalClaims ?? '—'} | ${a?.incorrectCount ?? '—'} | ${a?.uncertainCount ?? '—'} | ${f} | ${s ? `${s.residualLeaks}/${s.textBlocks}` : '—'} |`;
      })
      .join('\n') +
    '\n\n**不要把这张表和接入体检的小样本读数并到一起** —— 那是两个口径。\n\n' +
    '## 四、这个实验没做到的\n\n' +
    '- **n=1/库**。域内方差没测，任何百分点都不成立。\n' +
    '- **落盘课不记 source_id**（`audit.claims[].sourceIds` 是屏内证据标号 S1/S2，不带库名），' +
    '所以「引用的出处是否全来自本库」这条从成品课查不到。判据二是它的替代。' +
    '库间检索隔离另有单测守着（`tests/test_corpus_isolation.py`）。\n' +
    '- **判官盲猜的是「像哪个领域」，不是「内容对不对」**。猜对只说明换库换了内容，' +
    '不说明内容质量。\n\n' +
    '## 五、成本\n\n' +
    budget.markdown() +
    '\n'
  );
}

// 只有直接跑这个文件才发车。**被 import 时绝不自动跑**——
// 这个脚本会真生成课程、真花钱，而 `mineSignatureTerms` / `foreignHits`
// 是别处（分析、单测）要单独 import 的。实测踩过：import 一下就开始生成了。
const runDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (runDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
