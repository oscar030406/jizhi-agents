/**
 * `toMatchLlmRubric` / `toBeSimilarTo` 的用法示例 + 不花钱的自检。
 *
 * 平时 `npx vitest run` 跑到这个文件，只做两件本地的事：验余弦算得对，验「没 key 时
 * 断言会抛错、不会悄悄变绿」。真正调模型的两组默认关着。
 *
 * 为什么真调模型的两组除了 key 还要一个开关：这台开发机是配了 key 的，光按 key 放行
 * 的话，任何人跑一次全量都要替这几条示例付四十秒和一笔调用费。示例是文档，不该有
 * 这种副作用，所以额外要 `LLM_JUDGE_EXAMPLES=1` 才跑。
 * 你自己写的语义断言不需要这个开关，按 key 判就行——见下面 describe.skipIf 的写法。
 *
 *   # 两组一起跑（rubric 跟着 DEFAULT_MODEL，也可以单独指一个便宜模型当判官）
 *   LLM_JUDGE_EXAMPLES=1 LLM_JUDGE_MODEL=siliconflow:Qwen/Qwen3-30B-A3B-Instruct-2507 \
 *     npx vitest run tests/matchers
 *
 * matcher 是异步的，一定要 `await`——忘了 await 的断言永远是绿的。
 */

import { describe, expect, it } from 'vitest';

import { __cosineForTest, llmRubricReady, similarityReady } from './llm-judge';

/** 示例专用开关，见文件头。真实用例只判 key，不要抄这个。 */
const examplesOn = process.env.LLM_JUDGE_EXAMPLES === '1';

/** 临时把几个环境变量摘掉跑一段，用来模拟「这台机器没配 key」。 */
async function withoutEnv(keys: string[], fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

describe('语义断言 matcher — 不联网的部分', () => {
  it('余弦：同向 1、正交 0、反向 -1，且与向量长度无关', () => {
    expect(__cosineForTest([1, 0], [2, 0])).toBeCloseTo(1);
    expect(__cosineForTest([1, 0], [0, 1])).toBeCloseTo(0);
    expect(__cosineForTest([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(__cosineForTest([0, 0], [1, 1])).toBe(0);
  });

  // 下面两条钉的是「不静默通过」：没 key 时断言必须炸，不许当作满足。
  // 摘掉环境变量来验，所以配了 key 的机器上照样跑得到这条性质。
  it('没判官模型时 toMatchLlmRubric 抛错而不是判过', async () => {
    await withoutEnv(['LLM_JUDGE_MODEL', 'DEFAULT_MODEL'], async () => {
      expect(llmRubricReady()).toBe(false);
      await expect(expect('随便一段话').toMatchLlmRubric('讲清楚了什么是向量检索')).rejects.toThrow(
        /需要真实 API key/,
      );
    });
  });

  it('没 SILICONFLOW_API_KEY 时 toBeSimilarTo 抛错而不是判过', async () => {
    await withoutEnv(['SILICONFLOW_API_KEY'], async () => {
      expect(similarityReady()).toBe(false);
      await expect(expect('猫').toBeSimilarTo('猫咪')).rejects.toThrow(/需要真实 API key/);
    });
  });
});

// ---------------------------------------------------------------------------
// 下面两组要真花钱，默认整组 skipped（vitest 会在 skipped 一栏数出来）。
// 你自己的语义断言把 `examplesOn &&` 去掉就行，只留 key 判断。
// ---------------------------------------------------------------------------

describe.skipIf(!(examplesOn && llmRubricReady()))('toMatchLlmRubric 用法', () => {
  it('按 rubric 判一段讲义写得合不合格', async () => {
    const text =
      '向量检索先把文本变成一串数，再比这串数之间的夹角。夹角小就算意思接近，' +
      '所以换了说法也能找到——关键词检索做不到这一点。';
    await expect(text).toMatchLlmRubric('用日常语言解释了向量检索的原理，并且没有出现英文术语堆砌');
  }, 60_000);

  it('取反也能用：这段明显不合格', async () => {
    await expect('今天天气不错。').not.toMatchLlmRubric('解释了什么是向量检索');
  }, 60_000);

  it('门槛可以自己调高', async () => {
    await expect('水的沸点在一个标准大气压下是 100 摄氏度。').toMatchLlmRubric(
      '陈述了一个正确的物理常识',
      0.9,
    );
  }, 60_000);
});

describe.skipIf(!(examplesOn && similarityReady()))('toBeSimilarTo 用法', () => {
  it('同一句话的两种说法算近似', async () => {
    await expect('该标准于 1998 年发布，适用于全部工况').toBeSimilarTo('这个标准 1998 年就发布了');
  }, 60_000);

  it('八竿子打不着的两句话不近似', async () => {
    await expect('电压等于电流乘以电阻').not.toBeSimilarTo('光合作用发生在叶绿体');
  }, 60_000);
});
