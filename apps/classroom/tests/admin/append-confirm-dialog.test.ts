/**
 * 追加模式必须在确认弹层里回显。
 *
 * 新建库与追加到已有库的行为差别极大——跑几站、碰不碰既有库、失败会不会
 * 清理——而这个选择只在表单上勾一下，确认弹层此前只字不提。
 * 与当年「涉及实操不回显」同一族：**把一个后果很大的选择藏在确认之前**。
 *
 * 这条是静态断言而不是渲染测试：这一页没有既有的渲染测试设施，
 * 而要防的事情（弹层里没有这段）静态读文件就拦得住。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () =>
  readFileSync(join(process.cwd(), 'app/admin/knowledge/start-intake.tsx'), 'utf-8');

describe('确认弹层回显追加模式', () => {
  it('读得到表单上的 append 勾选', () => {
    expect(src()).toContain("pending?.get('append') === 'true'");
  });

  it('弹层里有专门的一条，且说清「不建新库」', () => {
    const s = src();
    expect(s).toContain('追加到已有库');
    expect(s).toContain('这次不建新库');
  });

  it('把「改删仍需重建」这句一起说了——含糊了会有人当全量增量用', () => {
    expect(src()).toContain('那得整库重建');
  });

  it('标题跟着分岔：追加时不说「发起接入」', () => {
    expect(src()).toContain("append ? '确认追加到已有库' : '确认发起接入'");
  });
});
