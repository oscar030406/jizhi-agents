/**
 * 生产启动入口：把 Node 的 `requestTimeout` 放大，然后交给 `next start`。
 *
 * ## 为什么需要这个文件
 *
 * Node 18+ 给每个 HTTP 请求设了 **总时长** 上限 `server.requestTimeout = 300000`
 * （5 分钟）——不是空闲超时，是从收到请求行到请求体收完的总时间。超了直接 408。
 *
 * 投币口要收整包语料。2026-08-22 验收实测：392MB 的包，上行 0.5MB/s，
 * 需要 10–13 分钟；在第 316 秒被这条线砍掉，返回 408。服务器侧看到的是字节
 * 一直在正常流入（`ss` 里 `lastrcv:2ms`、已收 294MB），所以不是网络断，
 * 是 Node 自己掐的。
 *
 * 更隐蔽的是它**测不出来**：我先用 115MB 试过一次，99 秒传完，够不到 300 秒线，
 * 一切正常。只有慢速大包才踩得到。
 *
 * ## 为什么改在这里，而不是别处
 *
 * - `next start` 不暴露 `requestTimeout`（只认 `keepAliveTimeout`），
 *   Next 16 的 `start-server.js` 里没有这个口子。
 * - 不改 `node_modules`——升级即失效，且没人知道改过。
 * - 不为这一个数切到 standalone 自建 server——那是整套部署形态的改动，
 *   风险远大于收益。
 *
 * 所以在进程启动的最早时刻包一层 `http.createServer`，之后 Next 自己建出来的
 * server 实例就带上了。一个文件、几行有效代码、可回滚。
 *
 * **不要改 `http.Server.prototype`**——试过，不生效：`createServer` 在构造函数里
 * 对这两个字段显式赋值，原型上的默认值当场被覆盖。必须包装工厂函数本身。
 *
 * ## 数值
 *
 * 1800 秒 = 30 分钟。按实测最慢那条（0.5MB/s）算，392MB 要 13 分钟，
 * 留一倍以上余量；同时它仍是个有限值——设成 0（永不超时）会让半死的连接
 * 永远占着，那台机器只有 2vCPU/4G。
 *
 * `headersTimeout` 一并放大：Node 要求它不大于 `requestTimeout`，但默认的
 * 60 秒对慢速客户端发首行也可能不够。
 */
import http from 'node:http';

const REQUEST_TIMEOUT_MS = Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 1_800_000);

const HEADERS_TIMEOUT_MS = Math.min(120_000, REQUEST_TIMEOUT_MS);

const createServer = http.createServer;
http.createServer = function patchedCreateServer(...args) {
  const server = createServer.apply(this, args);
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
};

console.log(
  `[start] requestTimeout=${REQUEST_TIMEOUT_MS / 1000}s ` +
    `headersTimeout=${HEADERS_TIMEOUT_MS / 1000}s（大包上传要用）`,
);

await import('next/dist/bin/next');
