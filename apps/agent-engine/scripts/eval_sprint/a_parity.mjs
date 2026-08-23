/**
 * A. 质量齐平线对照：主域（ai）与制造侧两个库（smart-manufacturing / plc-s71200）
 *    各取同难度需求各生成一门课，统一 rubric 四维盲评，出「差多少、差在哪个维度」。
 *
 * 这一轮同时是三样东西在泛化域的实效验证，三样读数各自单列，不揉成一个总分：
 *   · 蓝图三表（course-coherence 的 courseFrameFromOutlines）
 *   · 数字旁路（numeric-claims 的 mergeNumericBypass，读落盘 audit.claims 里的旁路标记）
 *   · 脚手架清除（adaptation-lint 的 scrubScaffoldHtml）
 *
 * 两种形态：
 *   默认            —— 生成 + 判官团盲评 + 三读数
 *   --no-judge-panel —— 只生成 1–2 门对照课，不开判官团，只出三读数 + 审核链自带读数
 *
 * 跑法（cwd 必须是 apps/classroom）：
 *   cd "D:/UserData/Desktop/挑战杯/apps/classroom"
 *   node --import tsx ../agent-engine/scripts/eval_sprint/a_parity.mjs --dry-run
 *   node --import tsx ../agent-engine/scripts/eval_sprint/a_parity.mjs --no-judge-panel --budget 2
 *
 * 主要参数：
 *   --base-url <url>     默认 http://localhost:3210；制造侧两个库在服务器上，跑它们要指到线上
 *   --groups a,b,c       默认 ai,smart-manufacturing,plc-s71200
 *   --slots 1,2,3        需求槽位，默认 1,2
 *   --judges m1,m2       判官模型，默认单判官
 *   --budget <元>        成本上限，默认 3
 *   --courses <json>     复用已生成的课：{"ai/1":"课号或本地json路径", ...}，跳过生成只重判
 *   --server-log <path>  服务端日志，用来数 [脚手架清除] 真删了几条
 */
import { readFileSync } from 'node:fs';
import {
  Budget,
  BudgetStop,
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
  mean,
  sd,
  stamp,
  stripProxyEnv,
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

// 同难度需求：按任务型别配对（概念 / 落地 / 排障），三个域同槽位同型别同长度量级。
// 「同难度」是按任务型别配的，不是按测过的难度量表配的——这一条写进报告，别当量表用。
const SLOTS = {
  1: {
    kind: '概念',
    ai: '我想搞懂注意力机制到底是怎么算出来的',
    'smart-manufacturing': '我想搞懂机械臂的正运动学到底是怎么算出来的',
    'plc-s71200': '我想搞懂 S7-1200 的高速计数器到底是怎么工作的',
  },
  2: {
    kind: '落地',
    ai: '我要把检索增强接进现有的问答服务，该怎么动手',
    'smart-manufacturing': '我要把视觉检测接进现有的装配工位，该怎么动手',
    'plc-s71200': '我要用 S7-1200 做一套三层料仓的启停联锁，该怎么动手',
  },
  3: {
    kind: '排障',
    ai: '我的检索问答老是答非所问，怎么一步步定位',
    'smart-manufacturing': '产线节拍老是掉，怎么一步步定位',
    'plc-s71200': 'PLC 的扫描周期忽长忽短，怎么一步步定位',
  },
};

const PROFILES = {
  ai: { corpus: 'ai', domain: 'ai', education: 'bachelor', role: '转型学习者' },
  'smart-manufacturing': {
    corpus: 'smart-manufacturing',
    domain: 'smart-manufacturing',
    education: 'bachelor',
    role: '转型学习者',
  },
  'plc-s71200': { corpus: 'plc-s71200', domain: 'plc-s71200', education: 'bachelor', role: '转型学习者' },
};

// 盲评封锁词：库名、组别名、批次名。**不含 "ai" 这两个字母**——
// 正文讲的是什么域，读正文本来就看得出来，那是内容属性不是元数据泄漏；
// 这里堵的是「哪一组、哪个库、哪一批」这类只有实验者该知道的标识。
const BANNED = [
  'plc-s71200',
  's7-1200 组',
  'smart-manufacturing',
  'eval_sprint',
  'eval-sprint',
  '齐平线',
  '对照组',
  '主域',
  '制造域',
  'slot',
];

const BASE = arg('base-url', 'http://localhost:3210');
const GROUPS = list('groups', ['ai', 'smart-manufacturing', 'plc-s71200']);
const SLOT_IDS = list('slots', ['1', '2']);
const JUDGES = list('judges', ['MiniMaxAI/MiniMax-M2.5']);
const NO_PANEL = flag('no-judge-panel');
const DRY = flag('dry-run');
const BUDGET = Number(arg('budget', 3)); // 默认保守；dry-run 也走同一道闸，好看出计划会不会撞上限
const MAX_BODY = Number(arg('max-body-chars', 24000));
const SEED = Number(arg('seed', 20260823));
const REUSE = arg('courses') ? JSON.parse(readFileSync(arg('courses'), 'utf8')) : {};
const SERVER_LOG = arg('server-log') ? readFileSync(arg('server-log'), 'utf8') : '';

async function main() {
  const killed = stripProxyEnv();
  const budget = new Budget(BUDGET, { dry: DRY });
  const apiKey = DRY ? null : loadApiKey();
  const ctx = { budget, apiKey };

  const plan = [];
  for (const slot of SLOT_IDS) {
    for (const g of GROUPS) {
      const req = SLOTS[slot]?.[g];
      if (!req) throw new Error(`槽位 ${slot} 没有 ${g} 的需求，检查 --slots/--groups`);
      plan.push({ key: `${g}/${slot}`, group: g, slot, kind: SLOTS[slot].kind, requirement: req });
    }
  }

  console.log('=== A 质量齐平线对照 ===');
  console.log(`目标服务：${BASE}`);
  console.log(`形态：${NO_PANEL ? '省钱形态（不开判官团，只读审核链自带读数）' : `判官团盲评（${JUDGES.join(' + ')}）`}`);
  console.log(`成本上限：¥${BUDGET}${DRY ? '（dry-run，不发任何请求）' : ''}`);
  if (killed.length) console.log(`已剥代理变量：${killed.map((k) => k.split('=')[0]).join(', ')}`);
  console.log(`\n计划 ${plan.length} 门课：`);
  for (const p of plan) {
    const reused = REUSE[p.key];
    console.log(
      `  ${p.key.padEnd(26)} [${p.kind}] ${reused ? `复用 ${reused}` : '现生成'}  「${p.requirement}」`,
    );
  }
  const genCount = plan.filter((p) => !REUSE[p.key]).length;
  console.log(
    `\n预计花费：生成 ${genCount} 门 × ≈¥${estCourseCost().toFixed(3)} = ¥${(genCount * estCourseCost()).toFixed(3)}` +
      (NO_PANEL ? '；判官团不开，0 元。' : `；盲评 ${plan.length} 份 × ${JUDGES.length} 判官。`),
  );

  const rows = [];
  let stopped = null;
  const sample = DRY ? sampleLocalCourse() : null;
  if (DRY && !sample) console.log('\n[dry-run] 本地没有可用的替身课程，读数环节只能空转。');
  if (DRY && sample) console.log(`\n[dry-run] 读数环节用替身课程走通：${sample.file}`);

  try {
    for (const p of plan) {
      console.log(`\n--- ${p.key} ---`);
      let course = null;
      let classroomId = REUSE[p.key] || null;

      if (classroomId && classroomId.endsWith('.json')) {
        course = loadCourseFile(classroomId);
      } else if (classroomId) {
        console.log(`  复用课号 ${classroomId}，取课…`);
        course = DRY ? sample?.course ?? null : await fetchCourse(BASE, classroomId);
      } else {
        console.log(`  生成：${p.requirement}`);
        const r = await generateCourse({
          baseUrl: BASE,
          requirement: p.requirement,
          profile: PROFILES[p.group],
          budget,
        });
        classroomId = r.classroomId;
        course = DRY ? sample?.course ?? null : await fetchCourse(BASE, classroomId);
        if (!DRY) console.log(`  课号 ${classroomId}，耗时 ${(r.ms / 1000 / 60).toFixed(1)} 分钟`);
      }

      const readings = course ? allReadings(course, SERVER_LOG) : null;
      if (readings) {
        console.log(
          `  读数：蓝图三表填了 ${readings.blueprint.tablesFilled}/3，类比漂移 ${readings.blueprint.analogyDrift}；` +
            `旁路补 ${readings.numeric.bypassAdded}（弃权 ${readings.numeric.bypassAbstained}）；` +
            `脚手架残留 ${readings.scaffold.residualLeaks}/${readings.scaffold.textBlocks} 块`,
        );
      }
      rows.push({
        script: 'a_parity',
        key: p.key,
        group: p.group,
        slot: p.slot,
        kind: p.kind,
        requirement: p.requirement,
        classroomId,
        dry: DRY,
        readings,
        scores: null,
      });
    }

    // ---- 判官团盲评：正文打散、编号化、同形自检之后才发出去 ----
    if (!NO_PANEL) {
      // 正文这时候才取一次，不把 course 对象挂在 rows 上（那会让明细文件涨到几十兆）。
      const items = [];
      for (const r of rows.filter((x) => x.readings)) {
        const course =
          DRY && sample
            ? sample.course
            : r.classroomId?.endsWith('.json')
              ? loadCourseFile(r.classroomId)
              : await fetchCourse(BASE, r.classroomId);
        items.push({ key: r.key, body: courseBody(course, { maxChars: MAX_BODY }) });
      }

      const { entries } = blindPack(items, SEED);
      const system = rubricSystem();
      const packed = entries.map((e) => ({
        ...e,
        message: `样本编号：${e.sid}\n以下是这门课的全部教学正文。\n\n${e.body}\n\n请按四个维度打分。`,
      }));
      const check = assertBlind(packed, BANNED);
      console.log(
        `\n盲评自检通过：${check.n} 份输入除正文外完全同形（骨架 ${check.skeletonChars} 字符），` +
          `封锁词 ${BANNED.length} 个一个都没出现。`,
      );

      for (const e of packed) {
        for (const model of JUDGES) {
          const res = await callModel(
            { model, system, user: e.message, tag: '判官盲评', maxTokens: 512 },
            ctx,
          );
          const row = rows.find((r) => r.key === e.key);
          if (res.dry) {
            console.log(`  [dry] ${e.sid} → ${model}：约 ${res.estIn} prompt token`);
            continue;
          }
          const score = parseRubric(res.text);
          row.scores = { ...(row.scores || {}), [model]: score };
          console.log(`  ${e.sid} → ${model}：${RUBRIC_DIMS.map(([k]) => `${k}=${score[k]}`).join(' ')}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof BudgetStop) {
      stopped = err.message;
      console.log(`\n${err.message}`);
    } else throw err;
  }

  const name = `a_parity-${stamp()}${DRY ? '-dryrun' : ''}`;
  const { jsonl, report } = emit(name, { rows, md: report_md(rows, budget, stopped) });
  console.log(`\n明细 ${jsonl}\n报告 ${report}`);
  console.log(`\n${budget.markdown()}`);
}

function report_md(rows, budget, stopped) {
  const dims = RUBRIC_DIMS.map(([k, label]) => ({ k, label }));
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r);
  }

  const scoreRows = [];
  for (const [g, rs] of byGroup) {
    const cells = dims.map(({ k }) => {
      const xs = rs.flatMap((r) => Object.values(r.scores || {}).map((s) => s[k])).filter(Number.isFinite);
      return xs.length ? `${mean(xs).toFixed(2)}±${sd(xs).toFixed(2)}` : '—';
    });
    scoreRows.push(`| ${g} | ${rs.length} | ${cells.join(' | ')} |`);
  }

  const readingRows = rows.map((r) => {
    const b = r.readings?.blueprint;
    const n = r.readings?.numeric;
    const s = r.readings?.scaffold;
    const a = r.readings?.audit;
    return (
      `| ${r.key} | ${r.kind} | ${b ? `${b.tablesFilled}/3` : '—'} | ${b?.analogyDrift ?? '—'} | ` +
      `${b?.duplicateNumericExamples ?? '—'} | ${n?.bypassAdded ?? '—'} | ${n?.bypassAbstained ?? '—'} | ` +
      `${n?.numericCoverage == null ? '—' : (n.numericCoverage * 100).toFixed(1) + '%'} | ` +
      `${s ? `${s.residualLeaks}/${s.textBlocks}` : '—'} | ${s?.rescrubDropped ?? '—'} | ` +
      `${a?.totalClaims ?? '—'} | ${a?.supportedRate == null ? '—' : (a.supportedRate * 100).toFixed(1) + '%'} |`
    );
  });

  return `# A 质量齐平线对照（${stamp()}）

${DRY ? '> **DRY-RUN 产物：一次请求都没发。** 表里的读数来自本地替身课程，只证明流程跑得通，不是结论。\n' : ''}${stopped ? `> 成本闸中途触发：${stopped}\n` : ''}
样本量：${rows.length} 门课，分组 ${[...byGroup.keys()].join(' / ')}。${NO_PANEL ? '本轮未开判官团（省钱形态）。' : `判官 ${JUDGES.join(' + ')}。`}

## 一、四维盲评

| 组 | n | ${dims.map((d) => d.label).join(' | ')} |
|---|---:|${dims.map(() => '---:').join('|')}|
${scoreRows.join('\n') || '| — | 0 | ' + dims.map(() => '—').join(' | ') + ' |'}

判官只看到编号与正文，输入除正文外逐字同形（脚本内 \`assertBlind\` 强制，不同形直接抛）。
域主题从正文本身能读出来，这一点抹不掉也不该抹——盲的是组别与批次，不是内容。

## 二、三样机制各自的读数

| 课 | 型别 | 蓝图三表填出 | 类比漂移 | 数字例重复 | 旁路补入 | 其中弃权 | 数字断言覆盖 | 脚手架残留 | 重扫可删 | 断言数 | supported |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${readingRows.join('\n')}

口径说明：

- **蓝图三表**填出几张 = \`courseFrameFromOutlines\` 在这门课上能不能填出类比 / 数字例 / 概念顺序三张表。
  落盘课程不带大纲的 keyPoints，脚本用每屏正文前若干句近似，识别率会偏低——这是近似口径的账，不是产品的账。
- **类比漂移** = 全课认出的不同类比数减一。蓝图治的病是「每屏各自即兴」，所以 0 才是达标。
- **旁路补入 / 弃权**直接数落盘 \`audit.claims\` 里 reason 带「正则旁路补入」「弃权」的条数，不重跑判官。
- **脚手架残留**是交付文本里 \`findScaffoldLeak\` 还认得出的块数；**重扫可删**是把 \`scrubScaffoldHtml\`
  再跑一遍还能删掉的段数（应为 0，非 0 说明有路径没过清除）。真正「删掉了几条」只写在服务端日志，
  给 \`--server-log\` 才数得到。

## 三、成本

${budget.markdown()}

## 四、这一轮没做到的

- 「同难度」是按任务型别（概念 / 落地 / 排障）配的，不是按测过的难度量表配的。
- 判官对域不盲，只对组别与批次盲。
- 这些数字是新口径，与既有对外数字（幻觉率 2.08%/576 断言、适配 85.2%、覆盖 96.0%）不同口径，另立行，不合并。
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
