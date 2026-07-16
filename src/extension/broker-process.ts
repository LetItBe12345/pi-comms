import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrateLegacyBroker } from "../broker/legacy-migration.js";
import { DEFAULT_BROKER_ENDPOINT, type TcpConnectEndpoint } from "../transport/tcp-endpoint.js";

export async function startLocalBroker(
  endpoint: TcpConnectEndpoint = DEFAULT_BROKER_ENDPOINT,
): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    npm,
    ["run", "broker", "--", "--host", endpoint.host, "--port", String(endpoint.port)],
    {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  child.unref();
}

async function runMigration(): Promise<void> {
  console.log(await migrateLegacyBroker());
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  void runMigration().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
