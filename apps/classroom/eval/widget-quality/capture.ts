/**
 * 教具多帧采集：按 rubric.md 第三节的探针表操作，一份用例出多帧。
 *
 * 为什么必须多帧：教具的头号死法是参数退化（拖了滑块曲线不动、点了节点不出内容），
 * 这些形态单帧全都好看，只有帧与帧一比才现原形——五维里的 W1 和红线 B1 都靠帧间差异判。
 *
 * 为什么先过一遍机械红线：已经被 redlines.ts 判死的用例不送截图。一是省时间，
 * 二是避免两套结论打架（rubric.md 第二节分工表里写死的口径）。
 *
 * 这一步不打分、不调模型：只产出图片 + index.json，打分留给后面接上的 VLM。
 *
 *   pnpm tsx eval/widget-quality/capture.ts                    # 全部用例
 *   pnpm tsx eval/widget-quality/capture.ts --filter curve     # 按 id 子串过滤
 *   pnpm tsx eval/widget-quality/capture.ts --out D:/shots     # 换产出目录
 *
 * 前置：另开一个终端跑 pnpm dev（默认 http://localhost:3000），渲染页是 /eval/widget。
 */

import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'url';
import { checkScenario, loadScenarios, type WidgetScenario } from './redlines';
import type { TemplateWidgetConfig } from '@/lib/types/widgets';

/** 渲染页里那个包住教具的框，截图只截它，不截整页空白 */
const ROOT = '#eval-widget-root';
/** 视窗给得比画框（1000）宽一点，免得出现横向滚动条把右边一列压掉 */
const VIEWPORT = { width: 1100, height: 900 };
/** 注入配置之后等渲染稳定：字体、SVG 描边、iframe 里的脚本 */
const SETTLE_AFTER_INJECT = 800;
/** 每次操作之后等动画停：模板组件用的是 CSS transition，200ms 量级 */
const SETTLE_AFTER_PROBE = 400;
/** 自由 HTML 教具最多点几个元素——不封顶的话一份满是按钮的页面能出几十帧 */
const MAX_HTML_PROBES = 6;

interface Probe {
  /** 这一帧是怎么来的，原样写进 index.json，正好填 rubric 提示词里的 {{probes}} */
  label: string;
  act: () => Promise<void>;
}

interface FrameRecord {
  file: string;
  probe: string;
}

// ==================== 探针：动什么由 templateId 决定 ====================

/** 把 input[type=range] 拨到指定位置。
 * 用 Playwright 的 fill 而不是拖鼠标：range 的 fill 走原生 setter 再派发 input 事件，
 * React 的 onChange 收得到，也不用算滑块轨道的像素坐标。 */
function rangeSetter(root: Locator) {
  return async (index: number, to: 'min' | 'max' | number) => {
    const el = root.locator('input[type=range]').nth(index);
    const value = typeof to === 'number' ? to : await el.getAttribute(to);
    await el.fill(String(value));
  };
}

/** 模板教具的探针表，与 rubric.md 第三节一一对应。改那张表要同步改这里。 */
function templateProbes(cfg: TemplateWidgetConfig, root: Locator): Probe[] {
  const setRange = rangeSetter(root);

  switch (cfg.templateId) {
    case 'attention_playground': {
      const tokens = cfg.params.tokens;
      const last = tokens.length - 1;
      // 探针表写的是「点最后一个 token」，但 focusDefault 常常就指着最后那个
      // （代词消解那份用例就是），照抄会拍出一张和默认态一模一样的帧，
      // VLM 一比帧就误判成「点了没反应」。所以改成「换一个 query」：优先最后一个，
      // 撞上默认焦点就退到第一个。
      const focus = cfg.params.focusDefault ?? 0;
      const target = focus === last ? 0 : last;
      // 这个组件里除了 token 之外没有别的按钮，直接按序号取
      return [
        {
          label: `把 query 换成 token「${tokens[target]}」`,
          act: () => root.locator('button').nth(target).click(),
        },
        {
          // 先把 query 拨回默认那个再拖温度：这一帧与默认态之间只差一个 τ，
          // 「温度到底管不管用」才判得干净（和曲线那边先复位滑块是同一条规矩）
          label: '把 query 拨回默认，温度滑块拖到最小',
          act: async () => {
            await root.locator('button').nth(focus).click();
            await setRange(0, 'min');
          },
        },
      ];
    }

    case 'bpe_merge_stepper':
      return [
        {
          label: '连点「合并一次」直到最后一步',
          act: async () => {
            const btn = root.getByRole('button', { name: /合并一次/ });
            // 步数有限，按 steps 长度封顶；按钮 disabled 就提前收工
            for (let i = 0; i < cfg.params.steps.length; i += 1) {
              if (await btn.isDisabled()) break;
              await btn.click();
            }
          },
        },
      ];

    case 'temperature_sampler':
      return [
        { label: '温度拖到最小', act: () => setRange(0, 'min') },
        { label: '温度拖到最大', act: () => setRange(0, 'max') },
      ];

    case 'rag_retrieval_playground':
      return cfg.params.suggestedQueries.map((q) => ({
        label: `点预设问法「${q}」`,
        act: () => root.getByRole('button', { name: q, exact: true }).click(),
      }));

    case 'parameter_curve': {
      const { sliders, coefficients, showTangent, xAxis } = cfg.params;
      // 每个滑块量程两端各一帧。动之前先把所有滑块拨回初值：不复位的话第二个滑块的
      // 两帧是叠在第一个滑块的极值上的，帧间差异归因就说不清了。
      const reset = async () => {
        for (const [i, s] of sliders.entries()) await setRange(i, coefficients[s.key]);
      };
      const probes: Probe[] = [];
      sliders.forEach((s, i) => {
        probes.push({
          label: `滑块「${s.label}」拖到最小 ${s.min}`,
          act: async () => {
            await reset();
            await setRange(i, s.min);
          },
        });
        probes.push({
          label: `滑块「${s.label}」拖到最大 ${s.max}`,
          act: async () => {
            await reset();
            await setRange(i, s.max);
          },
        });
      });
      if (showTangent) {
        // 切点滑块排在系数滑块后面；拖到 3/4 处而不是端点——端点上切线常压在坐标轴上看不清
        const x0 = xAxis.min + (xAxis.max - xAxis.min) * 0.75;
        probes.push({
          label: `切点拖到 ${xAxis.label} = ${x0}`,
          act: async () => {
            await reset();
            await setRange(sliders.length, x0);
          },
        });
      }
      return probes;
    }

    case 'process_stepper': {
      const n = cfg.params.steps.length;
      const mid = Math.floor((n - 1) / 2);
      const stepBtn = (i: number) => root.locator('ol li button').nth(i);
      return [
        { label: `点到第 ${mid + 1} 步`, act: () => stepBtn(mid).click() },
        { label: `点到第 ${n} 步（最后一步）`, act: () => stepBtn(n - 1).click() },
      ];
    }

    case 'tradeoff_matrix': {
      const dims = cfg.params.dimensions;
      // 维度按钮是这个组件里唯一带 aria-pressed 的元素；读它当前状态再决定点不点，
      // 这样两个探针互不依赖，谁先跑都得到同一个画面
      const keepOnly = async (k: number) => {
        const btns = root.locator('button[aria-pressed]');
        for (let i = 0; i < (await btns.count()); i += 1) {
          const b = btns.nth(i);
          if (((await b.getAttribute('aria-pressed')) === 'true') !== (i === k)) await b.click();
        }
      };
      return [
        { label: `只留维度「${dims[0]}」`, act: () => keepOnly(0) },
        { label: `只留维度「${dims[dims.length - 1]}」`, act: () => keepOnly(dims.length - 1) },
      ];
    }

    case 'layered_graph': {
      // 入度最高的节点＝汇聚点，它的说明位最该有内容（B3 就长在这儿）
      const inDeg = new Map<string, number>();
      for (const e of cfg.params.edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
      const nodes = cfg.params.layers.flatMap((l) => l.nodes);
      const target = [...nodes].sort((a, b) => (inDeg.get(b.id) ?? 0) - (inDeg.get(a.id) ?? 0))[0];
      return [
        {
          label: `点入度最高的节点「${target.label}」`,
          act: () => root.getByRole('button', { name: target.label, exact: true }).click(),
        },
      ];
    }
  }
}

/** 自由 HTML 教具：依次点每个可操作元素。
 * 选择器口径与 redlines.ts 的 countInteractiveElements 对齐——那边数出几个，
 * 这边就该点到几个；两边口径漂了，机械判和图判会互相打脸。 */
async function htmlProbes(page: Page): Promise<Probe[]> {
  const frame = page.frameLocator(`${ROOT} iframe`);
  const els = frame.locator(
    'button, a[href], input, select, textarea, [role=button], [role=slider], [contenteditable]',
  );
  const n = Math.min(await els.count(), MAX_HTML_PROBES);
  return Array.from({ length: n }, (_, i) => ({
    label: `点第 ${i + 1} 个可操作元素`,
    act: () => els.nth(i).click({ timeout: 3000 }),
  }));
}

// ==================== 采集 ====================

async function captureCase(page: Page, s: WidgetScenario, caseDir: string): Promise<FrameRecord[]> {
  const root = page.locator(ROOT);
  mkdirSync(caseDir, { recursive: true });

  await page.evaluate(
    (payload) => {
      const setter = (window as unknown as Record<string, (p: unknown) => void>).__setWidget;
      setter(payload);
    },
    { config: s.widgetConfig, html: s.html },
  );
  await page.waitForTimeout(SETTLE_AFTER_INJECT);

  const frames: FrameRecord[] = [];
  const seen = new Map<string, string>();
  const shoot = async (index: number, probe: string) => {
    const file = `${String(index).padStart(2, '0')}.png`;
    const buf = await root.screenshot();
    writeFileSync(join(caseDir, file), buf);
    // 逐字节相同的两帧有两种可能：教具真死了（该 VLM 判），或者探针本身是空操作
    // （点的正好是当前已选中的那个）。这里不下结论，只把话说出来——
    // 探针空操作会让好教具背上「点了没反应」的黑锅，加模板时最容易踩。
    const key = createHash('md5').update(buf).digest('hex');
    const twin = seen.get(key);
    if (twin) console.log(`     ⚠ ${file} 与 ${twin} 逐字节相同：先确认探针不是空操作`);
    seen.set(key, file);
    frames.push({ file, probe });
  };

  // 第 0 帧永远是默认态：红线 B4「默认态空屏」就只看这一帧
  await shoot(0, '默认态（一次都没点）');

  const probes =
    s.html !== undefined ? await htmlProbes(page) : templateProbes(s.widgetConfig!, root);
  for (const [i, p] of probes.entries()) {
    await p.act();
    await page.waitForTimeout(SETTLE_AFTER_PROBE);
    await shoot(i + 1, p.label);
  }
  return frames;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: 'http://localhost:3000' },
      out: { type: 'string' },
      filter: { type: 'string' },
    },
  });
  const here =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const baseUrl = values['base-url']!;
  const outDir = values.out ?? join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));

  const scenarios = loadScenarios(values.filter);
  console.log(`加载用例 ${scenarios.length} 份，产出目录 ${outDir}\n`);

  const cases: Array<{
    id: string;
    name: string;
    intent: string;
    kind: string;
    frames: FrameRecord[];
  }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    await page.goto(`${baseUrl}/eval/widget`);
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__evalReady === true,
    );

    for (const s of scenarios) {
      // 机械红线先判，判死的不送截图（rubric.md 第五节的结算顺序）
      const { schemaError, hits } = checkScenario(s);
      if (schemaError || hits.length > 0) {
        const reason = schemaError
          ? `校验器不过：${schemaError}`
          : hits.map((h) => `${h.code} ${h.detail}`).join('；');
        skipped.push({ id: s.id, reason });
        console.log(`跳过 ${s.id}  ${reason}`);
        continue;
      }

      const frames = await captureCase(page, s, join(outDir, s.id));
      cases.push({
        id: s.id,
        name: s.name,
        intent: s.intent,
        kind: s.templateId ?? `html:${s.widgetType ?? '?'}`,
        frames,
      });
      console.log(`采集 ${s.id}  ${frames.length} 帧`);
    }
  } finally {
    await browser?.close();
  }

  // index.json 就是打分器的入口：name / intent / probes 三样正好填 rubric.md 第四节的提示词
  mkdirSync(outDir, { recursive: true });
  const indexPath = join(outDir, 'index.json');
  writeFileSync(
    indexPath,
    JSON.stringify({ capturedAt: new Date().toISOString(), baseUrl, cases, skipped }, null, 2),
  );

  const total = cases.reduce((n, c) => n + c.frames.length, 0);
  console.log(`\n采集 ${cases.length} 份共 ${total} 帧，机械判死跳过 ${skipped.length} 份`);
  console.log(`索引：${indexPath}`);
}

if (typeof require !== 'undefined' && require.main === module) main();
