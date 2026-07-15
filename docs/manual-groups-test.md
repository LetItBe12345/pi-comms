# 阶段 5：双 Pi 群组手动测试

2026-07-15 已完成一次真实 Pi 本地验收，全部通过。

## 启动

三个终端分别执行：

```bash
npm run broker
pi -e ./src/extension/index.ts
pi -e ./src/extension/index.ts
```

## 测试

Pi A：

```text
/comms-create 开发组 Alice Alice-Pi
```

复制返回的 Group ID。Pi B：

```text
/comms-join <Group ID> Bob Bob-Pi
/comms-members
```

Pi A：

```text
/comms-members
/comms-test @Bob-Pi 只回复 GROUP_OK
```

Pi B 回答后执行：

```text
/comms-leave
```

## 通过条件

- 两边都看到 Alice、Alice-Pi、Bob、Bob-Pi。
- `@Bob-Pi` 只注入 Pi B，回答公开且只出现一次。
- 注入内容包含接收方身份、群名和在线成员，不包含接收方自己。
- Pi B 离群时 Bob 和 Bob-Pi 同时离线。
- 再次 `@Bob-Pi` 时公开显示失败。
