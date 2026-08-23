/**
 * 同题异人的组清单（D30）。
 *
 * 缺口不在数据——引擎每次投币的 `trial_courses/` 就是两档产物，
 * `/internal/v1/personalize/compare` 也能现跑。缺的是**展示端认不出新组**：
 * 文件名原本硬编码在 `/compare` 里，生成器产出新一组之后
 * 没有任何地方会把它加进那个数组，新域的对照跑了也看不见。
 *
 * 改成清单驱动，谁产出谁登记。这个文件钉住三件事：清单在、页面读它、
 * 生成器写它。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('同题异人的组清单', () => {
  it('清单存在且列出了现有两组', () => {
    const idx = JSON.parse(read('public/compare-showcase.index.json')) as { files: string[] };
    expect(idx.files).toContain('/compare-showcase.json');
    expect(idx.files).toContain('/compare-showcase-tools.json');
  });

  it('清单里的文件都真的在盘上', () => {
    const idx = JSON.parse(read('public/compare-showcase.index.json')) as { files: string[] };
    for (const f of idx.files) {
      expect(existsSync(join(process.cwd(), 'public', f.replace(/^\//, '')))).toBe(true);
    }
  });

  it('页面读清单，不再硬编码文件名', () => {
    const src = read('app/compare/page.tsx');
    expect(src).toContain('compare-showcase.index.json');
    // 兜底那两个还留着：老部署没有清单时不该整块空掉
    expect(src).toContain("'/compare-showcase.json', '/compare-showcase-tools.json'");
  });

  it('生成器写完把自己登记进清单', () => {
    // 「谁产出谁登记」——不然新跑一组还得有人记得改前端，
    // 那就是这族问题的第 N 次重演。
    const src = read('scripts/generate-compare-showcase.mjs');
    expect(src).toContain('registerInIndex');
    expect(src).toContain('compare-showcase.index.json');
  });
});
