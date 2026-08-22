/**
 * 公共页段落锚点：一屏一个高饱和锚点（Brilliant 配方，
 * docs/03-design/ui/public-site-redesign-20260809.md §4.1 三层配色的第三层）。
 *
 * 实心主色圆片 + 白图标。全页所有段落标题共用这一支色，
 * 不再一屏一个色相（原来课程墙绿、路径蓝、可信区紫，三个色相互相抢）。
 * 吃的是 --primary，所以公共页根节点上的朱砂变体一翻，全页锚点跟着翻。
 */
export function SectionAnchor({
  icon: Icon,
}: {
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[oklch(0.54_0.22_290)] to-[oklch(0.6_0.19_250)] text-white shadow-card"
    >
      <Icon className="size-[18px]" />
    </span>
  );
}
