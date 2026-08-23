import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { Page } from '@playwright/test';

/**
 * Targeted live verification of playback cursor persistence (#869 cutover):
 * the resume cursor lands in device-scoped KV (localStorage
 * `playback-cursor:<stageId>`) while the lecture plays, and survives a fresh
 * page (empty sessionStorage). Consumed-discussion state is volatile by
 * decision — a re-shown proactive card auto-skips — so no runtime records are
 * asserted here.
 */

const STAGE_ID = 'stage-playback-e2e';
const SCENE_ID = 'scene-playback-e2e';

async function seedStage(page: Page) {
  await page.goto('/classroom/warmup-nonexistent');
  await page.evaluate(
    async ({ stageId, sceneId }) => {
      const open = indexedDB.open('maic-documents', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('stages', { keyPath: 'id' });
        const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
        scenes.createIndex('by-stage', 'stageId');
        db.createObjectStore('outlines', { keyPath: 'stageId' });
      };
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const now = Date.now();
      const tx = db.transaction(['stages', 'scenes'], 'readwrite');
      tx.objectStore('stages').put({
        id: stageId,
        name: 'Playback E2E Stage',
        createdAt: now,
        updatedAt: now,
        dslVersion: '0.1.0',
      });
      localStorage.setItem(
        `maic:device:editor-current-scene:${stageId}`,
        JSON.stringify({ sceneId, updatedAt: new Date(now).toISOString() }),
      );
      tx.objectStore('scenes').put({
        id: sceneId,
        stageId,
        type: 'slide',
        title: 'Playback E2E Scene',
        order: 0,
        content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
        actions: [
          { id: 'act-speech-1', type: 'speech', text: 'One.' },
          { id: 'act-speech-2', type: 'speech', text: 'Two.' },
          { id: 'act-speech-3', type: 'speech', text: 'Three.' },
        ],
        createdAt: now,
        updatedAt: now,
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { stageId: STAGE_ID, sceneId: SCENE_ID },
  );
}

async function readCursor(page: Page): Promise<{ sceneId: string; actionIndex: number } | null> {
  return page.evaluate((stageId) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)!;
      if (key.includes(`playback-cursor:${stageId}`)) {
        const parsed = JSON.parse(localStorage.getItem(key)!);
        // BrowserKVStore may wrap the value; unwrap common shapes.
        return parsed?.value ?? parsed;
      }
    }
    return null;
  }, STAGE_ID);
}

test('playback cursor persists to device KV and survives a fresh page', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('settings-storage', settings);
    },
    createSettingsStorage({ autoPlayLecture: true, ttsEnabled: false }),
  );
  await seedStage(page);

  await page.goto(`/classroom/${STAGE_ID}`);
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });

  // 起播走底部工具条上的 Play 按钮。原来点的是画布中央那个 `z-[102]` 的
  // motion.div 遮罩——那个遮罩已经没有了（全仓搜不到 `z-[102]`），
  // 现在唯一的起播入口就是工具条这一个，它有 aria-label，不必按 class 猜。
  //
  // `exact: true` 不能省：`getByRole` 的 name 默认是**子串**匹配，而侧栏那个
  // 场景条目的无障碍名是「第 1 页 Playback E2E Scene」——里头就有 "Play"。
  // 不加 exact，`.first()` 拿到的是侧栏条目，点它只是切场景，起播按钮根本没被碰到
  // （实测：连点 12 次、24 秒，光标一次都没落盘）。
  //
  // 按钮先上屏、播放引擎后建好（引擎在当前场景加载完那一拍才 new 出来），
  // 早按的那一下会被 `handlePlayPause` 开头的 `if (!engine) return` 吞掉，
  // 界面上没有任何反馈——所以按到光标真的落盘为止，而不是按一下就干等。
  // `autoPlayLecture: true` 单独不起播（实测），起播这一下必须是人点的。
  // 讲稿动作按阅读时长推进，光标写盘还比进度晚 1 秒防抖。
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await play.first().waitFor({ state: 'visible', timeout: 15_000 });
  await expect(async () => {
    // 播起来之后按钮的 aria-label 变成 Pause，这里就不会再点第二下。
    if (await play.count()) await play.first().click();
    expect(
      (await readCursor(page))?.sceneId ?? null,
      'the device cursor should be persisted while the lecture plays',
    ).toBe(SCENE_ID);
  }).toPass({ timeout: 60_000, intervals: [500, 1000, 2000] });

  // Fresh page = empty sessionStorage → the KV cursor is the resume source
  // and must still be readable.
  const fresh = await context.newPage();
  await fresh.goto(`/classroom/${STAGE_ID}`);
  await expect(fresh.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });
  const cursorAfterReload = await readCursor(fresh);
  expect(cursorAfterReload?.sceneId).toBe(SCENE_ID);

  await fresh.close();
});
