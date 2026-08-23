/**
 * 评测冲刺四个脚本的公用件：参数解析、成本闸、判官直调、盲评封装、产物落盘。
 *
 * 四个脚本（a_parity / b_ablation / c_judge_stability / d_numeric_perturbation）
 * 共用这一份，避免四处各写一遍成本口径和盲评口径——两份口径必然长歪。
 *
 * 自检：
 *   cd "D:/UserData/Desktop/挑战杯/apps/classroom"
 *   node --import tsx "../agent-engine/scripts/eval_sprint/common.mjs" --selftest
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../../..');
export const CLASSROOM = path.join(ROOT, 'apps/classroom');
export const ENGINE = path.join(ROOT, 'apps/agent-engine');
export const EVIDENCE = path.join(ROOT, 'docs/05-evidence/eval_sprint');

export const SF_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const CALL_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------- 参数

const ARGV = process.argv.slice(2);
export function arg(name, fallback = undefined) {
  const i = ARGV.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = ARGV[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}
export function flag(name) {
  return ARGV.includes(`--${name}`);
}
export function list(name, fallback = []) {
  const v = arg(name);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

/**
 * 剥代理直连。硅基流动走 Clash 会被 fake-ip 伪装成成功再超时，
 * 所以进程内直接删掉代理变量，不指望调用方记得 `env -u`。
 */
export function stripProxyEnv() {
  const killed = [];
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    if (process.env[k]) {
      killed.push(`${k}=${process.env[k]}`);
      delete process.env[k];
    }
  }
  process.env.NO_PROXY = '*';
  process.env.no_proxy = '*';
  return killed;
}

// ---------------------------------------------------------------- 价格与成本闸

/** 价格真源是 backend/services/cost_meter.py，这里只解析不另立一份。 */
export function loadPrices() {
  const src = readFileSync(path.join(ENGINE, 'backend/services/cost_meter.py'), 'utf8');
  const body = src.slice(src.indexOf('PRICE_TABLE'), src.indexOf('class CostReport'));
  const table = [...body.matchAll(/\("([^"]+)",\s*([\d.]+),\s*([\d.]+)\)/g)].map((m) => [
    m[1],
    Number(m[2]),
    Number(m[3]),
  ]);
  const def = /DEFAULT_PRICE[^=]*=\s*\(([\d.]+),\s*([\d.]+)\)/.exec(body);
  if (!table.length || !def) {
    throw new Error('cost_meter.py 价格表解析失败：那边格式变了，改 common.mjs 的 loadPrices 正则');
  }
  return { table, fallback: [Number(def[1]), Number(def[2])] };
}

const PRICES = loadPrices();

/** 模型 id 可能带 `siliconflow:` 前缀，价格表按裸 id 前缀匹配。 */
export function priceFor(model) {
  const bare = String(model || '').replace(/^[a-z]+:/, '');
  for (const [prefix, pin, pout] of PRICES.table) {
    if (bare.startsWith(prefix)) return [pin, pout];
  }
  return PRICES.fallback;
}

export function costCny(model, promptTok, completionTok) {
  const [pin, pout] = priceFor(model);
  return (promptTok / 1e6) * pin + (completionTok / 1e6) * pout;
}

/** 粗估 token：中文约 1.6 字符 1 token。只用于 dry-run 报预算，不当实测。 */
export function estTokens(text) {
  return Math.ceil(String(text || '').length / 1.6);
}

export class BudgetStop extends Error {}

/**
 * 成本闸。累计 token 与估算成本，到上限即停（抛 BudgetStop，调用方落盘已有结果）。
 * dry 模式下不发请求，只把「会花多少」累加出来。
 */
export class Budget {
  constructor(limitCny, { dry = false } = {}) {
    this.limit = Number(limitCny);
    this.dry = dry;
    this.calls = [];
    this.spent = 0;
    this.promptTok = 0;
    this.completionTok = 0;
  }

  /** 下一次调用之前问一句：还够不够。不够就停，不要发出去再后悔。 */
  assertRoom(estCny, tag) {
    if (this.spent + estCny > this.limit) {
      throw new BudgetStop(
        `成本闸触发：已花 ¥${this.spent.toFixed(4)}，这一步预计 ¥${estCny.toFixed(4)}，` +
          `上限 ¥${this.limit.toFixed(4)}（${tag}）。已跑完的部分已落盘。`,
      );
    }
  }

  record({ tag, model, promptTok, completionTok, estimated }) {
    const cny = costCny(model, promptTok, completionTok);
    this.spent += cny;
    this.promptTok += promptTok;
    this.completionTok += completionTok;
    this.calls.push({ tag, model, promptTok, completionTok, cny, estimated: Boolean(estimated) });
    return cny;
  }

  summary() {
    const byTag = new Map();
    for (const c of this.calls) {
      const cur = byTag.get(c.tag) || { tag: c.tag, n: 0, cny: 0, tok: 0 };
      cur.n += 1;
      cur.cny += c.cny;
      cur.tok += c.promptTok + c.completionTok;
      byTag.set(c.tag, cur);
    }
    return {
      calls: this.calls.length,
      promptTok: this.promptTok,
      completionTok: this.completionTok,
      spentCny: Number(this.spent.toFixed(4)),
      limitCny: this.limit,
      dry: this.dry,
      byTag: [...byTag.values()].map((x) => ({ ...x, cny: Number(x.cny.toFixed(4)) })),
    };
  }

  markdown() {
    const s = this.summary();
    const rows = s.byTag
      .map((t) => `| ${t.tag} | ${t.n} | ${t.tok} | ${t.cny.toFixed(4)} |`)
      .join('\n');
    return [
      `| 环节 | 调用数 | token | ${s.dry ? '预估' : '估算'}成本(¥) |`,
      '|---|---:|---:|---:|',
      rows,
      `| **合计** | **${s.calls}** | **${s.promptTok + s.completionTok}** | **${s.spentCny.toFixed(4)}** |`,
      '',
      `上限 ¥${s.limitCny}；token 是${s.dry ? '按字符数粗估' : '接口回报的实测值'}，单价取 cost_meter.py 常量，以账单为准。`,
    ].join('\n');
  }
}

// ---------------------------------------------------------------- 模型直调

/**
 * 取判官用的 key。**按顺序找三处，不复制密钥到第四个文件**。
 *
 * 两侧各有一份 env 是既有事实：课堂侧 `.env.local` 给 Next 用，
 * 引擎侧 `.env` 给 FastAPI 用，key 可能只配在其中一边（本机就只在引擎侧）。
 * 原来只找课堂那一份，于是脚本在一台配好了 key 的机器上照样报「没有 key」。
 * 环境变量放最前：CI 与临时覆盖都走它，不该被文件盖掉。
 */
export function loadApiKey() {
  if (process.env.SILICONFLOW_API_KEY?.trim()) return process.env.SILICONFLOW_API_KEY.trim();
  const candidates = [
    path.join(CLASSROOM, '.env.local'),
    path.join(CLASSROOM, '..', 'agent-engine', '.env'),
  ];
  for (const envPath of candidates) {
    let text;
    try {
      text = readFileSync(envPath, 'utf8');
    } catch {
      continue; // 这一份不在盘上，换下一处
    }
    const key = /^SILICONFLOW_API_KEY=(.+)$/m.exec(text)?.[1]?.trim();
    if (key) return key;
  }
  throw new Error(
    `找不到 SILICONFLOW_API_KEY。找过：环境变量、${candidates.join('、')}`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一次判官调用。dry 模式只记账不发请求，返回 `{ text: null, dry: true }`。
 *
 * 失败不静默：三次都失败就抛，让调用方决定是记 miss 还是整批停。
 */
export async function callModel({ model, system, user, tag, maxTokens = 1024, temperature = 0 }, ctx) {
  const { budget, apiKey } = ctx;
  const estIn = estTokens(system) + estTokens(user);
  const estOut = Math.ceil(maxTokens * 0.35); // 判官回的是短 JSON，按 max 的三成估
  budget.assertRoom(costCny(model, estIn, estOut), tag);

  if (budget.dry) {
    budget.record({ tag, model, promptTok: estIn, completionTok: estOut, estimated: true });
    return { text: null, dry: true, estIn, estOut };
  }

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(SF_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const bodyText = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${bodyText.slice(0, 300)}`);
      const payload = JSON.parse(bodyText);
      const u = payload.usage || {};
      budget.record({
        tag,
        model,
        promptTok: u.prompt_tokens || estIn,
        completionTok: u.completion_tokens || 0,
      });
      return { text: payload.choices?.[0]?.message?.content ?? '', dry: false, usage: u };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
    }
  }
  throw new Error(`[${tag}] ${model} 三次都失败：${lastErr}`);
}

/** 抠出模型回的第一个 JSON 对象。回不出来就抛，不猜。 */
export function parseJsonObject(text) {
  const s = String(text ?? '').replace(/```(?:json)?/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`回复里没有 JSON：${s.slice(0, 120)}`);
  return JSON.parse(s.slice(start, end + 1));
}

// ---------------------------------------------------------------- 产品判官口径

export const VERDICTS = ['supported', 'uncertain', 'incorrect'];

/**
 * 从产品源码里现抠判官提示词。抠不出来就抛——拿"差不多的口径"顶上，
 * 测出来的是两份提示词的差，不是产品的行为。
 */
export function productJudgeSystem() {
  const src = readFileSync(path.join(CLASSROOM, 'lib/generation/hallucination-audit.ts'), 'utf8');
  const m = /const JUDGE_SYSTEM = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error('hallucination-audit.ts 里抠不到 JUDGE_SYSTEM，那边格式变了，改这里的正则');
  const full = m[1];
  const lines = full.split('\n');
  const opts = VERDICTS.map((v) => {
    const line = lines.find((l) => l.trim().startsWith(`- ${v}`));
    if (!line) throw new Error(`JUDGE_SYSTEM 里找不到「- ${v}」那一行`);
    return { verdict: v, line: line.trim() };
  });
  return { full, opts, strict: lines.find((l) => l.startsWith('宁严勿松')) ?? '' };
}

// ---------------------------------------------------------------- 四维 rubric

export const RUBRIC_DIMS = [
  ['fact', '事实性', '陈述是否与领域公认知识一致；有没有编造的数字、张冠李戴的归因、把比喻当机制'],
  ['structure', '结构', '整门课的编排是否成一条路：先后顺序讲得通、每屏有明确的一件事、没有该讲没讲或反复讲'],
  ['coherence', '连贯', '屏与屏之间是否共用同一套说法：一个类比贯穿到底、同一组数字只演一次、术语前后一致'],
  ['register', '语域', '语气与用词是否稳定在教学口吻：没有元话语（"本屏""接下来我们"）、没有营销腔、没有半截的提示词残留'],
];

/** 判官提示词。四维各 1–5 分，锚点写死，两个脚本共用同一份口径。 */
export function rubricSystem() {
  const dims = RUBRIC_DIMS.map(([k, label, desc]) => `- ${k}（${label}）：${desc}`).join('\n');
  return `你是课程质量评审员。你会看到一份课程的全部教学正文，请就四个维度各打一个 1–5 的整数分。

${dims}

评分锚点（四个维度同一套）：
5 = 挑不出问题，可以直接给学生看
4 = 有一两处小瑕疵，不影响理解
3 = 有明显问题但整体可用，需要人工改一遍
2 = 问题成片，改起来不如重写一部分
1 = 这个维度基本没成立

只输出一个 JSON 对象，不要围栏不要解释：
{"fact":n,"structure":n,"coherence":n,"register":n,"note":"一句话说清扣分扣在哪"}`;
}

export function parseRubric(text) {
  const o = parseJsonObject(text);
  const out = {};
  for (const [k] of RUBRIC_DIMS) {
    const v = Number(o[k]);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`维度 ${k} 分值非法：${o[k]}`);
    out[k] = v;
  }
  out.note = String(o.note ?? '').slice(0, 200);
  return out;
}

// ---------------------------------------------------------------- 盲评

/** 固定种子的洗牌，跑几遍顺序都一样，别人能照着复算。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(items, seed) {
  const rnd = mulberry32(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 盲评封装：把 `{ key, body }` 打成 `{ sid, body }`，洗牌，返回 sid→key 的对照表。
 * key（域名、库名、档位）留在脚本这边，一个字都不进判官的输入。
 */
export function blindPack(items, seed) {
  const order = shuffled(items.map((_, i) => i), seed);
  const entries = order.map((idx, n) => ({
    sid: `S${String(n + 1).padStart(3, '0')}`,
    key: items[idx].key,
    body: items[idx].body,
  }));
  return { entries, keymap: Object.fromEntries(entries.map((e) => [e.sid, e.key])) };
}

/**
 * 盲评自检：各组的判官输入除正文外必须完全同形。
 *
 * 做法是把每条 user 文本里的正文和编号抠掉，剩下的骨架必须逐字相同——
 * 有任何一组多带了一句「这是制造域的」，骨架就会多出一种，当场抛。
 * 另外扫一遍标识词：库名、档位名、stageId 这类只要出现在判官输入里就算漏。
 */
export function assertBlind(entries, banned = []) {
  const skeletons = new Map();
  for (const e of entries) {
    if (!/^S\d{3}$/.test(e.sid)) throw new Error(`盲评自检失败：编号带信息「${e.sid}」`);
    if (!e.message.includes(e.body)) throw new Error(`盲评自检失败：${e.sid} 的正文没原样进输入`);
    const skel = e.message.split(e.body).join('«正文»').split(e.sid).join('«编号»');
    if (!skeletons.has(skel)) skeletons.set(skel, []);
    skeletons.get(skel).push(e.sid);
    for (const word of banned) {
      if (!word) continue;
      if (e.message.toLowerCase().includes(String(word).toLowerCase())) {
        throw new Error(`盲评自检失败：${e.sid} 的判官输入里出现标识「${word}」`);
      }
    }
  }
  if (skeletons.size !== 1) {
    const shapes = [...skeletons.values()].map((v) => `${v[0]}等${v.length}条`).join(' / ');
    throw new Error(`盲评自检失败：判官输入出现 ${skeletons.size} 种骨架（${shapes}），不同形`);
  }
  return { n: entries.length, skeletonChars: [...skeletons.keys()][0].length };
}

// ---------------------------------------------------------------- 统计

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * 自助重抽：点估计贴着判据线的时候，报「有多大比例的重抽落在线的同一侧」。
 * 样本小的时候点估计不能单独看，这一条是给它配的诚实说明。
 */
export function bootstrapCoverage(values, threshold, { iters = 2000, seed = 20260823 } = {}) {
  if (!values.length) return { coverage: NaN, iters: 0, n: 0 };
  const rnd = mulberry32(seed);
  let above = 0;
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[Math.floor(rnd() * values.length)];
    if (s / values.length >= threshold) above += 1;
  }
  return { coverage: above / iters, iters, n: values.length, threshold };
}

// ---------------------------------------------------------------- 落盘

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // 带到秒：同一分钟内跑两次不会把上一份产物悄悄盖掉。
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** jsonl 明细 + markdown 报告，都落 docs/05-evidence/eval_sprint/（docs 不入库）。 */
export function emit(name, { rows = [], md = '' }) {
  mkdirSync(EVIDENCE, { recursive: true });
  const base = path.join(EVIDENCE, name);
  const jsonl = `${base}.jsonl`;
  const report = `${base}.md`;
  writeFileSync(jsonl, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  writeFileSync(report, md, 'utf8');
  return { jsonl, report };
}

export function readJsonlIfExists(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- 自检

function selftest() {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`自检失败：${msg}`);
    console.log(`  ok  ${msg}`);
  };

  ok(PRICES.table.length >= 3, `价格表解析到 ${PRICES.table.length} 档，兜底 ${PRICES.fallback.join('/')}`);
  ok(priceFor('siliconflow:zai-org/GLM-5.2')[0] === 4.0, 'siliconflow: 前缀不影响价格匹配');
  ok(priceFor('nobody/unknown-model')[0] === PRICES.fallback[0], '未知模型走兜底价');

  const b = new Budget(0.01, { dry: true });
  b.record({ tag: 't', model: 'Qwen/x', promptTok: 1_000_000, completionTok: 0, estimated: true });
  ok(Math.abs(b.spent - 0.7) < 1e-9, '百万 prompt token 按 ¥0.7 记账');
  let stopped = false;
  try {
    b.assertRoom(0.001, 't');
  } catch (e) {
    stopped = e instanceof BudgetStop;
  }
  ok(stopped, '超上限时 assertRoom 抛 BudgetStop');

  const packed = blindPack(
    [
      { key: 'ai', body: '甲正文' },
      { key: 'plc-s71200', body: '乙正文' },
      { key: 'smart-manufacturing', body: '丙正文' },
    ],
    7,
  );
  ok(packed.entries.length === 3 && packed.entries.every((e) => /^S\d{3}$/.test(e.sid)), '盲评编号不带信息');
  ok(
    JSON.stringify(blindPack([{ key: 'a', body: '1' }, { key: 'b', body: '2' }], 7).entries.map((e) => e.key)) ===
      JSON.stringify(blindPack([{ key: 'a', body: '1' }, { key: 'b', body: '2' }], 7).entries.map((e) => e.key)),
    '同种子洗牌结果可复现',
  );

  const good = packed.entries.map((e) => ({ ...e, message: `编号 ${e.sid}\n---\n${e.body}\n---\n请评分。` }));
  const shape = assertBlind(good, ['plc-s71200', 'smart-manufacturing', '裸生成']);
  ok(shape.n === 3, `同形自检通过，骨架 ${shape.skeletonChars} 字符`);

  let caughtShape = false;
  try {
    assertBlind([...good.slice(0, 2), { ...good[2], message: `${good[2].message}\n（制造域样本）` }], []);
  } catch {
    caughtShape = true;
  }
  ok(caughtShape, '多带一句话就会被同形自检抓住');

  let caughtWord = false;
  try {
    assertBlind(
      good.map((e) => ({ ...e, message: `${e.message}（来源 plc-s71200）` })),
      ['plc-s71200'],
    );
  } catch {
    caughtWord = true;
  }
  ok(caughtWord, '标识词漏进输入会被抓住');

  const r = parseRubric('```json\n{"fact":4,"structure":3,"coherence":5,"register":2,"note":"x"}\n```');
  ok(r.fact === 4 && r.register === 2, 'rubric 解析吃得下围栏');
  let caughtRubric = false;
  try {
    parseRubric('{"fact":9,"structure":3,"coherence":5,"register":2}');
  } catch {
    caughtRubric = true;
  }
  ok(caughtRubric, '越界分值不放过');

  const bc = bootstrapCoverage([1, 1, 1, 0, 1], 0.6);
  ok(bc.coverage > 0.5 && bc.iters === 2000, `自助重抽覆盖率 ${(bc.coverage * 100).toFixed(1)}%`);

  console.log('\ncommon.mjs 自检全过。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (flag('selftest')) selftest();
  else console.log('这是公用模块。跑自检：node --import tsx common.mjs --selftest');
}
