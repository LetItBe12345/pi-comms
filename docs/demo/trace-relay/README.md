# TRACE RELAY：三个私有仓，一条协作链

这是第二套独立 Demo，不覆盖 STARFALL。

三个用户分别拥有 `edge-gateway`、`order-worker`、`notify-service` 私有 Git 仓。每个 Pi Session 只能修改自己的仓，并通过 Pi Comms 传递完整事件契约。一次请求连续触发三轮 Agent 修复，最终恢复端到端 `trace_id`。

## 成品

- `trace-relay-three-private-repos.mp4`：1080p 演示视频。
- `trace-relay-three-private-repos.webm`：浏览器备用视频。
- `cover.png`：封面。
- `screenshots/`：三个关键画面。
- `transcript.md`：真实执行记录与验证结果。
- `trace-relay-demo.html`：画面源文件。
- `build-video.sh`：重新生成截图和视频。

视频压缩了模型等待时间，并以工程看板形式重现真实结果。消息、代码修改、测试结果与三轮路由均来自本地发行版实机执行。

## 重新生成

```bash
FFMPEG_BIN=ffmpeg bash docs/demo/trace-relay/build-video.sh
```
