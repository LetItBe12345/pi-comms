# 安装与加载

## 结论

Ubuntu 上，PI Extension 默认放在：

```bash
~/.pi/agent/extensions/
```

你的项目建议使用：

```text
~/.pi/agent/extensions/pi-comms/
├── package.json
├── package-lock.json
├── node_modules/
└── src/
    └── extension/
        └── index.ts
```

PI 启动时会自动加载：

```text
~/.pi/agent/extensions/*.ts
~/.pi/agent/extensions/*/index.ts
```

修改代码后，在 PI 里执行：

```text
/reload
```

即可热重载。([GitHub][1])

## 你的 MVP 最适合这样开发

代码仓库放在正常开发目录：

```text
~/projects/pi-comms/
├── package.json
└── src/extension/index.ts
```

然后创建软链接：

```bash
mkdir -p ~/.pi/agent/extensions

ln -s ~/projects/pi-comms \
  ~/.pi/agent/extensions/pi-comms
```

最终效果：

```text
~/.pi/agent/extensions/pi-comms/package.json
                         ↓
             ~/projects/pi-comms/package.json
```

`package.json` 中的 `pi.extensions` 指向 `src/extension/index.ts`。这样不需要复制代码，Git 仓库和 PI 加载的是同一份文件。

启动任意 PI Session：

```bash
pi
```

输入：

```text
/reload
```

你的 `/comms` 自定义 Slash Command 就会注册。

## 三种加载方式的区别

### 1. 临时测试

```bash
pi -e ~/projects/pi-comms/src/extension/index.ts
```

只对这一次 PI 进程有效。没有真正安装。官方也把 `-e` 定位为快速测试方式。([GitHub][1])

### 2. 全局 Extension

```text
~/.pi/agent/extensions/pi-comms/package.json
```

所有目录、所有 PI Session 都能加载。

**你的通信 Extension 应该使用这个方式。**

因为它需要发现同一设备上的其他 PI Session，而不是只服务某个代码仓库。

### 3. 项目级 Extension

```text
某个项目/.pi/extensions/pi-comms/index.ts
```

只有从该项目启动 PI 时才加载，而且需要先信任项目。([GitHub][1])

这不适合你的最终产品，但可以用于项目内部实验。

## 使用 `pi install` 时放在哪里

以后将 `pi-comms` 做成正式 Pi Package，可以执行：

```bash
pi install git:https://github.com/你的用户名/pi-comms
```

Git 包默认安装到：

```text
~/.pi/agent/git/
```

npm 包默认安装到：

```text
~/.pi/agent/npm/
```

项目级安装使用：

```bash
pi install -l git:https://github.com/你的用户名/pi-comms
```

对应目录是：

```text
项目/.pi/git/
项目/.pi/npm/
```

官方推荐通过 `pi install`、`pi list`、`pi config` 和 `pi update --extensions` 管理正式发布的扩展。([GitHub][2])

## 从旧 Unix Broker 迁移到 TCP

旧版 Broker 是独立后台进程。更新代码后，它可能仍在运行。不要让新旧 Broker 同时访问同一个 SQLite。

先关闭所有 Pi Session，再更新 Extension：

```bash
pi update --extensions
```

进入 Pi 管理的 Git Package 目录并执行一次迁移：

```bash
cd ~/.pi/agent/git/github.com/LetItBe12345/pi-comms
npm run broker:migrate
```

迁移命令会先通过旧协议确认目标确实是 Pi Comms Broker，再停止旧进程并清理 `broker.sock` 和旧锁。校验失败时不会结束进程。

之后重新启动 Pi 并执行：

```text
/comms
```

新版默认连接 `127.0.0.1:43127`，不再使用 Unix Socket。

## PI 主程序本身装在哪里

PI 当前官方发行版通过全局 npm 安装。curl 安装脚本本质上也使用全局 npm。([GitHub][2])

查看命令入口：

```bash
command -v pi
```

查看真实文件：

```bash
readlink -f "$(command -v pi)"
```

查看全局 npm 包目录：

```bash
npm root -g
```

实际包目录通常类似：

```text
/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/
```

使用 nvm 时则类似：

```text
~/.nvm/versions/node/vXX.X.X/lib/node_modules/@earendil-works/pi-coding-agent/
```

**不要把 Extension 放进这个 npm 包目录。** 更新 PI 后它可能被删除。Extension 应始终放在 `~/.pi/agent/extensions/`。

你的 MVP 推荐结构就是：

```text
~/projects/pi-comms/                       # Git 开发仓库
~/.pi/agent/extensions/pi-comms            # 指向仓库的软链接
~/.pi/agent/extensions/pi-comms/package.json
~/projects/pi-comms/src/extension/index.ts # Extension 入口
```

[1]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md "raw.githubusercontent.com"
