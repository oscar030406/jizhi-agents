/**
 * E3 原型：接地拼装课（不造事实，只造衔接）。
 *
 * 假设：密度已经存在于教材语料里，不需要被生成，需要被搬运。
 * 生成模型只干三件事：选段、写衔接（面向画像）、出练习。
 * 事实性内容 100% 来自教材原文摘录，逐段带出处——幻觉审核退化为
 * 「生成段是否与摘录矛盾」，事实层没有幻觉可言。
 *
 * 与 fork 的对照关系：同一个生成模型（Qwen3.5-397B）、同一个主题、
 * 相近的总篇幅（按 fork 中位数配预算）。唯一变量是「生成 vs 拼装」。
 *
 * 用法：
 *   node scripts/learning_eval/assemble_course.mjs --label e3_r1
 *   node scripts/learning_eval/assemble_course.mjs --label e3_r2 --temperature 0.7
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { callLLM } from './llm.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const ROOT = path.resolve(process.cwd(), '../..');
const TEXTBOOK = args.textbook || path.join(ROOT, 'data/eval/baseline/textbook_ch3.txt');
const OUT_DIR = args.out || path.join(process.cwd(), 'data/eval/zero_prior');
const LABEL = args.label || 'e3_r1';
// 与 fork 同一个生成模型——E3 验的是架构差异，模型必须钉住
const MODEL = args.model || 'Qwen/Qwen3.5-397B-A17B';
const TEMPERATURE = Number(args.temperature ?? 0.5);
// 摘录预算：fork 重抽后中位数约 5.5k 字，衔接+练习占掉 ~1.5k，摘录给 4.2k
const EXCERPT_BUDGET = Number(args.budget || 4200);

/** 教材切段：页标记之间按空行切，保留页码做出处 */
function splitParagraphs(text) {
  const paras = [];
  let page = '?';
  for (const block of text.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t) continue;
    const pm = t.match(/=====\s*教材第\s*(\d+)\s*页/);
    if (pm) { page = pm[1]; continue; }
    if (t.length < 30) continue;          // 页眉碎渣
    paras.push({ id: `P${String(paras.length + 1).padStart(3, '0')}`, page, text: t });
  }
  return paras;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const textbook = readFileSync(TEXTBOOK, 'utf8');
  const paras = splitParagraphs(textbook);
  console.log(`[${LABEL}] 教材切成 ${paras.length} 段，模型 ${MODEL}，摘录预算 ${EXCERPT_BUDGET} 字`);

  const catalog = paras.map((p) => `${p.id}(第${p.page}页,${p.text.length}字): ${p.text.slice(0, 80)}`).join('\n');

  const system = [
    '你是一名课程编排师。你的任务不是写教学内容，是从教材里**选段拼课**。',
    '',
    '铁律：',
    '1. 所有事实性内容（定义、公式、推导、代码、数字）必须来自教材摘录，你自己只写',
    '   衔接语和练习。你写的部分不许引入教材段落里没有的事实、数字或公式。',
    '2. 选段要选**承载推导和因果**的段落：手算例子、"为什么这样做"、不做会怎样。',
    '   只挑结论句的选法是失败的选法。',
    '3. 衔接语面向零基础学习者：说清"上一段讲了什么、下一段为什么要看、看的时候注意什么"。',
    '4. 每节配一道练习（不是概念复述题，要"算一下/改一下/预测一下"型），并给参考答案要点。',
  ].join('\n');

  const prompt = [
    '主题：注意力机制（自注意力 / 缩放 / 因果掩码 / 多头）。学习者：零基础转行者。',
    `摘录总预算：${EXCERPT_BUDGET} 字以内（超了会被机械截断，宁可少选选精）。`,
    '',
    '教材段落目录（id / 页码 / 字数 / 开头 80 字）：',
    catalog,
    '',
    '设计 5-6 节课。严格输出 JSON：',
    '{"sections":[{"title":"节标题","why_these":"为什么选这些段（一句话）",',
    '"excerpt_ids":["P012","P013"],"bridge":"2-4 句衔接语",',
    '"exercise":{"q":"练习题","key":"参考答案要点"}}]}',
  ].join('\n');

  const raw = await callLLM(MODEL, system, prompt, { temperature: TEMPERATURE, maxTokens: 4000 });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`拼装计划不是 JSON：${raw.slice(0, 300)}`);
  const plan = JSON.parse(m[0]);
  const byId = new Map(paras.map((p) => [p.id, p]));

  const parts = [];
  let used = 0;
  let dropped = 0;
  for (const [i, sec] of (plan.sections ?? []).entries()) {
    parts.push(`\n===== 第 ${i + 1} 节：${sec.title} =====`);
    if (sec.bridge) parts.push(`[导读] ${sec.bridge}`);
    for (const id of sec.excerpt_ids ?? []) {
      const p = byId.get(id);
      if (!p) continue;
      if (used + p.text.length > EXCERPT_BUDGET) { dropped++; continue; }   // 预算是硬的
      used += p.text.length;
      parts.push(`[教材摘录·第${p.page}页] ${p.text}`);
    }
    if (sec.exercise?.q) {
      parts.push(`[练习] ${sec.exercise.q}`);
      if (sec.exercise.key) parts.push(`[参考要点] ${sec.exercise.key}`);
    }
  }
  const materials = parts.join('\n');
  writeFileSync(path.join(OUT_DIR, `${LABEL}.materials.txt`), materials, 'utf8');
  writeFileSync(path.join(OUT_DIR, `${LABEL}.plan.json`), JSON.stringify({ label: LABEL, model: MODEL, plan }, null, 2), 'utf8');
  console.log(`[${LABEL}] 完成：${plan.sections?.length ?? 0} 节，摘录 ${used} 字（预算内丢弃 ${dropped} 段），总长 ${materials.length} 字`);
  console.log(`  → ${path.join(OUT_DIR, `${LABEL}.materials.txt`)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
