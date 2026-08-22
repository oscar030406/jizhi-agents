# public/illustrations —— 概念插图与空态插图

生图提示词真源：`docs/03-design/ui/image-gen-handbook.md`
（概念插图、空态与过程态、无字铁律与色板）。旧的 `ui/visual-asset-prompts-20260815.md`
与 `agent-persona-artpack-20260810.md` 已作废，别再照着出图。

命名：概念插图 `ill-<概念>.png`，空态 `empty-<场景>.png`，过程态 `state-<阶段>.png`。
统一 640×640，带 alpha，主色蓝紫 #6C50D9 / 靛蓝 #4D74E0，朱砂 #9F2F2D 只作点缀。

| 文件 | 画的是什么 | 现在挂在哪 |
|---|---|---|
| `ill-kb-intake.png` | 机械臂从一排线装书上取出一页发光的纸（1254×1254，08-17 批） | 首页机制卡「受控教材接地」 |
| `ill-books.png` | 四册线装书并排（1254×1254，08-17 批） | 未挂 |
| `ill-audit-props.png` | 印章 / 灯笼 / 纸页三小物散布（1254×1254，08-17 批） | 未挂 |
| `ill-lantern-row.png` | 四盏蓝紫灯笼横排（2172×724，08-17 批） | 未挂 |
| `ill-dual-audit.png` | 两枚印章各投一束光，光斑交叠 | 首页机制卡「双审核智能体辩论」 |
| `ill-provenance.png` | 讲义上的一句被细线牵回书里某一页 | 首页机制卡「出处逐句可查」 |
| `ill-arbitration.png` | 天平两端各托一枚印章，中央一方大印 | 未挂 |
| `ill-profile.png` | 三个侧脸剪影，头顶几何积木组合各不相同 | 未挂 |
| `ill-path.png` | 蜿蜒阶梯路，终点朱砂旗 | 未挂 |
| `ill-token.png` | 长条被切成大小不一的方块 | 未挂 |
| `ill-attention.png` | 两排圆点间粗细不等的弧线，最粗三条朱砂 | 未挂 |
| `ill-rag.png` | 漏斗接住书堆飘落的纸页，下方流出纸条 | 未挂 |
| `ill-hallucination.png` | 一行扭曲的字迹被朱砂印章盖住 | 未挂 |
| `empty-no-course.png` | 打开的空木书箱，旁边一支毛笔 | 未挂 |
| `empty-not-found.png` | 放大镜悬在空白纸上 | 共用空态组件 `components/ui/empty-state.tsx` |
| `state-generating.png` | 毛笔悬空，笔尖下三个递减墨点 | 未挂 |
| `state-done.png` | 合拢系好的卷轴，系带朱砂色 | 未挂 |

~~缺 `ill-retrieval.png`（机制卡「受控教材接地」用）~~：08-17 批的 `ill-kb-intake.png`
补上了这个缺（同一语义、无字），机制卡已挂。原有字稿不再重出。

新文件往哪加：按上面三种前缀命名放这里，再在表里补一行。淘汰稿不进这个目录。
