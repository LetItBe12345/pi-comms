import { describe, expect, it } from "vitest";
import {
  renderLaunchAgent,
  renderSystemdUserService,
} from "../src/broker/autostart.js";

describe("用户级登录自启配置", () => {
  it("生成 Ubuntu systemd 用户服务", () => {
    const service = renderSystemdUserService(
      "/usr/bin/node",
      "/opt/pi comms/launcher.ts",
      "/home/me/.pi/comms.db",
    );
    expect(service).toContain('ExecStart="/usr/bin/node" --import "tsx" "/opt/pi comms/launcher.ts"');
    expect(service).toContain("Restart=always");
    expect(service).toContain("WantedBy=default.target");
  });

  it("生成 macOS LaunchAgent 并转义路径", () => {
    const plist = renderLaunchAgent(
      "/usr/local/bin/node",
      "/Users/me/Pi & Comms/launcher.ts",
      "/Users/me/.pi/comms.db",
    );
    expect(plist).toContain("<string>io.pi-comms.broker</string>");
    expect(plist).toContain("/Users/me/Pi &amp; Comms/launcher.ts");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(renderLaunchAgent(
      "/usr/local/bin/node",
      "/Users/me/Pi & Comms/launcher.ts",
      "/Users/me/.pi/comms.db",
      "tsx",
      false,
    )).toContain("<false/>");
  });
});
