import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatEndpoint, validateListenEndpoint } from "../transport/tcp-endpoint.js";
import { probeBroker } from "../transport/broker-probe.js";
import {
  createBrokerServer,
  DEFAULT_DATABASE_PATH,
  type BrokerServer,
} from "./server.js";
import { BrokerLockBusyError } from "./process-lock.js";
import type { BrokerMode } from "./runtime-metadata.js";

interface LauncherOptions {
  mode: BrokerMode;
  port: number;
  dbPath: string;
}

export async function runBrokerLauncher(
  args: string[] = process.argv.slice(2),
): Promise<BrokerServer | undefined> {
  const options = parseLauncherArgs(args);
  const listen = validateListenEndpoint({
    host: options.mode === "lan-host" ? "0.0.0.0" : "127.0.0.1",
    port: options.port,
  });
  const broker = createBrokerServer({
    listen,
    dbPath: options.dbPath,
    mode: options.mode,
  });
  try {
    await broker.start();
  } catch (error) {
    if (listen.port === 0) throw error;
    const target = { host: "127.0.0.1", port: listen.port };
    const result = await waitForBroker(target, 8_000);
    if (result === "compatible") {
      console.log(`复用现有 Pi Comms Broker：${formatEndpoint(target)}`);
      return undefined;
    }
    if (result === "incompatible") {
      throw new Error(`端口上的服务不是兼容的 Pi Comms Broker：${formatEndpoint(target)}`);
    }
    if (error instanceof BrokerLockBusyError) {
      throw new Error(`等待现有 Broker 就绪超时：${formatEndpoint(target)}`);
    }
    throw error;
  }
  console.log(`Pi Comms Broker 正在监听 ${formatEndpoint(broker.endpoint)}`);
  const shutdown = () => void broker.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return broker;
}

function parseLauncherArgs(args: string[]): LauncherOptions {
  let mode: BrokerMode = "local";
  let port = 43_127;
  let dbPath = DEFAULT_DATABASE_PATH;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`缺少参数值：${name}`);
    if (name === "--mode" && (value === "local" || value === "lan-host")) mode = value;
    else if (name === "--port") port = Number(value);
    else if (name === "--db") dbPath = resolve(value);
    else throw new Error(`未知参数：${name}`);
  }
  return { mode, port, dbPath };
}

async function waitForBroker(
  endpoint: { host: string; port: number },
  timeoutMs: number,
): Promise<"compatible" | "incompatible" | "unreachable"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probeBroker(endpoint);
    if (result.status === "compatible") return "compatible";
    if (result.status === "incompatible") return "incompatible";
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return "unreachable";
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  void runBrokerLauncher().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
