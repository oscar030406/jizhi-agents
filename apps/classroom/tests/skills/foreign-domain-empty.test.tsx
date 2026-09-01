/**
 * 非 AI 域的岗位技能页（D2，用户点名的例子）。
 *
 * 原形态：一条注记 +「照常展示整张 AI 岗位图谱」。学习者画像选的是智能制造，
 * 页面却摆着一整套 AI 岗位的技能要求，顶上一行小字说本页覆盖 AI 领域。
 *
 * **注记会被略过，图谱不会。** 学习者据此规划学习方向，而那些岗位跟他的领域
 * 毫无关系——比什么都不显示更糟。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ForeignDomainEmpty } from '@/components/skills/foreign-domain-empty';

const html = (label: string, reason?: string) =>
  renderToStaticMarkup(createElement(ForeignDomainEmpty, { label, reason }));

describe('非 AI 域的岗位技能页空态', () => {
  it('说清这个领域没有岗位数据，只说现在能做什么', () => {
    const out = html('智能制造技能培训');
    expect(out).toContain('智能制造技能培训');
    expect(out).toContain('没有随附岗位／技能清单');
    // 现在能做的两件事都指向真存在的东西：逐门学课、看已发布的实操项目
    expect(out).toContain('回首页按课程逐门学');
  });

  it('不许许诺不存在的操作：管理端没有「补传岗位要求文件」这一格', () => {
    // 写入侧 backend/services/domain_intake.py 的 job_requirements 恒为 None，
    // 管理端也没有对应入口。指一个点不到的按钮，比直说没有更糟。
    const out = html('智能制造');
    expect(out).not.toContain('补传');
    expect(out).not.toContain('岗位／技能要求文件');
  });

  it('引擎给了原因就用引擎的原话', () => {
    const reason = '本机构管理者在接入该领域时未提供岗位/技能清单';
    const out = html('智能制造', reason);
    expect(out).toContain(reason);
  });

  it('明说不展示其它领域的岗位图谱，并说明为什么', () => {
    const out = html('智能制造');
    expect(out).toContain('不展示其它领域的岗位图谱');
    expect(out).toContain('误导学习方向');
  });

  it('给出两条去处：回首页看本域课程、或换回跟随培训领域', () => {
    const out = html('智能制造');
    // 两条去处都指首页：画像弹层在首页，独立 /profile 路由不存在（曾 404，08-28 线上实走修复）
    const homeLinks = out.match(/href="\/"/g) ?? [];
    expect(homeLinks.length).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain('href="/profile"');
  });
});
