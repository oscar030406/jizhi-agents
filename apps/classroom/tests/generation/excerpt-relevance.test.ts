import { afterEach, describe, expect, test, vi } from 'vitest';

import { injectExcerpts, type EvidenceBundle } from '@/lib/generation/evidence-grounding';

// 第五道缰绳：摘录必须与讲义前文咬合（判官审计 08-11 批 unrelated 14%，
// 用户原话「牛头不对马嘴」）。
//
// 下面的前文/引文全部取自 91 条判官标注真样本
// （agent-engine/data/eval/excerpt_relevance/verdicts-2026081{0,1}-*.jsonl），
// 分数是 scripts/calibrate_excerpt_relevance.py 在这些样本上实测的 bge-m3 余弦。
// 阈值 0.60 由同一脚本扫出（supports|unrelated 分离度 0.83，置换 p=0.001）。

/** 判官标注 hl07s01#s1 · 大模型评测入门/课程介绍 · supports · 余弦 0.8026 */
const EVAL_LEAD =
  '欢迎来到大模型评测课程。面对参数规模动辄千亿的行业现状，单纯依赖主观感受已无法界定模型能力的边界。' +
  '评测不仅是分数的比较，更是工程决策的依据。教材对大模型评测的定义及其必要性做了如下阐述：';
/** 判官标注 ha12s03#s2 · 大模型评测入门/GAIA 基准详解 · supports · 余弦 0.8243 */
const GAIA_LEAD =
  'GAIA 是专为通用 AI 助手设计的评估体系，其核心目标在于检验模型解决实际问题的综合素养。' +
  '关于其推出背景与核心能力维度，教材原文表述是：';
/** 同一条 GAIA 引文贴到 Python 字典课 · 判官判 unrelated · 余弦 0.5523 */
const PYTHON_DICT_LEAD =
  '在互联网 AI 服务中，数据交换标准通常是 JSON 格式。Python 的 json 库会将 JSON 对象直接解析为字典，' +
  '这使得处理 API 响应变得直观。教材对此的原文表述是：';

const GAIA_TEXT =
  'GAIA (General AI Assistants) 是由 Meta AI 和 Hugging Face 联合推出的评估基准，' +
  '专注于评估 AI 助手的通用能力。与 BFCL 专注于工具调用不同，GAIA 评估的是智能体在真实世界任务中的综合表现。';
const CONV_TEXT =
  '卷积层对输入和卷积核权重进行互相关运算，并在添加标量偏置之后产生输出。' +
  '所以，卷积层中的两个被训练的参数是卷积核权重和标量偏置。';
const EVAL_TEXT =
  '什么是大模型评测？大模型评测就是通过各种标准化的方法和数据集，' +
  '对大模型在不同任务上的表现进行量化和比较，从而判断模型的适用性和可靠性。';

const chunk = (source_id: string, content: string) => ({
  source_id,
  title: '测试教材',
  content,
  concept_tags: [],
});

const bundleOf = (...cs: Array<{ source_id: string; content: string }>): EvidenceBundle =>
  ({ chunks: cs, matchedConcepts: [], summary: '', corpus: 'ai' }) as unknown as EvidenceBundle;

const para = (html: string) => ({
  type: 'text',
  width: 880,
  height: 640,
  content: `<p style="font-size: 16px;">${html}</p>`,
});

/** 引擎 /excerpt-relevance 的响应形态：scores[占位符序号][source_ids 下标]。 */
function stubEngine(perSite: Array<Record<string, number>>, threshold = 0.6) {
  const calls: Array<{ contexts: string[]; source_ids: string[]; corpus: string }> = [];
  vi.stubEnv('GROUNDING_URL', 'http://engine.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return {
        ok: true,
        json: async () => ({
          data: {
            threshold,
            scores: perSite.map((row) =>
              (body.source_ids as string[]).map((sid) => row[sid] ?? null),
            ),
          },
        }),
      };
    }),
  );
  return calls;
}

const textOf = (slide: { elements: Array<{ content: string }> }) =>
  slide.elements.map((el) => el.content.replace(/<[^>]+>/g, '')).join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('摘录咬合过滤（真标注样本）', () => {
  test('supports 放行：0.80 的引文照常贴', async () => {
    const slide = { elements: [para(EVAL_LEAD), para('{{摘录:hl07s01#s1}}')] };
    const calls = stubEngine([{ 'hl07s01#s1': 0.8026 }]);

    const stats = await injectExcerpts(slide, bundleOf(chunk('hl07s01#s1', EVAL_TEXT)), new Set());

    expect(stats.injected).toBe(1);
    expect(stats.irrelevant).toBe(0);
    expect(stats.swapped).toBe(0);
    expect(textOf(slide)).toContain('大模型评测就是通过各种标准化的方法');
    // 打分请求带的是「跨元素累计的前文」——占位符独占一个元素，只看同元素前文必空
    expect(calls[0].contexts[0]).toContain('教材对大模型评测的定义');
    expect(calls[0].contexts[0].length).toBeLessThanOrEqual(160);
    expect(calls[0].source_ids).toEqual(['hl07s01#s1']);
    expect(calls[0].corpus).toBe('ai');
  });

  test('unrelated 拦截：Python 类讲义 + 卷积层引文（判官实测 0.4837）不贴，导语一并撤走', async () => {
    const lead = para('在 Python 中，类是创建对象的蓝图。教材对此的原文表述是：');
    const slide = { elements: [lead, para('{{摘录:dl01s02#s4}}')] };
    stubEngine([{ 'dl01s02#s4': 0.4837 }]);

    const stats = await injectExcerpts(slide, bundleOf(chunk('dl01s02#s4', CONV_TEXT)), new Set());

    expect(stats.injected).toBe(0);
    expect(stats.irrelevant).toBe(1);
    expect(textOf(slide)).not.toContain('卷积核权重');
    // 空头支票不留：摘录没贴成，「教材对此的原文表述是：」跟着撤
    expect(lead.content).not.toContain('原文表述是');
  });

  test('换候选成功：模型挑错了块，换成清单里咬合的那条', async () => {
    const slide = { elements: [para(GAIA_LEAD), para('{{摘录:dl01s02#s4}}')] };
    stubEngine([{ 'dl01s02#s4': 0.4837, 'ha12s03#s2': 0.8243 }]);

    const stats = await injectExcerpts(
      slide,
      bundleOf(chunk('dl01s02#s4', CONV_TEXT), chunk('ha12s03#s2', GAIA_TEXT)),
      new Set(),
    );

    expect(stats.swapped).toBe(1);
    expect(stats.injected).toBe(1);
    expect(stats.irrelevant).toBe(0);
    const out = textOf(slide);
    expect(out).toContain('General AI Assistants');
    expect(out).not.toContain('卷积核权重');
    expect(out).toContain('[ha12s03#s2]'); // 出处标注跟着换，不能贴 A 的原文标 B 的出处
  });

  test('全拒兜底：候选都不咬合就整条丢，不硬贴', async () => {
    // 同一条 GAIA 引文换到 Python 字典课，判官判 unrelated（实测 0.5523）
    const slide = { elements: [para(PYTHON_DICT_LEAD), para('{{摘录:ha12s03#s2}}')] };
    stubEngine([{ 'ha12s03#s2': 0.5523, 'dl01s02#s4': 0.4837 }]);

    const stats = await injectExcerpts(
      slide,
      bundleOf(chunk('ha12s03#s2', GAIA_TEXT), chunk('dl01s02#s4', CONV_TEXT)),
      new Set(),
    );

    expect(stats.injected).toBe(0);
    expect(stats.swapped).toBe(0);
    expect(stats.irrelevant).toBe(1);
    expect(textOf(slide)).not.toContain('General AI Assistants');
  });

  test('已被跨场景去重占用的块不作候选（换过去只会变成一行回指）', async () => {
    const slide = { elements: [para(GAIA_LEAD), para('{{摘录:dl01s02#s4}}')] };
    stubEngine([{ 'dl01s02#s4': 0.4837, 'ha12s03#s2': 0.8243 }]);

    const stats = await injectExcerpts(
      slide,
      bundleOf(chunk('dl01s02#s4', CONV_TEXT), chunk('ha12s03#s2', GAIA_TEXT)),
      new Set(['ha12s03#s2']),
    );

    expect(stats.swapped).toBe(0);
    expect(stats.irrelevant).toBe(1);
  });
});

describe('打分器不可用一律放行（摘录归零是翻过的车）', () => {
  test('引擎非 200：不咬合的那条也照贴', async () => {
    vi.stubEnv('GROUNDING_URL', 'http://engine.test');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
    const slide = { elements: [para(PYTHON_DICT_LEAD), para('{{摘录:ha12s03#s2}}')] };

    const stats = await injectExcerpts(slide, bundleOf(chunk('ha12s03#s2', GAIA_TEXT)), new Set());

    expect(stats.injected).toBe(1);
    expect(stats.irrelevant).toBe(0);
  });

  test('引擎不可达（抛异常）：行为等同未接打分器', async () => {
    vi.stubEnv('GROUNDING_URL', 'http://engine.test');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const slide = { elements: [para(PYTHON_DICT_LEAD), para('{{摘录:ha12s03#s2}}')] };

    const stats = await injectExcerpts(slide, bundleOf(chunk('ha12s03#s2', GAIA_TEXT)), new Set());

    expect(stats.injected).toBe(1);
  });

  test('未配置 GROUNDING_URL：一次网络调用都不发', async () => {
    vi.stubEnv('GROUNDING_URL', '');
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const slide = { elements: [para(PYTHON_DICT_LEAD), para('{{摘录:ha12s03#s2}}')] };

    const stats = await injectExcerpts(slide, bundleOf(chunk('ha12s03#s2', GAIA_TEXT)), new Set());

    expect(spy).not.toHaveBeenCalled();
    expect(stats.injected).toBe(1);
  });

  test('引擎索引里没有这块（分数为 null）：放行，不打分≠不咬合', async () => {
    const slide = { elements: [para(PYTHON_DICT_LEAD), para('{{摘录:ha12s03#s2}}')] };
    stubEngine([{}]); // scores 全 null

    const stats = await injectExcerpts(slide, bundleOf(chunk('ha12s03#s2', GAIA_TEXT)), new Set());

    expect(stats.injected).toBe(1);
    expect(stats.irrelevant).toBe(0);
  });
});

describe('多占位符：分数按出现顺序对齐', () => {
  test('第一条咬合放行、第二条不咬合拦下', async () => {
    const slide = {
      elements: [
        para(EVAL_LEAD),
        para('{{摘录:hl07s01#s1}}'),
        para('接着看另一段。教材对此的原文表述是：'),
        para('{{摘录:dl01s02#s4}}'),
      ],
    };
    const calls = stubEngine([
      { 'hl07s01#s1': 0.8026, 'dl01s02#s4': 0.42 },
      { 'hl07s01#s1': 0.55, 'dl01s02#s4': 0.4837 },
    ]);

    const stats = await injectExcerpts(
      slide,
      bundleOf(chunk('hl07s01#s1', EVAL_TEXT), chunk('dl01s02#s4', CONV_TEXT)),
      new Set(),
    );

    expect(calls[0].contexts).toHaveLength(2);
    expect(stats.injected).toBe(1);
    expect(stats.irrelevant).toBe(1);
    const out = textOf(slide);
    expect(out).toContain('大模型评测就是通过各种标准化的方法');
    expect(out).not.toContain('卷积核权重');
  });
});
