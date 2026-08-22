/**
 * 硅基流动调用，**一律走流式**。
 *
 * 为什么必须流式：Node 的 undici 对非流式请求有 5 分钟 headersTimeout。
 * 输入一大（我们要把 38k 字的教材整章塞进去）、服务端一忙，首字节就可能超过 5 分钟，
 * 连接被掐断。现象极其难查——没有报错，只是「卡住不动，然后重试五次一共二十五分钟」。
 * 这一天里我们在出题和评测两个地方各踩了一次。
 *
 * 流式下服务端会持续吐 SSE 分片，headersTimeout 不会触发。
 *
 * 另：代理必须剥掉。Clash 的 fake-ip 会把失败的 DNS 伪装成成功，
 * 调用方负责在启动前 unset HTTP_PROXY/HTTPS_PROXY。
 */

const ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';

export async function callLLM(model, system, prompt, opts = {}) {
  const { temperature = 0, maxTokens = 3000, json = false, retries = 4 } = opts;
  const key = process.env.SILICONFLOW_API_KEY;
  if (!key) throw new Error('缺 SILICONFLOW_API_KEY');

  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature,
          max_tokens: maxTokens,
          stream: true,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(900000),
      });
    } catch (e) {
      if (attempt === retries) throw new Error(`网络失败：${e.message}`);
      await new Promise((s) => setTimeout(s, 5000 * (attempt + 1)));
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      if (attempt === retries) throw new Error(`服务端 ${r.status}`);
      await new Promise((s) => setTimeout(s, 15000 * (attempt + 1)));
      continue;
    }
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      // 余额耗尽要立刻炸、炸得响。它不是暂时故障，重试五次只是把
      // 「没钱了」拖成「跑了一小时全部失败」——这一天里 196/196 全灭就是这么来的。
      if (/balance is insufficient|余额不足|"code"\s*:\s*30001/.test(body)) {
        throw new Error(`【余额耗尽】硅基流动账户没钱了，先充值再跑。原文：${body}`);
      }
      throw new Error(`HTTP ${r.status} ${body}`);
    }

    // 读流也要能重试。AbortSignal 是在**读 body 的过程中**触发的，
    // 不在 fetch 那个 try 里——不包起来的话，一次超时会顺着 Promise 链
    // 把整轮评测掀翻（踩过：357 个任务跑到一半整个进程退出）。
    let out = '';
    try {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';        // 最后一段可能是半行，留到下一轮
        for (const line of lines) {
          const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
          if (!s || s === '[DONE]') continue;
          try {
            const j = JSON.parse(s);
            out += j.choices?.[0]?.delta?.content ?? '';
          } catch {
            /* 心跳或非 JSON 行，跳过 */
          }
        }
      }
    } catch (e) {
      if (attempt === retries) throw new Error(`读流失败：${e.message}`);
      await new Promise((s) => setTimeout(s, 5000 * (attempt + 1)));
      continue;
    }
    // 空返回不能当 0 分往下传——那是最坏的误报（把「调用失败」说成「这门课什么都没教」）
    if (!out.trim()) {
      if (attempt === retries) throw new Error('流式返回为空');
      await new Promise((s) => setTimeout(s, 5000));
      continue;
    }
    return out;
  }
  throw new Error('重试耗尽');
}

/** 取回答里的第一个 JSON 对象。取不到返回 null，由调用方决定是当失败还是当 0 分。 */
export function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
