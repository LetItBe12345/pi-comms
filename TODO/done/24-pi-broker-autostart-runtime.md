# 阶段 24：修复 Pi 内 Broker 自动启动运行时

状态：已完成。2026-09-29 已通过真实 Pi 独立二进制验证。

## 目标

- Pi 使用 Bun 打包的独立二进制时，`/comms` 仍能自动启动 Broker。
- 登录自启配置使用真实 Node.js，不把 Pi 二进制误写为 Node。

## 实施项

- [x] 复现 Pi 把 Broker 参数当成自身 CLI 参数的问题。
- [x] 增加统一 Node.js 可执行文件解析。
- [x] 前台 Broker 启动和登录自启共用同一解析逻辑。
- [x] 增加 Pi 独立二进制场景的回归测试。
- [x] 通过类型检查、单元测试和 Broker 进程测试。
- [x] 使用本机真实 Pi 独立二进制验证 `/comms` 启动路径。

## 验收结果

- Pi 进程中的 `process.execPath` 为 Pi 自身时，不再执行 `pi --import ...`。
- 自动启动的 Broker 能监听目标端口并完成协议探测。
- systemd 和 LaunchAgent 配置写入真实 Node.js 路径。
