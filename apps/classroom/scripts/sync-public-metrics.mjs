/**
 * 把公共首页「相关指标」三张卡的数字从真源同步进 classroom。
 *
 * 真源是 `apps/agent-engine/data/metrics.json`（口径台账）。首页是客户端组件，
 * 又守着「公共页零引擎依赖」——不能在运行时去读引擎数据目录，引擎离线首页也得照常。
 * 所以走的是仓里既有的那条路（同 `sync-prereq-graph.mjs`）：**构建前同步成一份落盘常量，
 * 组件 import 它**。产物 `components/home/public-metrics.json` 是产物不是真源，
 * 改数一律改 metrics.json 再重跑本脚本，别手编产物。
 *
 *   node scripts/sync-public-metrics.mjs
 *
 * 幻觉率那条为什么不直接印 `value`：`value` 是 0.021，本身已经把 12/576 = 2.0833% 四舍五入
 * 掉了一位。/evidence 台账与 docs/05-evidence 全线写的是 2.08%（metrics.json 自己的
 * citations 也钉着这个串），首页改印 2.1% 等于在两张公共页之间造出新的分叉。
 * 所以取口径原文里的分子分母算，再拿 `value` 当校验——两者对不上（超出 tolerance）就报错退出，
 * 谁改了 value 忘了改口径当场炸。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../../agent-engine/data/metrics.json');
const TARGET = resolve(here, '../components/home/public-metrics.json');

const metrics = JSON.parse(readFileSync(SOURCE, 'utf8')).metrics;

/** 取一个匹配组，取不到就炸——静默兜底会让首页印上一个没人知道来路的数。 */
function grab(text, re, what) {
  const m = re.exec(text);
  if (!m) throw new Error(`metrics.json 里抽不出「${what}」（正则 ${re}）：${text.slice(0, 120)}…`);
  return Number(m[1]);
}

// 幻觉率：分子分母在口径原文里，value 只当校验位
const hall = metrics.api_hallucination_v2;
const claims = grab(hall.caliber, /(\d+)\s*条可核断言/, '可核断言数');
const runs = grab(hall.caliber, /(\d+)\s*个真\s*LLM\s*run/, 'run 数');
const unsupported = grab(hall.caliber, /(\d+)\s*条判无据/, '判无据数');
const rate = unsupported / claims;
const tolerance = hall.tolerance ?? 0.003;
if (Math.abs(rate - hall.value) > tolerance) {
  throw new Error(
    `api_hallucination_v2 口径原文的 ${unsupported}/${claims} = ${rate.toFixed(4)} ` +
      `与 value ${hall.value} 差得超过 tolerance ${tolerance}——先把真源对齐再同步`,
  );
}

// 适配准确率与知识点覆盖率：value 本身就是带口径的整句，点估计写在句首/句中
const adapt = metrics.adaptation_accuracy_2a;
const kc = metrics.kc_coverage_v1;

const out = {
  _source: 'apps/agent-engine/data/metrics.json',
  _generator: 'apps/classroom/scripts/sync-public-metrics.mjs（产物，勿手编）',
  hallucination: {
    percent: `${(rate * 100).toFixed(2)}%`,
    runs,
    claims,
    unsupported,
  },
  adaptation: {
    percent: grab(adapt.value, /^([\d.]+)%/, '适配准确率点估计').toFixed(1) + '%',
    n: grab(adapt.value, /n=(\d+)/, '适配准确率样本量'),
  },
  kcCoverage: {
    percent: grab(kc.value, /=\s*([\d.]+)%/, '覆盖率').toFixed(1) + '%',
    hit: grab(kc.value, /汇总\s*(\d+)\//, '命中知识点数'),
    total: grab(kc.value, /汇总\s*\d+\/(\d+)/, '知识点总数'),
    courses: grab(kc.value, /（(\d+)\s*门金标课）/, '金标课门数'),
  },
};

writeFileSync(TARGET, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(
  `落盘 ${TARGET}\n` +
    `  幻觉率 ${out.hallucination.percent}（${unsupported}/${claims}，${runs} run）\n` +
    `  适配准确率 ${out.adaptation.percent}（n=${out.adaptation.n}）\n` +
    `  知识点覆盖率 ${out.kcCoverage.percent}（${out.kcCoverage.hit}/${out.kcCoverage.total}，${out.kcCoverage.courses} 门）`,
);
