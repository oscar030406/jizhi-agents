/**
 * 走 API 生成一门完整课程，把「学习者能看到的一切」抓成一份材料文本。
 *
 * 为什么不走浏览器：浏览器跑一遍要十几分钟且不可脚本化复算。API 走的是同一条
 * 生成链路（outlines → content → actions），产物一致，还能固定输入做对照。
 *
 * 用法：
 *   node scripts/capture_course.mjs --url http://localhost:3210 --label fork
 *   node scripts/capture_course.mjs --url http://localhost:3211 --label upstream --model siliconflow:Qwen/Qwen3.5-397B-A17B
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { extractMaterials } from './zero_prior_eval.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const BASE = args.url || 'http://localhost:3210';
const LABEL = args.label || 'run';
const MODEL = args.model || '';
// --persona zero|backend：带画像抓课（分层消融的素材）。零基础 vs 后端转型，
// 两档画像取自 scenario_definition 的背景谱，字段与 classroom 画像弹窗同形。
const PERSONAS = {
  zero: {
    domain: 'ai', education: 'bachelor', role: '非计算机专业想入行',
    programming_level: 0, python_level: 0, agent_level: 0, rag_level: 0, engineering_level: 0,
    learning_preference: '生活类比与分步练习', time_budget_hours: 40,
  },
  backend: {
    domain: 'ai', education: 'bachelor', role: '后端开发转型',
    programming_level: 3, python_level: 3, agent_level: 1, rag_level: 1, engineering_level: 3,
    learning_preference: '接口契约与失败模式视角', time_budget_hours: 20,
  },
};
const PERSONA = args.persona ? PERSONAS[args.persona] : null;
if (args.persona && !PERSONA) throw new Error(`未知画像：${args.persona}`);
const OUT_DIR = args.out || path.join(process.cwd(), 'data', 'eval', 'zero_prior');
const REQUIREMENT = args.requirement || '我想学注意力机制';
const REQUIREMENTS = PERSONA ? { requirement: REQUIREMENT, learnerProfile: PERSONA } : { requirement: REQUIREMENT };
const TIMEOUT = 300000;

// 课堂角色：讲稿生成必须有 agents，否则路由直接早退返回空。
const AGENTS = [
  { id: 'default-1', name: '林老师', role: 'teacher', personality: '讲解清晰，善用类比' },
  { id: 'default-2', name: '小智', role: 'assistant', personality: '补充细节与代码' },
  { id: 'default-3', name: '小航', role: 'student', personality: '爱追问原理' },
];

function headers() {
  const h = { 'Content-Type': 'application/json', 'x-user-locale': 'zh-CN' };
  if (MODEL) h['x-model'] = MODEL;
  return h;
}

async function post(pathname, body) {
  const r = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await r.text();
  return { status: r.status, text };
}

/** outlines 是 SSE 流，逐行挑出 outline 对象 */
function parseOutlines(raw) {
  const outlines = [];
  let courseTitle = '';
  let languageDirective = '';
  for (const line of raw.split('\n')) {
    const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!s || s === '[DONE]') continue;
    try {
      const o = JSON.parse(s);
      if (o.courseTitle) courseTitle = o.courseTitle;
      if (o.languageDirective) languageDirective = o.languageDirective;
      const cand = o.outline ?? o.data?.outline ?? (o.id && o.title ? o : null);
      if (cand?.title) outlines.push(cand);
      if (Array.isArray(o.outlines)) outlines.push(...o.outlines);
      if (Array.isArray(o.data?.outlines)) outlines.push(...o.data.outlines);
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return { outlines, courseTitle, languageDirective };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`[${LABEL}] ${BASE}  模型=${MODEL || '(服务端默认)'}`);

  console.log('  1/3 生成大纲…');
  const o = await post('/api/generate/scene-outlines-stream', {
    requirements: REQUIREMENTS,
    stageId: `zero-prior-${LABEL}`,
  });
  const { outlines, courseTitle, languageDirective } = parseOutlines(o.text);
  if (!outlines.length) {
    console.error('  大纲为空：', o.text.slice(0, 300));
    return 1;
  }
  console.log(`      ${outlines.length} 个场景：${outlines.map((x) => x.type).join(',')}`);

  console.log('  2/3 逐场景生成内容…');
  const scenes = [];
  let prevSpeeches = [];
  for (const [i, outline] of outlines.entries()) {
    const c = await post('/api/generate/scene-content', {
      outline,
      allOutlines: outlines,
      stageId: `zero-prior-${LABEL}`,
      stageInfo: { name: courseTitle || REQUIREMENT },
      languageDirective,
      requirements: REQUIREMENTS,
    });
    let content = null;
    try {
      const j = JSON.parse(c.text);
      content = j.data?.content ?? j.content ?? null;
    } catch {
      /* ignore */
    }
    if (!content) {
      console.log(`      [${i + 1}/${outlines.length}] ${outline.title} — 失败 ${c.status}`);
      continue;
    }
    console.log(`      [${i + 1}/${outlines.length}] ${outline.title} — ok`);

    console.log(`  3/3 生成讲稿 [${i + 1}]…`);
    // 契约要点：必须带 allOutlines 和 agents，否则路由早退；返回的是 scene 不是 actions。
    const a = await post('/api/generate/scene-actions', {
      outline,
      allOutlines: outlines,
      content,
      stageId: `zero-prior-${LABEL}`,
      languageDirective,
      agents: AGENTS,
      previousSpeeches: prevSpeeches,
    });
    let actions = [];
    try {
      const j = JSON.parse(a.text);
      const scene = j.data?.scene ?? j.scene;
      actions = scene?.actions ?? [];
      const ps = j.data?.previousSpeeches ?? j.previousSpeeches;
      if (Array.isArray(ps)) prevSpeeches = ps.slice(-6);
    } catch {
      /* ignore */
    }
    if (!actions.length) console.log(`      讲稿为空：${a.status} ${a.text.slice(0, 120)}`);
    scenes.push({ title: outline.title, type: outline.type, content, actions });
  }

  const materials = extractMaterials(scenes);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  writeFileSync(path.join(OUT_DIR, `${LABEL}.materials.txt`), materials, 'utf8');
  writeFileSync(
    path.join(OUT_DIR, `${LABEL}.scenes.json`),
    JSON.stringify({ label: LABEL, base: BASE, model: MODEL, seconds: +secs, courseTitle, scenes }, null, 2),
    'utf8',
  );
  console.log(`\n[${LABEL}] 完成：${scenes.length} 个场景，材料 ${materials.length} 字符，耗时 ${secs}s`);
  return 0;
}

main().then((c) => process.exit(c ?? 0));
