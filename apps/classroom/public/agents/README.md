# public/agents —— 八角色形象定稿

生图提示词真源一份，改图前先读：`docs/03-design/ui/image-gen-handbook.md`
（八角色人设 + 逐条完整提示词 + 无字铁律 + 色板 + 命名规范 + 待生成清单）。
旧的 `agent-persona-artpack-20260810.md` 与 `ui/visual-asset-prompts-20260815.md` 已作废，
里面的要求（例如阿审乙胸前的「乙」字徽记）已被手册推翻，别再照着出图。

命名：小写连字符。角色前缀 `azhen / ajian / ajiang / ashen-a / ashen-b / acai / alu / awen`，
后缀 `-bust`（半身，UI 头像用）`-full`（全身立绘）。组图不带角色前缀。

| 文件 | 是什么 | 现在挂在哪 |
|---|---|---|
| `azhen-bust.png` … `awen-bust.png` | 八个角色半身像，512×512 | `/agents` 页职责分工卡（阿审甲乙两张叠放）；`ashen-a-bust.png` 另挂场景审核弹层标题旁 |
| `azhen-full.png` `ajian-full.png` `ajiang-full.png` `acai-full.png` `alu-full.png` `awen-full.png` `ashen-a-full.png` | 全身立绘（08-17 批补齐七位；阿审乙无全身，甲乙同衣异徽小尺寸分不出） | `/agents` 页「师门全员」区 |
| `azhen-actions.png` … `ashen-a-actions.png` | 三动作分镜横条 2172×724，七位全齐（08-17 批） | 未挂（切帧用，见下行） |
| `azhen-act1..3.png` … `ashen-a-act1..3.png` | 上排横条的单帧切割，21 张，高 512 已裁边（act1/2/3 = 每角色三个动作） | 待接线：生成等待期「当前主事角色」陪伴图（等体检收数完、无在飞生成时再改代码，防 HMR 杀生成循环） |
| `acai-desk.png` | 阿裁伏案读判词（天平在侧，1254×1254） | 未挂 |
| `hero-family.png` | 八人全家福横幅 1536×481 | **未挂**：图里阿审乙胸前有可辨识汉字「乙」，违无字铁律，等无徽记版重出（手册 B1/A5′） |
| `agents-grid.png` | 八人半身 2×4 拼版 | 未挂 |
| `ajiang-ashen-desk.png` | 阿讲与阿审对坐（生成 vs 审核的张力） | 未挂 |
| `agents-lineup-silhouette.png` | 八人剪影横条 1600×256 | 未挂 |
| `ajiang-to-ashen-facechange.png` | 阿讲→阿审变脸分镜条（7 格，格宽不齐） | 未挂 |

新文件往哪加：角色单图按上面的前缀+后缀命名直接放这里；组图/版面大图用能读懂的
描述性名字。淘汰稿不进这个目录。

处理过程：原稿白底，去底走 rembg u2net；`ashen-a-bust.png` 例外——u2net 把桌上的条陈
和小天平当背景抹了，改用四角漫水填充重切。全部转 255 色调色板 PNG（扁平赛璐璐上色，
肉眼无损）。带 alpha，深浅色模式都能直接用，不需要容器垫底色。
两个目录落盘 29 张合计 2,082,549 字节（2,034KB），复算：
`Get-ChildItem public/agents/*.png,public/illustrations/*.png | Measure-Object Length -Sum`。
