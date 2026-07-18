import { describe, expect, it } from "vitest";
import {
  CONNECTION_CONFIG_ENTRY,
  formatInvitation,
  parseInvitation,
  restoreConnectionConfig,
} from "../src/extension/connection-config.js";

describe("协作空间连接配置", () => {
  it("解析和格式化一行式邀请信息", () => {
    const parsed = parseInvitation("192.168.1.23:43127 group-a abcde-fghjk");
    expect(parsed).toEqual({
      endpoint: { host: "192.168.1.23", port: 43_127 },
      groupId: "group-a",
      inviteCode: "ABCDEFGHJK",
    });
    expect(formatInvitation(parsed.endpoint, parsed.groupId, parsed.inviteCode))
      .toBe("192.168.1.23:43127 group-a ABCDE-FGHJK");
  });

  it("按当前 Session 恢复最后一份连接配置", () => {
    const config = restoreConnectionConfig([
      {
        type: "custom",
        customType: CONNECTION_CONFIG_ENTRY,
        data: { mode: "local" },
      },
      {
        type: "custom",
        customType: CONNECTION_CONFIG_ENTRY,
        data: {
          mode: "lan-client",
          endpoint: { host: "192.168.1.8", port: 43_127 },
          groupId: "group-a",
          inviteCode: "ABCDE-FGHJK",
          brokerId: "broker-a",
        },
      },
    ]);
    expect(config).toEqual({
      mode: "lan-client",
      endpoint: { host: "192.168.1.8", port: 43_127 },
      groupId: "group-a",
      inviteCode: "ABCDEFGHJK",
      brokerId: "broker-a",
    });
  });
});
