import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('隐私页账户控制', () => {
  it('提供真实导出/删除入口，并移除“未收集真实学员数据”的失实承诺', () => {
    const source = readFileSync(join(process.cwd(), 'app', 'privacy', 'page.tsx'), 'utf-8');
    expect(source).toContain("window.location.assign('/api/account/export')");
    expect(source).toContain("fetch('/api/account'");
    expect(source).toContain('机构所有者仍有成员时会被拒绝');
    expect(source).not.toContain('本系统目前未收集任何真实学员数据');
  });
});
