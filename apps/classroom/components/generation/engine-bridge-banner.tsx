'use client';

/**
 * 引擎桥状态横幅。
 *
 * 四个引擎桥（画像/接地/审核证据/反馈决策）失败时全部静默降级——这是对的，
 * UX 不能因为引擎挂了而崩。但「降级不可见」不行：演示时引擎没起，
 * 页面照常出课，实际跑的是裸生成（评分表最低档），屏幕上看不出任何异常。
 *
 * 这个横幅只干一件事：桥不通时把话挑明。桥通时什么都不渲染，零打扰。
 * 探针逻辑在服务端 /api/health（token 不出服务端）。
 */

import { useEffect, useState } from 'react';

type BridgeState = 'ok' | 'down' | 'unconfigured' | 'unknown';

export function EngineBridgeBanner() {
  const [state, setState] = useState<BridgeState>('unknown');

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const resp = await fetch('/api/health', { cache: 'no-store' });
        const json = await resp.json();
        // apiSuccess 是平铺信封（{success, ...payload}），没有 data 层——
        // 第一版读 json.data.engineBridge 永远 undefined，横幅永远不出现，
        // 实拍才抓到。兼容两种形状，防止信封将来又改。
        if (alive) setState(json?.engineBridge ?? json?.data?.engineBridge ?? 'unknown');
      } catch {
        if (alive) setState('unknown');
      }
    };
    probe();
    // 演示中引擎可能中途被拉起或挂掉，低频轮询跟住状态变化
    const t = setInterval(probe, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (state === 'ok' || state === 'unknown') return null;

  return (
    <div
      role="alert"
      className="mx-auto mb-3 flex max-w-3xl items-center gap-2 rounded-lg border border-yellow-deep/30 bg-yellow-soft px-4 py-2 text-sm text-yellow-deep"
    >
      <span aria-hidden>⚠</span>
      <span>
        {state === 'down'
          ? '多智能体引擎未连接：当前为裸生成模式，学情画像、知识库接地与审核证据不可用。请先启动引擎（scripts/start-demo.ps1）。'
          : '未连接多智能体引擎：当前为裸生成模式，个性化与教材接地关闭。'}
      </span>
    </div>
  );
}
