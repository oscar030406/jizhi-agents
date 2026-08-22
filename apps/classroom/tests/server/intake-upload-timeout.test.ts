/**
 * 大包上传的保命线（2026-08-22 验收实测倒逼）。
 *
 * 验收投一个 392MB 的包，上行 0.5MB/s、需要 10–13 分钟，在**第 316 秒**收到 408。
 * 服务器侧 `ss` 看到字节一直在正常流入（已收 294MB、`lastrcv:2ms`），
 * 所以不是网络断也不是 nginx 超时——是 Node 自己的 `requestTimeout` 默认 300 秒
 * 掐掉了整个请求。
 *
 * 这个坑最恶心的地方是**小包测不出来**：先前用 115MB 试过一次，99 秒传完，
 * 够不到 300 秒线，一切正常。所以这里把三件事钉死。
 */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('大包上传不被 Node 默认超时掐断', () => {
  it('Node 默认值确实是 300 秒——这就是 408 的来源', () => {
    const bare = http.createServer();
    expect(bare.requestTimeout).toBe(300_000);
    bare.close();
  });

  it('包装 createServer 后新建的 server 带上放大的超时', () => {
    const original = http.createServer;
    try {
      http.createServer = function patched(this: unknown, ...args: unknown[]) {
        const server = (original as (...a: unknown[]) => http.Server).apply(this, args);
        server.requestTimeout = 1_800_000;
        server.headersTimeout = 120_000;
        return server;
      } as typeof http.createServer;

      const server = http.createServer();
      expect(server.requestTimeout).toBe(1_800_000);
      expect(server.headersTimeout).toBe(120_000);
      server.close();
    } finally {
      http.createServer = original;
    }
  });

  it('改 prototype 不管用——别有人「简化」成那样', () => {
    // 第一版就是这么写的，不生效：createServer 在构造函数里对这两个字段显式赋值，
    // 原型上的默认值当场被覆盖。这条测试是给后来人的路障。
    const saved = http.Server.prototype.requestTimeout;
    try {
      http.Server.prototype.requestTimeout = 1_800_000;
      const server = http.createServer();
      expect(server.requestTimeout).toBe(300_000);
      server.close();
    } finally {
      http.Server.prototype.requestTimeout = saved;
    }
  });

  it('启动脚本用的是包装法，且超时值高过实测所需时长', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/start-with-long-upload.mjs'), 'utf-8');
    expect(src).toContain('http.createServer =');
    expect(src).not.toMatch(/http\.Server\.prototype\.requestTimeout\s*=/);

    const raw = /REQUEST_TIMEOUT_MS\s*=\s*Number\([^)]*\|\|\s*([\d_]+)\)/.exec(src)?.[1];
    const ms = Number(raw?.replace(/_/g, ''));
    // 实测最慢那条：392MB ÷ 0.5MB/s ≈ 785 秒。留一倍以上余量。
    expect(ms).toBeGreaterThan(785_000 * 1.5);
  });
});
