'use client';

import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';
import { useStageStore } from '@/lib/store';
import { useInteractionProgress } from '@/lib/store/interaction-progress';
import { HeaderControls } from './stage/header-controls';

interface HeaderProps {
  readonly currentSceneTitle: string;
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
}

/**
 * 课内分段进度（设计规格 3.2.2，配方⑤③）：已完成互动数/总互动数。
 * 一段一个 quiz 场景；交卷即点亮（答错也推进），永不回退。
 * 填充 green-solid、轨道 purple-soft。
 */
function InteractionProgress() {
  const { t } = useI18n();
  const scenes = useStageStore((s) => s.scenes);
  const completed = useInteractionProgress((s) => s.completed);

  const interactions = useMemo(() => scenes.filter((s) => s.type === 'quiz'), [scenes]);
  if (interactions.length === 0) return null;
  const doneCount = interactions.filter((s) => completed[s.id]).length;

  return (
    <div
      className="hidden md:flex items-center gap-2 shrink-0"
      title={t('stage.interactionProgressHint')}
    >
      <div className="flex items-center gap-1 w-36">
        {interactions.map((scene) => (
          <span
            key={scene.id}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors duration-300',
              completed[scene.id] ? 'bg-green-solid' : 'bg-purple-soft',
            )}
          />
        ))}
      </div>
      {/* text-xs 收进徽章（规格2.4） */}
      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
        {doneCount}/{interactions.length}
      </span>
    </div>
  );
}

export function Header({ currentSceneTitle, mode, canEdit, onToggleEditMode }: HeaderProps) {
  const { t } = useI18n();
  const router = useRouter();

  return (
    <>
      {/* 统一 header：h-14、标题左对齐（规格2.4⑩） */}
      <header className="h-14 px-8 flex items-center justify-between z-10 bg-transparent gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={() => router.push('/')}
            className="shrink-0 p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title={t('generation.backToHome')}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Title block — hidden when `mode === 'edit'`. Header lives
              inside `PlaybackChromeRoot`, which is unmounted by `Stage`
              once mode flips to 'edit', so in steady state this branch
              is always taken. The guard exists for the ~280ms
              AnimatePresence exit window where the playback chrome
              is still rendering its exit animation while `mode` has
              already flipped — without the guard, this title would
              briefly stack on top of the incoming EditChromeRoot's
              CommandBar title during the cross-fade. */}
          {mode !== 'edit' && (
            <h1
              className="text-lg font-medium text-foreground truncate"
              suppressHydrationWarning
            >
              {currentSceneTitle || t('common.loading')}
            </h1>
          )}
        </div>

        {mode !== 'edit' && <InteractionProgress />}

        <HeaderControls mode={mode} canEdit={canEdit} onToggleEditMode={onToggleEditMode} />
      </header>
    </>
  );
}
