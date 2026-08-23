/**
 * 「知识库接入 → 课程生成 → 审核门 → 报告」这一条 e2e 主线用到的桩数据。
 *
 * 一条线上四个环节共用同一个语料库 id，是有意的：这条用例要证明的不是
 * 「四个页面各自能打开」，而是**接进来的那个库一路走到了报告页**。所以库名只在
 * 这里定义一次，四个环节各自从桩里取，中间任何一跳把它丢了、换了、兜底成别的库，
 * 页面上的中文名就对不上，断言当场就炸。
 */

import type { SceneAudit } from '../../../lib/generation/hallucination-audit';
import type { LearnerBlueprint } from '../../../lib/generation/learner-profile';

/** 本次接入的新库。id 必须过表单的 `[a-z0-9][a-z0-9_\-]*` 校验。 */
export const E2E_CORPUS = 'tsdb-ops';

/**
 * 这个库的中文名。**不在 `lib/knowledge/domain-labels.ts` 的硬编码表里**——
 * 只能从 `/api/domains` 的域注册清单查到。选一个表里没有的名字是故意的：
 * 页面上出现它，就说明清单真的灌进了浏览器侧的内存视图；如果哪天灌注这一跳断了，
 * 界面会退回裸英文 id `tsdb-ops`，断言随即失败——而不是悄悄兜底成别的库名。
 */
export const E2E_CORPUS_LABEL = '时序数据库运维';

/** 接入时填的领域范围，确认弹层与 run 记录都会带上它。 */
export const E2E_CORPUS_SCOPE = '时序数据库运维工程师';

/** 引擎给这次接入分配的 run 编号。形状照 `isValidRunId` 的 `[0-9A-Za-z:-]{1,64}`。 */
export const E2E_RUN_ID = '20260823T101500-e2e001';

/** 投料文件。内容不重要——桩把请求截在桥接路由之前，引擎根本收不到它。 */
export const E2E_INTAKE_FILE = {
  name: 'tsdb-ops-overview.md',
  mimeType: 'text/markdown',
  body: '# 时序数据库运维\n\n写入链路、压缩策略、扩容与巡检。\n',
};

/** `/api/domains` 的返回。形状是 `parseDomainRegistry` 的已解析态（`{entries}`）。 */
export function mockDomainRegistryResponse() {
  return {
    entries: {
      [E2E_CORPUS]: {
        corpus: E2E_CORPUS,
        label: E2E_CORPUS_LABEL,
        scope: E2E_CORPUS_SCOPE,
        chunks: 128,
        eligible: true,
      },
    },
    generated_at: '2026-08-23T10:20:00Z',
    source_run_id: E2E_RUN_ID,
  };
}

/** `/api/skills` 的返回。生成入口的知识库下拉只认这一路（拿不到才退部署期快照）。 */
export function mockSkillsResponse() {
  return {
    success: true,
    corpora: [{ corpus: E2E_CORPUS, available: true, eligible: true, chunk_count: 128 }],
  };
}

/**
 * 审核门的判词。`corpus` 由调用方传进来——传的是**页面实际发给判官的那个库名**，
 * 不是这里写死的常量。判官那一路一旦又忘了带画像（历史上真断过：换库出的课
 * 由默认语料库的判官来评），这里收到 undefined，徽标面板就印不出「取材《…》」。
 */
export function mockSceneAudit(corpus: string | undefined): SceneAudit {
  return {
    verdict: 'pass',
    claims: [
      {
        claim: '时序数据库按时间分片存储写入的数据点。',
        verdict: 'supported',
        reason: '与索引第 3 段一致。',
        sourceIds: ['S1'],
      },
    ],
    totalClaims: 1,
    flaggedCount: 0,
    uncertainCount: 0,
    incorrectCount: 0,
    judgeModel: 'e2e-judge-a',
    judgeModels: ['e2e-judge-a'],
    rounds: 1,
    durationMs: 1200,
    decision: 'publish',
    rationale: '事实性 1.00，无判错断言，直接放行。',
    grounded: true,
    ...(corpus ? { corpus } : {}),
    evidenceCount: 3,
    sources: [{ source_id: 'S1', title: '时序数据库运维手册' }],
  };
}

/** `/api/adaptive/blueprint` 的返回体里那份学情诊断。 */
export function mockLearnerBlueprint(): LearnerBlueprint {
  return {
    engine: 'llm',
    mastery_vector: { 'ts-write-path': 0.42, 'ts-compaction': 0.31 },
    weak_concepts: ['ts-compaction'],
    recommended_difficulty: 'L2',
    learning_risks: ['没有生产环境排障经验'],
    diagnosis_summary: '写入链路有概念基础，压缩与扩容是空白。',
    blueprint: {
      refined_goal: '能独立完成一次时序库扩容与巡检',
      learner_type: 'practitioner',
      skill_gaps: [
        {
          concept: 'ts-compaction',
          gap: 0.5,
          reason: '没接触过压缩策略调参',
          current_mastery: 0.31,
          target_mastery: 0.8,
          priority: 1,
        },
      ],
      content_strategy: ['先讲写入链路再讲压缩'],
      practice_strategy: ['给一份可复跑的扩容脚本'],
      assessment_strategy: ['用真实巡检指标出题'],
      resource_mix: null,
    },
  };
}
