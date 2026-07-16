# 发布

本项目作为 Pi Package 发布。Pi Package 的发布源是 GitHub 和 npm，不单独上传到 Pi 服务器。Pi Package Gallery 只是展示和发现入口：

```text
https://pi.dev/packages
```

带 `pi-package` 关键词的包可被 Gallery 收录。

## 发布路线

### 第一阶段：GitHub 发布

适合当前 MVP。

用户安装：

```bash
pi install https://github.com/LetItBe12345/pi-comms
```

固定版本：

```bash
pi install git:github.com/LetItBe12345/pi-comms@v0.1.0
```

Pi 会克隆仓库，并自动执行 `npm install`。

普通 PR、合并和推送只运行 CI，不创建 Release。发布必须从 GitHub Actions 手动触发，并输入确认词 `RELEASE`：

```bash
gh workflow run release.yml \
  --ref main \
  -f version=0.1.0 \
  -f confirm=RELEASE
```

工作流会检查版本、运行测试和生产安装验证，然后创建 `v0.1.0` Tag 与同名 GitHub Release。已有版本不会覆盖。

### 第二阶段：npm 发布

项目稳定后再做。

用户安装：

```bash
pi install npm:pi-comms
```

固定版本：

```bash
pi install npm:pi-comms@0.1.0
```

更新：

```bash
pi update npm:pi-comms
```

Pi 官方同时支持 npm、Git 和本地路径。

## package.json 发布要求

发布前 `package.json` 至少需要：

```json
{
  "name": "pi-comms",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

规则：

- Pi 自带的核心包放进 `peerDependencies`，不要重复打包。
- 普通运行依赖放进 `dependencies`。
- `keywords` 必须包含 `pi-package`，才能被 Package Gallery 收录。

## 当前判断

MVP 阶段采用：

```text
GitHub 仓库 + Git Tag 版本 + pi install GitHub URL
```

不发布 npm。用户通过以下命令安装：

```bash
pi install https://github.com/LetItBe12345/pi-comms
```

等 MVP 稳定，再发布 npm，并进入 Pi Package Gallery。
