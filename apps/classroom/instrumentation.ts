/**
 * Node 运行时启动钩子（Next.js instrumentation 约定，v15+ 默认启用）。
 *
 * undici 默认 headersTimeout=300s：非流式 LLM 调用（interactive widget 的
 * 27k HTML 单发生成）在服务端排队 >5min 时首字节还没来就被掐死，现象是
 * 「AI_APICallError: Cannot connect to API: Headers Timeout Error」整点 5 分钟
 * 出现（2026-08-03 实测：动手实验场景连续两轮死在这里）。抬到 15 分钟，
 * 与 aiCall 层自己的超时预算对齐——连接管理归 undici，业务超时归调用方。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setGlobalDispatcher, Agent } = await import('undici');
    setGlobalDispatcher(
      new Agent({
        headersTimeout: 15 * 60_000,
        bodyTimeout: 15 * 60_000,
      }),
    );
  }
}
