# 开发流程

## 依赖管理

- 使用 Node.js 22 和 npm。
- 依赖记录在 `package.json`。
- 提交 `package-lock.json`。
- 本地使用 `npm install`，CI 使用 `npm ci`。
- 按 TODO 阶段添加依赖，不提前安装。

## 版本管理

- 使用 Git，主分支为 `main`。
- 每个任务创建短期分支，如 `task/01-node-broker`。
- 一个提交只处理一件事。
- Pull Request 通过 CI 后合并。
- 功能和验收全部完成后，才把 TODO 移到 `done`。
- MVP 阶段使用 `0.x` 版本，发布标签格式为 `v0.1.0`。

## CI

使用 GitHub Actions，在 Pull Request 和 `main` 更新时执行：

```text
npm ci
npm run typecheck
npm test
npm run build
```

协议、Broker、路由和数据库使用自动测试。Pi Session、TUI 和中文输入使用人工验收。

## CD

本项目不部署服务器。发布流程为：

```text
CI 通过 → 人工验收 → 创建版本标签 → 创建 GitHub Release
```

MVP 阶段手动发布。安装方式稳定后，再自动生成和发布 npm 包。

## 日常流程

```text
选择 TODO → 创建分支 → 实现和测试 → 提交 PR → CI → 人工验收 → 合并 → 更新 TODO
```
