import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRoleRepository,
  prepareLanAcceptance,
  renderAcceptanceReport,
} from "../src/acceptance/lan.js";

describe("局域网引导式验收工具", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("为三个角色生成彼此独立且可自动判断的代码仓库", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-accept-tool-"));
    await Promise.all(["A", "B", "C"].map((role) =>
      createRoleRepository(join(directory!, role), role as "A" | "B" | "C")
    ));
    expect(await readFile(join(directory, "A", "contract.md"), "utf8"))
      .toContain("GET /health");
    expect(await readFile(join(directory, "B", "health.test.js"), "utf8"))
      .toContain("health contract");
    expect(await readFile(join(directory, "C", "client.test.js"), "utf8"))
      .toContain("accept health response");
  });

  it("生成脱敏报告并明确真实设备尚未验收", () => {
    const report = renderAcceptanceReport({
      role: "B",
      repositoryPath: "/private/path",
      reportPath: "/private/path/report.md",
      environment: {
        operatingSystem: "linux test",
        architecture: "x64",
        nodeVersion: "v22.0.0",
        piVersion: "0.80.10",
        piCommsVersion: "0.1.0",
        commitSha: "abc123",
      },
      checks: [{
        name: "普通网络",
        status: "pass",
        detail: "已检测到普通私网 IPv4（报告不会保存具体地址）。",
      }],
    });
    expect(report).toContain("环境预检通过不代表三台真实设备验收通过");
    expect(report).toContain("Pi：0.80.10");
    expect(report).not.toContain("/private/path");
  });

  it("准备角色仓库和 Markdown 报告", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-accept-tool-"));
    const result = await prepareLanAcceptance({
      role: "A",
      outputDirectory: directory,
      packageVersion: "0.1.0",
      piVersion: "0.80.10",
      commitSha: "candidate-sha",
    });
    expect(result.reportPath).toBe(join(directory, "lan-acceptance-report.md"));
    expect(await readFile(result.reportPath, "utf8")).toContain("candidate-sha");
  });
});
