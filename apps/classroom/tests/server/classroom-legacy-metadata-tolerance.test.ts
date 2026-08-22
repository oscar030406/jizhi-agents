import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { resolveConcept } from '@/lib/evidence/scene-concepts';

/**
 * 存量课容缺（WO-B1 DoD 第 2 条）。
 *
 * 新增的三个字段（课级 `generation`、场景级 `concepts`）全部可选，课程墙上的存量课
 * 一个都没有。**不迁移旧课、不补造历史值**——事后按时间窗猜出来的档位不是账。
 * 所以这里要钉的是：读真文件零报错，且 `resolveConcept` 对没有新字段的场景
 * 走的还是老那三级（engine / cited-chunks / title），一条都不许变成 `generated`。
 *
 * 读的是真文件，不是夹具——夹具证明不了「存量课不会炸」。
 */

const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');

interface LegacyScene {
  id?: string;
  title?: string;
  concepts?: unknown;
}
interface LegacyCourse {
  id?: string;
  stage?: Record<string, unknown>;
  scenes?: LegacyScene[];
  generation?: unknown;
  createdAt?: string;
}

/**
 * 「存量」的分界线：WO-B1 的字段是 2026-08-15 上线的，之前生成的课一门都没有。
 * 分界线读课自己的 `createdAt`，不按目录里有没有新字段分——按字段分会变成同义反复
 * （「没有新字段的课没有新字段」），迁移脚本真跑过一遍也照样绿。
 *
 * 08-16 之后新生成的课**本来就带** `concepts`，它们不是存量课，不进这里的分母。
 */
const SCHEMA_LANDED = '2026-08-15';

const files = readdirSync(CLASSROOMS_DIR).filter((f) => f.endsWith('.json'));
const allCourses: Array<{ file: string; data: LegacyCourse }> = files.map((file) => ({
  file,
  data: JSON.parse(readFileSync(path.join(CLASSROOMS_DIR, file), 'utf-8')) as LegacyCourse,
}));
const courses = allCourses.filter(
  ({ data }) => String(data.createdAt ?? '').slice(0, 10) < SCHEMA_LANDED,
);
const scenes = courses.flatMap((c) => c.data.scenes ?? []);

describe('存量课在新字段下的行为', () => {
  it('课程墙上的课全部能读、全部有场景', () => {
    // 不钉具体门数——课程墙是人工策展的，会增减。钉的是「读得动」。
    // 这一条管整面墙（新课也得读得动），下面两条只管存量课。
    expect(courses.length).toBeGreaterThan(0);
    for (const { file, data } of allCourses) {
      expect(data.stage, file).toBeTruthy();
      expect(Array.isArray(data.scenes), file).toBe(true);
    }
    expect(scenes.length).toBeGreaterThan(100);
  });

  it('一门存量课都没有新字段——没迁移、没补造历史值', () => {
    for (const { file, data } of courses) {
      expect(Object.hasOwn(data, 'generation'), `${file} 不该有 generation`).toBe(false);
    }
    const withConcepts = scenes.filter((s) => s.concepts !== undefined);
    expect(withConcepts).toEqual([]);
  });

  it('resolveConcept 对存量场景的结果没有一条走 generated', () => {
    const sources = new Set<string>();
    for (const scene of scenes) {
      const resolved = resolveConcept({
        sceneId: scene.id,
        sceneTitle: scene.title,
        // 存量场景没有 concepts，这里如实传 undefined
        sceneConcept: (scene.concepts as { concept?: string } | undefined)?.concept,
      });
      if (resolved) sources.add(resolved.source);
    }
    expect([...sources].sort()).toEqual(['cited-chunks', 'title']);
  });
});
