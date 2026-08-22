#!/usr/bin/env node
/**
 * 生成未登录可见的静态样例学情报告数据（public/demo-report.json）。
 *
 * 数据全部取自引擎归档 run（apps/agent-engine/data/runs/*.json，本身就是
 * 完整 IO 快照），零模型调用、零 API 成本。挑选规则与
 * scripts/export-submission-data.py 一致：优先真 LLM 生成
 * （trace 里 ResourceGenerationAgent engine=llm），排除确定性模板兜底
 * （正文含「的证据要点：」），带辩论回合加分；同分取归档时间最新的。
 *
 * 画像名用引擎预设画像的名称（learner_profiles.json），不编人名。
 *
 * 用法：node scripts/generate-demo-report.mjs
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');
const RUNS_DIR = path.join(REPO, 'apps', 'agent-engine', 'data', 'runs');
const PROFILES_PATH = path.join(
  REPO,
  'apps',
  'agent-engine',
  'data',
  'learner_profiles',
  'learner_profiles.json',
);
const OUT_PATH = path.join(HERE, '..', 'public', 'demo-report.json');

/** 确定性模板兜底的指纹（与 export-submission-data.py 同一口径） */
const TEMPLATE_MARKER = '的证据要点：';

async function pickBestRun() {
  const files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith('.json'));
  let best = null; // { score, mtimeMs, runId, run }
  for (const file of files) {
    const full = path.join(RUNS_DIR, file);
    let run;
    try {
      run = JSON.parse(await readFile(full, 'utf-8'));
    } catch {
      continue;
    }
    if (!run || typeof run !== 'object') continue;
    const mastery = run.diagnosis?.mastery_vector;
    // 三张图的最低数据要求：掌握度向量 + 学习路径 + 资源难度
    if (!mastery || Object.keys(mastery).length === 0) continue;
    if (!Array.isArray(run.learning_path?.learning_path) || !run.learning_path.learning_path.length)
      continue;
    if (!Array.isArray(run.resources?.graded_quiz) || !run.resources.graded_quiz.length) continue;
    if (!run.learner_profile_id) continue;

    const genLlm = (run.trace ?? []).some(
      (step) =>
        step?.agent === 'ResourceGenerationAgent' && String(step?.artifacts?.engine) === 'llm',
    );
    const body = JSON.stringify(run.resources ?? {});
    const score =
      (genLlm ? 4 : 0) +
      (body.includes(TEMPLATE_MARKER) ? 0 : 2) +
      (Array.isArray(run.debate) && run.debate.length > 0 ? 1 : 0);
    const { mtimeMs } = await stat(full);
    if (!best || score > best.score || (score === best.score && mtimeMs > best.mtimeMs)) {
      best = { score, mtimeMs, runId: run.run_id ?? file.replace(/\.json$/, ''), run };
    }
  }
  if (!best) throw new Error(`在 ${RUNS_DIR} 里没找到满足三图数据要求的 run`);
  return best;
}

async function loadProfile(profileId) {
  const data = JSON.parse(await readFile(PROFILES_PATH, 'utf-8'));
  const items = Array.isArray(data) ? data : (data.profiles ?? []);
  const hit = items.find((p) => p.id === profileId);
  if (!hit) throw new Error(`预设画像 ${profileId} 不在 ${PROFILES_PATH}`);
  return hit;
}

async function main() {
  const { score, mtimeMs, runId, run } = await pickBestRun();
  const profile = await loadProfile(run.learner_profile_id);
  const diagnosis = run.diagnosis;
  const lp = run.learning_path;

  // 图2数据：本 run 里所有带记录难度的资源条目（分阶测验题 + 路径阶段），
  // 一条不造——难度全部是引擎当时写进 run 的原值。
  const difficultyItems = [
    ...run.resources.graded_quiz.map((q, i) => ({
      kind: 'quiz',
      label: `测验 ${i + 1} · ${String(q.question ?? '').slice(0, 24)}`,
      difficulty: q.difficulty,
    })),
    ...lp.learning_path.map((s) => ({
      kind: 'stage',
      label: s.title,
      difficulty: s.difficulty,
    })),
  ].filter((it) => /^L[1-4]$/.test(String(it.difficulty)));

  const payload = {
    profile: {
      presetId: profile.id,
      name: profile.name,
      background: profile.background ?? '',
    },
    learningGoal: run.learning_goal ?? '',
    diagnosisSummary: diagnosis.diagnosis_summary ?? '',
    learningRisks: diagnosis.learning_risks ?? [],
    masteryVector: diagnosis.mastery_vector,
    weakConcepts: diagnosis.weak_concepts ?? [],
    difficultyBand: {
      recommended: diagnosis.recommended_difficulty ?? 'L2',
      items: difficultyItems,
    },
    learningPath: {
      stages: lp.learning_path.map((s) => ({
        title: s.title,
        difficulty: s.difficulty,
        goals: s.goals ?? [],
        concepts: s.concepts ?? [],
        estimatedHours: s.estimated_hours ?? null,
        practiceTask: s.practice_task ?? '',
        assessment: s.assessment ?? '',
      })),
      prerequisites: lp.prerequisites ?? [],
      estimatedHours: lp.estimated_time ?? null,
    },
    source: {
      runId,
      archivedAt: new Date(mtimeMs).toISOString(),
      engines: Object.fromEntries(
        (run.trace ?? []).map((t) => [t.agent, String(t.artifacts?.engine ?? '')]),
      ),
    },
  };

  await writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log(
    `已写入 ${OUT_PATH}\n  run：${runId}（挑选得分 ${score}）\n  画像：${profile.name}` +
      `\n  概念：${Object.keys(payload.masteryVector).length} 个（薄弱 ${payload.weakConcepts.length}）` +
      `\n  难度条目：${difficultyItems.length} 条；路径阶段：${payload.learningPath.stages.length} 个`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
