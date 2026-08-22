import { describe, expect, it } from 'vitest';
import {
  arbiterLabel,
  judgeLabel,
  judgePanelLabel,
  judgeRole,
  maskJudgeVerdict,
  modelDetailRows,
  modelName,
  vendorFamily,
} from '@/components/agents/judge-labels';
import {
  judgeRole as showcaseJudgeRole,
  maskJudgeVerdict as showcaseMask,
} from '@/components/evidence/audit-showcase';

// 真实的两判官配置（lib/server/audit-panel.ts 拼出来的 modelString 形状）
const QWEN = 'siliconflow:Qwen/Qwen3.6-35B-A3B';
const DEEPSEEK = 'siliconflow:deepseek-ai/DeepSeek-V3.2';

describe('vendorFamily', () => {
  it('按厂商族分类，大小写无关', () => {
    expect(vendorFamily(QWEN)).toBe('通义系');
    expect(vendorFamily(DEEPSEEK)).toBe('DeepSeek 系');
    expect(vendorFamily('minimax:abab7')).toBe('MiniMax 系');
    expect(vendorFamily('zhipu:GLM-4.6')).toBe('智谱系');
  });

  it('认不出的厂商如实标第三方，不猜', () => {
    expect(vendorFamily('some-vendor:mystery-7b')).toBe('第三方模型');
  });
});

describe('judgeRole / judgeLabel', () => {
  it('序号按面板顺序给甲乙，第三个起用数字', () => {
    expect(judgeRole(0)).toBe('审核智能体甲');
    expect(judgeRole(1)).toBe('审核智能体乙');
    expect(judgeRole(2)).toBe('审核智能体3');
  });

  it('带厂商族的完整称谓', () => {
    expect(judgeLabel(QWEN, 0)).toBe('审核智能体甲（通义系）');
    expect(judgeLabel(DEEPSEEK, 1)).toBe('审核智能体乙（DeepSeek 系）');
  });
});

describe('judgePanelLabel', () => {
  it('整组判官拼成一句，模型全串不出现', () => {
    const text = judgePanelLabel([QWEN, DEEPSEEK]);
    expect(text).toBe('审核智能体甲（通义系）、审核智能体乙（DeepSeek 系）');
    expect(text).not.toContain('siliconflow');
    expect(text).not.toContain('Qwen3.6');
  });

  it('单判官也走同一套称谓', () => {
    expect(judgePanelLabel([QWEN])).toBe('审核智能体甲（通义系）');
  });
});

describe('arbiterLabel', () => {
  it('仲裁只报厂商族', () => {
    expect(arbiterLabel(QWEN)).toBe('仲裁（通义系）');
  });
});

describe('modelName', () => {
  it('去掉供应商前缀与命名空间，只留型号', () => {
    expect(modelName(QWEN)).toBe('Qwen3.6-35B-A3B');
    expect(modelName(DEEPSEEK)).toBe('DeepSeek-V3.2');
  });

  it('本来就没前缀的串原样返回', () => {
    expect(modelName('GLM-4.6')).toBe('GLM-4.6');
  });
});

describe('modelDetailRows', () => {
  it('折叠里给脱敏后的型号，仲裁在最后一行', () => {
    expect(modelDetailRows([QWEN, DEEPSEEK], QWEN)).toEqual([
      { role: '审核智能体甲（通义系）', model: 'Qwen3.6-35B-A3B' },
      { role: '审核智能体乙（DeepSeek 系）', model: 'DeepSeek-V3.2' },
      { role: '仲裁（通义系）', model: 'Qwen3.6-35B-A3B' },
    ]);
  });

  it('供应商前缀一个字都不上屏', () => {
    const text = modelDetailRows([QWEN, DEEPSEEK], QWEN)
      .map((r) => r.model)
      .join(' ');
    expect(text).not.toContain('siliconflow');
    expect(text).not.toContain('/');
  });

  it('没有仲裁模型就不摆这一行', () => {
    expect(modelDetailRows([QWEN])).toHaveLength(1);
  });
});

describe('maskJudgeVerdict', () => {
  it('把嵌在分歧串里的模型名换成面板称谓', () => {
    expect(maskJudgeVerdict(`${QWEN} → 有误`, 0)).toBe('审核智能体甲 → 有误');
    expect(maskJudgeVerdict(`${DEEPSEEK} → 存疑`, 1)).toBe('审核智能体乙 → 存疑');
  });

  it('没有分隔符的旧格式当成纯判定，不丢内容', () => {
    expect(maskJudgeVerdict('存疑', 0)).toBe('审核智能体甲 → 存疑');
  });
});

describe('口径单一真源', () => {
  it('公共页审核抓错区转出的就是这里的函数，不是自己那份', () => {
    expect(showcaseJudgeRole).toBe(judgeRole);
    expect(showcaseMask).toBe(maskJudgeVerdict);
  });
});
