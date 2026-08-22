// 空态卡片。原来 /report 和 /skills 各写了一份，样式已经开始不一样（一个有圆底图标、
// 一个没有），/path 干脆没有空态。抽到这里，三页共用一份，说清「为什么空、该怎么办」。
//
// 注意：它只表示「数据到了但是空的」这一类终态，不表示「还在加载」。加载中要用各页自己的
// 骨架/转圈，判据是「确实在加载」而不是「数据是 null」——离线、无画像、无课程这些终态下
// 数据同样是 null，按 null 写会让骨架永久停在那里假装数据在路上。

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 px-4 py-10 text-center sm:px-6">
      {/* 空态插图（原来是一个 lucide 禁止符圆底）。图带 alpha，深浅色模式共用一张，
          不需要容器垫底色。纯装饰：为什么空、该怎么办都写在下面两行字里，读屏跳过它。 */}
      <img
        src="/illustrations/empty-not-found.png"
        alt=""
        aria-hidden
        className="mb-1 size-24 select-none"
      />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}
