import { accessSync, constants } from "node:fs";
import { platform } from "node:os";
import { basename, delimiter, join } from "node:path";

export function resolveNodeExecutable(options: {
  runtimeExecPath?: string;
  searchPath?: string;
  nodePath?: string;
  runtimePlatform?: NodeJS.Platform;
} = {}): string {
  const nodePath = options.nodePath ?? process.env.PI_COMMS_NODE_PATH;
  if (nodePath?.trim()) return nodePath;

  const runtimeExecPath = options.runtimeExecPath ?? process.execPath;
  if (isNodeExecutable(runtimeExecPath)) return runtimeExecPath;

  const runtimePlatform = options.runtimePlatform ?? platform();
  const executableName = runtimePlatform === "win32" ? "node.exe" : "node";
  const searchPath = options.searchPath ?? process.env.PATH ?? "";
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory.replace(/^"|"$/g, ""), executableName);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("未找到 Node.js；请安装 Node.js 22，或设置 PI_COMMS_NODE_PATH");
}

function isNodeExecutable(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "node" || name === "node.exe";
}
