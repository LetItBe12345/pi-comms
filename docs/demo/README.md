# 三 Session 视频 Demo

本目录展示三个真实 Pi Session 通过 Pi Comms 群聊并完成 Agent 接力。

## 文件

- `pi-comms-three-session-demo.mp4`：剪辑后的 1080p 演示视频。
- `pi-comms-three-session-demo.webm`：浏览器备用视频。
- `cover.png`：视频封面。
- `transcript.md`：真实对话、环境和 SQLite 验证结果。
- `three-session-demo.html`：三窗格画面源文件。
- `build-video.sh`：重新生成画面并剪辑视频。

视频压缩了模型等待时间。消息内容、成员、轮次和路由结果均来自 2026-07-16 的真实 PTY 验收。

## 重新生成

需要 Google Chrome 和 FFmpeg：

```bash
FFMPEG_BIN=ffmpeg bash docs/demo/build-video.sh
```
