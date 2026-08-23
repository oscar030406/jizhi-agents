import type { Page, Locator } from '@playwright/test';

import { E2E_CORPUS, E2E_RUN_ID } from '../fixtures/test-data/knowledge-pipeline';

/**
 * 管理端 · 一次接入 run 的详情页（`/admin/knowledge/runs/<runId>`）。
 *
 * 这一页是**服务端组件、直接读引擎数据目录**，`page.route` 的桩伸不进去。
 * 它在 e2e 里有数，靠的是 `playwright.config.ts` 把 `ENGINE_DATA_DIR` 指到
 * `e2e/fixtures/engine-data/`——那棵树里的 run 与这里的 `E2E_RUN_ID` 是同一个。
 * 页面上的每一个数字都出自那两个文件，不是引擎跑出来的。
 */
export class IntakeRunPage {
  readonly page: Page;
  /** run 头里的 `<corpus> · <run_id>` 那一行。库名与 run 号同时对上才算跳对了页。 */
  readonly identity: Locator;
  /** 每站一张卡。按卡上的站名再 filter 到具体某一站。 */
  readonly stageCards: Locator;
  /** 事件流列表（一行一条事件）。 */
  readonly eventList: Locator;
  /** 回放游标。原生 range，用键盘 Home/End/方向键推它，比拖拽稳。 */
  readonly replayCursor: Locator;

  constructor(page: Page) {
    this.page = page;
    this.identity = page.getByText(`${E2E_CORPUS} · ${E2E_RUN_ID}`);
    this.stageCards = page.getByTestId('intake-run-stage');
    this.eventList = page.getByTestId('intake-run-events');
    this.replayCursor = page.getByRole('slider', { name: '回放进度' });
  }

  /** 某一站的卡。传站名（run.json 里的 label），如「切块入库」。 */
  stageCard(label: string): Locator {
    return this.stageCards.filter({ hasText: label });
  }

  /** 事件流那一行「已显示 / 总数」的计数。 */
  eventCount(shown: number, total: number) {
    return this.page.getByText(`${shown} / ${total} 条`);
  }
}
