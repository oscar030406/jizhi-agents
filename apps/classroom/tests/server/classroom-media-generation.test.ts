import { afterEach, describe, expect, test, vi } from 'vitest';
import { replaceMediaPlaceholders } from '@/lib/server/classroom-media-generation';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

function slideScene(
  elements: Array<{ id: string; type: string; src?: string; mediaRef?: string }>,
) {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas_1',
        elements,
      },
    },
  } as unknown as Scene;
}

describe('classroom media placeholder replacement', () => {
  test('preserves direct video src when mediaRef is also present', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'https://example.com/direct.mp4',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    const video = content.canvas.elements[0];
    expect(video.src).toBe('https://example.com/direct.mp4');
  });
});

describe('generateMediaForClassroom model resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const outline = (type: 'image' | 'video') =>
    [
      {
        id: 'outline_1',
        type: 'slide',
        title: 'Scene 1',
        description: 'd',
        order: 1,
        mediaGenerations: [{ type, prompt: 'a cat', elementId: `gen_${type}_1` }],
      },
    ] as unknown as SceneOutline[];

  test.each([
    ['key-only', undefined, 'doubao-seedream-5-0-260128'],
    ['server-pinned', 'server-image-model', 'server-image-model'],
  ] as const)(
    'uses the %s image model for classroom generation',
    async (_, configured, expected) => {
      vi.stubEnv('IMAGE_SEEDREAM_API_KEY', 'sk-seedream');
      if (configured) vi.stubEnv('IMAGE_SEEDREAM_MODELS', configured);
      vi.resetModules();

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn.example.com/image.png' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          arrayBuffer: async () => new ArrayBuffer(8),
        });
      vi.stubGlobal('fetch', fetchMock);

      const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');
      await generateMediaForClassroom(outline('image'), 'cls-image', 'http://localhost');

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(expected);
    },
  );

  test.each([
    ['key-only', undefined, 'doubao-seedance-2-0-260128'],
    ['server-pinned', 'server-video-model', 'server-video-model'],
  ] as const)(
    'uses the %s video model for classroom generation',
    async (_, configured, expected) => {
      vi.stubEnv('VIDEO_SEEDANCE_API_KEY', 'sk-seedance');
      if (configured) vi.stubEnv('VIDEO_SEEDANCE_MODELS', configured);
      vi.useFakeTimers();
      vi.resetModules();

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'video-task' }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'video-task',
            status: 'succeeded',
            content: { video_url: 'https://cdn.example.com/video.mp4' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null },
          arrayBuffer: async () => new ArrayBuffer(8),
        });
      vi.stubGlobal('fetch', fetchMock);

      const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');
      const mediaMap = generateMediaForClassroom(outline('video'), 'cls-video', 'http://localhost');
      await vi.advanceTimersByTimeAsync(5_000);
      await mediaMap;

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(expected);
    },
  );
});
