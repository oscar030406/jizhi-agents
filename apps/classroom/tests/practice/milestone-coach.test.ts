import { describe, expect, it } from 'vitest';

import { milestoneLectureText } from '@/components/practice/milestone-coach';
import type { GuideMilestone } from '@/app/api/practice-guide/route';

const milestone: GuideMilestone = {
  index: 2,
  title: '本地跑通图像分类',
  goal: '在本地成功运行迁移学习笔记本',
  build: ['虚拟环境', '笔记本文件'],
  how: ['建目录', '建虚拟环境', '装 torch'],
  acceptance: '看到验证集准确率曲线',
  engineering_habit: { title: '第一次 git 提交', how: 'git init 后提交跑通的状态。' },
  pitfalls: ['依赖版本不匹配'],
  reading: [],
  check_question: '你是怎么配环境的？',
  expected_points: ['提到虚拟环境'],
  minutes: 90,
};

describe('milestoneLectureText', () => {
  it('把里程碑各段拼成教练能读的讲义，验收与工程习惯都在', () => {
    const text = milestoneLectureText(milestone);
    expect(text).toContain('目标：在本地成功运行迁移学习笔记本');
    expect(text).toContain('怎么做：1. 建目录 2. 建虚拟环境 3. 装 torch');
    expect(text).toContain('做到什么算完成：看到验证集准确率曲线');
    expect(text).toContain('第一次 git 提交');
    expect(text).toContain('常见坑：依赖版本不匹配');
  });

  it('没有坑就不留空行', () => {
    const text = milestoneLectureText({ ...milestone, pitfalls: [] });
    expect(text).not.toContain('常见坑');
    expect(text.split('\n')).toHaveLength(5);
  });
});
