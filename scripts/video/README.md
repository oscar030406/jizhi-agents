# 演示视频制作链

成片 `docs/06-defense/集智演示视频.mp4`（520 秒）就是这条链跑出来的。

- 口播稿：`docs/06-defense/录屏稿-v6.md`（叙事顺序对齐答辩 PPT，句子取自 PPT），知识宇宙补录段另在 `录屏稿-v6-知识宇宙.md`。
- 录屏操作：`docs/06-defense/录屏稿-v5.md` 第一、二、四节（账号、地址、每段怎么操作、失败口径）。v6 复用 v5 录的实录，没有重录，所以这份仍是录屏的操作依据。
- 实录：`docs/06-defense/video/raw/v5-*.mp4` 与 `v6-10-知识宇宙.mp4`。

## 顺序

1. **口播**：`python scripts/video/tts_narration.py docs/06-defense/录屏稿-v6.md -o docs/06-defense/audio/v6 --speed 1.1 --engine cosy`
   - 稿件里 `旁白【阿检】：` 这种标记按角色分块，一段可多块；块间垫 0.45 秒静音，拼成该段一个 mp3。`speakers.json` 记每块角色与起止秒，装配器按它切头像。
   - 音色表在脚本顶部 `VOICES`，现在七个角色统一用 CosyVoice2 的 anna（一条声线，用户定的）。key 从 `apps/agent-engine/.env` 读，请求直连不走代理，失败回退 edge-tts。
   - 产物：`<段号>.mp3`、`durations.json`、`speech-text.json`。`--dry-run` 只看清洗后的文本，`--only 04 07` 重合成某几段。
2. **ASR 回核**：`python scripts/video/asr_check.py docs/06-defense/audio/v6`
   - 本机 whisper small 转写与稿件比对，相似度低于 0.85 的段重合成。数字两边归一化后再比，「百分之二点一」对 2.1% 不算错。
3. **录屏**（只在实录要重录时做）：按 `录屏稿-v5.md` 第四节录到 `video/raw/`，1920×1080、30 fps。知识宇宙这类 WebGL 画面必须用有头 Chrome 录，无头会录成黑屏（`tmp/video-recording-20260904/rec-universe.js` 是现成的脚本）。
4. **装配**：`python scripts/video/compose_ffmpeg.py --tone dark`
   - 段序、实录文件、左下角字幕、要保留的区间都写在脚本顶部的 `SCENES` 里，改片子改这一处。
   - 每段画面按该段口播长度加 0.6 秒裁剪，不够长就定格末帧，所以没有空屏。
   - `--tone`：`dark` 反相转色相当暗色主题用（录屏是亮色页面，直接放刺眼），`dim` 只压白底，`none` 只拉对比度。
   - 片头片尾用答辩 PPT 封面底图现场合成，不再需要单独的图卡文件。
   - 按段并行编码后无损拼接，整片约 30 秒出片；总长超 600 秒直接报错。
5. **打包**：视频落到 `docs/06-defense/` 后跑 `scripts/build-submission.ps1`（不带 `-SkipVideoCheck`）。

## 已知坑

- CosyVoice2 的语气指令偶尔被念进音频，所以默认不加指令（`--instruct` 才加），合成后一律过 ASR。
- 音频偶发爆音靠播放端限幅，不追单条素材。
- 拼段不要用 `-c copy`：段与段的 SAR 不一致时会拼出花屏或半截文件，装配器统一走 `setsar=1` 再重编码。
- 旁白与录屏原声叠着有「双声」感：录屏段原声压到 0.2，产品自带 TTS 的段可调高 `system_audio`。
- 两个装配进程同时写同一个 `scene-*.mp4` 会写出坏文件，改脚本重跑前先确认上一次跑完了。
