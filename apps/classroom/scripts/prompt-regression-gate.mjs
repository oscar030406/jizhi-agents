/**
 * 提示词回归门：改了 `lib/prompts/**` 就跑一遍，掉分不许合。
 *
 *   node scripts/prompt-regression-gate.mjs            # 门禁本体
 *   node scripts/prompt-regression-gate.mjs --self-test # 只自检检查器本身
 *
 * 为什么要有这个东西：模板一共 25 套，`tests/prompts` 只覆盖到其中一部分
 * （agent-system 三个角色、director、pbl-design、slide-actions、几个 widget 契约）。
 * 剩下十几套改坏了没有任何东西会响——`loadPrompt` 读不到文件时返回 null 而不是抛，
 * `interpolateVariables` 认不出的占位符原样透传给模型。两条都是静默回退，
 * 线上表现是"课生成得出来但内容不对"，回溯成本极高。所以这里补一层零成本的静态体检，
 * 让分母覆盖到全部 25 套模板与 12 个 snippet。
 *
 * 两层都跑在磁盘上，不打任何模型接口，也不需要起服务。判官打分那层（换域体检、
 * eval/orchestration 之类）要真钱、要 classroom 与引擎两个进程同时在，一轮约 30 万 token
 * （`docs/05-evidence/kb-architecture-decision-20260816.md`），所以它**不进门禁**，
 * 手工跑，命令写在 `.github/workflows/prompt-regression-gate.yml` 的注释里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLASSROOM_ROOT = resolve(here, '..');
const PROMPTS_DIR = resolve(CLASSROOM_ROOT, 'lib/prompts');

/**
 * 基线 = 2026-08-23 在干净工作区实测到的通过率，不是拍的，也不是从历史分回归的。
 *
 * 实测记录（两层都在 `apps/classroom/` 下跑）：
 *   静态体检   198/198   （25 套模板 × 3 条 + 11 个 SnippetId + 56 个 md 文件 × 2 条）
 *   模板测试   62/62     `npx vitest run tests/prompts`，26 个 suite / 7 个文件
 *
 * 为什么敢把绝对阈值定在 1.0，而不是写成"相对上次不许跌超过 X"：
 * 这两层都是确定性检查——同一份磁盘内容跑两遍结果必然一致，没有采样噪声，
 * 也没有判官漂移。所以低于 1.0 不是波动，是真有东西坏了，容差留 0 才是对的口径。
 *
 * 反过来说，本仓库里明文禁止过"从历史通过率回归阈值"这种做法
 * （`lib/generation/spec.ts` 的压缩下限、`backend/services/feasibility.py` 的可行性判词，
 * 依据是 Lee et al. 2026 / arXiv:2605.01690——我们那个数据量回归出来的是噪声）。
 * 那条禁令针对的是**带噪的质量分**，跟这里的确定性检查不是一回事，不冲突。
 * 也正因为如此，真正带噪的那层（判官打分）被挡在门外：它的基线本来就不该这么定。
 *
 * 什么时候该改这两个数：只有当你**故意**引入一条暂时过不了的检查时才往下调，
 * 并且在这里写明是哪一条、为什么、什么时候补回来。日常改模板不该动它们。
 */
const BASELINE = {
  static: 1.0,
  tests: 1.0,
};

/** 分母跌到这个数以下就当扫描本身坏了——0/0 也是 100%，别让路径改错悄悄放行。 */
const MIN_STATIC_CHECKS = 100;

/** 从 types.ts 里抠出一个字符串字面量联合的全部取值。 */
function readUnion(typesSource, unionName) {
  const start = typesSource.indexOf(`export type ${unionName} =`);
  if (start < 0) throw new Error(`types.ts 里找不到 ${unionName} 联合`);
  const end = typesSource.indexOf(';', start);
  return [...typesSource.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * 静态体检。每条检查只判"确定坏了"的情况，不判风格好坏——
 * 风格是评审的事，门禁只拦一定会在运行时出事的形态。
 *
 * @param {string} promptsDir 指向 `lib/prompts`
 * @returns {{checks: {name: string, ok: boolean, detail: string}[]}}
 */
export function scanPrompts(promptsDir) {
  const checks = [];
  const add = (ok, name, detail = '') => checks.push({ ok, name, detail });

  const templatesDir = path.join(promptsDir, 'templates');
  const snippetsDir = path.join(promptsDir, 'snippets');

  const dirs = fs
    .readdirSync(templatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const snippetFiles = fs
    .readdirSync(snippetsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));

  const types = fs.readFileSync(path.join(promptsDir, 'types.ts'), 'utf8');
  const promptIds = readUnion(types, 'PromptId');
  const snippetIds = readUnion(types, 'SnippetId');

  // ① system.md 缺了或空了：loadPrompt 返回 null，调用方多半直接走降级分支，不报错。
  for (const d of dirs) {
    const p = path.join(templatesDir, d, 'system.md');
    const ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim().length > 0;
    add(ok, `模板 ${d} 的 system.md 非空`, ok ? '' : `${p} 缺失或为空`);
  }

  // ② 目录与 PromptId 联合双向对齐。目录没登记 = 谁也调不到的死模板；
  //    登记了没目录 = 运行时 loadPrompt 返回 null。
  for (const d of dirs) {
    const ok = promptIds.includes(d);
    add(ok, `模板 ${d} 已登记进 PromptId`, ok ? '' : `types.ts 的 PromptId 联合里没有 '${d}'`);
  }
  for (const id of promptIds) {
    const ok = dirs.includes(id);
    add(ok, `PromptId '${id}' 有对应目录`, ok ? '' : `templates/${id}/ 不存在`);
  }

  // ③ SnippetId 登记了就必须有文件——loadSnippet 找不到文件是直接抛的，会打断整次生成。
  //    反方向（有文件没登记）不查：loader 里是 as 断言，运行时照样能引，只是少一层类型保护。
  for (const id of snippetIds) {
    const ok = snippetFiles.includes(id);
    add(ok, `SnippetId '${id}' 有对应文件`, ok ? '' : `snippets/${id}.md 不存在`);
  }

  // ④⑤ 逐个 md 文件：snippet 引用能解析、条件块配平。
  const mdFiles = [];
  for (const d of dirs) {
    for (const f of ['system.md', 'user.md']) {
      const p = path.join(templatesDir, d, f);
      if (fs.existsSync(p)) mdFiles.push([`templates/${d}/${f}`, p]);
    }
  }
  for (const s of snippetFiles)
    mdFiles.push([`snippets/${s}.md`, path.join(snippetsDir, `${s}.md`)]);

  for (const [label, p] of mdFiles) {
    const text = fs.readFileSync(p, 'utf8');

    const refs = [...text.matchAll(/\{\{snippet:(\w[\w-]*)\}\}/g)].map((m) => m[1]);
    const dangling = refs.filter((r) => !snippetFiles.includes(r));
    add(
      dangling.length === 0,
      `${label} 的 snippet 引用可解析`,
      dangling.length === 0 ? '' : `引用了不存在的 snippet：${dangling.join('、')}`,
    );

    // processConditionalBlocks 的正则不支持嵌套，也不校验配平：多出来的 {{/if}}
    // 会原样留在提示词里发给模型，多出来的 {{#if}} 会把后面一整段吞掉。
    const opens = (text.match(/\{\{#if \w+\}\}/g) || []).length;
    const closes = (text.match(/\{\{\/if\}\}/g) || []).length;
    add(
      opens === closes,
      `${label} 的条件块配平`,
      opens === closes ? '' : `{{#if}} ${opens} 个，{{/if}} ${closes} 个`,
    );
  }

  return { checks };
}

/** 跑 `tests/prompts` 那套 vitest，用 json reporter 取通过数。 */
function runPromptTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-gate-'));
  const out = path.join(tmp, 'vitest.json');
  try {
    // 直接用 node 拉 vitest 的 CLI 入口，不走 npx / shell：
    // Windows 上 npx 是 .cmd，不开 shell 就找不到，开了 shell 又要处理临时目录路径里的空格。
    const vitestCli = path.join(
      path.dirname(
        createRequire(path.join(CLASSROOM_ROOT, 'noop.js')).resolve('vitest/package.json'),
      ),
      'vitest.mjs',
    );
    const r = spawnSync(
      process.execPath,
      [vitestCli, 'run', 'tests/prompts', '--reporter=json', `--outputFile=${out}`],
      { cwd: CLASSROOM_ROOT, encoding: 'utf8' },
    );
    if (!fs.existsSync(out)) {
      throw new Error(
        `vitest 没产出报告，门禁无法判分。原始输出：\n${(r.stderr || r.stdout || '').slice(-2000)}`,
      );
    }
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    const failures = [];
    for (const file of report.testResults || []) {
      for (const a of file.assertionResults || []) {
        if (a.status === 'failed') failures.push(a.fullName);
      }
    }
    return { passed: report.numPassedTests, total: report.numTotalTests, failures };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function pct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

function line(label, passed, total, baseline) {
  const rate = total === 0 ? 0 : passed / total;
  const flag =
    rate + 1e-9 >= baseline ? '' : `   ↓ 比基线低 ${((baseline - rate) * 100).toFixed(2)} 个百分点`;
  return `  ${label}  ${String(passed).padStart(4)}/${String(total).padEnd(4)}  ${pct(rate).padStart(7)}   基线 ${pct(baseline)}${flag}`;
}

function main() {
  const staticResult = scanPrompts(PROMPTS_DIR);
  const staticTotal = staticResult.checks.length;
  const staticFailed = staticResult.checks.filter((c) => !c.ok);
  const staticPassed = staticTotal - staticFailed.length;
  const staticRate = staticTotal === 0 ? 0 : staticPassed / staticTotal;

  const tests = runPromptTests();
  const testRate = tests.total === 0 ? 0 : tests.passed / tests.total;

  console.log('提示词回归门（离线层，不打模型接口）\n');
  console.log(line('静态体检', staticPassed, staticTotal, BASELINE.static));
  console.log(line('模板测试', tests.passed, tests.total, BASELINE.tests));
  console.log('');

  const blockers = [];

  if (staticTotal < MIN_STATIC_CHECKS) {
    blockers.push(
      `静态体检只扫出 ${staticTotal} 条检查（下限 ${MIN_STATIC_CHECKS}）——` +
        '多半是 lib/prompts 的路径或目录结构变了，扫描器扫了个空，不是真的通过。',
    );
  }
  if (tests.total === 0) {
    blockers.push('vitest 一条用例都没跑到——tests/prompts 的匹配路径可能已失效，这不算通过。');
  }
  if (staticRate + 1e-9 < BASELINE.static) {
    blockers.push(`静态体检 ${pct(staticRate)} 低于基线 ${pct(BASELINE.static)}`);
  }
  if (testRate + 1e-9 < BASELINE.tests) {
    blockers.push(`模板测试 ${pct(testRate)} 低于基线 ${pct(BASELINE.tests)}`);
  }

  if (staticFailed.length > 0) {
    console.log(`静态体检掉了 ${staticFailed.length} 条：`);
    for (const c of staticFailed) console.log(`  ✗ ${c.name}${c.detail ? ` —— ${c.detail}` : ''}`);
    console.log('');
  }
  if (tests.failures.length > 0) {
    console.log(`模板测试掉了 ${tests.failures.length} 条：`);
    for (const name of tests.failures) console.log(`  ✗ ${name}`);
    console.log('（逐条断言的报错正文去掉 --reporter=json 重跑一次就能看到）\n');
  }

  console.log(
    '判官打分那层没跑：要真钱、要 classroom 与引擎两个进程同时在。手工命令见 ' +
      '.github/workflows/prompt-regression-gate.yml 的注释。\n',
  );

  if (blockers.length > 0) {
    for (const b of blockers) console.error(`不通过：${b}`);
    console.error(
      '\n分确实该降（比如新加了一条暂时过不了的检查），就在 scripts/prompt-regression-gate.mjs ' +
        '的 BASELINE 里把数字改掉，并写清是哪一条、为什么。',
    );
    process.exit(1);
  }

  console.log('通过。');
}

/**
 * 自检：给检查器喂一棵人造的 prompts 树，确认每一类坏法都能被抓到。
 * 不引框架、不进 tests/——门禁自己的分母不该被自己的测试撑大。
 */
function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`自检失败：${msg}`);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-gate-selftest-'));
  const build = (mutate) => {
    fs.rmSync(root, { recursive: true, force: true });
    const tpl = path.join(root, 'templates');
    const snp = path.join(root, 'snippets');
    fs.mkdirSync(path.join(tpl, 'alpha'), { recursive: true });
    fs.mkdirSync(snp, { recursive: true });
    fs.writeFileSync(
      path.join(tpl, 'alpha', 'system.md'),
      '你好 {{snippet:common}} {{#if x}}A{{/if}}',
    );
    fs.writeFileSync(path.join(snp, 'common.md'), '公共块');
    fs.writeFileSync(
      path.join(root, 'types.ts'),
      "export type PromptId =\n  | 'alpha';\n\nexport type SnippetId =\n  | 'common';\n",
    );
    mutate({ root, tpl, snp });
    return scanPrompts(root);
  };
  const failedNames = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

  // 干净树：全过。
  const clean = build(() => {});
  assert(clean.checks.length > 0, '干净树应当产出检查项');
  assert(failedNames(clean).length === 0, `干净树不该有失败项，实际：${failedNames(clean)}`);

  // ① system.md 被清空。
  const empty = build(({ tpl }) => fs.writeFileSync(path.join(tpl, 'alpha', 'system.md'), '  \n'));
  assert(
    failedNames(empty).some((n) => n.includes('system.md 非空')),
    '空 system.md 没被抓到',
  );

  // ② 新目录没登记进 PromptId。
  const unreg = build(({ tpl }) => {
    fs.mkdirSync(path.join(tpl, 'beta'));
    fs.writeFileSync(path.join(tpl, 'beta', 'system.md'), '内容');
  });
  assert(
    failedNames(unreg).some((n) => n.includes('beta 已登记')),
    '未登记模板没被抓到',
  );

  // ③ PromptId 登记了但目录没了。
  const ghost = build(({ root: r }) =>
    fs.writeFileSync(
      path.join(r, 'types.ts'),
      "export type PromptId =\n  | 'alpha'\n  | 'gamma';\n\nexport type SnippetId =\n  | 'common';\n",
    ),
  );
  assert(
    failedNames(ghost).some((n) => n.includes("'gamma' 有对应目录")),
    '幽灵 PromptId 没被抓到',
  );

  // ④ 引用了不存在的 snippet。
  const dangling = build(({ tpl }) =>
    fs.writeFileSync(path.join(tpl, 'alpha', 'system.md'), '{{snippet:nope}}'),
  );
  assert(
    failedNames(dangling).some((n) => n.includes('snippet 引用可解析')),
    '悬空 snippet 引用没被抓到',
  );

  // ⑤ 条件块不配平。
  const unbalanced = build(({ tpl }) =>
    fs.writeFileSync(path.join(tpl, 'alpha', 'system.md'), '{{#if x}}A'),
  );
  assert(
    failedNames(unbalanced).some((n) => n.includes('条件块配平')),
    '不配平的条件块没被抓到',
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log('自检通过：5 类坏法全部拦下，干净树零误报。');
}

if (process.argv.includes('--self-test')) selfTest();
else main();
