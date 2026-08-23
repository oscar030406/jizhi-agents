import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 'template' 是 fork 私造的第七种 widgetType，上游 DSL 的 validate.ts 会把它判非法。
 * 这组测试是防「同步上游 dsl 包」手滑的绊线：一旦有人把上游的 interactive.ts 契约
 * 搬进本地 DSL 包，这里立刻红——红了要么放弃同步，要么把 'template' 补进搬来的
 * WIDGET_TYPES 白名单（接受与上游 DSL 永久分叉），二选一，不许带病合并。
 */
const DSL_SRC = join(__dirname, '..', '..', 'packages', '@openmaic', 'dsl', 'src');

describe('template widgetType 与上游 DSL 契约互斥', () => {
  it('本地 DSL 包不含上游的 interactive 契约（当前安全形态）或已兼容 template', () => {
    const interactivePath = join(DSL_SRC, 'interactive.ts');
    if (!existsSync(interactivePath)) {
      // 现状：interactive 形状留在 app 层（lib/types/），DSL 包不校验 widgetType，安全。
      return;
    }
    // 有人把上游 interactive.ts 搬进来了：白名单必须已补 'template'，否则存量课全炸。
    const source = readFileSync(interactivePath, 'utf-8');
    expect(
      source.includes("'template'"),
      '上游 interactive.ts 被同步进本地 DSL 包，但 WIDGET_TYPES 没补 template——' +
        '存量模板教具场景会全部校验失败。补白名单或放弃同步。',
    ).toBe(true);
  });

  it('validate.ts 未引入按 widgetType 白名单拒斥的校验（或已兼容 template）', () => {
    const validatePath = join(DSL_SRC, 'validate.ts');
    if (!existsSync(validatePath)) return;
    const source = readFileSync(validatePath, 'utf-8');
    if (!source.includes('checkInteractiveContent') && !source.includes('isWidgetType')) {
      return; // 现状：validate.ts 只管 widget_* 动作的浅字段，不碰 widgetType 白名单。
    }
    expect(
      source.includes("'template'"),
      'validate.ts 引入了 widgetType 白名单校验但没认 template——存量课会校验失败。',
    ).toBe(true);
  });
});
