'use client';

import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import type { Scene, StageMode } from '@/lib/types/stage';
import { LectureSceneView } from '../scene-renderers/lecture-scene-view';
import { QuizView } from '../scene-renderers/quiz-view';
import { InteractiveRenderer } from '../scene-renderers/interactive-renderer';
import { PBLRenderer } from '../scene-renderers/pbl-renderer';

interface SceneRendererProps {
  readonly scene: Scene;
  readonly mode: StageMode;
  /** 场景切换闸门，透传给 QuizView 的「跳转过去」（见 quiz-view.tsx）。 */
  readonly onRequestSceneSwitch?: (sceneId: string) => Promise<boolean>;
}

/**
 * Playback scene dispatcher. In Pro (edit) mode, Stage renders EditShell
 * directly as a top-level takeover — SceneRenderer is only on the playback
 * path, so it does not branch on `mode === 'edit'`.
 */
/**
 * 内容体与场景类型对不上时的终态。原来是五处裸英文 div（"Invalid slide content"
 * 之类）贴在画布左上角，既没告诉学生发生了什么，也没给下一步。走站内共用空态卡。
 */
function brokenContent(declared: string) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        title="这一页的内容读不出来"
        hint={`这一页标成「${declared}」，但存的内容不是这个类型，渲染不了。可以翻到下一页继续，或进专业模式重新生成本页。`}
      />
    </div>
  );
}

export function SceneRenderer({ scene, mode, onRequestSceneSwitch }: SceneRendererProps) {
  const renderer = useMemo(() => {
    switch (scene.type) {
      case 'slide':
        if (scene.content.type !== 'slide') return brokenContent('讲义');
        // 2026-08-03 用户裁决：学习者端取消幻灯片放映，slide 场景唯一形态=讲义
        // （数据源仍是模板槽位 DSL；教师端 Pro 编辑器不受影响）。
        return <LectureSceneView scene={scene} />;
      case 'quiz':
        if (scene.content.type !== 'quiz') return brokenContent('测验');
        return (
          <QuizView
            key={scene.id}
            questions={scene.content.questions}
            sceneId={scene.id}
            stageId={scene.stageId}
            sceneTitle={scene.title}
            onRequestSceneSwitch={onRequestSceneSwitch}
          />
        );
      case 'interactive':
        if (scene.content.type !== 'interactive') return brokenContent('教具');
        return <InteractiveRenderer content={scene.content} sceneId={scene.id} />;
      case 'pbl':
        if (scene.content.type !== 'pbl') return brokenContent('实战任务');
        return <PBLRenderer content={scene.content} mode={mode} sceneId={scene.id} />;
      default:
        // switch 已穷尽 SceneType，走到这里说明数据里的类型比代码新
        return brokenContent('未知类型');
    }
  }, [scene, mode, onRequestSceneSwitch]);

  return <div className="w-full h-full">{renderer}</div>;
}
