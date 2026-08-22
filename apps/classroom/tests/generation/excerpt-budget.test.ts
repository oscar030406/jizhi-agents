import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { injectExcerpts, type EvidenceBundle } from '@/lib/generation/evidence-grounding';
import { mdToElements } from '@/lib/generation/md-to-elements';
import { parseExcerptBlock } from '@/components/slide-renderer/components/element/TextElement/ExcerptBlock';

// 摘录按盒预算裁字（用户 08-03 实测：整段原文溢出画布底被截断）。
// 预算按 16px 字号 / 1.5 行高 / 盒 padding 反算，装不下裁短加省略号。

function bundleWith(content: string): EvidenceBundle {
  return {
    chunks: [{ source_id: 'c1', title: '测试教材', content, score: 1 }],
  } as unknown as EvidenceBundle;
}

function bundleOf(...ids: string[]): EvidenceBundle {
  return {
    chunks: ids.map((id) => ({ source_id: id, title: '测试教材', content: '原文'.repeat(60) })),
  } as unknown as EvidenceBundle;
}

/** 讲义流的真实元素形态：md→elements 逐段成元素，段落是 <p style=…> 包一层。 */
const para = (html: string) => ({
  type: 'text',
  width: 880,
  height: 640,
  content: `<p style="font-size: 16px;">${html}</p>`,
});

const LONG = '很'.repeat(500);

// tests/setup-env.ts 会把 .env.local 灌进 process.env，其中就有 GROUNDING_URL——
// 不关掉的话本文件会去真调 8001 的摘录咬合打分，测试成败取决于引擎起没起
// （实测：引擎一起来，用 '原文'×60 当正文的合成 fixture 立刻被判不咬合）。
// 咬合那一条缰绳有自己的用例文件（excerpt-relevance.test.ts），这里只测别的几条。
beforeEach(() => vi.stubEnv('GROUNDING_URL', ''));
afterEach(() => vi.unstubAllEnvs());

describe('injectExcerpts 盒预算', () => {
  test('小盒 text 元素：摘录被裁短并加省略号，注入仍计数', async () => {
    const el = {
      type: 'text',
      width: 400,
      height: 120,
      content: '{{摘录:c1}}',
    };
    const stats = await injectExcerpts({ elements: [el] }, bundleWith(LONG), new Set());
    expect(stats.injected).toBe(1);
    expect(el.content).toContain('…');
    expect(el.content.length).toBeLessThan(LONG.length);
    // 裁短后仍是合法摘录格式（出处行完整）
    expect(parseExcerptBlock(el.content)).toMatchObject({ kind: 'excerpt', sourceId: 'c1' });
  });

  test('大盒 text 元素：500 字全量注入，不裁', async () => {
    const el = { type: 'text', width: 840, height: 400, content: '{{摘录:c1}}' };
    await injectExcerpts({ elements: [el] }, bundleWith(LONG), new Set());
    expect(el.content).toContain(LONG);
    expect(el.content).not.toContain('…');
  });

  test('非 text 元素字段（无盒）：维持 600 字上限', async () => {
    const cell: { text: string } = { text: '{{摘录:c1}}' };
    const stats = await injectExcerpts(cell, bundleWith('短'.repeat(700)), new Set());
    expect(stats.injected).toBe(1);
    expect(cell.text).toContain('…');
    expect(cell.text.length).toBeLessThan(700);
  });
});

describe('引导句缰绳（摘录咬合，2026-08-10）', () => {
  test('讲义流内嵌：前文有冒号引导句才注入', async () => {
    const el = {
      type: 'text',
      width: 840,
      height: 400,
      content: '教材对此的原文表述是：\n{{摘录:c1}}',
    };
    const stats = await injectExcerpts({ elements: [el] }, bundleWith('内容'.repeat(50)), new Set());
    expect(stats.injected).toBe(1);
    expect(stats.noLead).toBe(0);
  });

  test('讲义流内嵌：前文无引导句 → 拒贴并计 noLead', async () => {
    const el = {
      type: 'text',
      width: 840,
      height: 400,
      content: '这是一段与前后都无关的普通叙述而已。\n{{摘录:c1}}',
    };
    const stats = await injectExcerpts({ elements: [el] }, bundleWith('内容'.repeat(50)), new Set());
    expect(stats.injected).toBe(0);
    expect(stats.noLead).toBe(1);
    expect(el.content).not.toContain('📖');
  });

  test('专用摘录盒（占位符即全部内容）豁免引导句要求', async () => {
    const el = { type: 'text', width: 400, height: 120, content: '{{摘录:c1}}' };
    const stats = await injectExcerpts({ elements: [el] }, bundleWith('内容'.repeat(50)), new Set());
    expect(stats.injected).toBe(1);
    expect(stats.noLead).toBe(0);
  });

  test('掉了摘录 → 前一元素整段就是导语时，整段抹掉（b2-rag 实测形态）', async () => {
    // 模型引用了不在可引用清单里的 id（b2/b3-kv-cache 的保底块就是这么被清掉的）
    const lead = para('关于系统具体的工作模式，教材里有更完整的展开：');
    const ph = para('{{摘录:ld10s01#s5}}');
    const stats = await injectExcerpts({ elements: [lead, ph] }, bundleOf('c1'), new Set());
    expect(stats.unknown).toBe(1);
    expect(ph.content).not.toContain('摘录');
    expect(lead.content).toBe('');
  });

  test('掉了摘录 → 导语只是长段落的收尾一句时，只撤这一句（b3-kv-cache 实测形态）', async () => {
    const body =
      '想象你在和朋友打电话，如果每说一个新词，都要把之前聊过的所有话重新背一遍，电话会变得极慢。' +
      '如果没有优化，模型每生成一个新字，都要把之前所有字对应的数据重新算一次。';
    const lead = para(`${body}教材对此的原文表述是：`);
    const ph = para('{{摘录:unknown#1}}');
    await injectExcerpts({ elements: [lead, ph] }, bundleOf('c1'), new Set());
    expect(lead.content).toContain('重新算一次。');
    expect(lead.content).not.toContain('教材对此的原文表述是');
  });

  test('掉了摘录 → 前一段不是导语就不动（防误删正文）', async () => {
    // 严口径的意义：这句里出现了「教材」「引用」两个意图词，但整句不是预告，不能删
    const prose = para('这段讲的是分块策略本身，与教材引用无关，末尾也没有冒号');
    const ph = para('{{摘录:unknown#1}}');
    await injectExcerpts({ elements: [prose, ph] }, bundleOf('c1'), new Set());
    expect(prose.content).toContain('分块策略本身');
  });

  test('意图词引导句（句号收尾）也放行——v2 口径：意图在词不在标点', async () => {
    // 首版只认冒号，实测把两门新课摘录清零（模型写「教材对此有更完整的展开。」）
    const el = {
      type: 'text',
      width: 840,
      height: 400,
      content: '这一点教材里有更完整的展开。\n{{摘录:c1}}',
    };
    const stats = await injectExcerpts({ elements: [el] }, bundleWith('内容'.repeat(50)), new Set());
    expect(stats.injected).toBe(1);
    expect(stats.noLead).toBe(0);
  });
});

describe('跨场景去重的边界（2A run-20260811：整页只剩回指）', () => {
  test('整页占位符全是已引用出处 → 放行第一条，不让整页空手', async () => {
    const lead = para('教材对 RAG 核心定义的原文表述是：');
    const ph = para('{{摘录:ha08s03#s2}}');
    const stats = await injectExcerpts(
      { elements: [lead, ph] },
      bundleOf('ha08s03#s2'),
      new Set(['ha08s03#s2']),
    );
    expect(stats.injected).toBe(1);
    expect(stats.deduped).toBe(0);
    expect(ph.content).toContain('📖');
    expect(lead.content).toContain('原文表述是');
  });

  test('本页还有别的摘录能贴 → 已引用的出处照常回指', async () => {
    const fresh = para('{{摘录:s9}}');
    const dup = para('{{摘录:s2}}');
    const stats = await injectExcerpts(
      { elements: [fresh, dup] },
      bundleOf('s9', 's2'),
      new Set(['s2']),
    );
    expect(stats.injected).toBe(1);
    expect(stats.deduped).toBe(1);
    expect(dup.content).toContain('前文已引用');
  });

  test('豁免只用一次：同一出处在本页出现两次，第二次仍回指', async () => {
    const a = para('{{摘录:s2}}');
    const b = para('{{摘录:s2}}');
    const stats = await injectExcerpts({ elements: [a, b] }, bundleOf('s2'), new Set(['s2']));
    expect(stats.injected).toBe(1);
    expect(stats.deduped).toBe(1);
    expect(a.content).toContain('📖');
    expect(b.content).toContain('前文已引用');
  });

  test('没有 usedIds（单场景调用）时行为不变', async () => {
    const el = para('{{摘录:s2}}');
    const stats = await injectExcerpts({ elements: [el] }, bundleOf('s2'), undefined);
    expect(stats.injected).toBe(1);
  });
});

// ── 端到端：b2-rag（2A run-20260811 两轮稳定 miss）的真实版面 + 真实语料块 ──
// 病灶：整页唯一的教材原文被跨场景去重换成一行回指，而「教材对 RAG 核心定义的
// 原文表述是：」还留在上面 → 判官两轮都认定「术语 RAG 未定义，假设读者已从前文
// 获得定义」，判成 advanced / transition。
describe('b2-rag 真实复现', () => {
  const MD = [
    '大模型有时会一本正经地胡说八道。为了解决这个问题，我们需要给它配一个“外部知识库”。',
    '',
    '教材对 RAG 核心定义的原文表述是：',
    '',
    '{{摘录:ha08s03#s2}}',
    '',
    '基于上述定义，系统必须建立标准化的处理流水线，确保知识能被准确查找。',
    '',
    '关于系统具体的工作模式，教材里有更完整的展开：',
    '',
    '{{摘录:ha08s03#s3}}',
    '',
    '为什么要对文档进行分割处理？如果直接把一本 10 万字的书塞给模型，它会“消化不良”。',
  ].join('\n');

  // 语料原文（engine /internal/v1/personalize/evidence 实拉，截取）
  const S2 =
    '### 8.3.1 RAG的基础知识\n\n（1）什么是RAG？\n\n检索增强生成（Retrieval-Augmented Generation，RAG）' +
    '是一种结合了信息检索和文本生成的技术。它的核心思想是：在生成回答之前，先从外部知识库中检索相关信息，' +
    '然后将检索到的信息作为上下文提供给大语言模型，从而生成更准确、更可靠的回答。';
  // #s3 是「如图8.5所示…」的图解说明段：selfContained 判否 → 丢弃（真实行为）
  const S3 = '### 8.3.2 RAG系统工作原理\n\n如图8.5所示，展示了RAG系统的两个主要工作模式：\n1. 数据处理流程…';

  const bundle = {
    chunks: [
      { source_id: 'ha08s03#s2', title: '第8章 8.3 RAG系统', content: S2 },
      { source_id: 'ha08s03#s3', title: '第8章 8.3 RAG系统', content: S3 },
    ],
  } as unknown as EvidenceBundle;

  test('一条被去重、一条被拒 → 放行被去重的那条，并撤掉被拒那条的导语', async () => {
    const slide = mdToElements(MD);
    const stats = await injectExcerpts(slide, bundle, new Set(['ha08s03#s2']));
    const out = slide.elements
      .map((el) => String(el.content ?? '').replace(/<[^>]+>/g, ''))
      .filter((s) => s.trim())
      .join('\n');
    expect(stats.injected).toBe(1);
    expect(out).toContain('检索增强生成（Retrieval-Augmented Generation，RAG）是一种结合了信息检索');
    expect(out).toContain('教材对 RAG 核心定义的原文表述是：');
    expect(out).not.toContain('关于系统具体的工作模式');
    expect(out).toContain('为什么要对文档进行分割处理');
  });
});
