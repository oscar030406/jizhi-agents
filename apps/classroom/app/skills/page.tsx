/**
 * /skills 的服务端外壳。
 *
 * 主库 ai 的岗位技能地图改从 `data/skill-map-ai.json` 快照渲染：那条实时路要转给引擎
 * 逐条技能做检索，冷启动实测 ~38 秒，学习者进来先盯着一个转圈。快照由
 * `scripts/export-skill-map.mjs` 导出、跟着仓库走；页面上的「重新读取」仍然去问引擎。
 *
 * 「已有课」那一行读数据目录里的 `learning-path.json`（新课生成完直接覆盖那份文件，
 * 不发版），所以这一层必须 `force-dynamic`，不能静态化成某一次读到的样子。
 * 其它领域仍走原来的实时接口，本文件不给它们塞任何 ai 的数据。
 */

import skillMapSnapshot from '@/data/skill-map-ai.json';
import {
  jobSkillEvidence,
  jobSkillRows,
  readLearningPath,
  skillCoverageOf,
} from '@/lib/server/learning-path';
import SkillsView from './skills-view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const learningPath = await readLearningPath().catch(() => null);
  // 技能徽章的接线面（对口课的主概念与场景 id）。只读 jobSkillCourses 映射到的那十几门
  // 课文件；读失败就给空表，页面据此显示「判不了」而不是拿别的数据凑一个判定。
  const skillEvidence = learningPath ? await jobSkillEvidence(learningPath).catch(() => []) : [];
  return (
    <SkillsView
      snapshot={skillMapSnapshot as Parameters<typeof SkillsView>[0]['snapshot']}
      jobSkills={learningPath ? jobSkillRows(learningPath, skillCoverageOf(skillMapSnapshot)) : []}
      skillEvidence={skillEvidence}
      jobId={learningPath?.jobSkillCourses?.job_id ?? ''}
    />
  );
}
