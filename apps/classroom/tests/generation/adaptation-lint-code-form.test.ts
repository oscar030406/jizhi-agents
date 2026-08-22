/**
 * L1-CODE-FORM：零基础档自撰区的代码结构闸。
 *
 * 2026-08-13 实测链路：以零基础视角生成一门课 →
 * ①自述没进画像（已修）②摘录给 `def query(...)`（检索层已加同源结构闸，已修）
 * ③**摘录修好之后，模型自撰区照样写 `import numpy as np` / `def distance(a, b):`**。
 * 这一条补的是 ③——L1 指令里「不引入未讲过的语法或库」是文字要求，机械层不查就压不住。
 *
 * 判据来自外部教材，不是自拟阈值：蟒蛇书 1-6 章 129 个文件里 import/def/class
 * 出现率均为 0%，全书 563 个文件才 57%/31%/25%（九份语料的阶梯见
 * apps/agent-engine/scripts/experiments/textbook_code_ladder.py）。
 */

import { describe, expect, it } from 'vitest';

import { lintAdaptation } from '@/lib/generation/adaptation-lint';

const ids = (text: string, tier: 'L1' | 'L2' | 'L3' = 'L1') =>
  lintAdaptation(text, tier).violations.map((v) => v.ruleId);

describe('L1-CODE-FORM', () => {
  it('抓 import——实测那门课自撰区写出来的就是这一行', () => {
    const text = ['我们可以用代码模拟一个二维向量：', '', '```python', 'import numpy as np', 'v = np.array([1, 2])', '```'].join('\n');
    expect(ids(text)).toContain('L1-CODE-FORM');
  });

  it('抓 def', () => {
    const text = ['算距离：', '', '```python', 'def distance(a, b):', '    return abs(a - b)', '```'].join('\n');
    expect(ids(text)).toContain('L1-CODE-FORM');
  });

  it('抓 class 与装饰器', () => {
    expect(ids('```python\nclass Dog:\n    pass\n```')).toContain('L1-CODE-FORM');
    expect(ids('```python\n@dataclass\nclass X:\n    a = 1\n```')).toContain('L1-CODE-FORM');
  });

  it('蟒蛇书入门段的真实形态不触发', () => {
    const text = ['先看一句：', '', '```python', 'message = "你好"', 'print(message)', '```'].join('\n');
    expect(ids(text)).not.toContain('L1-CODE-FORM');
  });

  it('L2/L3 不设这道闸——那两档的自然形态本来就有 import 和 def', () => {
    const text = '```python\nimport numpy as np\ndef f(x):\n    return x\n```';
    expect(ids(text, 'L2')).not.toContain('L1-CODE-FORM');
    expect(ids(text, 'L3')).not.toContain('L1-CODE-FORM');
  });

  it('散文里提到 import 不算代码', () => {
    const text = '我们把这个动作叫 import，意思是把别人写好的工具拿过来用。';
    expect(ids(text)).not.toContain('L1-CODE-FORM');
  });

  it('摘录区不归这条管——摘录改不动，结构闸在检索层（beginner_code_form）', () => {
    const text = ['{{摘录:tu04#s2}}', '```python', 'import numpy as np', 'x = 1', '```'].join('\n');
    const v = lintAdaptation(text, 'L1').violations.filter((x) => x.ruleId === 'L1-CODE-FORM');
    for (const item of v) expect(item.zone).not.toBe('excerpt');
  });

  it('是 A 类——值得花一次定向改写，不是只记个警告', () => {
    const text = '```python\nimport math\nd = math.sqrt(2)\n```';
    const hit = lintAdaptation(text, 'L1').violations.find((v) => v.ruleId === 'L1-CODE-FORM');
    expect(hit?.cls).toBe('A');
  });
});
