/**
 * 场景 → 知识点。证据归拢的单位由这里定。
 *
 * ## 病灶
 *
 * 图纸 §十 偏差 8（账本 F3）：**四种交互的证据各走各的，没挂到同一知识点**。
 * `from-quiz.ts` 与 `from-tutor.ts` 原来把 `measured.concept` 写成**场景标题**——
 * 同一个知识点上的测验证据与导学证据落在两个不同的键上，永远不会合流，
 * 置信度因此涨不起来，多形态证据的价值拿不到。
 *
 * ## 判据不是标题，是引用
 *
 * 试过拿引擎 `goal_concepts.py` 的关键词表把标题映射成概念，
 * **实测 212 个真实场景标题只解析出 18.4%**——那张表是解析「我想学 RAG」这类
 * 学习目标用的。真实标题是「课程介绍」「知识检查点」「学习率的影响」，本来就不含概念词。
 *
 * 改判据：场景审核账单里每条判词带 `sourceIds`，而每个教材 chunk 自带 `concept_tags`。
 * 「这个场景讲什么」从**它实际引用了什么**推出来。实测覆盖 **160/212 = 75.5%**。
 *
 * 映射表由 `apps/agent-engine/scripts/experiments/derive_scene_concepts.py` 生成，
 * 与 `lib/generation/data/prereq-graph.json` 同一个模式：脚本产出、静态 import、
 * 前端可用。判据与局限写在脚本的模块头与 JSON 的 `_meta` 里。
 *
 * ## 一个场景挂多个概念时只取主概念
 *
 * 实测 160 个已解析场景里 77 个挂 ≥2 个概念。**不给每个概念各记一条证据**——
 * `selection.ts` 的 `predictedCorrect` 注释里写着这个坑（D-20b）：一道挂 3 KC 的
 * 四选一答对，每条证据各涨一次会把 1.28 的 log-odds 算成 3.84。要正确摊分得有
 * 逐 KC 判定，而选择题只有对错。所以取被引用最多的那个概念，其余落盘供追溯、不参与归拢。
 *
 * ## 取不到时退回标题——而且必须能看出来
 *
 * 新生成的课不在这份映射里（脚本只扫已落库的课）。这时退回场景标题，
 * 与改动之前的行为一致，**不静默假装归拢成功**：调用方拿 {@link conceptSourceOf}
 * 就知道这条证据的键是概念还是标题。
 */

import raw from './data/scene-concepts.json';

/**
 * 一个场景的概念标签。事后反推表（本文件的 JSON）与生成期写进场景的
 * `Scene.concepts` 用**同一个形状**，读的人不用分两套。
 */
export interface SceneConcepts {
  /** 主概念：票数最高者，并列按名字定序。 */
  concept: string;
  /** 每个概念的 chunk 票数，供追溯；不参与归拢。 */
  votes: Record<string, number>;
  citedChunks: number;
}

const TABLE = (raw as { scenes?: Record<string, SceneConcepts> }).scenes ?? {};

/**
 * 这条证据的归拢键是怎么来的。`title` = 退化路径，别当成归拢成功。
 * `generated` = 生成时就写进场景的标签（新课走这条），见 {@link sceneConceptsFromChunks}。
 */
export type ConceptSource = 'generated' | 'cited-chunks' | 'engine' | 'title';

/**
 * 票数最高的概念，并列按名字定序。
 *
 * 定序规则与 `apps/agent-engine/scripts/experiments/derive_scene_concepts.py` 的
 * `sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))` 逐条对齐：先票数降序，
 * 再**按码点**升序。这里刻意不用 `localeCompare`——它随 locale 变，Python 那边是
 * 码点比较，两边会在同一份输入上给出不同的主概念。
 */
export function pickPrimaryConcept(votes: Record<string, number>): string | null {
  let best: string | null = null;
  let bestVotes = -1;
  for (const [name, count] of Object.entries(votes)) {
    if (count > bestVotes || (count === bestVotes && best !== null && name < best)) {
      best = name;
      bestVotes = count;
    }
  }
  return best;
}

/**
 * 生成期的概念标签：从这次检索真的取到的教材 chunk 上算出来。
 *
 * 口径与 `derive_scene_concepts.py` 同源——**按 chunk 计票**（同一个 chunk 只算一次，
 * 一个概念被几个不同的 chunk 支撑就是几票），取票数最高者为主概念，并列按名字定序。
 * 区别只在计票的输入：脚本用的是审核判词回溯出的 `sourceIds`，这里用的是生成当时
 * 检索给的候选块——生成时还没有判词。
 *
 * 一条标签都算不出来（没证据 / 块上没有 `concept_tags`）就返回 `null`，
 * 调用方据此**整个字段不写**，不落空对象占位。
 */
export function sceneConceptsFromChunks(
  chunks: ReadonlyArray<{ source_id?: string; concept_tags?: string[] }>,
): SceneConcepts | null {
  const votes: Record<string, number> = {};
  const cited = new Set<string>();
  for (const chunk of chunks) {
    const id = chunk.source_id;
    if (!id || cited.has(id)) continue;
    cited.add(id);
    for (const tag of chunk.concept_tags ?? []) {
      if (tag) votes[tag] = (votes[tag] ?? 0) + 1;
    }
  }
  const concept = pickPrimaryConcept(votes);
  if (!concept) return null;
  const ordered = Object.entries(votes).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { concept, votes: Object.fromEntries(ordered), citedChunks: cited.size };
}

/**
 * 场景对应的知识点。表里没有就返回 null——**不猜**。
 */
export function conceptForScene(sceneId: string | undefined): string | null {
  if (!sceneId) return null;
  return TABLE[sceneId]?.concept ?? null;
}

/**
 * 归拢键 + 它的来源，一次给出。
 *
 * 优先级：场景自带的生成期概念 > 引擎判词里直接给的 > 引用推出来的 > 场景标题。
 *
 * 生成期概念排最前，是因为它就是这一页**当时真的检索到什么**的记录，不是事后回溯；
 * 而且它覆盖新课，反推表只覆盖已落库的课。引擎那一路次之——判官逐条出的结论
 * （`from-tutor` 的 `profile_evidence.concept`）比我们从引用反推的硬。
 *
 * `sceneConcept` 缺省（老课、或生成时引擎离线）就跳过这一级，行为与本级加入之前一致。
 */
export function resolveConcept(input: {
  /** 场景自带的主概念，即 `Scene.concepts.concept`。老课没有这个字段。 */
  sceneConcept?: string | null;
  engineConcept?: string | null;
  sceneId?: string;
  sceneTitle?: string;
}): { concept: string; source: ConceptSource } | null {
  const generated = input.sceneConcept?.trim();
  if (generated) return { concept: generated, source: 'generated' };
  const engine = input.engineConcept?.trim();
  if (engine) return { concept: engine, source: 'engine' };
  const derived = conceptForScene(input.sceneId);
  if (derived) return { concept: derived, source: 'cited-chunks' };
  const title = input.sceneTitle?.trim();
  if (title) return { concept: title, source: 'title' };
  return null;
}

/** 该场景引用推出的全部概念及票数，供界面展开追溯用。 */
export function conceptVotesForScene(sceneId: string | undefined): Record<string, number> {
  if (!sceneId) return {};
  return TABLE[sceneId]?.votes ?? {};
}

/** 映射表覆盖了多少场景。对外报覆盖率时用这个数，不要手写。 */
export function sceneConceptTableSize(): number {
  return Object.keys(TABLE).length;
}
