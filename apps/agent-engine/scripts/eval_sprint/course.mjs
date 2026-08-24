/**
 * 课程这一侧：怎么把一门课跑出来、怎么把它量出来。
 *
 * 量的三样东西全部**直接 import 产品函数**，不在这里重写一份判据——
 * 重写一份量出来的就是两份代码的差，不是产品的实效。
 *   · 蓝图三表  lib/generation/course-coherence.ts
 *   · 数字旁路  lib/generation/numeric-claims.ts
 *   · 脚手架    lib/generation/adaptation-lint.ts
 *
 * 所以跑的时候 cwd 必须是 apps/classroom（tsx 与相对 json import 都靠那边解析）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLASSROOM, costCny, estTokens } from './common.mjs';

const ts = (rel) => pathToFileURL(path.join(CLASSROOM, rel)).href;

const { courseFrameFromOutlines, extractAnalogy, extractWorkedExample } = await import(
  ts('lib/generation/course-coherence.ts')
);
const { extractNumericClaims, hasCounterpart, mergeNumericBypass } = await import(
  ts('lib/generation/numeric-claims.ts')
);
const { findScaffoldLeak, scrubScaffoldHtml } = await import(ts('lib/generation/adaptation-lint.ts'));
const { extractTeachingText } = await import(ts('lib/generation/hallucination-audit.ts'));

export const productFns = {
  courseFrameFromOutlines,
  extractAnalogy,
  extractWorkedExample,
  extractNumericClaims,
  hasCounterpart,
  mergeNumericBypass,
  findScaffoldLeak,
  scrubScaffoldHtml,
  extractTeachingText,
};

// ---------------------------------------------------------------- 生成一门课

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一门课的**估算**成本。真实值靠 /api/usage 的前后快照差，这里只给 dry-run 报预算。
 * 依据：9 屏 × (内容 1 + 讲稿 1 + 判官 2 + 仲裁 0.3 + 修订 0.3) + 大纲 1 ≈ 42 次调用，
 * 平均每次 prompt 3.5k / completion 1.2k（取 data/eval/course_cost.json 里同链路的量级）。
 * 这是估算不是实测，跑完第一门用实测值覆盖 `--cost-per-course`。
 */
export const COURSE_CALLS = 42;
export const COURSE_PROMPT_TOK = 3500;
export const COURSE_COMPLETION_TOK = 1200;

export function estCourseCost(model = 'Qwen/Qwen3-30B-A3B-Instruct-2507') {
  return costCny(model, COURSE_CALLS * COURSE_PROMPT_TOK, COURSE_CALLS * COURSE_COMPLETION_TOK);
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} 回的不是 JSON（HTTP ${r.status}）：${text.slice(0, 200)}`);
  }
  if (!r.ok || body.success === false) {
    throw new Error(`${url} 失败 HTTP ${r.status}：${text.slice(0, 300)}`);
  }
  return body;
}

/** /api/usage 的 byModel 快照，用来算「这门课真花了多少」。 */
export async function usageSnapshot(baseUrl) {
  try {
    const body = await getJson(`${baseUrl}/api/usage`);
    return Object.fromEntries(
      (body.byModel || []).map((b) => [b.key, { inp: b.inputTokens, out: b.outputTokens }]),
    );
  } catch (err) {
    return { __error: String(err) };
  }
}

/** 两次快照相减，逐模型记进成本闸。拿不到快照就退回估算值并标记。 */
export function chargeUsageDelta(budget, before, after, tag, fallbackModel) {
  if (before?.__error || after?.__error) {
    budget.record({
      tag: `${tag}(估算)`,
      model: fallbackModel,
      promptTok: COURSE_CALLS * COURSE_PROMPT_TOK,
      completionTok: COURSE_CALLS * COURSE_COMPLETION_TOK,
      estimated: true,
    });
    return { measured: false };
  }
  let any = false;
  for (const [model, a] of Object.entries(after)) {
    const b = before[model] || { inp: 0, out: 0 };
    const dIn = a.inp - b.inp;
    const dOut = a.out - b.out;
    if (dIn <= 0 && dOut <= 0) continue;
    any = true;
    budget.record({ tag, model, promptTok: Math.max(0, dIn), completionTok: Math.max(0, dOut) });
  }
  return { measured: any };
}

/**
 * 走产品的整课路径（POST /api/generate-classroom → 轮询 jobId）。
 * 这条路径带审核门与蓝图，逐屏路（scene-content）不带，评测必须用这条。
 */
export async function generateCourse({ baseUrl, requirement, profile, budget, timeoutMs = 45 * 60_000 }) {
  if (budget.dry) {
    const est = estCourseCost();
    budget.assertRoom(est, '整课生成');
    budget.record({
      tag: '整课生成',
      model: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
      promptTok: COURSE_CALLS * COURSE_PROMPT_TOK,
      completionTok: COURSE_CALLS * COURSE_COMPLETION_TOK,
      estimated: true,
    });
    return { classroomId: null, dry: true, plan: { baseUrl, requirement, profile } };
  }

  budget.assertRoom(estCourseCost(), '整课生成');
  const before = await usageSnapshot(baseUrl);
  const started = await getJson(`${baseUrl}/api/generate-classroom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-locale': 'zh-CN' },
    body: JSON.stringify({ requirement, ...(profile ? { learnerProfile: profile } : {}) }),
  });
  const jobId = started.jobId;
  if (!jobId) throw new Error(`没拿到 jobId：${JSON.stringify(started).slice(0, 200)}`);

  const t0 = Date.now();
  let last = '';
  /** 连续几次读不到状态才放弃。生成本身还在服务端跑，客户端读不到不代表它死了。 */
  const MAX_POLL_FAILS = 6;
  let pollFails = 0;
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} 超过 ${timeoutMs / 60000} 分钟未完成`);
    await sleep(5000);
    // 轮询要容忍瞬时失败：dev server 热重载时这个接口会回一页 HTML 错误页，
    // 一次抖动就把跑了十分钟的整轮丢掉不划算。**只容忍读状态失败，不容忍
    // job 自己报 failed**——后者是真结果，照旧立刻抛。
    // 实测：编辑源码触发重编译（`compile: 861ms`）那一下，轮询拿到 HTTP 500。
    let job;
    try {
      job = await getJson(`${baseUrl}/api/generate-classroom/${jobId}`);
      pollFails = 0;
    } catch (err) {
      pollFails += 1;
      if (pollFails > MAX_POLL_FAILS) {
        throw new Error(`job ${jobId} 连续 ${MAX_POLL_FAILS} 次读不到状态：${String(err).slice(0, 160)}`);
      }
      process.stdout.write(`      读状态失败 ${pollFails}/${MAX_POLL_FAILS}，5 秒后重试
`);
      continue;
    }
    if (job.message && job.message !== last) {
      last = job.message;
      process.stdout.write(`      ${job.status} ${job.progress ?? ''}% ${job.message}\n`);
    }
    if (job.status === 'failed') throw new Error(`job ${jobId} 失败：${job.error || '(无错误信息)'}`);
    if (job.status === 'succeeded') {
      const after = await usageSnapshot(baseUrl);
      const charged = chargeUsageDelta(budget, before, after, '整课生成', 'Qwen/Qwen3-30B-A3B-Instruct-2507');
      return {
        classroomId: job.classroomId || job.result?.classroomId,
        jobId,
        ms: Date.now() - t0,
        costMeasured: charged.measured,
      };
    }
  }
}

/**
 * 取一门课：先问服务，服务不在就直接读盘。
 *
 * 事后汇总（消融 --judge、任何离线读数）读的是**已经落盘的课**，
 * 却因为要走 HTTP 而必须有一个服务活着——那是没道理的耦合。
 * 实测撞到过：四档跑完各自的服务都收了，别人又在重建 3210，
 * 于是汇总一步卡在「课程取不到」，而课就在 data/classrooms/ 躺着。
 *
 * 服务优先仍然保留：线上那份可能比盘上新（生成刚结束还没 flush 的情况）。
 */
export async function fetchCourse(baseUrl, classroomId) {
  let online = null;
  try {
    const body = await getJson(`${baseUrl}/api/classroom?id=${encodeURIComponent(classroomId)}`);
    online = body.classroom ?? null;
  } catch {
    online = null;
  }
  if (online) return online;
  const onDisk = path.join(CLASSROOM, 'data/classrooms', `${classroomId}.json`);
  if (existsSync(onDisk)) return loadCourseFile(onDisk);
  throw new Error(`课程 ${classroomId} 取不到：${baseUrl} 没响应，盘上也没有 ${onDisk}`);
}

export function loadCourseFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * dry-run 的替身课程：拿本地最新的一门已存课程走通读数与盲评封装。
 * 只为证明流程跑得通，任何数字都不代表结论——报告里会显式标注。
 */
export function sampleLocalCourse() {
  const dir = path.join(CLASSROOM, 'data/classrooms');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f));
  if (!files.length) return null;
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return { file: files[0], course: loadCourseFile(files[0]) };
}

// ---------------------------------------------------------------- 取正文

function walkText(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) walkText(x, out);
    return;
  }
  if (typeof node === 'object') {
    if (node.type === 'text' && typeof node.content === 'string') out.push(node.content);
    for (const v of Object.values(node)) walkText(v, out);
  }
}

/** 一屏里所有文本元素的 HTML 原文（脚手架读数要看 HTML，不能先剥标签）。 */
export function sceneHtmlBlocks(scene) {
  const out = [];
  walkText(scene?.content, out);
  return out;
}

const plain = (html) =>
  String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 判官看到的正文：逐屏标题 + 教学正文 + 讲稿台词，拼成一份纯文本。 */
export function courseBody(course, { maxChars = 24000 } = {}) {
  const parts = [];
  for (const s of course.scenes || []) {
    parts.push(`## ${s.title || ''}`);
    const teaching = extractTeachingText(s.content);
    if (teaching) parts.push(teaching);
    for (const a of s.actions || []) {
      const line = a?.content || a?.text || a?.speech;
      if (typeof line === 'string' && line.trim()) parts.push(line.trim());
    }
  }
  return parts.join('\n').slice(0, maxChars);
}

// ---------------------------------------------------------------- 三样读数

/**
 * 蓝图三表：在这个域里**填不填得出来**，以及填出来之后**重不重**。
 * 蓝图治的病是"每屏各自即兴"，所以效果读数是类比是否唯一、数字例是否只演一次。
 *
 * 注意：落盘的课程不带 outline 的 keyPoints，这里用每屏正文的前若干行近似，
 * 近似口径写在报告里——它会让类比/数字例的识别率偏低，不是产品的锅。
 */
export function blueprintReading(course) {
  const outlines = (course.scenes || []).map((s) => ({
    id: s.outlineId || s.id,
    title: s.title || '',
    keyPoints: plain(sceneHtmlBlocks(s).join('\n'))
      .split(/[。；\n]/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 6)
      .slice(0, 12),
  }));
  const frame = courseFrameFromOutlines(outlines);

  const perSceneAnalogy = outlines.map((o) => extractAnalogy(o.keyPoints)).filter(Boolean);
  const distinctAnalogies = new Set(perSceneAnalogy);
  const worked = outlines.map((o) => extractWorkedExample(o.title, o.keyPoints)).filter(Boolean);
  const numberSets = worked.map((w) => w.split('：').slice(1).join('：'));
  const dupNumbers = numberSets.length - new Set(numberSets).size;

  return {
    scenes: outlines.length,
    // ⚠️ `tablesFilled` 是**拿落盘大纲重算**「这门课本来能填几张表」，
    // 与运行时有没有真把 coherenceDirective 拼进提示词**无关**——
    // 关掉 COURSE_COHERENCE 之后它照样是 2/3（2026-08-23 档 0 实测）。
    // **所以它区分不了消融的档 2 与档 3，出爬升图不要用它。**
    // 使用侧的真指标是下面三个：analogyDrift（换了几次喻体）、
    // distinctAnalogies（一门课用了几个不同类比）、duplicateNumericExamples。
    // 档 0 实测 analogyMentions=0，而开着一致性的课是 2-6 次——那才是区分度。
    tablesFilledNote: '潜在值，非运行时使用量；档间不变，不可用于爬升图',
    frameAnalogy: frame.analogy ?? null,
    frameNumericExamples: frame.numericExamples?.length ?? 0,
    frameConceptOrder: frame.conceptOrder?.length ?? 0,
    tablesFilled: [frame.analogy ? 1 : 0, frame.numericExamples?.length ? 1 : 0, frame.conceptOrder?.length ? 1 : 0].reduce(
      (a, b) => a + b,
      0,
    ),
    analogyMentions: perSceneAnalogy.length,
    distinctAnalogies: distinctAnalogies.size,
    analogyDrift: Math.max(0, distinctAnalogies.size - 1), // 全课应当只有一个类比
    workedExampleScenes: worked.length,
    duplicateNumericExamples: dupNumbers,
  };
}

/**
 * 数字旁路：判官抽到的断言里有几条是旁路补的、其中几条弃权，
 * 以及正文里的数字断言到底被覆盖了多少。
 *
 * 旁路补入的断言在落盘的 audit.claims 里带着 reason 标记，不用重跑判官就能数。
 */
export function numericReading(course) {
  let judged = 0;
  let bypassAdded = 0;
  let bypassAbstained = 0;
  let scenesWithAudit = 0;
  let numericClaimsInText = 0;
  let numericCoveredByJudge = 0;

  for (const s of course.scenes || []) {
    const audit = s.audit;
    const teaching = extractTeachingText(s.content);
    const found = extractNumericClaims(teaching);
    numericClaimsInText += found.length;

    if (!audit || !Array.isArray(audit.claims)) continue;
    scenesWithAudit += 1;
    judged += audit.claims.length;
    for (const c of audit.claims) {
      const reason = String(c.reason || '');
      if (reason.includes('正则旁路补入')) {
        bypassAdded += 1;
        if (reason.includes('弃权')) bypassAbstained += 1;
      }
    }
    // 比「数值+单位」串，不比裸数字——裸数字会把章节号、序号也算成命中。
    const claimBlob = audit.claims.map((c) => String(c.claim || '')).join('\n').replace(/\s+/g, '');
    for (const f of found) {
      if (f.numbers.some((n) => claimBlob.includes(n))) numericCoveredByJudge += 1;
    }
  }

  return {
    scenesWithAudit,
    judgedClaims: judged,
    bypassAdded,
    bypassAbstained,
    numericClaimsInText,
    numericCoveredByJudge,
    numericCoverage: numericClaimsInText ? numericCoveredByJudge / numericClaimsInText : null,
  };
}

/**
 * 脚手架清除：交付文本里**还剩几条**元话语，以及重扫一遍还能删掉几条。
 *
 * 「删掉了几条」只写在服务端日志（scene-generator 的 `[脚手架清除]` 那行），
 * HTTP 这头看不见，所以给 `--server-log` 一个口子：给了就把那几行也统计进来。
 */
export function scaffoldReading(course, serverLogText = '') {
  let blocks = 0;
  let residual = 0;
  let rescrubDropped = 0;
  const samples = [];

  for (const s of course.scenes || []) {
    for (const html of sceneHtmlBlocks(s)) {
      blocks += 1;
      const text = plain(html);
      if (text && findScaffoldLeak(text)) {
        residual += 1;
        if (samples.length < 5) samples.push(text.slice(0, 60));
      }
      const scrub = scrubScaffoldHtml(html);
      rescrubDropped += scrub.dropped.length;
    }
  }

  const logged = [...String(serverLogText).matchAll(/\[脚手架清除\][^\n]*?删掉\s*(\d+)\s*段/g)].reduce(
    (a, m) => a + Number(m[1]),
    0,
  );

  return {
    textBlocks: blocks,
    residualLeaks: residual,
    residualRate: blocks ? residual / blocks : null,
    rescrubDropped,
    droppedFromServerLog: serverLogText ? logged : null,
    samples,
  };
}

/** 审核链自带读数（省钱形态用这一组，不开判官团）。 */
export function auditReading(course) {
  let total = 0;
  let flagged = 0;
  let uncertain = 0;
  let incorrect = 0;
  let scenes = 0;
  const verdicts = {};
  for (const s of course.scenes || []) {
    const a = s.audit;
    if (!a) continue;
    scenes += 1;
    total += a.totalClaims || 0;
    flagged += a.flaggedCount || 0;
    uncertain += a.uncertainCount || 0;
    incorrect += a.incorrectCount || 0;
    verdicts[a.verdict || 'unknown'] = (verdicts[a.verdict || 'unknown'] || 0) + 1;
  }
  return {
    scenesAudited: scenes,
    totalClaims: total,
    flaggedCount: flagged,
    uncertainCount: uncertain,
    incorrectCount: incorrect,
    supportedRate: total ? (total - flagged) / total : null,
    verdicts,
  };
}

export function allReadings(course, serverLogText = '') {
  return {
    blueprint: blueprintReading(course),
    numeric: numericReading(course),
    scaffold: scaffoldReading(course, serverLogText),
    audit: auditReading(course),
    bodyChars: courseBody(course, { maxChars: 1e9 }).length,
    estBodyTokens: estTokens(courseBody(course, { maxChars: 1e9 })),
  };
}
