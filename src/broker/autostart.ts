import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "pi-comms";
const LAUNCH_AGENT_ID = "io.pi-comms.broker";

export async function configureBrokerAutostart(
  enabled: boolean,
  dbPath: string,
): Promise<void> {
  if (platform() === "linux") {
    await configureSystemd(enabled, dbPath);
    return;
  }
  if (platform() === "darwin") {
    await configureLaunchAgent(enabled, dbPath);
  }
}

export function renderSystemdUserService(
  nodePath: string,
  launcherPath: string,
  dbPath: string,
  tsxImport = "tsx",
): string {
  return [
    "[Unit]",
    "Description=Pi Comms nearby groups",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdQuote(nodePath)} --import ${systemdQuote(tsxImport)} ${systemdQuote(launcherPath)} --mode lan-host --port 43127 --db ${systemdQuote(dbPath)}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderLaunchAgent(
  nodePath: string,
  launcherPath: string,
  dbPath: string,
  tsxImport = "tsx",
): string {
  const args = [
    nodePath,
    "--import",
    tsxImport,
    launcherPath,
    "--mode",
    "lan-host",
    "--port",
    "43127",
    "--db",
    dbPath,
  ].map((value) => `      <string>${escapeXml(value)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCH_AGENT_ID}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function configureSystemd(enabled: boolean, dbPath: string): Promise<void> {
  const path = join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  if (enabled) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      renderSystemdUserService(
        process.execPath,
        launcherPath(),
        dbPath,
        import.meta.resolve("tsx"),
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
    return;
  }
  await execFileAsync("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`])
    .catch(() => undefined);
  await rm(path, { force: true });
  await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
}

async function configureLaunchAgent(enabled: boolean, dbPath: string): Promise<void> {
  const path = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_ID}.plist`);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  if (enabled) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      renderLaunchAgent(
        process.execPath,
        launcherPath(),
        dbPath,
        import.meta.resolve("tsx"),
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    await execFileAsync("launchctl", ["bootout", domain, path]).catch(() => undefined);
    await execFileAsync("launchctl", ["bootstrap", domain, path]);
    return;
  }
  await execFileAsync("launchctl", ["bootout", domain, path]).catch(() => undefined);
  await rm(path, { force: true });
}

function launcherPath(): string {
  return fileURLToPath(new URL("./launcher.ts", import.meta.url));
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
