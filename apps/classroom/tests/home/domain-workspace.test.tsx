/**
 * 域工作区（首页最小实现）的三态锁：
 * - 画像未选库 / 选 ai → 原路径卡（AI 路径照常）
 * - 选了有课的域（具身智能 2 门）→ 该域课程列表，可点进课堂
 * - 选了没课的域（企业管理系统 Odoo）→ 诚实空态 + 引导生成，不显示 AI 路径
 * 后两态必须带「路径仅覆盖 AI 领域」的口径提示。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PathOrDomainCard, DomainCoursesCard } from '@/components/home/learning-overview';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('域工作区：PathOrDomainCard 三态', () => {
  it('未选库/选 ai 走原路径卡', () => {
    for (const corpus of ['', 'ai', undefined]) {
      const out = html(createElement(PathOrDomainCard, { corpus, progressByCourseId: {} }));
      expect(out).toContain('我的学习路径');
    }
  });

  it('外域（智能制造）走域课程卡：本地快照无课时给诚实空态，不显示 AI 路径', () => {
    // 该域的公开课在生产环境（运行时 /api/course-domains 口径）；本地快照没有，
    // 卡片必须如实说「还没有生成课程」而不是拿 AI 课冒充——列课行为由下面
    // DomainCoursesCard 注入映射的用例覆盖。
    const out = html(
      createElement(PathOrDomainCard, { corpus: 'smart-manufacturing', progressByCourseId: {} }),
    );
    expect(out).toContain('领域课程');
    expect(out).toContain('还没有生成课程');
    expect(out).not.toContain('我的学习路径');
    expect(out).toContain('学习路径目前只覆盖人工智能应用开发领域');
  });

  it('无课域（odoo）显示诚实空态与生成引导，不显示 AI 课', () => {
    const out = html(createElement(PathOrDomainCard, { corpus: 'odoo', progressByCourseId: {} }));
    expect(out).toContain('还没有生成课程');
    expect(out).toContain('企业管理系统 Odoo');
    expect(out).not.toContain('Python 零基础第一课');
    expect(out).toContain('学习路径目前只覆盖人工智能应用开发领域');
  });

  it('DomainCoursesCard 用注入的映射（数据变了卡跟着变，不写死）', () => {
    const out = html(
      createElement(DomainCoursesCard, {
        corpus: 'iotdb',
        courseDomains: { c1: { domain: 'iotdb', title: '时序库第一课' } },
      }),
    );
    expect(out).toContain('时序库第一课');
    expect(out).toContain('时序数据库 IoTDB');
  });
});
