/**
 * D. 数字扰动检出率：拿 data/eval/numeric_perturbation_set.jsonl 的 100 对，
 *    出「三类扰动 × 旁路开/关」的两张率表。内部回归尺，不对外。
 *
 * 两档怎么来的：同一句只调一次判官，判官回来的断言池分两条路后处理——
 *   旁路关 = 判官原样的断言池
 *   旁路开 = 再过一遍产品的 `mergeNumericBypass`（原样 import，不改一行）
 * 所以两档共用一次调用，成本减半，而且两档之间除了那一层后处理再无别的差。
 *
 * 这不是整条产品链路的两档：线上 `mergeNumericBypass` 焊死在 hallucination-audit.ts:476，
 * 要在真链路上关掉它得加开关（报告里写了加在哪）。本脚本不碰产品代码。
 *
 * 跑法（cwd 必须是 apps/classroom）：
 *   node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --dry-run
 *   node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --n 100 --budget 1
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  Budget,
  BudgetStop,
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
  emit,
  stamp,
  stripProxyEnv,
} from './common.mjs';
import { productFns } from './course.mjs';

const SET = arg('set', path.join(ENGINE, 'data/eval/numeric_perturbation_set.jsonl'));
const N = Number(arg('n', 100));
const JUDGE = arg('judge', 'MiniMaxAI/MiniMax-M2.5');
const DRY = flag('dry-run');
const BUDGET = Number(arg('budget', 1));
const SKIP_ORIGINAL = flag('skip-original');

const BANNED = ['perturb', '扰动', '旁路', 'value_x2', 'unit_swap', 'consequence_flip', '原句', '扰动句'];

/**
 * 一条断言有没有盖住某个数字。
 * 比的是产品口径的「数值+单位」串（extractNumericClaims 已经去过空白），
 * 不是裸数字——裸数字会把章节号、序号也算成命中。
 */
function covers(claimText, numbers) {
  const flat = String(claimText || '').replace(/\s+/g, '');
  return numbers.some((n) => flat.includes(n));
}

/**
 * 一句话过一次判官，然后分两档后处理。
 * 命中判据：句子里的数字断言，有没有被一条 verdict 非 supported 的断言盖住。
 */
function scoreArms(sentence, judged) {
  const targets = productFns.extractNumericClaims(sentence);
  const bypass = productFns.mergeNumericBypass(judged, sentence, undefined, (claim, reason) => ({
    claim,
    verdict: 'uncertain',
    reason,
  }));

  const measure = (claims) => {
    let covered = 0;
    let flagged = 0;
    for (const t of targets) {
      const hit = claims.filter((c) => covers(c.claim, t.numbers));
      if (!hit.length) continue;
      covered += 1;
      if (hit.some((c) => c.verdict !== 'supported')) flagged += 1;
    }
    return { targets: targets.length, covered, flagged };
  };

  return {
    off: measure(judged),
    on: measure(bypass.claims),
    bypassAdded: bypass.added,
    bypassAbstained: bypass.abstained,
  };
}

function rate(rows, pick) {
  const t = rows.reduce((a, r) => a + pick(r).targets, 0);
  const f = rows.reduce((a, r) => a + pick(r).flagged, 0);
  const c = rows.reduce((a, r) => a + pick(r).covered, 0);
  return { targets: t, covered: c, flagged: f, detect: t ? f / t : null, coverage: t ? c / t : null };
}

async function main() {
  const killed = stripProxyEnv();
  const budget = new Budget(BUDGET, { dry: DRY });
  const apiKey = DRY ? null : loadApiKey();
  const ctx = { budget, apiKey };
  const system = productJudgeSystem().full;

  const pairs = readFileSync(SET, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .slice(0, N);

  const byType = {};
  for (const p of pairs) byType[p.perturbation_type] = (byType[p.perturbation_type] || 0) + 1;

  console.log('=== D 数字扰动检出率 ===');
  console.log(`数据集 ${SET}`);
  console.log(`${pairs.length} 对，扰动类型分布：${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`判官 ${JUDGE}；旁路两档共用同一次调用（关=判官原池，开=再过一遍 mergeNumericBypass）`);
  console.log(`成本上限：¥${BUDGET}${DRY ? '（dry-run，不发任何请求）' : ''}`);
  if (killed.length) console.log(`已剥代理变量：${killed.map((k) => k.split('=')[0]).join(', ')}`);

  const jobs = [];
  for (const [i, p] of pairs.entries()) {
    jobs.push({ idx: i, role: 'perturbed', type: p.perturbation_type, text: p.perturbed, sourceId: p.source_id });
    if (!SKIP_ORIGINAL) {
      jobs.push({ idx: i, role: 'original', type: p.perturbation_type, text: p.original, sourceId: p.source_id });
    }
  }
  console.log(
    `\n共 ${jobs.length} 次判官调用（扰动句 ${pairs.length}${SKIP_ORIGINAL ? '' : ` + 原句 ${pairs.length} 作误报对照`}）。`,
  );

  // 盲：句子打散编号送判，判官看不出这是原句还是扰动句、属于哪一类扰动。
  const packed = jobs.map((j, i) => ({
    sid: `S${String(i + 1).padStart(3, '0')}`,
    key: `${j.role}#${j.idx}`,
    body: j.text,
    message: `以下是一段课堂教学正文（编号 S${String(i + 1).padStart(3, '0')}）：\n\n${j.text}\n\n请按上面的口径抽取断言并逐条判定。`,
  }));
  const check = assertBlind(packed, BANNED);
  console.log(`盲评自检通过：${check.n} 条输入除正文外完全同形；原句/扰动句/扰动类型都不进输入。`);

  const rows = [];
  let stopped = null;
  try {
    for (let i = 0; i < jobs.length; i++) {
      const res = await callModel(
        { model: JUDGE, system, user: packed[i].message, tag: `判定-${jobs[i].role}`, maxTokens: 1024 },
        ctx,
      );
      if (res.dry) {
        if (i === 0) console.log(`  [dry] 每条约 ${res.estIn} prompt token，共 ${jobs.length} 条`);
        continue;
      }
      let judged = [];
      // 判官没给出可解析的回复，与「判官看了但没检出」是两回事。
      // 混在一起算，工具的毛病会被算成产品的漏检——检出率被压低而没人看得出来。
      // 所以单记一格，报告里分开统计、也从检出率的分母里剔除。
      let parseFailed = false;
      try {
        const o = parseJsonObject(res.text);
        judged = (o.claims || [])
          .filter((c) => c && typeof c.claim === 'string' && VERDICTS.includes(c.verdict))
          .map((c) => ({ claim: c.claim, verdict: c.verdict, reason: String(c.reason || '') }));
      } catch (e) {
        parseFailed = true;
        console.log(`  ${packed[i].sid} 判官回复解析不了（不计入检出率分母）：${e.message}`);
      }
      const scored = scoreArms(jobs[i].text, judged);
      rows.push({
        script: 'd_numeric_perturbation',
        ...jobs[i],
        judgedClaims: judged.length,
        parseFailed,
        ...scored,
      });
      if ((i + 1) % 10 === 0) console.log(`  已跑 ${i + 1}/${jobs.length}，累计 ¥${budget.spent.toFixed(4)}`);
    }
  } catch (err) {
    if (err instanceof BudgetStop) {
      stopped = err.message;
      console.log(`\n${err.message}`);
    } else throw err;
  }

  const name = `d_numeric_perturbation-${stamp()}${DRY ? '-dryrun' : ''}`;
  const { jsonl, report } = emit(name, { rows, md: reportMd(byType, rows, budget, stopped) });
  console.log(`\n明细 ${jsonl}\n报告 ${report}`);
  console.log(`\n${budget.markdown()}`);
}

function reportMd(byType, rows, budget, stopped) {
  const types = Object.keys(byType);
  // 解析失败的样本一律剔出率的计算：它们是工具没拿到答案，不是产品没检出。
  const usable = rows.filter((r) => !r.parseFailed);
  const failed = rows.length - usable.length;
  const pert = usable.filter((r) => r.role === 'perturbed');
  const orig = usable.filter((r) => r.role === 'original');

  const line = (label, rs) => {
    const off = rate(rs, (r) => r.off);
    const on = rate(rs, (r) => r.on);
    const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
    return `| ${label} | ${rs.length} | ${off.targets} | ${pct(off.coverage)} | ${pct(off.detect)} | ${pct(
      on.coverage,
    )} | ${pct(on.detect)} |`;
  };

  const detectVals = pert.map((r) => (r.on.targets ? r.on.flagged / r.on.targets : 0));
  const boot = detectVals.length ? bootstrapCoverage(detectVals, 0.5) : null;

  return `# D 数字扰动检出率（${stamp()}）

${DRY ? '> **DRY-RUN 产物：一次请求都没发。** 率表全空，只证明流程、盲评自检、两档后处理跑得通。\n' : ''}${stopped ? `> 成本闸中途触发：${stopped}\n` : ''}
数据集 \`data/eval/numeric_perturbation_set.jsonl\`，类型分布 ${types.map((t) => `${t}=${byType[t]}`).join('、')}。
**类型极不均衡**（value_x2 占绝大多数，unit_swap 与 consequence_flip 各不到十条），小格子的点估计不能单独看。

判官回复解析失败 **${failed}/${rows.length}** 条，已从下面所有率的分母里剔除。
这些是判官没吐出可解析的 JSON（实测有一次它反过来说「你没给我正文」），
属于工具没拿到答案，**不是产品没检出**——混进分母会把工具的毛病算成漏检。

## 一、扰动句：三类 × 旁路开/关

| 扰动类型 | 句数 | 数字断言 | 覆盖率(旁路关) | 检出率(旁路关) | 覆盖率(旁路开) | 检出率(旁路开) |
|---|---:|---:|---:|---:|---:|---:|
${types.map((t) => line(t, pert.filter((r) => r.type === t))).join('\n')}
${line('**合计**', pert)}

${
  boot
    ? `自助重抽（2000 次，判据线 0.5）：${(boot.coverage * 100).toFixed(1)}% 的重抽落在线以上，n=${boot.n}。`
    : ''
}

## 二、原句对照（误报）

| 口径 | 句数 | 数字断言 | 覆盖率(旁路关) | 误标率(旁路关) | 覆盖率(旁路开) | 误标率(旁路开) |
|---|---:|---:|---:|---:|---:|---:|
${orig.length ? line('原句', orig) : '| 原句 | 0 | — | — | — | — | — |'}

原句这一行是必须的：只看扰动句的检出率，把所有句子都标成"存疑"也能拿满分。

## 三、这两个数各是什么意思

- **覆盖率** = 句子里的数字断言，有几条被断言池里的某一条盖住。旁路真正改变的是这个量。
- **检出率** = 被盖住 **且** 判定不是 supported 的比例。
- 旁路补进来的断言一律 \`uncertain\`，reason 里写着"正则旁路补入"。
  它的意思是"这条没被真正判过"，不是"这条错了"——所以旁路开的检出率天然不低于关，
  这不是判得更准，是**漏判被标出来了**。报告里不许把它读成准确率提升。

## 四、要在真链路上关掉旁路，开关加在哪

\`lib/generation/hallucination-audit.ts:476\` —— \`ruleOnClaims\` 里那句 \`return mergeNumericBypass(...)\`。
加一个 env（比如 \`NUMERIC_BYPASS\`），只在显式设成 \`0\` 时跳过合并、直接返回 \`judged\`，
**默认必须保持"开"**。本脚本没有走这条真链路：它自己调判官、自己分两档后处理，
所以量到的是那一层后处理的边际效果，不是整条链的两档差。

## 五、成本

${budget.markdown()}

## 六、没做到的

- 扰动集是程序化生成的（\`build_numeric_perturbation_set.py\`），\`value_x2\` 里可能混着"翻倍之后仍然正确"的句子，
  这部分会被算成漏检。要更准得人工过一遍标真值。
- 判官单跑，没有仲裁没有第二轮，与线上审核链不是一个东西。这是内部回归尺，不对外报。
`;
}

/** 两档后处理的自检：dry-run 不会真调判官，这一层逻辑得有别的东西盯着。 */
function selftest() {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`自检失败：${msg}`);
    console.log(`  ok  ${msg}`);
  };
  const sentence = '扫描周期超过 150 毫秒就停机，余量留 70 毫秒。';

  const blind = scoreArms(sentence, []);
  ok(blind.off.targets > 0, `句子里认出 ${blind.off.targets} 条数字断言`);
  ok(blind.off.covered === 0 && blind.off.flagged === 0, '判官一条没抽到时，旁路关这档覆盖 0');
  ok(blind.on.covered === blind.on.targets, '旁路开把没被判过的数字全补上了');
  ok(blind.on.flagged === blind.on.targets, '旁路补的一律 uncertain，算进"标出来了"');

  const judgedSupported = [
    { claim: '扫描周期超过 150 毫秒就停机，余量留 70 毫秒。', verdict: 'supported', reason: '' },
  ];
  const hit = scoreArms(sentence, judgedSupported);
  ok(hit.off.covered === hit.off.targets, '判官抽到了，旁路关这档也算覆盖');
  ok(hit.off.flagged === 0, 'supported 不算检出');
  ok(hit.bypassAdded === 0, '判官已经覆盖同一组数字时，旁路不重复补');

  console.log('\nd_numeric_perturbation 两档后处理自检全过。');
}

if (flag('selftest')) selftest();
else
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
