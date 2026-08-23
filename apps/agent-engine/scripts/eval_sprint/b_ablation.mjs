/**
 * B. 消融爬升：同一需求同一域，四档逐级加东西，判官盲评四维，出爬升表。
 *
 *   档 0 裸生成    关审核门 + 关蓝图 + 关模板池（讲义走六类兜底）
 *   档 1 +模板池   打开讲义场景与版式槽位
 *   档 2 +审核门   打开判官团审核
 *   档 3 +蓝图连贯 打开课程级三表（当前产品默认形态）
 *
 * 开关**只用现成的 env**，缺的不自己加。缺哪个、该加在哪，脚本会在盘上现查现报
 * （`process.env.<NAME>` 在产品代码里搜不到就算没有），报告里照抄那几行给人去加。
 *
 * 分两步跑，因为 env 是服务端进程的，脚本改不了：
 *   ① 每档一次，服务端按脚本打印的 env 起好，再跑 `--rung N` 生成那一档的课
 *   ② 四档齐了跑 `--judge`，一次性盲评（判官必须同时看到四档才谈得上同批可比）
 *
 * 跑法（cwd 必须是 apps/classroom）：
 *   node --import tsx ../agent-engine/scripts/eval_sprint/b_ablation.mjs --dry-run
 *   node --import tsx ../agent-engine/scripts/eval_sprint/b_ablation.mjs --rung 3
 *   node --import tsx ../agent-engine/scripts/eval_sprint/b_ablation.mjs --judge
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  Budget,
  BudgetStop,
  EVIDENCE,
  arg,
  flag,
  list,
  loadApiKey,
  callModel,
  parseRubric,
  rubricSystem,
  blindPack,
  assertBlind,
  emit,
  readJsonlIfExists,
  stamp,
  stripProxyEnv,
  CLASSROOM,
  RUBRIC_DIMS,
} from './common.mjs';
import {
  generateCourse,
  fetchCourse,
  loadCourseFile,
  sampleLocalCourse,
  courseBody,
  allReadings,
  estCourseCost,
} from './course.mjs';

/**
 * 四档要的开关。`env` 里 null 表示"用产品默认"，字符串表示要显式设。
 * `needs` 列的是本档必须能关掉的东西——现成 env 关不掉的，标出来等人加。
 */
const RUNGS = [
  {
    id: 0,
    name: '裸生成',
    env: { LECTURE_SCENE_MODE: '0', SLIDE_TEMPLATE_MODE: '0', AUDIT_GATE: '0', COURSE_COHERENCE: '0' },
  },
  {
    id: 1,
    name: '+模板池',
    env: { LECTURE_SCENE_MODE: null, SLIDE_TEMPLATE_MODE: null, AUDIT_GATE: '0', COURSE_COHERENCE: '0' },
  },
  {
    id: 2,
    name: '+审核门',
    env: { LECTURE_SCENE_MODE: null, SLIDE_TEMPLATE_MODE: null, AUDIT_GATE: null, COURSE_COHERENCE: '0' },
  },
  {
    id: 3,
    name: '+蓝图连贯',
    env: { LECTURE_SCENE_MODE: null, SLIDE_TEMPLATE_MODE: null, AUDIT_GATE: null, COURSE_COHERENCE: null },
  },
];

/** 缺开关时该加在哪——写死的坐标，报告直接照抄，不让人再去找一遍。 */
const MISSING_HINTS = {
  AUDIT_GATE:
    'lib/server/classroom-generation.ts:663 的 `auditAndBuildScene`（整课路）与 ' +
    'app/api/generate/scene-audit/route.ts:62（逐屏路）：两处都在调 auditSceneContent 之前判一下，' +
    '关掉时原样返回 content 且不写 scene.audit。默认必须保持"开"。',
  COURSE_COHERENCE:
    'lib/server/classroom-generation.ts:600（frame = courseFrameFromOutlines）与 :879（coherenceDirective 拼进提示词），' +
    '以及 app/api/generate/scene-content/route.ts:274（coherenceFromOutlines）：关掉时不拼那段指令。默认必须保持"开"。',
};

const BASE = arg('base-url', 'http://localhost:3210');
const DOMAIN = arg('domain', 'ai');
const REQUIREMENT = arg('requirement', '我想搞懂注意力机制到底是怎么算出来的');
const RUNG = arg('rung') == null ? null : Number(arg('rung'));
const DO_JUDGE = flag('judge');
const DRY = flag('dry-run');
const BUDGET = Number(arg('budget', 3));
const JUDGES = list('judges', ['MiniMaxAI/MiniMax-M2.5']);
const MAX_BODY = Number(arg('max-body-chars', 24000));
const SEED = Number(arg('seed', 20260823));
const FORCE = flag('force');
const SERVER_LOG = arg('server-log') ? readFileSync(arg('server-log'), 'utf8') : '';

const BANNED = ['裸生成', '模板池', '审核门', '蓝图连贯', 'rung', '档 0', '档 1', '档 2', '档 3', 'ablation'];

/** 开关在不在盘上：产品代码里搜得到 `process.env.<NAME>` 才算有。 */
function switchExists(name) {
  const roots = ['lib', 'app', 'components'].map((d) => path.join(CLASSROOM, d));
  const needle = `process.env.${name}`;
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) stack.push(p);
      } else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) {
        if (readFileSync(p, 'utf8').includes(needle)) return path.relative(CLASSROOM, p);
      }
    }
  }
  return null;
}

function rungPlan() {
  const seen = new Map();
  return RUNGS.map((r) => {
    const rows = Object.entries(r.env).map(([k, v]) => {
      if (!seen.has(k)) seen.set(k, switchExists(k));
      return { name: k, value: v, at: seen.get(k), ready: Boolean(seen.get(k)) || v === null };
    });
    return { ...r, switches: rows, ready: rows.every((x) => x.ready) };
  });
}

function envLine(rung) {
  const sets = rung.switches.filter((s) => s.value !== null).map((s) => `${s.name}=${s.value}`);
  return sets.length ? sets.join(' ') : '(全用产品默认，不设任何 env)';
}

function rungFile(id) {
  return path.join(EVIDENCE, `b_ablation-rung${id}.jsonl`);
}

async function main() {
  const killed = stripProxyEnv();
  const budget = new Budget(BUDGET, { dry: DRY });
  const apiKey = DRY || !DO_JUDGE ? null : loadApiKey();
  const ctx = { budget, apiKey };
  const plan = rungPlan();

  console.log('=== B 消融爬升 ===');
  console.log(`目标服务：${BASE}   域：${DOMAIN}   需求：「${REQUIREMENT}」`);
  console.log(`成本上限：¥${BUDGET}${DRY ? '（dry-run，不发任何请求）' : ''}`);
  if (killed.length) console.log(`已剥代理变量：${killed.map((k) => k.split('=')[0]).join(', ')}`);

  console.log('\n四档与它们要的开关（现查盘）：');
  for (const r of plan) {
    const done = readJsonlIfExists(rungFile(r.id)).length;
    console.log(`  档 ${r.id} ${r.name.padEnd(10)} ${r.ready ? '可跑' : '缺开关'}   已跑 ${done} 门`);
    console.log(`      服务端起进程时设：${envLine(r)}`);
    for (const s of r.switches) {
      if (s.value === null) continue;
      console.log(
        `      ${s.name.padEnd(18)} ${s.at ? `现成，见 ${s.at}` : '**没有这个开关**，要加：' + MISSING_HINTS[s.name]}`,
      );
    }
  }

  const runnable = plan.filter((r) => r.ready).length;
  console.log(
    `\n四档全跑预计 ¥${(RUNGS.length * estCourseCost()).toFixed(3)}（每档一门 × ≈¥${estCourseCost().toFixed(3)}）；` +
      `今天现成开关只够跑 ${runnable} 档，其余等开关补上。`,
  );

  const rows = [];
  let stopped = null;
  const sample = DRY ? sampleLocalCourse() : null;

  try {
    // ---- ① 生成某一档 ----
    if (RUNG != null || DRY) {
      const targets = RUNG != null ? plan.filter((r) => r.id === RUNG) : plan;
      for (const r of targets) {
        if (!r.ready && !FORCE) {
          console.log(`\n档 ${r.id}「${r.name}」缺开关，跳过。开关加好再跑，或 --force 明知故犯。`);
          continue;
        }
        console.log(`\n--- 生成 档 ${r.id} ${r.name} ---`);
        console.log(`  预计 ≈¥${estCourseCost().toFixed(3)}`);
        const g = await generateCourse({
          baseUrl: BASE,
          requirement: REQUIREMENT,
          profile: { corpus: DOMAIN, domain: DOMAIN, education: 'bachelor', role: '转型学习者' },
          budget,
        });
        const course = DRY ? sample?.course ?? null : await fetchCourse(BASE, g.classroomId);
        const readings = course ? allReadings(course, SERVER_LOG) : null;
        const row = {
          script: 'b_ablation',
          rung: r.id,
          rungName: r.name,
          domain: DOMAIN,
          requirement: REQUIREMENT,
          env: envLine(r),
          classroomId: g.classroomId,
          dry: DRY,
          readings,
        };
        rows.push(row);
        if (!DRY) emit(`b_ablation-rung${r.id}`, { rows: [row], md: '' });
        if (readings) {
          console.log(
            `  读数：蓝图三表 ${readings.blueprint.tablesFilled}/3，类比漂移 ${readings.blueprint.analogyDrift}，` +
              `断言 ${readings.audit.totalClaims}，脚手架残留 ${readings.scaffold.residualLeaks}`,
          );
        }
      }
    }

    // ---- ② 四档齐了一起盲评 ----
    if (DO_JUDGE || DRY) {
      const done = DRY
        ? plan.map((r) => ({ rung: r.id, rungName: r.name, classroomId: null }))
        : plan.flatMap((r) => readJsonlIfExists(rungFile(r.id)));
      console.log(`\n--- 盲评：手上有 ${done.length} 档 ---`);
      if (!DRY && done.length < 2) {
        console.log('  少于两档没什么好比的，先把各档跑出来。');
      } else {
        const items = [];
        for (const d of done) {
          const course =
            DRY && sample
              ? sample.course
              : d.classroomId?.endsWith('.json')
                ? loadCourseFile(d.classroomId)
                : await fetchCourse(BASE, d.classroomId);
          items.push({ key: `rung${d.rung}`, body: courseBody(course, { maxChars: MAX_BODY }) });
          if (!rows.find((r) => r.rung === d.rung)) rows.push({ ...d, script: 'b_ablation', dry: DRY });
        }
        const { entries } = blindPack(items, SEED);
        const system = rubricSystem();
        const packed = entries.map((e) => ({
          ...e,
          message: `样本编号：${e.sid}\n以下是这门课的全部教学正文。\n\n${e.body}\n\n请按四个维度打分。`,
        }));
        const check = assertBlind(packed, BANNED);
        console.log(
          `  盲评自检通过：${check.n} 份输入除正文外完全同形（骨架 ${check.skeletonChars} 字符），` +
            `档位名一个都没漏进去。`,
        );
        for (const e of packed) {
          for (const model of JUDGES) {
            const res = await callModel({ model, system, user: e.message, tag: '判官盲评', maxTokens: 512 }, ctx);
            if (res.dry) {
              console.log(`  [dry] ${e.sid} → ${model}：约 ${res.estIn} prompt token`);
              continue;
            }
            const score = parseRubric(res.text);
            const row = rows.find((r) => `rung${r.rung}` === e.key);
            row.scores = { ...(row.scores || {}), [model]: score };
            console.log(`  ${e.sid} → ${model}：${RUBRIC_DIMS.map(([k]) => `${k}=${score[k]}`).join(' ')}`);
          }
        }
      }
    }

    if (RUNG == null && !DO_JUDGE && !DRY) {
      console.log('\n没指定动作。要么 --rung N 跑一档，要么 --judge 盲评已有档，要么 --dry-run 看计划。');
    }
  } catch (err) {
    if (err instanceof BudgetStop) {
      stopped = err.message;
      console.log(`\n${err.message}`);
    } else throw err;
  }

  const name = `b_ablation-${stamp()}${DRY ? '-dryrun' : ''}`;
  const { jsonl, report } = emit(name, { rows, md: reportMd(plan, rows, budget, stopped) });
  console.log(`\n明细 ${jsonl}\n报告 ${report}`);
  console.log(`\n${budget.markdown()}`);
}

function reportMd(plan, rows, budget, stopped) {
  const dims = RUBRIC_DIMS;
  const ladder = plan.map((r) => {
    const row = rows.find((x) => x.rung === r.id);
    const cells = dims.map(([k]) => {
      const xs = Object.values(row?.scores || {}).map((s) => s[k]).filter(Number.isFinite);
      return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '—';
    });
    const b = row?.readings?.blueprint;
    const a = row?.readings?.audit;
    return `| ${r.id} | ${r.name} | ${r.ready ? '现成开关够' : '缺开关'} | ${cells.join(' | ')} | ${
      b ? `${b.tablesFilled}/3` : '—'
    } | ${a?.totalClaims ?? '—'} |`;
  });

  const missing = plan
    .flatMap((r) => r.switches.filter((s) => s.value !== null && !s.at).map((s) => ({ rung: r.id, ...s })))
    .filter((v, i, arr) => arr.findIndex((x) => x.name === v.name) === i);

  return `# B 消融爬升（${stamp()}）

${DRY ? '> **DRY-RUN 产物：一次请求都没发。** 分值列全是空的，读数来自本地替身课程，只证明流程跑得通。\n' : ''}${stopped ? `> 成本闸中途触发：${stopped}\n` : ''}
域 ${arg('domain', 'ai')}，需求「${REQUIREMENT}」，四档同一条需求、同一个库、同一个判官口径。

## 一、爬升表

| 档 | 加了什么 | 开关 | ${dims.map(([, l]) => l).join(' | ')} | 蓝图三表 | 断言数 |
|---:|---|---|${dims.map(() => '---:').join('|')}|---:|---:|
${ladder.join('\n')}

## 二、每档靠什么开关

${plan
  .map(
    (r) =>
      `- **档 ${r.id} ${r.name}**：服务端起进程时设 \`${envLine(r)}\`` +
      r.switches
        .filter((s) => s.value !== null)
        .map((s) => `\n  - \`${s.name}\` ${s.at ? `现成（${s.at}）` : '**缺**'}`)
        .join(''),
  )
  .join('\n')}

${
  missing.length
    ? `### 还缺的开关（由人来加，脚本不碰产品代码）\n\n${missing
        .map((m) => `- \`${m.name}\`：${MISSING_HINTS[m.name]}`)
        .join('\n')}\n\n加之前提醒一句：**默认行为必须一个字不改**，开关只在显式设成 0 时改路径。`
    : '现成开关已经够跑满四档。'
}

## 三、盲评怎么保证真盲

判官输入只有编号与正文，档位名（裸生成 / +模板池 / +审核门 / +蓝图连贯）、rung 字样、批次名
全在封锁词表里，出现一次就抛。四档同批洗牌后一起送判，顺序由固定种子 ${SEED} 决定，可复算。

## 四、成本

${budget.markdown()}

## 五、没做到的

- 每档只跑一门课，判官分是单点，看不出生成随机性。要下结论至少每档三门取均值（预算翻三倍）。
- 服务端 env 得人工重起进程，脚本管不了；跑错档的风险靠产物里记的 \`env\` 字段事后对账。
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
