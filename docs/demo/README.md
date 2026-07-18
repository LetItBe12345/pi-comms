# 三 Session 视频 Demo

## 最新：《银盾接力》银行隐私协作

全中文银行业务 Demo 已放在 [`privacy-shield/`](./privacy-shield/README.md)：银行隐私 Agent 先生成零 PII 的最小复现契约，外包 Agent 只修自己的规则引擎，补丁最后回到银行私有环境验收。包含 MP4、WebM、封面和四张关键截图。

## TRACE RELAY 分布式代码协作

新的代码场景 Demo 已放在 [`trace-relay/`](./trace-relay/README.md)：三个用户、三个隔离的私有 Git 仓和三个 Pi Session，通过事件契约自动接力修复同一条分布式链路。包含 MP4、WebM、封面和三张关键截图。

## STARFALL 星坠救援

发行版实机剧情 Demo 已放在 [`starfall/`](./starfall/README.md)：三个独立 Pi Session 自动接力诊断、修改代码并验收，包含 MP4、WebM、封面和三张关键截图。

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
