'use client';

/**
 * 体检产物的「点开看」。
 *
 * 之前这一页只把复算路径印成一段 `<code>` 文本，样式像链接却点不动，
 * 用户点了以为是死链（2026-08-21 报的问题）。现在路径旁边就是能打开的按钮，
 * 弹层里给的是那个文件在服务器上的原文。
 *
 * 内容在服务端渲染时就读好了（两类文件各 1–2 KB），没有另开接口：
 * 页面本身已经在管理者闸后面，少一个接口就少一处要守的路径。
 * 原文不渲染 markdown / 不格式化 JSON——这里要看的就是产物文件本身长什么样。
 */

import { useState } from 'react';
import { FileText } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { RunArtifact } from './data';

const ARTIFACT_LABELS: Record<string, string> = {
  'REPORT.md': '体检报告',
  'beginner_kc_misses.json': '入门档未覆盖知识清单',
  'advanced_kc_misses.json': '进阶档未覆盖知识清单',
};

export function RunArtifacts({ artifacts }: { readonly artifacts: readonly RunArtifact[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (artifacts.length === 0) return null;
  const shown = artifacts.find((a) => a.name === open) ?? null;

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {artifacts.map((a) => (
          <button
            key={a.name}
            type="button"
            onClick={() => setOpen(a.name)}
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] transition-colors hover:bg-accent"
          >
            <FileText className="size-3 shrink-0" />
            {ARTIFACT_LABELS[a.name] ?? '体检明细'}
          </button>
        ))}
      </div>

      <Dialog open={shown !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {shown ? (ARTIFACT_LABELS[shown.name] ?? '体检明细') : ''}
            </DialogTitle>
            <DialogDescription>本次体检明细；可在此查看完整内容。</DialogDescription>
          </DialogHeader>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-[10px] leading-relaxed">
            {shown?.text}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
