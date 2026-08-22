/**
 * 教具（交互场景）→ **信号**，不是证据。
 *
 * ## 为什么是信号
 *
 * 设计稿 §4.4 的判据很硬：**能填满四个子盒的交互产物才是证据，填不满的只是信号。**
 * 教具是 sandbox iframe，父页面与它之间只有 `postMessage`，没有判定协议——
 * 拿得到「他停了多久、动了几下」，拿不到「他这样操作对不对」。
 *
 * 四个子盒里教具只填得满**来源**（哪次交互、哪份资源、什么时刻）。
 * 测项能猜（场景标题），但**判定拿不到**——硬造一个「停留久 = 掌握了」是伪造判定，
 * 那正是 §4.4 那张表明确划掉的：
 *
 * ```
 * 页面停留时长   来源 ✓  测项 ✗  判定 ✗  →  否，信号
 * ```
 *
 * ## 信号有什么用
 *
 * 不进履历、不进画像，但**进权重**：某节停留极短且随后答错，说明那次作答置信度低
 * （`weight.ts` 的 `lowDwell`）。这条边界要划死，否则画像被无判定的行为数据污染。
 *
 * ## 升格路径，零成本
 *
 * 设计稿点名过：跳过某节时补问一句「已经会了还是太难了」，它立刻变成有判定有测项的
 * 证据——不用出题，不用调模型。教具同理：操作完弹一句「这个交互你看懂了吗」，
 * 拿到判定就走 {@link createEvidence}，modality 记 `skip-probe`。
 * **这一步没做**，做了要改教具的交互契约；先把信号记下来，升格随时可加。
 */

import type { EvidenceSource } from './types';

/** 停留低于此值算「扫了一眼就走」。与 `weight.ts` 的 `lowDwell` 是同一个概念。 */
export const LOW_DWELL_MS = 5_000;

/** 教具信号的类型标识。`weight.ts` 目前只认 `lowDwell` 这一种。 */
export const WIDGET_DWELL = 'lowDwell';
export const WIDGET_ENGAGED = 'widgetEngaged';

export interface WidgetSignalInput {
  interactionId: string;
  sceneId: string;
  /** 在这个教具上停了多久。 */
  dwellMs: number;
  at: string;
}

export interface WidgetSignalDraft {
  source: EvidenceSource;
  kind: string;
  value: number;
  note: string;
}

/**
 * 一次教具停留 → 一条信号。**永远返回信号，不返回证据**——见文件头。
 *
 * 停留极短记 `lowDwell`（权重函数会据此给同一次交互的证据打折）；
 * 停留够久记 `widgetEngaged`，目前没有消费者，但记下来才有升格的余地——
 * 权重函数认不认是它的事，账本先如实记。
 */
export function widgetSignalDraft(input: WidgetSignalInput): WidgetSignalDraft | null {
  if (!Number.isFinite(input.dwellMs) || input.dwellMs < 0) return null;
  const low = input.dwellMs < LOW_DWELL_MS;
  return {
    source: {
      interactionId: input.interactionId,
      resourceId: input.sceneId,
      at: input.at,
    },
    kind: low ? WIDGET_DWELL : WIDGET_ENGAGED,
    value: Math.round(input.dwellMs),
    note: low
      ? `教具停留 ${(input.dwellMs / 1000).toFixed(1)}s，低于 ${LOW_DWELL_MS / 1000}s`
      : `教具停留 ${(input.dwellMs / 1000).toFixed(1)}s`,
  };
}
