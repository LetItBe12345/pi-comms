# STARFALL 三 Session 发行版 Demo

三个真实 Pi Session 通过 Pi Comms 完成一次“深空救援”：舰桥诊断、机库修复、瞭望塔验收。

## 产物

- `starfall-three-session-demo.mp4`：1080p 演示短片。
- `starfall-three-session-demo.webm`：WebM 版本。
- `cover.png`：视频封面。
- `screenshots/`：三个关键画面。
- `transcript.md`：版本、真实对话、代码改动和 SQLite 证据。
- `starfall-demo.html`：三联屏画面源文件。
- `build-video.sh`：重新生成图片和视频。

画面压缩了模型等待时间。消息、轮次、代码改动和测试结果来自 2026-07-17 的真实运行。

## 重新生成

需要 Google Chrome 和 FFmpeg：

```bash
FFMPEG_BIN=ffmpeg bash docs/demo/starfall/build-video.sh
```
