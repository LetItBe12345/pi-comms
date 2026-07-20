import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, platform, release, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSocket } from "node:dgram";
import { promisify } from "node:util";
import { primaryOrdinaryNetwork } from "../discovery/network.js";

const execFileAsync = promisify(execFile);
export const PI_ACCEPTANCE_BASELINE = "0.80.10";

export type LanAcceptanceRole = "A" | "B" | "C";
export type CheckStatus = "pass" | "warning" | "manual";

export interface AcceptanceCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface AcceptanceEnvironment {
  operatingSystem: string;
  architecture: string;
  nodeVersion: string;
  piVersion: string;
  piCommsVersion: string;
  commitSha: string;
}

export interface LanAcceptancePreparation {
  role: LanAcceptanceRole;
  repositoryPath: string;
  reportPath: string;
  environment: AcceptanceEnvironment;
  checks: AcceptanceCheck[];
}

export async function prepareLanAcceptance(options: {
  role: LanAcceptanceRole;
  outputDirectory: string;
  reportPath?: string;
  packageVersion: string;
  commitSha?: string;
  piVersion?: string;
}): Promise<LanAcceptancePreparation> {
  const repositoryPath = resolve(options.outputDirectory);
  const reportPath = resolve(
    options.reportPath ?? join(repositoryPath, "lan-acceptance-report.md"),
  );
  const environment: AcceptanceEnvironment = {
    operatingSystem: `${platform()} ${release()}`,
    architecture: arch(),
    nodeVersion: process.version,
    piVersion: options.piVersion ?? await commandVersion("pi"),
    piCommsVersion: options.packageVersion,
    commitSha: options.commitSha ?? await gitCommit(),
  };
  const checks = [
    ...await runPreflightChecks(),
    {
      name: "Pi 正式版",
      status: environment.piVersion === PI_ACCEPTANCE_BASELINE
        ? "pass" as const
        : "warning" as const,
      detail: environment.piVersion === PI_ACCEPTANCE_BASELINE
        ? `已固定为 ${PI_ACCEPTANCE_BASELINE}。`
        : `当前是 ${environment.piVersion}，阶段 16B 基线是 ${PI_ACCEPTANCE_BASELINE}。`,
    },
    {
      name: "Pi Comms 版本",
      status: environment.commitSha === "未知" ? "warning" as const : "pass" as const,
      detail: environment.commitSha === "未知"
        ? "无法读取 commit SHA，请使用固定 Git commit 安装。"
        : "已记录当前 commit SHA；三台设备必须完全一致。",
    },
  ];
  await createRoleRepository(repositoryPath, options.role);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    renderAcceptanceReport({
      role: options.role,
      repositoryPath,
      reportPath,
      environment,
      checks,
    }),
    "utf8",
  );
  return {
    role: options.role,
    repositoryPath,
    reportPath,
    environment,
    checks,
  };
}

export async function runPreflightChecks(): Promise<AcceptanceCheck[]> {
  const ordinaryNetwork = primaryOrdinaryNetwork();
  const vpnActive = Object.keys(networkInterfaces()).some(isVpnInterfaceName);
  return [
    ordinaryNetwork === undefined
      ? {
        name: "普通网络",
        status: "warning",
        detail: "没有检测到普通私网 IPv4，请连接普通 Wi-Fi 或有线网络。",
      }
      : {
        name: "普通网络",
        status: "pass",
        detail: "已检测到普通私网 IPv4（报告不会保存具体地址）。",
      },
    await checkTcpListen(ordinaryNetwork?.address),
    await checkMdnsPort(ordinaryNetwork?.address),
    {
      name: "VPN",
      status: vpnActive ? "warning" : "pass",
      detail: vpnActive
        ? "检测到 VPN 接口；请确认 VPN 允许访问本地网络。"
        : "未检测到活动 VPN 接口。",
    },
    {
      name: "跨设备发现",
      status: "manual",
      detail: "必须在阶段 16B 由另一台真实设备确认，单机检查不能代替。",
    },
  ];
}

export async function createRoleRepository(
  directory: string,
  role: LanAcceptanceRole,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const files = roleFiles(role);
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

export function renderAcceptanceReport(
  preparation: LanAcceptancePreparation,
): string {
  const checks = preparation.checks.map((check) =>
    `- [${check.status === "pass" ? "x" : " "}] ${check.name}：${check.detail}`
  ).join("\n");
  return `# Pi Comms 局域网验收报告

> 本报告由验收工具生成。环境预检通过不代表三台真实设备验收通过。

## 环境

- 角色：${preparation.role}
- 系统：${preparation.environment.operatingSystem}
- 架构：${preparation.environment.architecture}
- Node.js：${preparation.environment.nodeVersion}
- Pi：${preparation.environment.piVersion}
- Pi Comms：${preparation.environment.piCommsVersion}
- 运行代码：${preparation.environment.commitSha}

## 环境预检

${checks}

## 真实设备步骤

- [ ] 三台设备使用同一个 Pi Comms commit SHA。
- [ ] A 创建允许附近加入的群组。
- [ ] B、C 在 10 秒内看到附近群组。
- [ ] B、C 无需邀请码直接加入默认开放群组。
- [ ] 另建启用邀请码的群组，B 使用正确邀请码加入。
- [ ] 完成人对人、人对 Agent、Agent 对人、Agent 对 Agent 通信。
- [ ] 完成断网恢复、VPN 开关和普通网络切换。
- [ ] 完成后台保持、登录后自启和发行版升级。

## 执行记录

| 步骤 | 首次结果 | 耗时 | 重试原因 | 错误 |
| --- | --- | --- | --- | --- |
| 附近发现 | 待执行 |  |  |  |
| 默认开放群组直接加入 | 待执行 |  |  |  |
| 受限群组输入邀请码加入 | 待执行 |  |  |  |
| 四种通信方向 | 待执行 |  |  |  |
| 断网和 VPN 恢复 | 待执行 |  |  |  |
| 后台、自启和升级 | 待执行 |  |  |  |

## 结果

- [ ] 通过
- [ ] 失败（请记录首次失败和重试原因）
`;
}

function roleFiles(role: LanAcceptanceRole): Record<string, string> {
  const sharedPackage = JSON.stringify({
    name: `pi-comms-lan-role-${role.toLowerCase()}`,
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2) + "\n";
  if (role === "A") {
    return {
      "package.json": sharedPackage,
      "README.md": "# A：协议负责人\n\n请让 A-Pi 把 `contract.md` 中的接口要求交给 B-Pi。\n",
      "contract.md": "# Health API\n\n`GET /health` 返回 `{ \"status\": \"ok\", \"service\": \"pi-comms\" }`。\n",
    };
  }
  if (role === "B") {
    return {
      "package.json": sharedPackage,
      "README.md": "# B：服务端负责人\n\n请让 B-Pi 根据 A-Pi 传来的协议完成实现，再转交 C-Pi。\n",
      "health.js": "export function health() {\n  return { status: \"TODO\", service: \"pi-comms\" };\n}\n",
      "health.test.js": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { health } from \"./health.js\";\n\ntest(\"health contract\", () => {\n  assert.deepEqual(health(), { status: \"ok\", service: \"pi-comms\" });\n});\n",
    };
  }
  return {
    "package.json": sharedPackage,
    "README.md": "# C：客户端验收负责人\n\n请让 C-Pi 根据 B-Pi 公开的结果完成解析器并运行测试。\n",
    "client.js": "export function isHealthy(payload) {\n  return false;\n}\n",
    "client.test.js": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { isHealthy } from \"./client.js\";\n\ntest(\"accept health response\", () => {\n  assert.equal(isHealthy({ status: \"ok\", service: \"pi-comms\" }), true);\n});\n",
  };
}

async function commandVersion(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: 5_000,
    });
    return stdout.trim().split(/\r?\n/).at(-1) || "未知";
  } catch {
    return "未安装";
  }
}

async function gitCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return "未知";
  }
}

async function checkTcpListen(address?: string): Promise<AcceptanceCheck> {
  if (address === undefined) {
    return {
      name: "TCP 监听",
      status: "warning",
      detail: "没有普通私网 IPv4，无法检查附近连接。",
    };
  }
  return new Promise((resolveCheck) => {
    const server = createServer();
    server.once("error", () => resolveCheck({
      name: "TCP 监听",
      status: "warning",
      detail: "无法在普通网络监听 TCP，请检查防火墙或网络权限。",
    }));
    server.listen({ host: address, port: 0 }, () => {
      server.close(() => resolveCheck({
        name: "TCP 监听",
        status: "pass",
        detail: "普通网络 TCP 监听可用。",
      }));
    });
  });
}

async function checkMdnsPort(address?: string): Promise<AcceptanceCheck> {
  if (address === undefined) {
    return {
      name: "附近发现",
      status: "warning",
      detail: "没有普通私网 IPv4，无法检查附近发现端口。",
    };
  }
  return new Promise((resolveCheck) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const finish = (status: CheckStatus, detail: string) => {
      try {
        socket.close();
      } catch {}
      resolveCheck({ name: "附近发现", status, detail });
    };
    socket.once("error", () => finish(
      "warning",
      "无法使用附近发现端口，请检查防火墙、VPN 或网络权限。",
    ));
    socket.bind({ address, port: 5_353 }, () => finish(
      "pass",
      "附近发现端口可用；跨设备发现仍需阶段 16B 确认。",
    ));
  });
}

function isVpnInterfaceName(name: string): boolean {
  return /^(utun|tun|tap|wg|tailscale|zt|ppp)/i.test(name);
}
