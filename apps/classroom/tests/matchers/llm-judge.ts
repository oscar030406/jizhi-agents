/**
 * 两个语义断言 matcher：`toMatchLlmRubric` 与 `toBeSimilarTo`。
 *
 * 判据照 promptfoo 的 `llm-rubric` / `similar` 两个 assertion 重写（只对判据，不抄码）。
 * 没装 promptfoo，理由是量出来的：0.122.0 解包 29.3 MB / 629 个文件 / 80 个直接依赖
 * （express、socket.io、drizzle-orm、6 个 opentelemetry、posthog 遥测）+ 42 个可选依赖
 * （playwright、sharp、huggingface transformers、四个 AWS SDK），engines 要 Node >=22.22
 * 而本仓库声明的是 >=20.9；更要命的是这两个函数根本没单独出口——`exports` 只开了 `.`
 * 和 `./contracts`，深路径 import 直接 ERR_PACKAGE_PATH_NOT_EXPORTED，只能从根 barrel
 * 进，等于把整个 evaluator + server + redteam 图拉进测试进程。
 * 换来的东西是「一段评分提示词 + 一次余弦」，自己写不到一百行。
 * 判据来源：promptfoo@0.122.0 src/matchers/{llmGrading,similarity,rubric,shared}.ts、
 * src/prompts/grading.ts、src/assertions/similar.ts。
 *
 * 三条硬约束：
 *
 * 1. **默认一分钱不花**。这套单测有 4200+ 条、跑一次二十秒，两个 matcher 都必须
 *    「没配 key 就别跑」。判断放在 `llmRubricReady()` / `similarityReady()`，
 *    测试侧用 `describe.skipIf(...)` 把整组标成 skipped —— vitest 会把它数进
 *    `skipped` 一栏，看得见。
 * 2. **绝不静默通过**。真跑起来以后，没 key、网络挂了、模型返回的 JSON 解析不了，
 *    一律抛错让这条测试红掉，不许 fallback 成 pass。matcher 里没有一条 `return { pass: true }`
 *    是在「拿不到结论」的分支上。忘了加 skipIf 直接调 matcher，也会撞上第一条抛错。
 *    这一点上我们比 promptfoo 严：它的 matchesSimilarity 拿不到 key 时是 resolve 出
 *    `{ pass:false, reason:'API key is not set…' }`（src/providers/openai/embedding.ts
 *    返回 `{error}` 而不是抛），跟「两句话真的不像」长得一模一样，只能靠读 reason 分辨。
 * 3. **走既有通道**。rubric 走 `resolveModel` + `callLLM`，和产品代码同一条路径、同一套
 *    provider 配置（默认跟 `DEFAULT_MODEL`；判官不挂 stage，所以不吃 `MODEL_ROUTES` 的
 *    分流，要换模型用 `LLM_JUDGE_MODEL`）；相似度走硅基流动 `BAAI/bge-m3`，
 *    与 `apps/agent-engine/scripts/build_embedding_index.py` 建索引时同一个端点、
 *    同一个模型，分数量纲才和线上那套接地门可比。
 *
 * 调硅基流动一律剥代理直连：本机 Clash 起来时 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`
 * 会把国内直连的请求绕出去，fake-ip 还会把失败 DNS 伪装成成功。引擎侧的做法是
 * `_SESSION.trust_env = False`（`apps/agent-engine/backend/rag/embedding_retriever.py:52`），
 * 这里对应的就是 `withoutProxyEnv()`。
 *
 * 用法见同目录 `llm-judge.example.test.ts`。
 */

import { expect } from 'vitest';

// ---------------------------------------------------------------------------
// 开关：有没有 key
// ---------------------------------------------------------------------------

/** 评分用的模型串。`LLM_JUDGE_MODEL` 优先，否则跟着项目的 `DEFAULT_MODEL` 走。 */
function judgeModelString(): string {
  return process.env.LLM_JUDGE_MODEL || process.env.DEFAULT_MODEL || '';
}

/**
 * rubric 判官能不能跑。
 *
 * 这里刻意只读环境变量、不 import 产品代码：本模块被 `tests/setup-env.ts` 每个
 * 测试文件都加载一次，一旦顺带把 providers 那棵树拉进来，474 个文件的启动都要付钱。
 * key 的命名跟 `lib/server/provider-config.ts` 的 `<PREFIX>_API_KEY` 约定
 * （PREFIX = provider id 大写、连字符换下划线）。
 */
export function llmRubricReady(): boolean {
  const providerId = judgeModelString().split(':')[0];
  if (!providerId) return false;
  return Boolean(process.env[`${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`]);
}

/** 相似度能不能跑（bge-m3 在硅基流动上）。 */
export function similarityReady(): boolean {
  return Boolean(process.env.SILICONFLOW_API_KEY);
}

function refuseWithoutKey(what: string, hint: string): never {
  throw new Error(
    `${what} 需要真实 API key，当前没配。\n` +
      `这条断言不会「当作通过」——请用 describe.skipIf(!${hint}()) 把整组标成 skipped，` +
      `或者配好 key 再跑。`,
  );
}

// ---------------------------------------------------------------------------
// 剥代理
// ---------------------------------------------------------------------------

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

/**
 * 把代理环境变量摘掉跑一段，跑完原样放回。
 *
 * Node 内置 fetch 本来就不读这几个变量，但 undici 的全局 dispatcher、以及任何
 * 走 `lib/server/proxy-fetch.ts` 的路径都会读——这层是防它们，不是防 fetch 本身。
 *
 * ponytail: 直接改 process.env，同进程内并发跑别的用例时会互相看见这几秒的空窗。
 * 这两个 matcher 本来就是 opt-in 的慢路径，真出现并发争用再换成给 provider 传
 * dispatcher。
 */
async function withoutProxyEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string>();
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      saved.set(key, value);
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// rubric 判官
// ---------------------------------------------------------------------------

/**
 * 评分提示词。形状对齐 promptfoo 的 llm-rubric：给出待评文本和评分标准，
 * 只回一个裸 JSON（`reason` / `score` / `pass`），不许带围栏。
 * 顺序上先写 reason 再出分，和 eval/ 下几个判官一致——先说理由再打分，
 * 分数不容易被第一直觉钉死。
 */
const RUBRIC_SYSTEM_PROMPT = `你是一个严格的评分员。给定一段「待评文本」和一条「评分标准」，判断这段文本是否满足该标准。

规则：
- 只按评分标准判断，不要引入标准里没写的偏好。
- 文本表述方式与标准的措辞不同不算问题，判断实质是否满足。
- score 是 0 到 1 的小数：完全满足给 1，完全不满足给 0，部分满足给中间值。
- pass 表示是否达到可接受的程度。

只输出一个 JSON 对象，不要代码围栏、不要任何解释性前后缀：
{"reason": "一到两句话说明判断依据", "score": 0.0, "pass": true}`;

export interface RubricVerdict {
  pass: boolean;
  score: number;
  reason: string;
}

/**
 * 这里比 promptfoo 严一格，是故意的。
 *
 * promptfoo 的 llm-rubric 没有默认阈值（src/matchers/rubric.ts:863-880：只有当
 * `assertion.threshold` 显式给了才拿分数卡），所以模型回一个 `{pass:true, score:0}`
 * 照样算过——这是它文档里承认的坑。本项目最恨的就是这种静默通过，于是这边补一个
 * 默认门槛（数值取自它 similar 那侧的 0.75），`pass` 与 `score >= threshold` 两个
 * 信号都成立才算过。
 */
const DEFAULT_RUBRIC_THRESHOLD = 0.75;

function parseVerdict(raw: string): RubricVerdict {
  // 模型偶尔还是会裹一层 ```json，剥掉再解析；解析不出来就抛，不猜。
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`rubric 判官返回的不是 JSON，原文：\n${raw.slice(0, 500)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const score = typeof obj.score === 'number' ? obj.score : Number.NaN;
  if (typeof obj.pass !== 'boolean' || !Number.isFinite(score)) {
    throw new Error(`rubric 判官返回的 JSON 缺 pass/score，原文：\n${raw.slice(0, 500)}`);
  }
  return {
    pass: obj.pass,
    score,
    reason: typeof obj.reason === 'string' ? obj.reason : '',
  };
}

/** 让模型按 rubric 给一段文本打分。没 key 直接抛。 */
export async function gradeByRubric(output: string, rubric: string): Promise<RubricVerdict> {
  if (!llmRubricReady()) refuseWithoutKey('toMatchLlmRubric', 'llmRubricReady');

  // 动态 import：这几个模块很重，只有真要打分时才付这份加载成本。
  const [{ resolveModel }, { callLLM }] = await Promise.all([
    import('@/lib/server/resolve-model'),
    import('@/lib/ai/llm'),
  ]);
  const { model } = await resolveModel({ modelString: judgeModelString() });

  const result = await withoutProxyEnv(() =>
    callLLM(
      {
        model,
        temperature: 0,
        system: RUBRIC_SYSTEM_PROMPT,
        prompt: `【评分标准】\n${rubric}\n\n【待评文本】\n${output}`,
      },
      'test-llm-rubric',
    ),
  );
  return parseVerdict(result.text);
}

// ---------------------------------------------------------------------------
// 语义相似度
// ---------------------------------------------------------------------------

const EMBEDDING_ENDPOINT = 'https://api.siliconflow.cn/v1/embeddings';
const EMBEDDING_MODEL = 'BAAI/bge-m3';

/**
 * 跟 promptfoo 的 similar 默认值一致（src/assertions/similar.ts: `assertion.threshold ?? 0.75`；
 * 文档里那个 0.8 只是示例写的数，不是默认）。
 *
 * ponytail: 这个数是照 OpenAI text-embedding-3-large 的分布定的，bge-m3 在中文短句上
 * 普遍跑得更高（线上摘录咬合门取的是 0.6）。真拿它卡具体用例前先自己量一遍分布，
 * 别直接信这个默认值。
 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 两段文本的 bge-m3 余弦。没 key 直接抛。 */
export async function semanticSimilarity(a: string, b: string): Promise<number> {
  if (!similarityReady()) refuseWithoutKey('toBeSimilarTo', 'similarityReady');

  const payload = await withoutProxyEnv(async () => {
    const resp = await fetch(EMBEDDING_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: [a, b] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      throw new Error(`${EMBEDDING_MODEL} 取嵌入失败：HTTP ${resp.status} ${await resp.text()}`);
    }
    return (await resp.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  });

  const data = payload.data;
  if (!data || data.length < 2) {
    throw new Error(`${EMBEDDING_MODEL} 只返回了 ${data?.length ?? 0} 条嵌入，要 2 条`);
  }
  const sorted = [...data].sort((x, y) => x.index - y.index);
  return cosine(sorted[0].embedding, sorted[1].embedding);
}

// 只给自测用：余弦这几行是本文件唯一的纯计算逻辑，得留个不花钱的验算口。
export const __cosineForTest = cosine;

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

expect.extend({
  async toMatchLlmRubric(received: unknown, rubric: string, threshold?: number) {
    if (typeof received !== 'string') {
      throw new Error(`toMatchLlmRubric 只能断言字符串，收到 ${typeof received}`);
    }
    const gate = threshold ?? DEFAULT_RUBRIC_THRESHOLD;
    const verdict = await gradeByRubric(received, rubric);
    const pass = verdict.pass && verdict.score >= gate;
    return {
      pass,
      message: () =>
        `rubric「${rubric}」${this.isNot ? '本不该' : '未'}被满足` +
        `（score ${verdict.score.toFixed(2)} / 门槛 ${gate}，模型判 ${verdict.pass}）\n` +
        `判官理由：${verdict.reason}\n` +
        `待评文本：${received.slice(0, 300)}`,
      actual: verdict.score,
      expected: gate,
    };
  },

  async toBeSimilarTo(received: unknown, expected: string, threshold?: number) {
    if (typeof received !== 'string') {
      throw new Error(`toBeSimilarTo 只能断言字符串，收到 ${typeof received}`);
    }
    const gate = threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const score = await semanticSimilarity(received, expected);
    return {
      pass: score >= gate,
      message: () =>
        `${EMBEDDING_MODEL} 余弦 ${score.toFixed(4)}，门槛 ${gate}` +
        `（${this.isNot ? '本不该到' : '没到'}）\n` +
        `实际：${received.slice(0, 200)}\n期望近似：${expected.slice(0, 200)}`,
      actual: score,
      expected: gate,
    };
  },
});

declare module 'vitest' {
  // 类型参数必须和 @vitest/expect 里的 `interface Matchers<T = any>` 逐字一致，
  // 换成 unknown 会撞 TS2428。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    /**
     * 让 LLM 按 rubric 给这段文本打分。`await` 它。
     * 没配 key 会抛错——请先用 `describe.skipIf(!llmRubricReady())` 关掉。
     */
    toMatchLlmRubric(rubric: string, threshold?: number): Promise<T>;
    /**
     * bge-m3 余弦相似度断言。`await` 它。
     * 没配 `SILICONFLOW_API_KEY` 会抛错——请先用 `describe.skipIf(!similarityReady())` 关掉。
     */
    toBeSimilarTo(expected: string, threshold?: number): Promise<T>;
  }
}
