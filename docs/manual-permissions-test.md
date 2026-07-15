# 权限系统验收

日期：2026-07-15

- 三种权限可以通过 `Ctrl+P` 切换。
- “需要批准”时，请求先显示“等待目标批准”，未注入 Agent。
- 批准后显示“排队处理中”，真实 Pi 返回 `PERMISSION_OK`。
- 自动测试覆盖拒绝、禁止、失效、重连和重复操作。
- `npm run check`：51 项测试通过。

## 截图

- [权限菜单](./screenshots/permission-menu.png)
- [审批界面](./screenshots/pending-approval.png)
