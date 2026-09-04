/**
 * 首页的服务端外壳。
 *
 * 课程墙、学习路径五阶、岗位技能摘要都在这里读好，再交给客户端的 `HomeView`。
 * 原来这三样各发一次 fetch，访客第一眼看到的是几行「正在读取…」；
 * 而阶次那一路走的是引擎的概念拓扑，排出来第一阶是「企业级 AI Agent 开发实战」。
 *
 * 路径现读数据目录里的 `learning-path.json`（`lib/server/learning-path.ts`）：
 * 线上新课生成完直接覆盖那份文件，不发版，所以这里必须 `force-dynamic`，
 * 不能让 Next 把首页静态化成某一次读到的快照。
 */

import { cookies } from 'next/headers';

import HomeView from './home-view';
import skillMapSnapshot from '@/data/skill-map-ai.json';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { createLogger } from '@/lib/logger';
import {
  jobSkillRows,
  readCuratedWall,
  readLearningPath,
  skillCoverageOf,
  type JobSkillRow,
} from '@/lib/server/learning-path';
import type { ClassroomSummary } from '@/lib/server/classroom-storage';
import type { CuratedPath } from '@/lib/server/learning-path';

const log = createLogger('HomePage');

export const dynamic = 'force-dynamic';

async function homeData(): Promise<{
  initialCourses: ClassroomSummary[];
  initialPath: CuratedPath | null;
  initialJobSkills: JobSkillRow[];
}> {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const [{ classrooms, path }, learningPath] = await Promise.all([
      readCuratedWall(token),
      readLearningPath(),
    ]);
    return {
      initialCourses: classrooms,
      initialPath: path,
      initialJobSkills: jobSkillRows(learningPath, skillCoverageOf(skillMapSnapshot)),
    };
  } catch (error) {
    // 读盘失败不把整个首页打成 500：造课入口、画像、演示通道都还能用，
    // 课程墙那一块由 HomeView 出「没读到学习路径」的降级说明。
    log.warn(`首页数据读取失败，按降级渲染：${String(error)}`);
    return { initialCourses: [], initialPath: null, initialJobSkills: [] };
  }
}

export default async function Page() {
  return <HomeView {...await homeData()} />;
}
