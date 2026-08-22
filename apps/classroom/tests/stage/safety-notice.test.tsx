/**
 * 高危领域的安全提示层（WO-N16 C21）。
 *
 * 这个文件除了验渲染，还钉一条**接线**：`needsSafetyLayer` 曾经有零个消费者——
 * 函数写好了、声明贯通了、清单里字段也在，就是没有任何地方读它。
 * 那是本项目今天数到第十例的同族问题（建了没接线 / 接了没灌注 /
 * 灌了形状歪 / 解析器不认自己的输出）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyDomainRegistry,
  needsSafetyLayer,
  parseDomainRegistry,
} from '@/lib/knowledge/domain-registry';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('安全提示层的判据', () => {
  it('只看接入时的声明，不从语料猜', () => {
    applyDomainRegistry(
      parseDomainRegistry({
        corpora: [
          { corpus: 'mfg', hands_on_safety: true },
          { corpus: 'ai', hands_on_safety: false },
          { corpus: 'odoo' }, // 老库没有这个字段
        ],
      }),
    );
    expect(needsSafetyLayer('mfg')).toBe(true);
    expect(needsSafetyLayer('ai')).toBe(false);
    // 缺字段按不需要处理：漏挂是安全责任，但误挂会让提示彻底失效
    // （每门 AI 课顶着「注意触电」，看两次就没人看了）。
    // 所以缺省不挂、由管理者显式声明——文案与勾选项在管理端要写清后果。
    expect(needsSafetyLayer('odoo')).toBe(false);
    expect(needsSafetyLayer('从没见过的库')).toBe(false);
    expect(needsSafetyLayer(undefined)).toBe(false);
  });

  it('清单没灌注时不误判——首帧读空清单要能被后续重算纠正', () => {
    applyDomainRegistry(null);
    expect(needsSafetyLayer('mfg')).toBe(false);
    applyDomainRegistry(
      parseDomainRegistry({ corpora: [{ corpus: 'mfg', hands_on_safety: true }] }),
    );
    expect(needsSafetyLayer('mfg')).toBe(true);
  });
});

describe('安全提示层真的被挂上了', () => {
  it('课堂页渲染 SafetyNotice', () => {
    // needsSafetyLayer 曾经零消费者：函数、字段、声明链路全都在，
    // 就是没有任何地方读它。静态断言比「组件能渲染」更能守住这条。
    const page = read('app/classroom/[id]/page.tsx');
    expect(page).toContain('SafetyNotice');
    expect(page).toMatch(/import \{ SafetyNotice \}/);
  });

  it('组件订阅清单版本号，不会卡在首帧的空清单上', () => {
    const src = read('components/stage/safety-notice.tsx');
    expect(src).toContain('useDomainRegistryVersion');
    expect(src).toMatch(/needsSafetyLayer\(corpus, version\)/);
  });

  it('文案给出可执行的处置，不是空喊注意安全', () => {
    const src = read('components/stage/safety-notice.tsx');
    expect(src).toContain('以现行国标与设备厂商手册为准');
    expect(src).toContain('有资质的人员在场');
  });
});
