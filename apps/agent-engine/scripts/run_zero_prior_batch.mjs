/**
 * 零先验评测的批量跑法：每个条件跑 N 轮，报均值与标准差。
 *
 * 为什么必须批量：单轮结果波动极大——同一份代码连跑三轮拿到 12 / 16 / 10 分。
 * 拿单轮数字下结论，等于把生成随机性当成产品差异。这个脚本跑完给的是
 * 「均值 ± 标准差」和逐轮明细，能看出差异是真的还是噪声。
 *
 * 用法：
 *   node scripts/run_zero_prior_batch.mjs --runs 3
 *   node scripts/run_zero_prior_batch.mjs --runs 3 --only fork
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const RUNS = Number(args.runs || 3);
const OUT_DIR = path.join(process.cwd(), 'data', 'eval', 'zero_prior');
const ONLY = args.only;

const CONDITIONS = [
  { name: 'fork', url: 'http://localhost:3210', model: '' },
  { name: 'upstream', url: 'http://localhost:3211', model: 'siliconflow:Qwen/Qwen3.5-397B-A17B' },
].filter((c) => !ONLY || c.name === ONLY);

const DIMS = ['Q1_concept', 'Q2_math', 'Q3_apply', 'Q4_code'];
const DIM_LABEL = { Q1_concept: '是什么', Q2_math: '数学原理', Q3_apply: '怎么落地', Q4_code: '代码怎么写' };

function run(cmd, argv, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

function stats(xs) {
  if (!xs.length) return { mean: 0, sd: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd =
    xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
  return { mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const key =
    process.env.SILICONFLOW_API_KEY ||
    (existsSync('../classroom/.env.local')
      ? (readFileSync('../classroom/.env.local', 'utf8').match(/^SILICONFLOW_API_KEY=(.+)$/m) ?? [])[1]
      : '');
  if (!key) {
    console.error('缺 SILICONFLOW_API_KEY');
    return 1;
  }

  const results = {};
  for (const cond of CONDITIONS) {
    results[cond.name] = [];
    for (let i = 1; i <= RUNS; i++) {
      const label = `${cond.name}_r${i}`;
      process.stdout.write(`[${label}] 生成…`);
      const capArgs = ['scripts/capture_course.mjs', '--url', cond.url, '--label', label];
      if (cond.model) capArgs.push('--model', cond.model);
      const cap = await run('node', capArgs, {
        NO_PROXY: 'localhost,127.0.0.1',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
      });
      const m = cap.out.match(/(\d+) 个场景，材料 (\d+) 字符，耗时 (\d+)s/);
      if (!m) {
        console.log(` 失败\n${cap.out.slice(-300)}`);
        continue;
      }
      process.stdout.write(` ${m[1]} 场景 / ${m[2]} 字 / ${m[3]}s，评测…`);

      const ev = await run(
        'node',
        [
          'scripts/zero_prior_eval.mjs',
          '--label',
          label,
          '--materials',
          path.join(OUT_DIR, `${label}.materials.txt`),
        ],
        { SILICONFLOW_API_KEY: key },
      );
      const rf = path.join(OUT_DIR, `${label}.result.json`);
      if (!existsSync(rf)) {
        console.log(` 评测失败\n${ev.out.slice(-300)}`);
        continue;
      }
      const r = JSON.parse(readFileSync(rf, 'utf8'));
      const byDim = {};
      for (const a of r.result?.answers ?? []) byDim[a.id] = a.score ?? 0;
      results[cond.name].push({
        run: i,
        total: r.total ?? 0,
        scenes: Number(m[1]),
        chars: Number(m[2]),
        seconds: Number(m[3]),
        ...byDim,
      });
      console.log(` ${r.total}/16`);
    }
  }

  console.log('\n══════ 汇总 ══════\n');
  const head = `${'条件'.padEnd(10)}${'n'.padEnd(4)}${'合计'.padEnd(14)}` + DIMS.map((d) => DIM_LABEL[d].padEnd(12)).join('');
  console.log(head);
  console.log('-'.repeat(head.length + 6));
  for (const [name, rows] of Object.entries(results)) {
    if (!rows.length) continue;
    const t = stats(rows.map((r) => r.total));
    const cells = DIMS.map((d) => {
      const s = stats(rows.map((r) => r[d] ?? 0));
      return `${s.mean.toFixed(1)}±${s.sd.toFixed(1)}`.padEnd(12);
    });
    console.log(
      `${name.padEnd(10)}${String(rows.length).padEnd(4)}${`${t.mean.toFixed(1)}±${t.sd.toFixed(1)} [${t.min}-${t.max}]`.padEnd(14)}${cells.join('')}`,
    );
  }

  console.log('\n逐轮明细：');
  for (const [name, rows] of Object.entries(results)) {
    for (const r of rows) {
      console.log(
        `  ${name}_r${r.run}: ${r.total}/16  (${DIMS.map((d) => r[d] ?? 0).join('/')})  ` +
          `${r.scenes} 场景 ${r.chars} 字 ${r.seconds}s`,
      );
    }
  }

  writeFileSync(path.join(OUT_DIR, 'batch_summary.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n明细已存 ${path.join(OUT_DIR, 'batch_summary.json')}`);
  return 0;
}

main().then((c) => process.exit(c ?? 0));
