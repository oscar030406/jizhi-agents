import { describe, expect, it } from 'vitest';

import raw from '@/lib/evidence/data/scene-concepts.json';
import {
  pickPrimaryConcept,
  resolveConcept,
  sceneConceptsFromChunks,
} from '@/lib/evidence/scene-concepts';

/**
 * 生成期概念标签（WO-B1）。
 *
 * 判据不是这里发明的：`apps/agent-engine/scripts/experiments/derive_scene_concepts.py`
 * 已经定了口径——**按 chunk 计票**（同一个 chunk 只算一次），取票数最高者为主概念，
 * 并列按名字定序。这里只是把同一条规则挪到生成时执行，输入从「审核判词回溯出的
 * sourceIds」换成「检索当时给的候选块」。
 */

const table = (raw as { scenes: Record<string, { concept: string; votes: Record<string, number> }> })
  .scenes;

describe('按 chunk 计票', () => {
  it('一个概念被几个不同的 chunk 支撑就是几票', () => {
    const got = sceneConceptsFromChunks([
      { source_id: 'a', concept_tags: ['rag', 'llm_basics'] },
      { source_id: 'b', concept_tags: ['rag'] },
      { source_id: 'c', concept_tags: ['rag'] },
    ]);
    expect(got).toEqual({
      concept: 'rag',
      votes: { rag: 3, llm_basics: 1 },
      citedChunks: 3,
    });
  });

  it('同一个 chunk 重复出现只算一次——重复引用不代表它更重要', () => {
    const got = sceneConceptsFromChunks([
      { source_id: 'a', concept_tags: ['rag'] },
      { source_id: 'a', concept_tags: ['rag'] },
      { source_id: 'b', concept_tags: ['agent'] },
    ]);
    expect(got?.votes).toEqual({ agent: 1, rag: 1 });
    expect(got?.citedChunks).toBe(2);
  });

  it('票数并列取字典序在前的，保证同一份输入永远同一个主概念', () => {
    const forward = sceneConceptsFromChunks([
      { source_id: 'a', concept_tags: ['rag'] },
      { source_id: 'b', concept_tags: ['agent'] },
    ]);
    const reversed = sceneConceptsFromChunks([
      { source_id: 'b', concept_tags: ['agent'] },
      { source_id: 'a', concept_tags: ['rag'] },
    ]);
    expect(forward?.concept).toBe('agent');
    expect(reversed?.concept).toBe('agent');
  });

  it('算不出标签就返回 null——调用方据此整个字段不写，不落空对象', () => {
    expect(sceneConceptsFromChunks([])).toBeNull();
    expect(sceneConceptsFromChunks([{ source_id: 'a' }])).toBeNull();
    expect(sceneConceptsFromChunks([{ source_id: 'a', concept_tags: [] }])).toBeNull();
    // 没有 source_id 的块无法去重，跳过而不是猜一个 id
    expect(sceneConceptsFromChunks([{ concept_tags: ['rag'] }])).toBeNull();
  });
});

describe('与 derive_scene_concepts.py 的对照', () => {
  it('拿脚本产出的真票数重跑选主概念，160 行全部同解', () => {
    const rows = Object.entries(table);
    expect(rows.length).toBe(160);
    const mismatched = rows.filter(([, row]) => {
      // 表里的 votes 已经是脚本排好序的；倒过来喂，才真的在考并列定序，
      // 而不是在考「稳定排序有没有原样保留顺序」。
      const shuffled = Object.fromEntries(Object.entries(row.votes).reverse());
      return pickPrimaryConcept(shuffled) !== row.concept;
    });
    expect(mismatched.map(([id]) => id)).toEqual([]);
  });

  it('这份对照里确实有并列的行，否则测的就不是定序规则', () => {
    const tied = Object.values(table).filter((row) => {
      const counts = Object.values(row.votes);
      return counts.length > 1 && counts[0] === counts[1];
    });
    // 160 行里 31 行首位并列（脚本产出的真实分布）
    expect(tied.length).toBe(31);
  });
});

describe('resolveConcept 新增的一级', () => {
  it('场景自带概念压过其它三级，来源标成 generated', () => {
    expect(
      resolveConcept({
        sceneConcept: 'rag',
        engineConcept: 'attention',
        sceneId: 'scene_8JNE3hQ_Mp',
        sceneTitle: '随便',
      }),
    ).toEqual({ concept: 'rag', source: 'generated' });
  });

  it('没有这个字段就跳过这一级，行为与本级加入之前一致', () => {
    expect(resolveConcept({ engineConcept: 'attention', sceneTitle: '随便' })).toEqual({
      concept: 'attention',
      source: 'engine',
    });
    expect(resolveConcept({ sceneConcept: '   ', sceneTitle: '课程介绍' })).toEqual({
      concept: '课程介绍',
      source: 'title',
    });
  });
});
