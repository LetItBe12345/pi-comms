# CI/CD 规划

## 1. 当前 CI

每次 Pull Request 和 `main` 更新时运行：

```text
npm ci
TypeScript 类型检查
协议和 Broker 自动测试
```

目标：快速发现代码和通信错误。

## 2. Pi Extension 集成测试

阶段 2 完成后增加：

```text
安装指定版本的 Pi
启动 Broker
启动 Pi 并加载 Extension
确认命令注册和 Broker 连接
关闭 Pi 并确认连接清理
```

CI 使用临时 Pi 目录，避免污染真实配置：

```bash
PI_CODING_AGENT_DIR="$RUNNER_TEMP/pi-agent"
```

## 3. 双 Pi 端到端测试

阶段 3 完成后启动：

```text
Pi Session A ─┐
              ├── Local Broker
Pi Session B ─┘
```

验证：

- A 的定向消息只进入 B。
- B 的结果返回 A。
- 最终结果只返回一次。
- Session 关闭后连接被清理。

普通 CI 优先使用模拟模型，保证稳定且不产生 API 费用。

## 4. 真实模型测试

真实 API 测试只在以下情况运行：

- 手动触发。
- 定时运行。
- 正式发布前。

API Key 保存为 GitHub Secret。测试只验证通信闭环，不严格比较模型回答文字。

## 5. TUI 测试

- 组件逻辑使用自动测试。
- 终端交互使用伪终端测试。
- 中文输入法、滚动、Enter 和 Esc 使用人工验收。

## 6. CD 发布

MVP 完成后的发布流程：

```text
CI 通过
→ 生成 npm 包
→ 在干净 Pi 环境中安装验证
→ 创建 GitHub Release
→ 发布 npm
```

用户通过 npm 或 Git 安装：

```bash
pi install npm:pi-comms@版本号
pi install git:github.com/LetItBe12345/pi-comms@v1.0.0
```

## 实施顺序

```text
当前：基础 CI
阶段 2：Pi 加载测试
阶段 3：双 Pi E2E
发布前：真实模型 E2E
MVP 完成：自动打包和发布
```

## 参考

- [Pi Extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi Package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
