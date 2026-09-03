# 演示视频制作链

稿件：`docs/06-defense/录屏稿-v3.md`（分镜、操作、旁白三合一）。旧的 v2 操作卡与旁白稿不再维护。

## 顺序

1. **图卡**：`python scripts/video/make_cards.py` → `docs/06-defense/video/{opening,end}-card-v3.png`
2. **口播**：`python scripts/video/tts_narration.py docs/06-defense/录屏稿-v3.md`
   - 首选 SiliconFlow CosyVoice2（key 从 `apps/agent-engine/.env` 读，请求直连不走代理），失败自动回退 edge-tts。
   - 产物 `docs/06-defense/audio/v3/<段号>.mp3`、`durations.json`（每段口播秒数，录屏时画面不能短于它）、`speech-text.json`（清洗后的实际口播文本）。
   - `--dry-run` 先看清洗后的文本；`--only 04 07` 只重合成某几段；`--speed 1.05` 微调语速。
3. **ASR 回核**：`python scripts/video/asr_check.py docs/06-defense/audio/v3`
   - 本机 whisper small 转写，与口播稿比对；相似度低于 0.85 或转写里出现语气指令词的段要重合成。
   - 数字两边都归一化成阿拉伯数字再比，「百分之二点一」对 2.1% 不算错。
4. **录屏**：按录屏稿第四节的文件名录到 `docs/06-defense/video/raw/`。1920×1080、30 fps。每段画面时长 ≥ `durations.json` 里对应口播秒数，装配器会硬校验。
   - 本机没装 OBS。Win+G 游戏录制栏可以录浏览器窗口（设置里把质量调到高、帧率 30、录系统声音）；要录整个桌面或多窗口切换就装 OBS。
5. **填加速段**：`docs/06-defense/video/scenes-v3.json` 里第 03 段的 `speedups` 把 `end` 改成实际的生成等待结束秒。装配器会在右上角盖「过程加速 N×」。
6. **出片**：`python scripts/video/compose_video.py docs/06-defense/video/scenes-v3.json -o docs/06-defense/集智演示视频.mp4`
   - 超 600 秒直接报错。左下角功能字幕、旁白全量、录屏原声压低都由装配器处理。
7. **打包**：视频落到 `docs/06-defense/` 后，跑 `scripts/build-submission.ps1`（不带 `-SkipVideoCheck`）。

## 已知坑（从数字人项目带过来的）

- CosyVoice2 的语气指令偶尔会被念进音频，所以默认不加指令（`--instruct` 才加），而且合成后一律过 ASR。
- 音频偶发爆音靠播放端限幅，不追单条素材。
- 剪辑合成用 moviepy 重编码整体拼接，不用 `-c copy` 拼段（PTS 会跳）。
- 旁白与录屏原声叠着会有「双声」感：录屏段原声默认压到 0.2，产品自带 TTS 的段可以调高 `system_audio`。
