import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import pathData from '@/data/learning-path.json';

/**
 * 学习路径数据的完整性。
 *
 * 这份 JSON 是「人工智能应用开发」学习路径的单一真源：首页课程墙、
 * `/api/course-path/ai`、岗位技能页的「已有课」都从这里读。它有几条只有测试守得住的约束：
 *
 *  1. **顺序真源唯一**：阶内的展示顺序写在 `stages[].nodeIds` 里，节点上的 `stage`
 *     只是同一件事的冗余标注。两边对不上时页面会静默漏掉节点（既不报错也不显示）。
 *  2. **占位规范**：`live` 必须有 courseId 且课真的落在盘上；`planned` 一律没有 courseId；
 *     `blocked` 必须记着被门禁挡下的那一版。混淆的后果分别是——把没有的课算进
 *     「已生成 N 门」的门数，或者渲染出一个点开就 404 的卡。
 *  3. **一门课只挂一处**：同一个 courseId 出现在两个节点上，课程墙就会把它画两遍。
 *  4. **岗位技能指得到节点**：`jobSkillCourses` 里写错一个节点 id，
 *     岗位技能页那一项就静默少一行「已有课」。
 */

interface Node {
  id: string;
  stage: string;
  title: string;
  prereq?: string[];
  courseId?: string | null;
  altCourseIds?: string[];
  blockedCourseId?: string;
  status?: string;
  requirement?: string;
}
interface Stage {
  id: string;
  title: string;
  goal: string;
  link: string;
  nodeIds: string[];
}

const data = pathData as unknown as {
  nodes: Node[];
  stages: Stage[];
  jobSkillCourses: { job_id: string; title: string; skills: Record<string, string[]> };
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

  it('stages[].nodeIds 指到的节点都存在，且每个节点恰好挂在一阶上', () => {
    const hung = data.stages.flatMap((s) => s.nodeIds);
    expect(hung.filter((id) => !nodeIds.has(id))).toEqual([]);
    expect(new Set(hung).size).toBe(hung.length);
    expect([...nodeIds].filter((id) => !hung.includes(id))).toEqual([]);
  });

  it('节点的 stage 与它被挂上的阶 id 一致（顺序真源是 nodeIds，stage 只是冗余标注）', () => {
    const mismatched = data.stages.flatMap((s) =>
      s.nodeIds
        .map((id) => data.nodes.find((n) => n.id === id))
        .filter((n): n is Node => Boolean(n) && n!.stage !== s.id)
        .map((n) => `${n.id}: stage=${n.stage} 挂在 ${s.id}`),
    );
    expect(mismatched).toEqual([]);
  });

  it('每一阶都写了标题、目标与承接说明', () => {
    const thin = data.stages
      .filter((s) => !s.title?.trim() || !s.goal?.trim() || !s.link?.trim())
      .map((s) => s.id);
    expect(thin).toEqual([]);
  });

  it('prereq 全部指向存在的节点，且不自指', () => {
    const broken = data.nodes.flatMap((n) =>
      (n.prereq ?? []).filter((p) => !nodeIds.has(p) || p === n.id).map((p) => `${n.id} → ${p}`),
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
  /**
   * 这里**不再**断言「每个 courseId 都落在仓库的 data/classrooms 里」。
   * 真源那份 learning-path.json 现在住在服务器的数据目录，新课生成完直接覆盖它、不发版；
   * 仓库里这份是兜底快照，仓库的课程目录也只是线上的一个子集。拿子集去卡真源会一直红。
   *
   * 它原本要防的是「渲染出一个点开就 404 的卡」——那件事改由渲染层挡：
   * `readCuratedWall` 只把当前会话真读得到的课摆上墙，读不到的节点整个不出。
   * 这里只守 id 的形状，别让一个明显写坏的值混进去。
   */
  it('引到的课程 id 都是合法的课程 id', () => {
    const bad = data.nodes.flatMap((n) =>
      [n.courseId, ...(n.altCourseIds ?? []), n.blockedCourseId]
        .filter((id): id is string => Boolean(id))
        .filter((id) => !/^[A-Za-z0-9_-]{10}$/.test(id))
        .map((id) => `${n.id} → ${id}`),
    );
    expect(bad).toEqual([]);
  });

  it('仓库里落着盘的那些课，至少有一门被路径收着（快照没整个漂掉）', () => {
    const linked = data.nodes.flatMap((n) => [
      ...(n.courseId ? [n.courseId] : []),
      ...(n.altCourseIds ?? []),
    ]);
    expect(linked.filter((id) => onDiskCourseIds.has(id)).length).toBeGreaterThan(0);
  });

  it('一个 courseId 只挂在一个节点上', () => {
    const linked = data.nodes.flatMap((n) => [
      ...(n.courseId ? [n.courseId] : []),
      ...(n.altCourseIds ?? []),
      ...(n.blockedCourseId ? [n.blockedCourseId] : []),
    ]);
    expect(new Set(linked).size).toBe(linked.length);
  });

  it('status=live 必须带 courseId', () => {
    const bad = data.nodes.filter((n) => n.status === 'live' && !n.courseId).map((n) => n.id);
    expect(bad).toEqual([]);
  });

  it('status=planned 一律没有 courseId，且带一句 requirement 草案', () => {
    const bad = data.nodes
      .filter((n) => n.status === 'planned')
      .filter((n) => n.courseId || !n.requirement?.trim())
      .map((n) => n.id);
    expect(bad).toEqual([]);
  });

  it('status=blocked 记着被挡下那一版，且没有对外的 courseId', () => {
    const bad = data.nodes
      .filter((n) => n.status === 'blocked')
      .filter((n) => !n.blockedCourseId || n.courseId)
      .map((n) => n.id);
    expect(bad).toEqual([]);
  });

  it('status 只有 live / planned / blocked 三种', () => {
    const bad = data.nodes
      .filter((n) => !['live', 'planned', 'blocked'].includes(n.status ?? ''))
      .map((n) => `${n.id}: ${n.status}`);
    expect(bad).toEqual([]);
  });
});

describe('jobSkillCourses', () => {
  it('每一项技能都指到存在的节点', () => {
    const broken = Object.entries(data.jobSkillCourses.skills).flatMap(([skill, ids]) =>
      ids.filter((id) => !nodeIds.has(id)).map((id) => `${skill} → ${id}`),
    );
    expect(broken).toEqual([]);
  });

  it('每一项技能至少挂一个节点', () => {
    const empty = Object.entries(data.jobSkillCourses.skills)
      .filter(([, ids]) => ids.length === 0)
      .map(([skill]) => skill);
    expect(empty).toEqual([]);
  });
});
