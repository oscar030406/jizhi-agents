/**
 * 拿第三轮同题对照课屏 2 的**真产物**回归。
 *
 * 我构造的 fixture 一路绿，线上那一屏照样五个「本段目标：」——因为我构造的
 * 形状是「标签行 + 正文段在同一个元素里」，而真产物是**五个 text 元素、
 * 每个的全部内容就是一行标签**（25 字、22 字、24 字……）。删完剩 0 字，
 * 于是「删剩太少就放弃」的阀门一律放弃，标签照样上屏。
 *
 * 粒度错了，阈值怎么调都治不了：该丢的是整条元素，不是元素里的一段。
 * 所以这条测试盯的是真产物，不是我以为的形状。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scrubScaffoldHtml } from '@/lib/generation/adaptation-lint';

interface El {
  id: string;
  type: string;
  content?: string;
}

const screen2 = (): El[] =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/scaffold-leak-screen2.json'), 'utf-8'),
  ).elements;

describe('屏 2 真产物回归', () => {
  it('五个元素被认出来，且都是「整条都是脚手架」', () => {
    const hits = screen2()
      .filter((el) => el.type === 'text' && typeof el.content === 'string')
      .map((el) => ({ id: el.id, ...scrubScaffoldHtml(el.content!) }))
      .filter((r) => r.dropped.length);

    expect(hits).toHaveLength(5);
    // 关键断言：全部是 empty。不是 empty 的话说明我又在治想象中的形状
    expect(hits.every((h) => h.empty)).toBe(true);
    expect(hits[0].dropped[0]).toContain('本段目标');
  });

  it('这一屏还有别的文字元素——所以整条丢弃不会把屏清空', () => {
    const texts = screen2().filter((el) => el.type === 'text' && typeof el.content === 'string');
    const emptied = texts.filter((el) => scrubScaffoldHtml(el.content!).empty).length;
    expect(texts.length).toBeGreaterThan(emptied);
  });

  it('正文元素一个都不许误伤', () => {
    const survivors = screen2()
      .filter((el) => el.type === 'text' && typeof el.content === 'string')
      .map((el) => scrubScaffoldHtml(el.content!))
      .filter((r) => !r.empty);
    // 剩下的元素一段都不该被删——它们是这一屏真正的教学内容
    expect(survivors.every((r) => r.dropped.length === 0)).toBe(true);
  });
});
