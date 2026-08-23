'use client';

/**
 * `useExportScript` — download the classroom narration script (the
 * `SpeechAction.text` per scene) as a Markdown file.
 *
 * Ported from upstream lib/export/use-export-script.ts (issue #413): teachers
 * want the TTS narration text as a local document for lesson prep/reference,
 * not just the PPTX export. This is a pure client-side collection +
 * serialization + download — no server route or media work. The upstream DOCX
 * branch is intentionally dropped (no `docx` dependency in this fork).
 *
 * App-side / impure: store read, sonner toast, `saveAs` download.
 */
import { useCallback } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';

import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('ExportScript');

/** One scene's narration, collected from its speech actions. */
export interface SceneScript {
  sceneId: string;
  sceneTitle: string;
  sceneOrder: number;
  text: string;
}

export const SCRIPT_MD_MIME_TYPE = 'text/markdown;charset=utf-8';

/**
 * Collect each scene's narration: concatenate its `SpeechAction.text` values in
 * action order. Scenes with no speech text are omitted entirely. `slideFallback`
 * supplies the locale-appropriate label for scenes with an empty title.
 */
export function collectSceneScripts(
  scenes: Scene[],
  slideFallback: (order: number) => string,
): SceneScript[] {
  const scripts: SceneScript[] = [];
  for (const scene of scenes) {
    const parts: string[] = [];
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && action.text.trim()) {
        parts.push(action.text.trim());
      }
    }
    const text = parts.join('\n');
    if (!text) continue;
    scripts.push({
      sceneId: scene.id,
      sceneTitle: scene.title || slideFallback(scene.order),
      sceneOrder: scene.order,
      text,
    });
  }
  return scripts;
}

/** Normalize CRLF and lone CR line endings for consistent cross-format output. */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Neutralize a scene/stage title before it's interpolated into a Markdown
 * heading: flatten embedded newlines to spaces, then backslash-escape a
 * leading `#` run so it renders as literal text instead of Markdown heading
 * syntax. Escaping (not stripping) preserves titles that legitimately start
 * with `#` (e.g. "#1 Introduction") while still neutralizing the character's
 * special meaning. Newlines are flattened before the leading-`#` check so a
 * title like "\n# Injected" can't dodge the escape by shielding its `#`
 * behind whitespace that a later `trim()` would otherwise re-expose.
 */
function sanitizeMarkdownHeading(text: string): string {
  const flattened = text.replace(/[\r\n]+/g, ' ').trim();
  return flattened.replace(/^#+/, (hashes) =>
    hashes
      .split('')
      .map((h) => `\\${h}`)
      .join(''),
  );
}

/** Serialize collected scripts as a Markdown document. */
export function buildMarkdown(stageName: string, scripts: SceneScript[]): string {
  const lines = [`# ${sanitizeMarkdownHeading(stageName)}`];
  for (const script of scripts) {
    if (!script.text) continue;
    lines.push('', `## ${sanitizeMarkdownHeading(script.sceneTitle)}`, '');
    const paragraphs = normalizeLineEndings(script.text)
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
      .filter(Boolean);
    for (const paragraph of paragraphs) {
      lines.push(paragraph, '');
    }
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build a safe download file name: `<stem>-script.md`. Illegal filename
 * characters are stripped (emoji survive; control/zero-width characters do
 * not), whitespace runs collapse to a single `-`, and an empty stem falls
 * back to `script`.
 */
export function buildScriptFileName(stageName: string): string {
  const cleaned = stageName
    .replace(/[\u0000-\u001f\u007f\u200b-\u200c\u200e-\u200f\ufeff\\/:*?"<>|]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned ? `${cleaned}-script.md` : `script.md`;
}

/** Export hook — exposes the Markdown script download. */
export function useExportScript() {
  const { t } = useI18n();

  const exportScriptMd = useCallback(() => {
    const scenes = useStageStore.getState().scenes;
    const stage = useStageStore.getState().stage;
    // 场景无标题时的兜底页名（locale 未收录 slideFallback key，直接中文文案）。
    const scripts = collectSceneScripts(scenes, (order) => `幻灯片 ${order + 1}`);
    if (scripts.length === 0) {
      toast.warning(t('export.nothingToExport'));
      return;
    }

    try {
      const fileName = stage?.name || 'classroom';
      const blob = new Blob([buildMarkdown(fileName, scripts)], {
        type: SCRIPT_MD_MIME_TYPE,
      });
      saveAs(blob, buildScriptFileName(fileName));
      toast.success(t('export.exportSuccess'));
    } catch (error) {
      log.error('Script export failed (md):', error);
      toast.error(t('export.exportFailed'));
    }
  }, [t]);

  return { exportScriptMd };
}
