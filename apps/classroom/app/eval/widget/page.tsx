'use client';

import { useEffect, useState } from 'react';
import TemplateWidgetHost from '@/components/widgets/TemplateWidgetHost';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import type { TemplateWidgetConfig } from '@/lib/types/widgets';

/** 教具评测的渲染页，形状照抄 /eval/whiteboard：注入函数挂 window、
 * 就绪标志同名 __evalReady，采集脚本两页共用一套等待逻辑。
 *
 * 这页只负责「把产品组件挂起来」——模板教具直接用 TemplateWidgetHost，
 * 自由 HTML 走和产品同一条 srcDoc + patchHtmlForIframe 路径。
 * 渲染逻辑一行都不在这里重写：评测页里另写一份渲染，量到的就不是产品的画面。 */

const CANVAS_WIDTH = 1000;
/** 自由 HTML 教具没有自然高度（内容在 iframe 里，父页面量不到），
 * 给一个和白板画布同高的固定值当画框；模板教具的高度由内容自己撑。 */
const HTML_HEIGHT = 563;

interface EvalWidgetPayload {
  /** 模板教具 */
  config?: TemplateWidgetConfig;
  /** 自由 HTML 教具 */
  html?: string;
}

function WidgetCanvas() {
  const [payload, setPayload] = useState<EvalWidgetPayload | null>(null);
  /** 每次注入自增，用作 key 强制重挂——教具的步号/滑块位置都是组件内部 state，
   * 不换 key 的话上一份用例拖到一半的状态会漏进下一份的默认态帧。 */
  const [seq, setSeq] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // 暴露给 Playwright 的注入口
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setWidget = (incoming: EvalWidgetPayload) => {
      setPayload(incoming);
      setSeq((n) => n + 1);
    };

    // 就绪标志
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__evalReady = true;
    // 与白板页一致：延到微任务里置位，避免渲染中套渲染的告警
    queueMicrotask(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <div
      id="eval-widget-root"
      style={{
        width: CANVAS_WIDTH,
        padding: 16,
        backgroundColor: '#ffffff',
      }}
    >
      {payload?.config && <TemplateWidgetHost key={seq} config={payload.config} />}
      {payload?.html !== undefined && (
        <iframe
          key={seq}
          srcDoc={patchHtmlForIframe(payload.html)}
          title="eval widget"
          // 与产品同一套 sandbox（InteractiveIframeHost）：故意不给 allow-same-origin
          sandbox="allow-scripts allow-forms allow-popups"
          style={{ width: '100%', height: HTML_HEIGHT, border: 0, display: 'block' }}
        />
      )}
    </div>
  );
}

export default function EvalWidgetPage() {
  return <WidgetCanvas />;
}
