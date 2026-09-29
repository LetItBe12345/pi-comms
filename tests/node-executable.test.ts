import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNodeExecutable } from "../src/node-executable.js";

describe("Node.js 运行时解析", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("真实 Node 进程直接复用 process.execPath", () => {
    expect(resolveNodeExecutable({
      runtimeExecPath: "/usr/bin/node",
      searchPath: "",
      runtimePlatform: "linux",
    })).toBe("/usr/bin/node");
  });

  it("Pi 独立二进制不会被当成 Node，而是从 PATH 查找 Node", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-node-"));
    const nodePath = join(directory, "node");
    await writeFile(nodePath, "#!/bin/sh\n", "utf8");
    await chmod(nodePath, 0o755);

    expect(resolveNodeExecutable({
      runtimeExecPath: "/opt/pi/pi",
      searchPath: directory,
      runtimePlatform: "linux",
    })).toBe(nodePath);
  });

  it("允许显式指定 Node 路径", () => {
    expect(resolveNodeExecutable({
      runtimeExecPath: "/opt/pi/pi",
      searchPath: "",
      nodePath: "/opt/node-22/bin/node",
      runtimePlatform: "linux",
    })).toBe("/opt/node-22/bin/node");
  });
});
