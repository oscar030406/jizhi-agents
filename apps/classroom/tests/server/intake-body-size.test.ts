/**
 * 投币口的请求体上限（2026-08-22 验收第二败倒逼）。
 *
 * 验收传一个 392.9MB 的 zip，进度条走满 100%、**完整传完之后**才失败，
 * 前端显示「请求体不是合法的表单」。服务器日志里是：
 *
 *     Request body exceeded 200MB for /api/knowledge/intake-runs.
 *     Only the first 200MB will be available unless configured.
 *
 * 关键在它的失败形态：**不是拒收，是静默截断到前 200MB**。multipart 的结尾边界
 * 跟着丢掉，`req.formData()` 解析时才炸，于是错误呈现成「你的表单不合法」——
 * 把锅甩给了填表的人，而真正的原因是服务端自己把包切了一刀。
 *
 * 这一轮排查还排除了三个更吓人的猜测：没有 OOM、进程没重启、内存曲线平稳。
 * 单纯是一个配置数字。
 *
 * 这个文件锁两件事：配置值够大，以及错误文案不再单方面指责客户端。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** '2gb' / '512mb' → 字节数。 */
function toBytes(literal: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(gb|mb|kb|b)$/i.exec(literal.trim());
  if (!m) return NaN;
  const scale = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9 }[m[2].toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'];
  return Number(m[1]) * scale;
}

describe('投币口能收下整包语料', () => {
  it('proxyClientMaxBodySize 大于验收包的两倍', () => {
    const cfg = read('next.config.ts');
    const literal = /proxyClientMaxBodySize:\s*'([^']+)'/.exec(cfg)?.[1];
    expect(literal, '配置项不见了——它是 Next 唯一管这条上限的旋钮').toBeTruthy();

    // 验收包 392.9MB。留一倍余量：管理者投两本书就能翻倍。
    expect(toBytes(literal!)).toBeGreaterThan(392.9e6 * 2);
  });

  it('桥根本不解析请求体——解析就是把整包读进内存', () => {
    // 这条原本锁的是「解析失败时的文案要指路而不是指责客户端」。
    // 后来第四坎（OOM kill）把解析这一步整个删了：桥改成 `body: req.body` 流式转发，
    // 那段文案随之消失，测试也就没有对象可锁了。
    //
    // 但要保住的性质更硬：**这里永远不许出现 `req.formData()`**。
    // 它读一份、fetch 再序列化一份，393MB 的包在 4G 机器上直接被内核干掉，
    // 而且只有大包才现形——单测和小包 curl 都测不出来，只能靠这条静态断言拦住。
    const route = read('app/api/knowledge/intake-runs/route.ts');
    // 只看可执行代码：注释里写着「原本是 req.formData()」是历史记录，
    // 那句话正是防止后人改回去的说明，不该为了让断言变绿把它删掉。
    const code = route
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/req\.formData\(\)/);
    expect(code).toContain('body: req.body');
  });
});
