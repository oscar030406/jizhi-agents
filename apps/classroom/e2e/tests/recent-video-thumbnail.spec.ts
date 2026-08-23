import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/scene-content';

const TEST_STAGE_ID = 'e2e-video-thumbnail-stage';
const VIDEO_MEDIA_REF = 'gen_vid_thumbnail';
const LEGACY_STAGE_ID = 'e2e-legacy-video-ref-stage';
const LEGACY_VIDEO_REF = 'gen_vid_1';
const UNIQUE_VIDEO_REF = 'gen_vid_unique_legacy';
const FAILED_EXACT_STAGE_ID = 'e2e-failed-exact-video-ref-stage';
const OTHER_VIDEO_REF = 'gen_vid_other_success';
const POSTER_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function seedVideoThumbnailStage({
  page,
  stageId = TEST_STAGE_ID,
  courseName = 'Video Thumbnail Course',
  slideMediaRef = VIDEO_MEDIA_REF,
  storedMediaRef = slideMediaRef,
  storedError,
  extraStoredMediaRefs = [],
}: {
  page: Page;
  stageId?: string;
  courseName?: string;
  slideMediaRef?: string;
  storedMediaRef?: string;
  storedError?: string;
  extraStoredMediaRefs?: string[];
}) {
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({
      stageId,
      courseName,
      slideMediaRef,
      storedMediaRef,
      storedError,
      extraStoredMediaRefs,
      posterBase64,
      theme,
    }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['mediaFiles'], 'readwrite');
          const now = Date.now();
          const videoBytes = new Uint8Array([
            0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 109, 112, 52, 50, 105,
            115, 111, 109,
          ]);
          const posterBytes = Uint8Array.from(atob(posterBase64), (char) => char.charCodeAt(0));
          const videoBlob = new Blob([videoBytes], { type: 'video/mp4' });
          const posterBlob = new Blob([posterBytes], { type: 'image/png' });
          const failedVideoBlob = new Blob([], { type: 'video/mp4' });

          const putVideoRecord = (mediaRef: string, error?: string) => {
            const blob = error ? failedVideoBlob : videoBlob;
            tx.objectStore('mediaFiles').put({
              id: `${stageId}:${mediaRef}`,
              stageId,
              type: 'video',
              blob,
              mimeType: 'video/mp4',
              size: blob.size,
              poster: error ? undefined : posterBlob,
              prompt: 'A generated classroom video preview',
              params: '{}',
              error,
              createdAt: now,
            });
          };

          const documentScene = {
            id: 'scene-video-thumbnail',
            stageId,
            type: 'slide',
            title: 'Video preview',
            order: 0,
            content: {
              type: 'slide',
              canvas: {
                id: 'slide-video-thumbnail',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme,
                background: { type: 'solid', color: '#111827' },
                elements: [
                  {
                    id: 'video-el',
                    type: 'video',
                    src: slideMediaRef,
                    mediaRef: slideMediaRef,
                    left: 0,
                    top: 0,
                    width: 1000,
                    height: 562.5,
                    rotate: 0,
                    autoplay: false,
                  },
                ],
              },
            },
            createdAt: now,
            updatedAt: now,
          };

          putVideoRecord(storedMediaRef, storedError);
          for (const mediaRef of extraStoredMediaRefs) {
            putVideoRecord(mediaRef);
          }

          tx.oncomplete = () => {
            db.close();
            const documentRequest = indexedDB.open('maic-documents', 1);
            documentRequest.onupgradeneeded = () => {
              const documentDb = documentRequest.result;
              documentDb.createObjectStore('stages', { keyPath: 'id' });
              const scenes = documentDb.createObjectStore('scenes', {
                keyPath: ['stageId', 'id'],
              });
              scenes.createIndex('by-stage', 'stageId');
              documentDb.createObjectStore('outlines', { keyPath: 'stageId' });
            };
            documentRequest.onsuccess = () => {
              const documentDb = documentRequest.result;
              const documentTx = documentDb.transaction(
                ['stages', 'scenes', 'outlines'],
                'readwrite',
              );
              documentTx.objectStore('stages').put({
                id: stageId,
                name: courseName,
                description: '',
                language: 'en-US',
                style: 'professional',
                createdAt: now,
                updatedAt: now,
                dslVersion: '0.1.0',
              });
              documentTx.objectStore('scenes').put(documentScene);
              documentTx.objectStore('outlines').put({
                stageId,
                outline: { outlines: [], createdAt: now, updatedAt: now },
              });
              documentTx.oncomplete = () => {
                documentDb.close();
                resolve();
              };
              documentTx.onerror = () => reject(documentTx.error);
            };
            documentRequest.onerror = () => reject(documentRequest.error);
          };
          tx.onerror = () => reject(tx.error);
        };

        request.onerror = () => reject(request.error);
      });
    },
    {
      stageId,
      courseName,
      slideMediaRef,
      storedMediaRef,
      storedError,
      extraStoredMediaRefs,
      posterBase64: POSTER_BASE64,
      theme: defaultTheme,
    },
  );

  await page.goto('/', { waitUntil: 'networkidle' });
}

/**
 * 点开卡片后确认真的进了这门课。
 *
 * 原来这里还要在课堂里再找一次 `[data-video-element] video[controls]`。
 * 那个东西现在课堂里不存在了：2026-08-03 起学习者端的 slide 场景**只有讲义一种形态**
 * （`components/stage/scene-renderer.tsx` 的分支），播放态渲染 `LectureSceneView`，
 * 它只把文字和图片收进阅读流；画布那条路（`ScreenCanvas` → `BaseVideoElement`）
 * 除白板外已经没有调用方。所以这一段只断「点卡片进的是这门课」，
 * 视频本身的解析由上面首页缩略图那几条断（缩略图走的是同一个 mediaRef 解析）。
 */
async function expectOpenedClassroom(page: Page, courseName: string) {
  await expect(
    page.getByRole('heading', { name: courseName, level: 1 }),
    '点卡片后没进到这门课的课堂',
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * 首页「最近学习」卡上的视频缩略图。
 *
 * 这三条过去整组红在同一处：它们从**匿名首页**找课程卡，而账户系统恒开
 * （`accountsEnabled()` 直接 return true），匿名访客拿到的是公共落地页——
 * 上面根本没有最近学习这一栏。卡片只在登录后的工作台上，所以先把会话桩装上。
 */
test.describe('Home recent video thumbnails', () => {
  // 两件事都要先于任何导航做掉：seed helper 第一件事就是 goto('/')。
  test.beforeEach(async ({ page, mockApi }) => {
    await mockApi.mockSignedIn();
    // 「最近学习」在工作台上是折叠区，默认收起，课程卡要展开才渲染
    // （收起时首屏只有「继续上次」那张英雄卡，它不是 CourseCard）。
    await page.addInitScript(() => localStorage.setItem('recentClassroomsOpen', 'true'));
  });

  test('renders generated video thumbnails and opens the card from the preview area', async ({
    page,
  }) => {
    await seedVideoThumbnailStage({ page });

    const card = page.locator('.group.cursor-pointer').filter({
      hasText: 'Video Thumbnail Course',
    });
    const video = card.locator('[data-video-element] video');

    await expect(video).toBeVisible({ timeout: 10_000 });
    await expect(video).toHaveAttribute('src', /^blob:/);
    await expect(video).toHaveAttribute('poster', /^blob:/);
    await expect(video).not.toHaveAttribute('controls', '');
    await expect(card.locator('[data-testid="thumbnail-video-indicator"]')).toBeVisible();

    await card.click({ position: { x: 24, y: 24 } });
    await page.waitForURL(`**/classroom/${TEST_STAGE_ID}`);
    await expectOpenedClassroom(page, 'Video preview');
  });

  test('falls back from legacy gen_vid_1 refs to the single stored video media file', async ({
    page,
  }) => {
    await seedVideoThumbnailStage({
      page,
      stageId: LEGACY_STAGE_ID,
      courseName: 'Legacy Video Ref Course',
      slideMediaRef: LEGACY_VIDEO_REF,
      storedMediaRef: UNIQUE_VIDEO_REF,
    });

    const card = page.locator('.group.cursor-pointer').filter({
      hasText: 'Legacy Video Ref Course',
    });
    const thumbnailVideo = card.locator('[data-video-element] video');

    await expect(thumbnailVideo).toBeVisible({ timeout: 10_000 });
    await expect(thumbnailVideo).toHaveAttribute('src', /^blob:/);
    await expect(card.locator('[data-testid="thumbnail-video-indicator"]')).toBeVisible();

    await card.click({ position: { x: 24, y: 24 } });
    await page.waitForURL(`**/classroom/${LEGACY_STAGE_ID}`);
    await expectOpenedClassroom(page, 'Video preview');
  });

  test('does not fall back to another video when the exact legacy ref failed', async ({ page }) => {
    await seedVideoThumbnailStage({
      page,
      stageId: FAILED_EXACT_STAGE_ID,
      courseName: 'Failed Exact Video Ref Course',
      slideMediaRef: LEGACY_VIDEO_REF,
      storedMediaRef: LEGACY_VIDEO_REF,
      storedError: 'Generation failed',
      extraStoredMediaRefs: [OTHER_VIDEO_REF],
    });

    const card = page.locator('.group.cursor-pointer').filter({
      hasText: 'Failed Exact Video Ref Course',
    });

    await expect(card.locator('[data-testid="thumbnail-video-indicator"]')).toBeVisible();
    await expect(card.locator('[data-video-element] video')).toHaveCount(0);
  });
});
