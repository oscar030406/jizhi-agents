/**
 * 适配评测 2A：批量生成「画像 × 主题」单场景资源（口径 metric-calibers-v1 §2A）。
 *
 * 用例集 apps/agent-engine/data/eval/adaptation_probe/profiles.json（预注册冻结）。
 * 每组 = 一次 /api/generate/scene-content 调用（单讲义场景，非全课——省成本），
 * 产物落 apps/agent-engine/data/eval/adaptation_probe/resources/<case>.json：
 *   { caseId, profileId, tier, topicId, text }   ← text 是判官盲评的唯一输入，
 * 判官脚本只读 text 字段，画像信息物理隔离在 meta 里。
 *
 * --mismatch：跑预注册的 6 组故意错配对照（profiles.json 的 mismatch_controls）。
 * 需求侧仍是 profile 的画像文案（userBio / role），但五维数值换成 serve_tier 的——
 * presentationTier / excerptDifficultyCap / excerptCodeLineCap 都只读这几个数值
 * （apps/classroom/lib/generation/learner-profile.ts），换掉它们等于强制按 serve_tier
 * 的档位指令生成。落盘的 tier 字段写 serve_tier（判官的判定靶子就是资源实际档位），
 * profileTier 另存。对照组是判官效度证据，不进 2A 分子分母。
 *
 * --spec / --domain：跑**另一个领域**的用例集（盲投泛化验收）。领域决定检索走哪个语料库
 * （引擎侧 get_corpus_retriever，未建库返回 None 且绝不回退默认语料），主题来自该域的接入报告。
 * 判据、聚合、判官阵容一个字不改——改了就不是同一把尺子，等价检验也就没意义。
 *
 * ⚠ 跑前确认 dev :3000 空闲（没课在生成）——共用生成通道。
 * 用法：node scripts/run-adaptation-probe.mjs [--base http://localhost:3000] [--concurrency 3] [--only b1:rag,...]
 *       node scripts/run-adaptation-probe.mjs --mismatch --out <dir>
 *       node scripts/run-adaptation-probe.mjs --spec profiles-odoo.json --domain odoo --out <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE_DIR = path.join(ROOT, 'apps/agent-engine/data/eval/adaptation_probe');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    // 末位布尔开关（--mismatch 收尾）原来会拿到 undefined 而不是 true
    const next = arr[i + 1];
    if (cur.startsWith('--')) acc.push([cur.slice(2), next === undefined || next.startsWith('--') ? true : next]);
    return acc;
  }, []),
);
const BASE = args.base || 'http://localhost:3000';
const CONCURRENCY = Number(args.concurrency || 3);
const OUT_DIR = typeof args.out === 'string' ? path.resolve(args.out) : path.join(PROBE_DIR, 'resources');

const SPEC_FILE = typeof args.spec === 'string' ? args.spec : 'profiles.json';
const spec = JSON.parse(fs.readFileSync(path.join(PROBE_DIR, SPEC_FILE), 'utf-8'));
// 领域决定检索走哪个语料库。命令行 > 用例集里声明的 > 默认 AI 域。
const DOMAIN = (typeof args.domain === 'string' ? args.domain : spec.domain) || 'ai';

/** 档位 → 引擎五维画像（0-4）。数值口径与 UI 前测一致。 */
const TIER_PROFILE = {
  beginner: { education: '高中/在读', programming_level: 0, python_level: 0, agent_level: 0, rag_level: 0, engineering_level: 0 },
  transition: { education: '本科', programming_level: 3, python_level: 2, agent_level: 0, rag_level: 0, engineering_level: 2 },
  advanced: { education: '本科', programming_level: 4, python_level: 3, agent_level: 3, rag_level: 2, engineering_level: 3 },
};

const byId = (arr, id) => {
  const hit = arr.find((x) => x.id === id);
  if (!hit) throw new Error(`profiles.json 里找不到 id=${id}`);
  return hit;
};

const cases = [];
if (args.mismatch) {
  // 预注册的错配对照：serveTier 决定档位指令，profile 只提供需求侧画像文案。
  for (const m of spec.mismatch_controls) {
    const profile = byId(spec.profiles, m.profile);
    cases.push({
      caseId: `${m.profile}-${m.topic}-as-${m.serve_tier}`,
      profile,
      topic: byId(spec.topics, m.topic),
      serveTier: m.serve_tier,
      note: m.note,
    });
  }
} else {
  for (const p of spec.profiles) {
    for (const t of spec.topics) {
      cases.push({ caseId: `${p.id}-${t.id}`, profile: p, topic: t });
    }
  }
}
const only = args.only ? String(args.only).split(',') : null;
const selected = only ? cases.filter((c) => only.includes(c.caseId)) : cases;

fs.mkdirSync(OUT_DIR, { recursive: true });

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractText(content) {
  const elements = content?.canvas?.elements ?? content?.elements ?? [];
  return elements
    .filter((el) => el?.type === 'text' && typeof el.content === 'string')
    .map((el) => stripHtml(el.content))
    .join('\n')
    .trim();
}

async function runCase(c) {
  const outFile = path.join(OUT_DIR, `${c.caseId}.json`);
  if (fs.existsSync(outFile)) {
    console.log(`[skip] ${c.caseId} 已存在`);
    return { caseId: c.caseId, ok: true, skipped: true };
  }
  const outline = {
    id: `probe-${c.caseId}`,
    title: c.topic.requirement.replace(/^讲清楚|^讲一节/, '').slice(0, 24) || c.topic.id,
    type: 'slide',
    description: c.topic.requirement,
  };
  const body = {
    outline,
    allOutlines: [outline],
    stageId: `adaptation-probe-${c.caseId}`,
    stageInfo: { name: `适配探针 ${c.topic.id}` },
    languageDirective: '全程使用简体中文',
    requirements: {
      requirement: c.topic.requirement,
      userBio: c.profile.persona,
      // 错配模式：画像文案照旧，五维数值换成 serveTier 的 —— 姿态档/摘录难度上限/
      // 摘录代码行数上限三处全部由这几个数值算出，一处换全链路跟着换。
      learnerProfile: {
        domain: DOMAIN,
        role: c.profile.persona,
        ...TIER_PROFILE[c.serveTier ?? c.profile.tier],
      },
    },
  };
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/generate/scene-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-locale': 'zh-CN' },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    const content = payload?.data?.content ?? payload?.data ?? payload?.content;
    const text = extractText(content);
    if (!res.ok || text.length < 200) {
      console.log(`[fail] ${c.caseId} HTTP ${res.status} textLen=${text.length}`);
      return { caseId: c.caseId, ok: false };
    }
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          caseId: c.caseId,
          profileId: c.profile.id,
          // tier = 判官该判中的靶子。错配组里资源实际就是 serveTier 那一档。
          tier: c.serveTier ?? c.profile.tier,
          ...(c.serveTier ? { profileTier: c.profile.tier, serveTier: c.serveTier, mismatchNote: c.note } : {}),
          topicId: c.topic.id,
          domain: DOMAIN,
          text,
        },
        null, 2),
      'utf-8');
    console.log(`[ok] ${c.caseId} ${Math.round((Date.now() - started) / 1000)}s ${text.length} 字`);
    return { caseId: c.caseId, ok: true };
  } catch (err) {
    console.log(`[fail] ${c.caseId} ${err}`);
    return { caseId: c.caseId, ok: false };
  }
}

const queue = [...selected];
const results = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) results.push(await runCase(queue.shift()));
  }),
);
const ok = results.filter((r) => r.ok).length;
console.log(`\n=== ${ok}/${results.length} 成功 ===`);
process.exit(ok === results.length ? 0 : 1);
