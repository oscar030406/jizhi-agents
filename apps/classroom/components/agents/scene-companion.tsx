'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_ART, AGENT_PERSONAS } from './agent-avatar';
import type { Scene } from '@/lib/types/stage';

/**
 * 导学引路小人 —— 刚进课堂时右侧是空的，阿问站在那儿招手，点一下把导学栏拉开。
 *
 * 交互语法沿用灵山「灵伴」那套（可拖、空闲游走、呼吸、点击回应、头顶气泡），
 * 但角色固定是阿问：右侧那块地界归导学管，让阿讲在那儿喊「右边找我」说不通。
 * 招呼词随当前屏的类型换，讲义/测验/教具/实操各说各的，学生知道现在能问什么。
 *
 * 导学栏一展开就退场——阿问已经在栏里了，外面再站一个是重影。
 *
 * 三帧取自 `AGENT_ART.acts`（act1 准备 / act2 动作 / act3 定格）：静立=act1，
 * 说话=act1↔act2 交替，被点=act3 定格。原图高统一 512、宽 213~512 各不相同，
 * 所以固定高度、宽度自适应，别设死宽高比。
 */

/** 招呼词按当前屏的类型换。写成师门口气的大白话，不喊口号、不写产品腔。 */
const SCENE_LINE: Record<string, string> = {
  slide: '这节读完想验一验？点我，我出题考你。',
  quiz: '题做完别急着走。点我，我接着往你薄的地方问。',
  interactive: '动完手来说说为什么这么选。点我，我陪你捋。',
  pbl: '项目卡住了就点我，我从你做到的那一步往下问。',
};
const FALLBACK_LINE = '想被考一考就点我，我按这节讲过的内容出题。';

/** 距画布右缘留出的距离：站在右侧留白带里，不压正文行宽。 */
const RIGHT_INSET = 116;

const IDLE = 0;
const ACTIVE = 1;
const SETTLE = 2;

export function SceneCompanion({
  scene,
  chatCollapsed,
  onToggleChat,
}: {
  scene: Scene | null;
  /** 右侧导学栏是否收着。只有收着时才需要有人在外面引路。 */
  chatCollapsed?: boolean;
  onToggleChat?: () => void;
}) {
  const sceneType = scene?.content?.type ?? scene?.type ?? null;
  const art = AGENT_ART.tutor;
  const persona = AGENT_PERSONAS.tutor;
  const frames = art.acts;
  const line = (sceneType && SCENE_LINE[sceneType]) || FALLBACK_LINE;

  const [bubbleState, setBubbleState] = useState<{ sceneId: string; text: string } | null>(null);
  const [frame, setFrame] = useState(IDLE);
  const [glide, setGlide] = useState(true);
  const [hidden, setHidden] = useState(false);
  // 窄屏上正文占满全宽，游走到哪都压字——缩一号钉在角落
  const [isMobile, setIsMobile] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dollRef = useRef<HTMLButtonElement>(null);
  const drag = useRef({ active: false, moved: false, dx: 0, dy: 0 });
  const lastInteract = useRef(0);
  const greeted = useRef<Set<string>>(new Set());
  const settleUntil = useRef(0);

  const H = isMobile ? 88 : 132;
  const visible = chatCollapsed !== false && !hidden;
  const bubble = bubbleState && bubbleState.sceneId === scene?.id ? bubbleState.text : null;

  useEffect(() => {
    // jsdom 没有 matchMedia。这个组件挂在课堂画布里，任何渲染课堂子树的测试都会
    // 连带渲染它——2026-08-21 实测打挂了 `tests/playback/scene-switch-gate-wiring`
    // 两条既有用例（`window.matchMedia is not a function`）。
    // 修在组件而不是测试的全局 setup 里：缺一个可选的媒体查询能力就整棵树崩，
    // 本来就不该是组件的行为。拿不到就按非窄屏走，小人照常显示。
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 760px)');
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const [pos, setPos] = useState({ x: -9999, y: -9999 });

  /** 定位基准是所在的画布，不是视口——导学栏一展开画布变窄，小人跟着让位。 */
  const boxOf = useCallback(() => {
    const r = rootRef.current?.parentElement?.getBoundingClientRect();
    return { w: r?.width ?? window.innerWidth, h: r?.height ?? window.innerHeight };
  }, []);

  const clamp = useCallback(
    (x: number, y: number) => {
      const box = boxOf();
      const w = dollRef.current?.offsetWidth ?? H;
      return {
        x: Math.max(8, Math.min(x, box.w - w - 8)),
        y: Math.max(8, Math.min(y, box.h - H - 8)),
      };
    },
    [H, boxOf],
  );

  // 初值直接算好，免得先在角落闪一下再跳过去。画布尺寸变了（折侧栏、开导学栏、
  // 改窗口）就重新夹一次，不然小人会留在画布外面。
  useEffect(() => {
    if (!visible) return;
    const place = () =>
      setPos((p) => (p.x < 0 ? clamp(boxOf().w - RIGHT_INSET, boxOf().h * 0.5) : clamp(p.x, p.y)));
    place();
    // ResizeObserver 与 matchMedia 同款：jsdom 里没有，缺了不该让整棵课堂子树崩。
    // 拿不到就退化成「只在 window resize 时重夹」——画布尺寸变化（折侧栏、开导学栏）
    // 检测不到，小人可能短暂留在旧位置，但不会挡住任何东西，也不影响其余功能。
    const parent = rootRef.current?.parentElement;
    const ro = parent && typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    ro?.observe(parent!);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [clamp, boxOf, visible]);

  // 预载三帧，切帧不闪白
  useEffect(() => {
    for (const src of frames ?? []) {
      const img = new Image();
      img.src = src;
    }
  }, [frames]);

  // 换屏就换一句招呼，同一屏只招呼一次；导学栏开着时不打扰
  useEffect(() => {
    if (!scene || !visible) return;
    if (greeted.current.has(scene.id)) return;
    const t = window.setTimeout(() => {
      greeted.current.add(scene.id);
      setBubbleState({ sceneId: scene.id, text: line });
    }, 3000);
    return () => window.clearTimeout(t);
  }, [scene, line, visible]);

  // 气泡自己消失，别让它一直杵在那儿挡正文
  useEffect(() => {
    if (!bubble) return;
    const t = window.setTimeout(() => setBubbleState(null), 9000);
    return () => window.clearTimeout(t);
  }, [bubble]);

  // 说话时 act1↔act2 交替，看着像在比划；点击定格期间让位
  useEffect(() => {
    if (!bubble) return;
    let on = false;
    const iv = window.setInterval(() => {
      if (Date.now() <= settleUntil.current) return;
      on = !on;
      setFrame(on ? ACTIVE : IDLE);
    }, 420);
    return () => {
      window.clearInterval(iv);
      setFrame((f) => (f === ACTIVE ? IDLE : f));
    };
  }, [bubble]);

  // 空闲只在右缘那条竖带里上下溜达，不横穿正文
  useEffect(() => {
    if (isMobile || !visible) return;
    const iv = window.setInterval(() => {
      if (drag.current.active) return;
      if (Date.now() - lastInteract.current < 9000) return;
      setGlide(true);
      const box = boxOf();
      setPos(clamp(box.w - RIGHT_INSET - Math.random() * 36, box.h * (0.3 + Math.random() * 0.42)));
    }, 17000);
    return () => window.clearInterval(iv);
  }, [clamp, isMobile, boxOf, visible]);

  const onPointerDown = (e: React.PointerEvent) => {
    const o = rootRef.current?.parentElement?.getBoundingClientRect();
    drag.current = {
      active: true,
      moved: false,
      dx: e.clientX - (o?.left ?? 0) - pos.x,
      dy: e.clientY - (o?.top ?? 0) - pos.y,
    };
    setGlide(false);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    const o = rootRef.current?.parentElement?.getBoundingClientRect();
    const nx = e.clientX - (o?.left ?? 0) - drag.current.dx;
    const ny = e.clientY - (o?.top ?? 0) - drag.current.dy;
    if (Math.abs(nx - pos.x) > 4 || Math.abs(ny - pos.y) > 4) drag.current.moved = true;
    setPos(clamp(nx, ny));
  };
  const onPointerUp = () => {
    if (!drag.current.active) return;
    const moved = drag.current.moved;
    drag.current.active = false;
    lastInteract.current = Date.now();
    setGlide(true);
    if (moved) return;
    // 点一下：定格帧回应一下，然后把导学栏拉开——这才是她站在这儿的目的
    settleUntil.current = Date.now() + 900;
    setFrame(SETTLE);
    window.setTimeout(() => setFrame((f) => (f === SETTLE ? IDLE : f)), 900);
    setBubbleState(null);
    onToggleChat?.();
  };

  const label = useMemo(
    () => `${persona.name} · ${persona.role} —— 点我展开导学，也可以拖动`,
    [persona],
  );

  if (!frames || !visible) return null;

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute z-30 flex select-none flex-col items-end"
      style={{
        left: pos.x,
        top: pos.y,
        transition: glide ? 'left 2.4s ease, top 2.4s ease' : 'none',
      }}
    >
      {bubble && (
        <div className="pointer-events-auto absolute bottom-full right-0 mb-2 w-60 animate-[companion-pop_.28s_ease] rounded-xl border border-border-subtle bg-surface-raised px-3 py-2 text-left text-[0.82rem] leading-relaxed text-foreground shadow-lg">
          <span className="mb-0.5 block text-[0.7rem] text-muted-foreground">{persona.name}</span>
          {bubble}
          <button
            type="button"
            onClick={() => setBubbleState(null)}
            aria-label="关掉这句话"
            className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border-subtle bg-surface text-[0.65rem] text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </div>
      )}
      <button
        ref={dollRef}
        type="button"
        className="pointer-events-auto cursor-pointer touch-none border-0 bg-transparent p-0 drop-shadow-[0_8px_10px_rgba(20,22,26,0.22)] active:cursor-grabbing"
        style={{ height: H }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setHidden(true)}
        aria-label={label}
        title={`${label}（双击暂时收起）`}
      >
        <img
          src={frames[frame]}
          alt={`${persona.name}（${persona.role}）`}
          draggable={false}
          className="pointer-events-none block h-full w-auto animate-[companion-breathe_3.6s_ease-in-out_infinite] object-contain"
        />
      </button>
    </div>
  );
}
