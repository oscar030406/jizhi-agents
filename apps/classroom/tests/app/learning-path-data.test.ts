import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import pathData from '@/data/learning-path.json';

/**
 * 学习路径数据的完整性。
 *
 * 这份 JSON 现在被四处消费（/path 的模块分区、公共页的路径三卡与课程墙分组、
 * 登录工作台的「我的学习路径」、回填脚本），而它有两条只有测试守得住的约束：
 *
 *  1. **顺序真源唯一**：模块内的展示顺序写在 `tracks[].nodeIds` 里，节点上的 `stage`
 *     只是同一件事的冗余标注。两边对不上时页面会静默漏掉节点（既不报错也不显示）。
 *  2. **占位规范**：没生成的课必须 `courseId: null` + `status: "planned"`；有 courseId
 *     的必须在 data/classrooms 里真的落着盘。两者混淆的后果分别是——把没有的课
 *     算进「已生成 N 门」的门数里，或者渲染出一个点开就 404 的卡。
 */

interface Node {
  id: string;
  stage: string;
  title: string;
  prereq?: string[];
  courseId?: string | null;
  status?: string;
  requirement?: string;
}
interface Track {
  id: string;
  title: string;
  nodeIds: string[];
}

const data = pathData as {
  nodes: Node[];
  tracks: Track[];
  extensionDomain?: { courseIds: string[] };
};

const onDiskCourseIds = new Set(
  readdirSync(join(process.cwd(), 'data', 'classrooms'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, '')),
);

const nodeIds = new Set(data.nodes.map((n) => n.id));

describe('learning-path.json 结构', () => {
  it('节点 id 不重复', () => {
    expect(nodeIds.size).toBe(data.nodes.length);
  });

  it('tracks[].nodeIds 指到的节点都存在，且每个节点恰好挂在一个模块上', () => {
    const hung = data.tracks.flatMap((t) => t.nodeIds);
    expect(hung.filter((id) => !nodeIds.has(id))).toEqual([]);
    expect(new Set(hung).size).toBe(hung.length);
    expect([...nodeIds].filter((id) => !hung.includes(id))).toEqual([]);
  });

  it('节点的 stage 与它被挂上的模块 id 一致（顺序真源是 nodeIds，stage 只是冗余标注）', () => {
    const mismatched = data.tracks.flatMap((t) =>
      t.nodeIds
        .map((id) => data.nodes.find((n) => n.id === id))
        .filter((n): n is Node => Boolean(n) && n!.stage !== t.id)
        .map((n) => `${n.id}: stage=${n.stage} 挂在 ${t.id}`),
    );
    expect(mismatched).toEqual([]);
  });

  it('prereq 全部指向存在的节点，且不自指', () => {
    const broken = data.nodes.flatMap((n) =>
      (n.prereq ?? [])
        .filter((p) => !nodeIds.has(p) || p === n.id)
        .map((p) => `${n.id} → ${p}`),
    );
    expect(broken).toEqual([]);
  });

  it('prereq 链无环', () => {
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];
    const walk = (id: string, trail: string[]) => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') {
        cycles.push([...trail, id].join(' → '));
        return;
      }
      state.set(id, 'visiting');
      for (const p of byId.get(id)?.prereq ?? []) walk(p, [...trail, id]);
      state.set(id, 'done');
    };
    for (const n of data.nodes) walk(n.id, []);
    expect(cycles).toEqual([]);
  });
});

describe('learning-path.json 占位规范', () => {
  it('有 courseId 的节点，课必须真的落在盘上', () => {
    const dangling = data.nodes
      .filter((n) => n.courseId && !onDiskCourseIds.has(n.courseId))
      .map((n) => `${n.id} → ${n.courseId}`);
    expect(dangling).toEqual([]);
  });

  it('没有 courseId 的节点一律 status=planned，且带一句 requirement 草案', () => {
    const bad = data.nodes
      .filter((n) => !n.courseId)
      .filter((n) => n.status !== 'planned' || !n.requirement?.trim())
      .map((n) => n.id);
    expect(bad).toEqual([]);
  });

  it('已经有课的节点不许还标着 planned', () => {
    const bad = data.nodes.filter((n) => n.courseId && n.status === 'planned').map((n) => n.id);
    expect(bad).toEqual([]);
  });

  it('扩展域的课在盘上，且不与主线节点重复挂课', () => {
    const ext = data.extensionDomain?.courseIds ?? [];
    expect(ext.filter((id) => !onDiskCourseIds.has(id))).toEqual([]);
    const mainCourseIds = new Set(data.nodes.map((n) => n.courseId).filter(Boolean));
    expect(ext.filter((id) => mainCourseIds.has(id))).toEqual([]);
  });
});
