/**
 * C. 判官新域校准：从制造侧课程里抽 20–30 条断言，把 rubric 的三个选项置换 3 轮，
 *    看同一条断言在三轮里判不判成同一档——测的是尺子本身晃多厉害，不是产品分数。
 *
 * 判定口径**从产品源码里现抠**（hallucination-audit.ts 的 JUDGE_SYSTEM），
 * 不在这边另写一份。抠不出来就抛，不拿"差不多的口径"顶上——那测出来的是两份提示词的差。
 *
 * 自变量只有一个：三个选项在提示词里的先后顺序（原序 / 反序 / 轮转）。
 * 其余逐字相同，temperature 锁 0。
 *
 * 跑法（cwd 必须是 apps/classroom）：
 *   node --import tsx ../agent-engine/scripts/eval_sprint/c_judge_stability.mjs --dry-run
 *   node --import tsx ../agent-engine/scripts/eval_sprint/c_judge_stability.mjs \
 *       --from D:/.../plc课.json,D:/.../制造课.json --n 24 --budget 1
 *
 * 参数：--from 课程 json 路径（逗号分隔） / --ids 课号（配 --base-url 从线上取）
 *       --n 抽多少条（默认 24） / --judge 判官模型 / --budget 上限
 */
import path from 'node:path';
import {
  Budget,
  BudgetStop,
  VERDICTS,
  productJudgeSystem,
  arg,
  flag,
  list,
  loadApiKey,
  callModel,
  parseJsonObject,
  assertBlind,
  emit,
  shuffled,
  stamp,
  stripProxyEnv,
} from './common.mjs';
import { loadCourseFile, sampleLocalCourse, fetchCourse } from './course.mjs';

const ORDERS = [
  { id: 'orig', name: '原序', perm: [0, 1, 2] },
  { id: 'rev', name: '反序', perm: [2, 1, 0] },
  { id: 'rot', name: '轮转', perm: [1, 2, 0] },
];

function systemFor(order, { opts, strict }) {
  const body = order.perm.map((i) => opts[i].line).join('\n');
  return `你是独立的教学内容事实审核员。给你一条从课堂教学内容里抽出来的事实性断言，请判定它属于哪一档。

${body}
${strict}

只输出一个 JSON 对象，不要围栏不要解释：
{"verdict":"${VERDICTS.join('|')}","reason":"一句话理由"}`;
}

const BASE = arg('base-url', 'http://localhost:3210');
const FROM = list('from');
const IDS = list('ids');
const N = Number(arg('n', 24));
const JUDGE = arg('judge', 'MiniMaxAI/MiniMax-M2.5');
const DRY = flag('dry-run');
const BUDGET = Number(arg('budget', 1));
const SEED = Number(arg('seed', 20260823));

const BANNED = ['plc-s71200', 'smart-manufacturing', '原序', '反序', '轮转', '第 1 轮', '第 2 轮', '第 3 轮'];

/** Fleiss kappa：三轮当三个评分者，看一致性比随机高多少。 */
function fleissKappa(rows) {
  const n = rows.length;
  const raters = rows[0]?.length ?? 0;
  if (!n || raters < 2) return NaN;
  const counts = rows.map((r) => VERDICTS.map((v) => r.filter((x) => x === v).length));
  const pi = counts.map((c) => (c.reduce((a, b) => a + b * b, 0) - raters) / (raters * (raters - 1)));
  const pbar = pi.reduce((a, b) => a + b, 0) / n;
  const pj = VERDICTS.map((_, j) => counts.reduce((a, c) => a + c[j], 0) / (n * raters));
  const pe = pj.reduce((a, p) => a + p * p, 0);
  return pe === 1 ? 1 : (pbar - pe) / (1 - pe);
}

function collectClaims(courses) {
  const out = [];
  for (const { label, course } of courses) {
    for (const s of course.scenes || []) {
      for (const c of s.audit?.claims || []) {
        const text = String(c.claim || '').trim();
        if (text.length < 8) continue;
        out.push({ source: label, scene: s.title || '', claim: text, productVerdict: c.verdict || null });
      }
    }
  }
  return out;
}

async function main() {
  const killed = stripProxyEnv();
  const budget = new Budget(BUDGET, { dry: DRY });
  const apiKey = DRY ? null : loadApiKey();
  const ctx = { budget, apiKey };
  const spec = productJudgeSystem();

  console.log('=== C 判官新域校准 ===');
  console.log(`判官：${JUDGE}   三轮选项置换：${ORDERS.map((o) => o.name).join(' / ')}`);
  console.log(`成本上限：¥${BUDGET}${DRY ? '（dry-run，不发任何请求）' : ''}`);
  if (killed.length) console.log(`已剥代理变量：${killed.map((k) => k.split('=')[0]).join(', ')}`);
  console.log(`判定口径抠自产品 JUDGE_SYSTEM，三条选项原文：`);
  for (const o of spec.opts) console.log(`  ${o.line}`);

  const courses = [];
  for (const f of FROM) courses.push({ label: path.basename(f, '.json'), course: loadCourseFile(f) });
  for (const id of IDS) courses.push({ label: id, course: DRY ? null : await fetchCourse(BASE, id) });
  if (!courses.length) {
    const s = sampleLocalCourse();
    if (!s) throw new Error('没给 --from/--ids，本地也没有课程可用');
    courses.push({ label: path.basename(s.file, '.json'), course: s.course });
    console.log(`\n没指定来源，退回本地最新一门课：${s.file}`);
    console.log('  ⚠ 本地课程是主域的，真跑校准必须用 --from 指到制造侧课程，否则测的不是新域。');
  }

  const pool = collectClaims(courses.filter((c) => c.course));
  const picked = shuffled(pool, SEED).slice(0, N);
  console.log(`\n断言池 ${pool.length} 条，抽 ${picked.length} 条 × ${ORDERS.length} 轮 = ${picked.length * ORDERS.length} 次判定。`);
  if (picked.length < 20) console.log(`  ⚠ 只有 ${picked.length} 条，低于设计下限 20 条，结论要标注样本不足。`);

  const rows = [];
  let stopped = null;
  try {
    for (const order of ORDERS) {
      const system = systemFor(order, spec);
      const packed = picked.map((c, i) => ({
        sid: `S${String(i + 1).padStart(3, '0')}`,
        key: `${order.id}#${i}`,
        body: c.claim,
        message: `断言编号：S${String(i + 1).padStart(3, '0')}\n断言：${c.claim}\n\n请判定这一条。`,
      }));
      const check = assertBlind(packed, BANNED);
      console.log(
        `\n--- ${order.name}（选项顺序 ${order.perm.map((i) => spec.opts[i].verdict).join(' → ')}）---`,
      );
      console.log(`  盲评自检通过：${check.n} 条输入除断言正文外完全同形；轮次名不进输入。`);

      for (let i = 0; i < packed.length; i++) {
        const res = await callModel(
          { model: JUDGE, system, user: packed[i].message, tag: `判定-${order.id}`, maxTokens: 256 },
          ctx,
        );
        if (res.dry) {
          if (i === 0) console.log(`  [dry] 每条约 ${res.estIn} prompt token，本轮 ${packed.length} 条`);
          continue;
        }
        const v = String(parseJsonObject(res.text).verdict || '').trim();
        if (!VERDICTS.includes(v)) throw new Error(`判官回了个不认识的档：${v}`);
        rows.push({
          script: 'c_judge_stability',
          order: order.id,
          idx: i,
          source: picked[i].source,
          claim: picked[i].claim,
          productVerdict: picked[i].productVerdict,
          verdict: v,
        });
      }
    }
  } catch (err) {
    if (err instanceof BudgetStop) {
      stopped = err.message;
      console.log(`\n${err.message}`);
    } else throw err;
  }

  const md = reportMd(picked, rows, budget, stopped, spec);
  const name = `c_judge_stability-${stamp()}${DRY ? '-dryrun' : ''}`;
  const { jsonl, report } = emit(name, { rows, md });
  console.log(`\n明细 ${jsonl}\n报告 ${report}`);
  console.log(`\n${budget.markdown()}`);
}

function reportMd(picked, rows, budget, stopped, spec) {
  const perItem = picked.map((_, i) => ORDERS.map((o) => rows.find((r) => r.order === o.id && r.idx === i)?.verdict));
  const complete = perItem.filter((v) => v.every(Boolean));
  const allSame = complete.filter((v) => new Set(v).size === 1).length;
  const kappa = complete.length ? fleissKappa(complete) : NaN;

  const flip = new Map();
  for (const v of complete) {
    const k = [...new Set(v)].sort().join('/');
    flip.set(k, (flip.get(k) || 0) + 1);
  }

  return `# C 判官新域校准（${stamp()}）

${DRY ? '> **DRY-RUN 产物：一次请求都没发。** 一致性数字全是空的，只证明流程与自检跑得通。\n' : ''}${stopped ? `> 成本闸中途触发：${stopped}\n` : ''}
样本 ${picked.length} 条断言 × ${ORDERS.length} 轮选项置换；判官 ${arg('judge', 'MiniMaxAI/MiniMax-M2.5')}，temperature 0。
判定口径抠自 \`lib/generation/hallucination-audit.ts\` 的 \`JUDGE_SYSTEM\`，三条选项原文一字未改，
唯一被动的是它们在提示词里的先后顺序。

## 一、自稳性

| 指标 | 值 |
|---|---:|
| 三轮判齐的条数 | ${complete.length ? `${allSame}/${complete.length}（${((allSame / complete.length) * 100).toFixed(1)}%）` : '—'} |
| Fleiss κ（三轮当三个评分者） | ${Number.isFinite(kappa) ? kappa.toFixed(3) : '—'} |
| 有分歧的条数 | ${complete.length ? complete.length - allSame : '—'} |

分歧形态：

${flip.size ? [...flip.entries()].map(([k, n]) => `- ${k}：${n} 条`).join('\n') : '—'}

## 二、选项顺序

${ORDERS.map((o) => `- **${o.name}**：${o.perm.map((i) => spec.opts[i].verdict).join(' → ')}`).join('\n')}

## 三、盲

判官输入只有编号与断言正文。轮次名、库名不进输入（封锁词表强制）。
每一轮内部 ${picked.length} 条输入除断言正文外逐字同形；轮与轮之间**故意**只差选项顺序，那是自变量。

## 四、成本

${budget.markdown()}

## 五、没做到的

- 只测同一个判官的自稳性，不测判官之间的一致性，也不测判得对不对（那要真值集，是另一件事）。
- 断言不带原始资料，判的是"与领域公认知识一致否"这一档口径；产品线上判定是带证据的，两者不能直接比。
- 断言来源课程若不是制造侧的，这一轮就不算新域校准，报告里的来源字段要自己核。
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
