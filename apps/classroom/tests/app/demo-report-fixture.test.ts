import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONCEPT_META } from '@/lib/knowledge/concept-labels';

/**
 * /demo/report 的正文直接印 public/demo-report.json 里的引擎自由文本
 * （`diagnosisSummary` / `learningRisks`）。那份文案是
 * scripts/generate-demo-report.mjs 从归档 run 原样抄过来的，引擎的措辞里带
 * `agent_basics` 这类内部概念 id——页面上没有任何一层会把它换成中文，
 * 所以闸设在这里：重新生成快照后这条会红，改文案再提交。
 */
const FIXTURE = join(process.cwd(), 'public', 'demo-report.json');
const data = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as {
  diagnosisSummary: string;
  learningRisks: string[];
};

describe('样例学情报告的自由文本里没有裸概念 id', () => {
  const prose = [data.diagnosisSummary, ...data.learningRisks];

  it.each(Object.keys(CONCEPT_META))('%s 不出现在正文里', (id) => {
    // `rag` 这类短 id 会撞上正常英文词，按词边界匹配（中文相邻不算边界，所以
    // 「检索增强 RAG 实践」里的 RAG 不会误伤——大小写不同，本来也不匹配）。
    const re = new RegExp(`\\b${id}\\b`);
    for (const text of prose) expect(text).not.toMatch(re);
  });
});
