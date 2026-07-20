import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareLanAcceptance, type LanAcceptanceRole } from "../src/acceptance/lan.js";

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const preparation = await prepareLanAcceptance({
    role: args.role,
    outputDirectory: args.outputDirectory,
    reportPath: args.reportPath,
    packageVersion: packageJson.version,
  });
  console.log(`角色 ${preparation.role} 已准备完成。`);
  console.log(`一次性仓库：${preparation.repositoryPath}`);
  console.log(`验收报告：${preparation.reportPath}`);
  for (const check of preparation.checks) {
    console.log(`[${check.status}] ${check.name}：${check.detail}`);
  }
  console.log("下一步：在 Pi 中打开 /comms，并按报告中的真实设备步骤操作。");
  console.log("验收结束后请先保存报告，再由你手动决定是否删除一次性仓库。");
}

function parseArguments(values: string[]): {
  role: LanAcceptanceRole;
  outputDirectory: string;
  reportPath?: string;
} {
  let role: LanAcceptanceRole | undefined;
  let outputDirectory: string | undefined;
  let reportPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--role") {
      const candidate = values[++index]?.toUpperCase();
      if (candidate === "A" || candidate === "B" || candidate === "C") {
        role = candidate;
      } else {
        throw new Error("--role 必须是 A、B 或 C");
      }
    } else if (value === "--output") {
      outputDirectory = resolve(requiredValue(values[++index], "--output"));
    } else if (value === "--report") {
      reportPath = resolve(requiredValue(values[++index], "--report"));
    } else {
      throw new Error(`未知参数：${value}`);
    }
  }
  if (role === undefined) {
    throw new Error("请使用 --role A、--role B 或 --role C 选择本机角色");
  }
  return {
    role,
    outputDirectory: outputDirectory ?? resolve(`pi-comms-lan-role-${role.toLowerCase()}`),
    reportPath,
  };
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} 缺少参数`);
  }
  return value;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
