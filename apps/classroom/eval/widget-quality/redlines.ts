/**
 * 教具红线的确定性检查（B1–B4 的机械那一半）。
 *
 * 为什么不全部交给 VLM：红线是一票否决，判错的代价比维度分判偏大得多。
 * 凡是能从 config / HTML 源码里算出确定答案的，就不许让模型看图猜——
 * 「滑块绑的系数根本不在公式里」这种死状，截图上看起来和正常教具一模一样，
 * 单帧 VLM 永远判不出来；反过来「文字挤成一团」这类只有像素能回答的，
 * 机械检查也不该硬猜。分工表写在 rubric.md，改这里要同步改那张表。
 *
 * 直接跑：pnpm tsx eval/widget-quality/redlines.ts
 * 它会加载 scenarios/ 全部用例，先过一遍真校验器（validateTemplateParams），
 * 再跑红线，最后拿每个用例自带的 expectRedLines 对答案，不一致就退出码 1。
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateTemplateParams } from '@/lib/generation/widget-templates';
import { evalCurve } from '@/components/widgets/ParameterCurve';
import type { CurveFamily, TemplateWidgetConfig } from '@/lib/types/widgets';

// ==================== 用例形状 ====================

/** 红线码。含义见 rubric.md，与 PBL planner 那套 B 码不同名不同义，别串。 */
export type RedLineCode = 'B1' | 'B2' | 'B3' | 'B4';

export interface RedLineHit {
  code: RedLineCode;
  /** 一句话说清是哪里犯的，报告里直接给人看 */
  detail: string;
}

export interface WidgetScenario {
  id: string;
  name: string;
  /** 模板教具填这个；自由 HTML 教具留空 */
  templateId?: string;
  /** 自由 HTML 教具填这个 */
  widgetType?: string;
  domain: string;
  /** 「看完这屏学生该能说出什么」。VLM 判教学意图那一维就是拿它当参照物 */
  intent: string;
  note?: string;
  /** 机械检查的期望答案。正例是空数组，红线样例写它该被判出的码 */
  expectRedLines: RedLineCode[];
  widgetConfig?: TemplateWidgetConfig;
  html?: string;
}

// ==================== 模板教具：读 config 判 ====================

/** 各曲线族公式里真正用到的系数。滑块绑到不在这张表里的字母 = 死滑块。
 * 与 ParameterCurve.evalCurve 的分支一一对应，那边加族这边要补。 */
const CURVE_COEFFICIENTS: Record<CurveFamily, ReadonlyArray<'a' | 'b' | 'c'>> = {
  linear: ['a', 'b'],
  quadratic: ['a', 'b', 'c'],
  power: ['a', 'b', 'c'],
  exponential: ['a', 'b', 'c'],
  logarithmic: ['a', 'b'],
  logistic: ['a', 'b', 'c'],
};

/** 与组件同参数的采样：121 点、丢掉非有限与 1e15 以上的值。
 * 常数抄自 ParameterCurve（那两个是组件内部常量，没导出，这里跟着写死；
 * 改那边的量级上限要回来同步，不然评测会和画面不一致）。 */
function finitePointCount(
  curve: CurveFamily,
  k: { a: number; b: number; c: number },
  xAxis: { min: number; max: number },
): number {
  let n = 0;
  for (let i = 0; i < 121; i += 1) {
    const x = xAxis.min + ((xAxis.max - xAxis.min) * i) / 120;
    const y = evalCurve(curve, k, x);
    if (Number.isFinite(y) && Math.abs(y) < 1e15) n += 1;
  }
  return n;
}

const allSame = (xs: unknown[]) => xs.every((x) => JSON.stringify(x) === JSON.stringify(xs[0]));

export function checkTemplateConfig(config: TemplateWidgetConfig): RedLineHit[] {
  const hits: RedLineHit[] = [];

  switch (config.templateId) {
    case 'process_stepper': {
      const steps = config.params.steps;
      if (allSame(steps)) {
        hits.push({
          code: 'B1',
          detail: `${steps.length} 步内容逐字相同，按「下一步」只有步号在动`,
        });
      }
      if (steps.every((s) => !s.carries)) {
        hits.push({ code: 'B3', detail: '没有任何一步写了交给下一步的东西，流程退化成分段文字' });
      }
      break;
    }

    case 'bpe_merge_stepper': {
      const steps = config.params.steps;
      if (allSame(steps)) {
        hits.push({ code: 'B1', detail: `${steps.length} 步的分词状态完全相同，合并从未发生` });
      }
      break;
    }

    case 'attention_playground': {
      const { scores } = config.params;
      if (allSame(scores)) {
        hits.push({ code: 'B2', detail: '相容性矩阵每一行都相同，点哪个 token 权重分布都不变' });
      } else if (scores.every((row) => new Set(row).size === 1)) {
        hits.push({
          code: 'B2',
          detail: '每行内部数值全相等，softmax 恒为均匀分布，温度滑块拖到头也没有形状变化',
        });
      }
      break;
    }

    case 'temperature_sampler': {
      const logits = config.params.candidates.map((c) => c.logit);
      if (new Set(logits).size === 1) {
        hits.push({
          code: 'B2',
          detail: '所有候选词 logit 相同，任何温度下都是均匀分布，温度滑块无效',
        });
      }
      break;
    }

    case 'tradeoff_matrix': {
      const { dimensions, options } = config.params;
      const flatDims = dimensions.every(
        (_, d) => new Set(options.map((o) => o.cells[d]?.rating)).size === 1,
      );
      if (flatDims) {
        hits.push({
          code: 'B2',
          detail: '每个维度下所有方案评分都一样，勾选任何维度组合排名都不会变',
        });
      }
      break;
    }

    case 'parameter_curve': {
      const { curve, coefficients, sliders, xAxis } = config.params;
      const used = CURVE_COEFFICIENTS[curve];
      for (const s of sliders) {
        if (!used.includes(s.key)) {
          hits.push({
            code: 'B2',
            detail: `滑块「${s.label}」绑在系数 ${s.key} 上，而 ${curve} 族的公式只用到 ${used.join('/')}，拖它曲线不动`,
          });
        }
      }
      const n = finitePointCount(curve, coefficients, xAxis);
      if (n < 2) {
        hits.push({
          code: 'B4',
          detail: `默认系数下 121 个采样点里只有 ${n} 个能画，首屏是一副空坐标轴`,
        });
      }
      break;
    }

    case 'layered_graph': {
      const nodes = config.params.layers.flatMap((l) => l.nodes);
      if (nodes.every((n) => !n.note)) {
        hits.push({
          code: 'B3',
          detail: `${nodes.length} 个节点没有一个带说明，点下去只有高亮，不出内容`,
        });
      }
      break;
    }

    case 'rag_retrieval_playground':
      // 这个模板的空转判定要重算一遍组件里的 Dice 打分才做得准，
      // 那个函数没导出，抄一份会漂移——留给 VLM 看多帧召回排名有没有变。
      break;
  }

  return hits;
}

// ==================== 自由 HTML 教具：扫源码判 ====================

const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'canvas', 'details']);
const INTERACTIVE_ROLES = new Set(['button', 'slider', 'checkbox', 'radio', 'tab', 'switch']);
const HANDLER_RE = /\bon(click|input|change|mousedown|pointerdown|keydown|touchstart)\s*=/i;

/**
 * 数 HTML 里到底有几个学生动得了的东西。
 * 已知上限：把交互全放在 canvas 上、只靠 addEventListener 绑在 document 的教具，
 * 这里会数少。宁可少数——少数只会把好教具误判成红线，
 * 由人复核一眼就能翻案；多数则会放过真死状。
 */
export function countInteractiveElements(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const roleMatch = /\brole\s*=\s*["']?([a-z]+)/i.exec(attrs);
    const interactive =
      INTERACTIVE_TAGS.has(tag) ||
      (tag === 'a' && /\bhref\s*=/i.test(attrs)) ||
      /\bcontenteditable\b/i.test(attrs) ||
      (roleMatch !== null && INTERACTIVE_ROLES.has(roleMatch[1].toLowerCase())) ||
      HANDLER_RE.test(attrs);
    if (interactive) n += 1;
  }
  return n;
}

export function checkHtml(html: string): RedLineHit[] {
  const n = countInteractiveElements(html);
  if (n <= 1) {
    return [
      {
        code: 'B1',
        detail: `整份 HTML 只数出 ${n} 个可操作元素，学生除了点它一下没有别的事可做`,
      },
    ];
  }
  return [];
}

// ==================== 用例加载 ====================

const HERE =
  typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

export function loadScenarios(filter?: string): WidgetScenario[] {
  const dir = join(HERE, 'scenarios');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as WidgetScenario)
    .filter((s) => !filter || s.id.includes(filter));
}

/** 一个用例的机械结论：校验器过不过 + 命中哪些红线。 */
export function checkScenario(s: WidgetScenario): { schemaError?: string; hits: RedLineHit[] } {
  if (s.html !== undefined) return { hits: checkHtml(s.html) };
  if (!s.widgetConfig) return { schemaError: '既没有 widgetConfig 也没有 html', hits: [] };

  // 先过生成端那把真校验器：用例本身要是连 schema 都不合法，
  // 说明它跑不到渲染，红线判定无从谈起——这一步等于给用例集上锁。
  const { templateId, params, name, guide } = s.widgetConfig;
  const validated = validateTemplateParams(templateId, params, { name, guide });
  if (!validated.ok) return { schemaError: validated.error, hits: [] };

  return { hits: checkTemplateConfig(validated.config) };
}

// ==================== 命令行 ====================

function main() {
  const filter = process.argv[2];
  const scenarios = loadScenarios(filter);
  console.log(`加载用例 ${scenarios.length} 份${filter ? `（过滤：${filter}）` : ''}\n`);

  let failed = 0;
  for (const s of scenarios) {
    const { schemaError, hits } = checkScenario(s);
    const got = hits.map((h) => h.code).sort();
    const want = [...s.expectRedLines].sort();
    const ok = !schemaError && JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed += 1;

    const kind = s.templateId ?? `html:${s.widgetType ?? '?'}`;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${s.id}  [${kind}]`);
    if (schemaError) console.log(`       校验器不过：${schemaError}`);
    for (const h of hits) console.log(`       ${h.code} ${h.detail}`);
    if (!ok && !schemaError) console.log(`       期望 [${want.join(',') || '无'}]，实得 [${got.join(',') || '无'}]`);
  }

  console.log(`\n合计 ${scenarios.length} 份，对不上的 ${failed} 份`);
  if (failed > 0) process.exit(1);
}

// tsx 在本仓按 CJS 跑（package.json 没有 type: module），require.main 可用。
// 万一以后整仓换 ESM，这里退化成「不自动执行、只当库用」，不会误跑。
if (typeof require !== 'undefined' && require.main === module) main();
