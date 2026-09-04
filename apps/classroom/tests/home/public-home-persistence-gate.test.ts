import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

it('匿名公共页不读取账号课程持久化', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/home-view.tsx'), 'utf8');

  expect(source).toContain(
    'if (accountLoading || forcePublic || (accountEnabled && !account)) return;',
  );
});
