# Release Fleet Workflow Demo

四个 PI Session 始终在同一页面：一个主开发 Session，以及分别运行在 Windows、Linux、macOS 私有用户设备上的三个测试 Session。

故事从本地开发和 PR 开始，经 GitHub Actions 构建正式 Release，再由主 Session 分发到三个用户设备执行 Browser Use、Computer Use 和端到端验证。macOS 首轮失败后，证据返回主 Session，触发修复 PR 与第二次正式发布，最终三平台全部通过。

## 成品

- `release-fleet-workflow-demo.mp4`：1080p MP4 成片。
- `release-fleet-demo.html`：同页四 Session 画面源文件。
- `cover.png`：封面。
- `screenshots/`：四张关键画面。
- `build-video.sh`：重新生成截图和视频。

## 重新生成

需要 Google Chrome 与 FFmpeg：

```bash
bash docs/demo/release-fleet/build-video.sh
```
