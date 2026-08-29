/**
 * 双判官交叉验证消融：对照臂 A（单判官） vs 实验臂 B（双判官+答辩+仲裁）。
 *
 * 被测对象是 OpenMAIC 的 auditSceneContent（原样 import，不改一行）。两臂在同一
 * 进程里跑，喂完全相同的 scene content 与 evidence（每场景检索一次后缓存复用）。
 *
 * 跑法（必须剥代理，且 cwd 必须是 OpenMAIC —— tsx 靠那里的 tsconfig 解析 @/ 别名）：
 *   cd "D:/UserData/Desktop/挑战杯/apps/classroom"
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy NO_PROXY="*" \
 *     node --import tsx "D:/UserData/Desktop/挑战杯/apps/agent-engine/scripts/experiments/run_cross_validation_ablation.mjs"
 *
 * 可选参数：--only s01,s02   只跑指定场景
 *           --arms A         只跑指定臂
 *           --out <path>     换产物路径（默认 cross_validation_runs.json）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 锚定脚本自身位置，不写机器路径（L9）：scripts/experiments/ -> 引擎根 -> apps
const ENGINE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OPENMAIC = `${dirname(ENGINE_ROOT)}/classroom`;
const DATA_DIR = `${ENGINE_ROOT}/data/experiments`;
const TRUTH_SET = `${DATA_DIR}/claim_truth_set.json`;

// 判官换型对比（08-03）：JUDGE_1 可由 env 覆盖，其余不动——
// 候选逐个跑臂 A（产品真实审核链口径），与 7-29 GLM-5.2 基线同表对比。
const JUDGE_1 = process.env.JUDGE_1_MODEL || 'zai-org/GLM-5.2';
const JUDGE_2 = 'deepseek-ai/DeepSeek-V3.2';
const ARBITER = 'deepseek-ai/DeepSeek-V3.2';
const GENERATOR = 'Qwen/Qwen3-30B-A3B-Instruct-2507';

const GROUNDING_URL = 'http://127.0.0.1:8001';
const GROUNDING_TOKEN = 'demo-internal-token';
const TOP_K = 6;
const MAX_CHUNK_CHARS = 700; // 与 lib/generation/evidence-grounding.ts 一致

const SF_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const CALL_TIMEOUT_MS = 300_000;
const MAX_CALL_ATTEMPTS = 3; // 首次 + 2 次重试
const MAX_ARM_ATTEMPTS = 3;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = arg('--out', `${DATA_DIR}/cross_validation_runs.json`);
const ONLY = arg('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ARMS = arg('--arms', 'A,B')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const apiKey = /^SILICONFLOW_API_KEY=(.+)$/m.exec(readFileSync(`${OPENMAIC}/.env.local`, 'utf8'))?.[1]?.trim();
if (!apiKey) throw new Error('SILICONFLOW_API_KEY not found in OpenMAIC/.env.local');

const { auditSceneContent } = await import(
  pathToFileURL(`${OPENMAIC}/lib/generation/hallucination-audit.ts`).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OpenAI 兼容端点直调，temperature 锁 0。调用轨迹全部写进 log。 */
function mkCall(model, log, tag) {
  return async (system, user) => {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_CALL_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      try {
        const resp = await fetch(SF_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 8192,
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
        const msg = payload.choices?.[0]?.message ?? {};
        const text = msg.content ?? '';
        log.push({
          tag,
          model,
          attempt,
          ms: Date.now() - t0,
          promptChars: system.length + user.length,
          finishReason: payload.choices?.[0]?.finish_reason ?? null,
          usage: payload.usage ?? null,
          raw: text,
          ...(msg.reasoning_content ? { reasoningChars: String(msg.reasoning_content).length } : {}),
        });
        return text;
      } catch (err) {
        lastErr = err;
        log.push({ tag, model, attempt, ms: Date.now() - t0, error: String(err) });
        if (attempt < MAX_CALL_ATTEMPTS) await sleep(2000 * attempt);
      }
    }
    throw lastErr;
  };
}

/** 受控知识库检索：每场景一次，两臂共用。 */
async function fetchEvidence(query) {
  const url = `${GROUNDING_URL}/internal/v1/personalize/evidence?${new URLSearchParams({
    query,
    top_k: String(TOP_K),
    corpus: 'default',
  })}`;
  const resp = await fetch(url, {
    headers: { 'x-internal-token': GROUNDING_TOKEN },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`evidence HTTP ${resp.status}`);
  const chunks = (await resp.json()).data?.chunks ?? [];
  if (chunks.length === 0) throw new Error(`evidence empty for query: ${query}`);
  return {
    chunks,
    // 与 evidenceForJudge() 逐字一致的拼法
    text: chunks
      .map((c) => `[${c.source_id}] ${c.title}：${c.content.slice(0, MAX_CHUNK_CHARS)}`)
      .join('\n'),
    sources: chunks.map((c) => ({ source_id: c.source_id, title: c.title })),
  };
}

/**
 * 两臂唯一的差别就是判官面板/仲裁/答辩的配置，其余入参逐字相同。
 *
 * sceneType 固定 'interactive'：它不改判官提示词（只有 'quiz' 会加附加段），
 * 但会关掉「改写内容 + 二轮复审」。这是必要的——真值标签贴在原始断言上，
 * 一旦内容被改写，第二轮判定的就是另一段文本，标签失效、两臂不可比。
 * 本实验测的是判官判定准确率，不是端到端内容改进。
 */
function armOptions(arm, scene, evidence, log) {
  const base = {
    sceneTitle: scene.title,
    content: scene.content,
    sceneType: 'interactive',
    evidence: evidence.text,
    evidenceCount: evidence.chunks.length,
    sources: evidence.sources,
  };
  if (arm === 'A') {
    return {
      ...base,
      judgeCalls: [mkCall(JUDGE_1, log, 'judge1')],
      judgeModel: JUDGE_1,
      judgeModels: [JUDGE_1],
    };
  }
  return {
    ...base,
    judgeCalls: [mkCall(JUDGE_1, log, 'judge1'), mkCall(JUDGE_2, log, 'judge2')],
    arbiterCall: mkCall(ARBITER, log, 'arbiter'),
    reviseCall: mkCall(GENERATOR, log, 'defense'),
    judgeModel: JUDGE_1,
    judgeModels: [JUDGE_1, JUDGE_2],
    arbiterModel: ARBITER,
  };
}

const armConfig = (arm) =>
  arm === 'A'
    ? { arm: 'A', label: '单判官（对照）', judges: [JUDGE_1], arbiter: null, defender: null }
    : {
        arm: 'B',
        label: '双判官交叉验证+答辩+仲裁（实验）',
        judges: [JUDGE_1, JUDGE_2],
        arbiter: ARBITER,
        defender: GENERATOR,
      };

async function runArm(arm, scene, evidence) {
  for (let attempt = 1; attempt <= MAX_ARM_ATTEMPTS; attempt++) {
    const log = [];
    const t0 = Date.now();
    try {
      const { audit } = await auditSceneContent(armOptions(arm, scene, evidence, log));
      const durationMs = Date.now() - t0;
      // auditSceneContent 从不抛错：审核基建失败会退化成 flagged + 0 条断言。
      const failed = audit.verdict === 'flagged' && audit.totalClaims === 0;
      if (failed && attempt < MAX_ARM_ATTEMPTS) {
        console.log(`    [${scene.id}/${arm}] audit infrastructure failure, retry ${attempt}`);
        await sleep(3000 * attempt);
        continue;
      }
      return {
        ...armConfig(arm),
        attempt,
        durationMs,
        audit,
        calls: log,
        ...(failed ? { error: 'audit failed: flagged with zero claims (infrastructure)' } : {}),
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      if (attempt < MAX_ARM_ATTEMPTS) {
        console.log(`    [${scene.id}/${arm}] threw: ${String(err)} — retry ${attempt}`);
        await sleep(3000 * attempt);
        continue;
      }
      return { ...armConfig(arm), attempt, durationMs, error: String(err), calls: log };
    }
  }
}

const dataset = JSON.parse(readFileSync(TRUTH_SET, 'utf8'));
const scenes = dataset.scenes.filter((s) => ONLY.length === 0 || ONLY.includes(s.id));

const out = {
  meta: {
    startedAt: new Date().toISOString(),
    truthSet: TRUTH_SET,
    auditModule: `${OPENMAIC}/lib/generation/hallucination-audit.ts`,
    script: 'apps/agent-engine/scripts/experiments/run_cross_validation_ablation.mjs',
    arms: { A: armConfig('A'), B: armConfig('B') },
    settings: {
      temperature: 0,
      maxTokens: 8192,
      topK: TOP_K,
      sceneType: 'interactive',
      sceneTypeNote:
        "固定 interactive 以关闭改写+二轮复审：真值标签贴在原始断言上，改写后标签失效。judge 提示词不受 sceneType 影响（只有 quiz 会加附加段），两臂设置完全一致。",
      evidenceNote: '每场景检索一次并缓存，两臂共用同一份 evidence 文本。',
    },
    armsRun: ARMS,
  },
  scenes: [],
};

mkdirSync(dirname(OUT), { recursive: true });
const flush = () => writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

for (const scene of scenes) {
  console.log(`[${scene.id}] ${scene.title}`);
  const record = { id: scene.id, title: scene.title, evidenceQuery: scene.evidence_query, runs: {} };
  try {
    const evidence = await fetchEvidence(scene.evidence_query);
    record.evidence = {
      chunkCount: evidence.chunks.length,
      sourceIds: evidence.sources.map((s) => s.source_id),
      text: evidence.text,
    };
    for (const arm of ARMS) {
      const t0 = Date.now();
      const result = await runArm(arm, scene, evidence);
      record.runs[arm] = result;
      console.log(
        `    arm ${arm}: ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          (result.error
            ? `ERROR ${result.error}`
            : `claims=${result.audit.totalClaims} verdict=${result.audit.verdict} ` +
              `decision=${result.audit.decision} disputes=${result.audit.debate?.length ?? '-'}`),
      );
      flush();
    }
  } catch (err) {
    record.error = String(err);
    console.log(`    scene failed: ${String(err)}`);
  }
  out.scenes.push(record);
  flush();
}

out.meta.finishedAt = new Date().toISOString();
out.meta.totalMs = {
  A: out.scenes.reduce((n, s) => n + (s.runs?.A?.durationMs ?? 0), 0),
  B: out.scenes.reduce((n, s) => n + (s.runs?.B?.durationMs ?? 0), 0),
};
flush();
console.log(`\nwrote ${OUT}`);
