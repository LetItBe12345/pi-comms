import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { BrokerConfigStatusPayload, ProactiveStatus } from "../protocol.js";

type ConfigRequest = "broker.config.update" | "broker.config.validate" | "broker.config.delete";

export async function showBrokerSettings(options: {
  ui: ExtensionUIContext;
  status: ProactiveStatus;
  maskedApiKey?: string;
  request: (type: ConfigRequest, payload: unknown) => Promise<BrokerConfigStatusPayload | undefined>;
}): Promise<void> {
  const { ui, request } = options;
  if (options.status === "config_error") {
    if (await ui.confirm("Broker 配置文件损坏", "重建前会保留一份带时间戳的备份。")) {
      await request("broker.config.delete", { rebuild: true });
    }
    return;
  }
  const choices = ["配置或更换 API Key", "查看配置说明"];
  if (options.maskedApiKey !== undefined) choices.push("重新验证 API Key", "删除 API Key");
  let action: string | undefined;
  do {
    action = await ui.select(
      `Broker 设置 · DeepSeek V4.1 Flash (deepseek-flash)\n状态：${statusLabel(options.status)}${
        options.maskedApiKey === undefined ? "" : ` · ${options.maskedApiKey}`
      }`,
      choices,
    );
    if (action === "查看配置说明") {
      await ui.confirm(
        "路由模型配置说明",
        "1. 打开 https://platform.deepseek.com/api_keys，创建 Key 并确认账户有额度。\n" +
        "2. 在 Broker 所在电脑输入 Key，验证后保存到 ~/.pi/comms/config.json。\n" +
        "3. 进入群聊，在 Ctrl+P 中检查「主动参与」是否开启。\n\n" +
        "官方 API：https://api.deepseek.com；模型：deepseek-flash。\n" +
        "用于群聊路由、新消息判断和摘要，与 Pi /login、/model 配置分开。\n" +
        "附近加入的用户应请群聊主机配置。",
      );
    }
  } while (action === "查看配置说明");
  if (action === undefined) return;
  if (action === "删除 API Key") {
    if (await ui.confirm("删除 DeepSeek API Key？", "主动参与将停止，普通群聊不受影响。")) {
      await request("broker.config.delete", {});
    }
    return;
  }
  let type: ConfigRequest = "broker.config.validate";
  let payload: unknown = {};
  if (action === "配置或更换 API Key") {
    if (!await ui.confirm(
      "第 1 步：准备 DeepSeek API Key",
      "打开 https://platform.deepseek.com/api_keys，创建 Key 并确认账户有额度。\n" +
      "Broker 使用 DeepSeek V4.1 Flash（deepseek-flash），不使用 Pi Session 的 Key。\n" +
      "已准备好 Key，继续输入？",
    )) return;
    const apiKey = await ui.input("第 2 步：输入 DeepSeek API Key", "sk-...");
    if (apiKey === undefined || !apiKey.trim()) return;
    if (!await ui.confirm(
      "第 3 步：验证并保存",
      "将向 DeepSeek 官方 API 发送一次小请求验证 Key，可能产生少量费用。\n" +
      "验证成功后保存到这台电脑的 ~/.pi/comms/config.json。继续？",
    )) return;
    type = "broker.config.update";
    payload = { apiKey: apiKey.trim() };
  }
  ui.notify("正在验证 DeepSeek API Key…", "info");
  const status = await request(type, payload);
  if (status === undefined) {
    ui.notify("未收到 Broker 响应。请检查连接，再打开 Broker 设置。", "warning");
  } else if (status.proactiveStatus === "ready" &&
    (status.message === "验证成功" || status.message === "DeepSeek API Key 已验证并保存")) {
    ui.notify("DeepSeek V4.1 Flash 已就绪。进入群聊，在 Ctrl+P 中检查「主动参与」开关。", "info");
  } else if (status.proactiveStatus === "unverified") {
    ui.notify("Key 已保存但未验证，主动参与尚不可用。网络恢复后选择「重新验证 API Key」。", "warning");
  }
}

function statusLabel(status: ProactiveStatus): string {
  const labels: Record<ProactiveStatus, string> = {
    ready: "已就绪",
    unconfigured: "未配置",
    unverified: "Key 尚未验证",
    invalid_key: "Key 已失效",
    config_error: "配置文件无法读取",
    temporarily_unavailable: "暂时不可用",
  };
  return labels[status];
}
