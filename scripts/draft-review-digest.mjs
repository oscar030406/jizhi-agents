/**
 * 把机构态草稿的判词摘成一页，供机构所有者在 /admin/course/<id> 上做人工复核放行的决定。
 *
 * 只读。不改课、不放行。判词一律照抄，不复述、不润色——复核是人替机器担责，
 * 摘要如果替判官改了口径，那这份责任就担错了。
 *
 * 用法（服务器上）：
 *   node draft-review-digest.mjs --since 2026-09-04T04:25 --org org_9b088fb61b061c77 > review.md
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, c, i, r) => {
    if (c.startsWith('--')) a.push([c.slice(2), r[i + 1]?.startsWith('--') ? true : r[i + 1]]);
    return a;
  }, []),
);
const JOBS = args.jobs || '/var/lib/jizhi-web/classroom-jobs';
const COURSES = args.courses || '/var/lib/jizhi-web/classrooms';
const SINCE = args.since || '';
const ORG = args.org || '';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const trim = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const jobs = fs
  .readdirSync(JOBS)
  .map((f) => read(path.join(JOBS, f)))
  .filter((j) => (!SINCE || String(j.createdAt) >= SINCE) && (!ORG || j.ownerOrgId === ORG))
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

console.log('# 机构态草稿判词摘要\n');
console.log(`生成于 ${new Date().toISOString().slice(0, 19)}Z；来源 job ${jobs.length} 条，机构 ${ORG || '(不限)'}。`);
console.log('\n判词全部照抄，未改写。人工复核放行在 `/admin/course/<id>` 页面上做。\n');

for (const job of jobs) {
  const id = job.classroomId;
  console.log(`\n---\n\n## ${id ?? '(无草稿)'} — job \`${job.id}\``);
  const secs = job.completedAt && job.startedAt
    ? Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000)
    : null;
  console.log(`\n- 需求：${trim(job.inputSummary?.requirementPreview, 120)}`);
  console.log(`- 任务状态：${job.status}；耗时 ${secs === null ? '—' : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`}`);
  console.log(`- 归属：org=\`${job.ownerOrgId ?? 'NULL'}\`（有 org 才能走人工复核放行）`);
  if (!id || !fs.existsSync(path.join(COURSES, `${id}.json`))) {
    console.log(`- **没有落盘草稿**（闸 A 在生成早期就拒了）。门禁判词：\n\n  > ${trim(job.error, 900)}\n`);
    continue;
  }
  const c = read(path.join(COURSES, `${id}.json`));
  const scenes = c.scenes ?? [];
  const ca = c.stage?.courseAudit ?? null;

  console.log(`- 标题：${c.stage?.name ?? '(无)'}；${scenes.length} 屏`);
  console.log(`\n### 门禁判词（decideCourseLearnerRelease 的原文）\n\n> ${trim(job.error, 1200)}\n`);

  // 事实核查：课程级 + 屏级的断言账
  const flagged = [];
  const pushClaims = (where, audit) => {
    for (const cl of audit?.claims ?? []) {
      if (cl.verdict && cl.verdict !== 'supported') flagged.push({ where, ...cl });
    }
  };
  pushClaims('课程级', ca);
  scenes.forEach((s, i) => pushClaims(`屏${i + 1} ${s.title ?? ''}`, s.audit));
  const incorrect = flagged.filter((f) => f.verdict === 'incorrect');

  console.log('### 事实核查\n');
  console.log(
    `课程级裁决 \`${ca?.verdict ?? '无'}\` / \`${ca?.decision ?? '无'}\`，` +
      `断言 ${ca?.totalClaims ?? 0} 条，flagged ${ca?.flaggedCount ?? 0}，` +
      `uncertain ${ca?.uncertainCount ?? 0}，incorrect ${ca?.incorrectCount ?? 0}；` +
      `证据 ${ca?.evidenceCount ?? 0} 块。判官 ${(ca?.judgeModels ?? [ca?.judgeModel]).filter(Boolean).join(' / ') || '—'}。`,
  );
  if (ca?.rationale) console.log(`\n课程级判词：\n\n> ${trim(ca.rationale, 600)}`);
  if (flagged.length) {
    console.log(`\n非 supported 的断言共 ${flagged.length} 条（其中 incorrect ${incorrect.length} 条）：\n`);
    for (const f of flagged.slice(0, 25)) {
      console.log(`- \`${f.verdict}\` ${f.where}：「${trim(f.claim, 90)}」 — ${trim(f.reason, 200)}`);
    }
    if (flagged.length > 25) console.log(`- …另有 ${flagged.length - 25} 条，见课程文件`);
  } else {
    console.log('\n没有非 supported 的断言。');
  }

  // 教学合同履约：违规原文照抄
  const align = ca?.learningAlignment;
  console.log('\n### 教学合同履约（语义对齐）\n');
  if (!align) {
    console.log('没有对齐记录。');
  } else {
    console.log(`complete=${align.complete} aligned=${align.aligned}，违规 ${(align.violations ?? []).length} 条：\n`);
    for (const v of align.violations ?? []) console.log(`- ${trim(v, 320)}`);
  }

  // 语料是否真被用上
  console.log('\n### 语料使用（每屏检索到的 source_id 数）\n');
  const all = new Set();
  const rows = scenes.map((s, i) => {
    const ids = (s.audit?.sources ?? []).map((x) => x.source_id);
    ids.forEach((x) => all.add(x));
    return `- 屏${i + 1} ${s.title ?? ''}：${ids.length} 块${ids.length ? ` — ${ids.slice(0, 6).join(', ')}` : ''}`;
  });
  console.log(rows.join('\n'));
  for (const x of (ca?.sources ?? []).map((s) => s.source_id)) all.add(x);
  const ib = [...all].filter((x) => x.startsWith('ib'));
  console.log(`\n合计去重 ${all.size} 块；其中本次新入库的面试题集语料 ${ib.length} 块${ib.length ? `（${ib.join(', ')}）` : ''}。`);

  const label = incorrect.length ? '事实问题' : '形式偏差';
  console.log(
    `\n### 初判：**${label}**\n\n` +
      (incorrect.length
        ? `有 ${incorrect.length} 条断言被判 incorrect，放行前应逐条核对。`
        : `没有 incorrect 断言；拦下它的是教学合同的形式要求（激活/示范/反馈重试/迁移各屏与目标动作对不上），不是内容说错了。`),
  );
}
