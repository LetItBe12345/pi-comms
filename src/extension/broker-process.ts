import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { migrateLegacyBroker } from "../broker/legacy-migration.js";
import type { BrokerMode } from "../broker/runtime-metadata.js";
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_SERVICE,
  createEnvelope,
  encodeEnvelope,
  JsonlDecoder,
  type BrokerEnvelope,
} from "../protocol.js";
import { probeBroker } from "../transport/broker-probe.js";
import {
  DEFAULT_BROKER_ENDPOINT,
  formatEndpoint,
  type TcpConnectEndpoint,
} from "../transport/tcp-endpoint.js";

export async function startLocalBroker(
  endpoint: TcpConnectEndpoint = DEFAULT_BROKER_ENDPOINT,
  dbPath?: string,
): Promise<void> {
  await startBroker({ mode: "local", endpoint, dbPath });
}

export async function startLanHostBroker(
  endpoint: TcpConnectEndpoint = DEFAULT_BROKER_ENDPOINT,
  dbPath?: string,
): Promise<void> {
  await startBroker({ mode: "lan-host", endpoint, dbPath });
}

export async function startBroker(options: {
  mode: BrokerMode;
  endpoint?: TcpConnectEndpoint;
  dbPath?: string;
}): Promise<void> {
  const endpoint = options.endpoint ?? DEFAULT_BROKER_ENDPOINT;
  const existing = await probeBroker(endpoint);
  if (existing.status === "compatible") {
    if (options.mode === "local" || existing.brokerMode === "lan-host") return;
    await stopBroker(endpoint);
  } else if (existing.status === "incompatible") {
    throw new Error(
      `端口上的服务不是兼容的 Pi Comms Broker：${formatEndpoint(endpoint)}`,
    );
  }

  const launcherPath = fileURLToPath(new URL("../broker/launcher.ts", import.meta.url));
  const args = [
    "--import",
    import.meta.resolve("tsx"),
    launcherPath,
    "--mode",
    options.mode,
    "--port",
    String(endpoint.port),
    ...(options.dbPath === undefined ? [] : ["--db", options.dbPath]),
  ];
  const child = spawn(
    process.execPath,
    args,
    {
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

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await probeBroker(endpoint);
    if (
      result.status === "compatible" &&
      (options.mode === "local" || result.brokerMode === "lan-host")
    ) return;
    if (result.status === "incompatible") {
      throw new Error(
        `端口上的服务不是兼容的 Pi Comms Broker：${formatEndpoint(endpoint)}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`启动协作空间超时：${formatEndpoint(endpoint)}`);
}

export async function stopBroker(
  endpoint: TcpConnectEndpoint = DEFAULT_BROKER_ENDPOINT,
): Promise<void> {
  await new Promise<void>((resolveStop, rejectStop) => {
    const socket = createConnection(endpoint);
    const decoder = new JsonlDecoder();
    const probe = createEnvelope("broker.probe", {
      service: BROKER_SERVICE,
      protocolVersion: BROKER_PROTOCOL_VERSION,
    });
    const shutdown = createEnvelope("broker.shutdown", {});
    let requested = false;
    const timer = setTimeout(() => {
      socket.destroy();
      rejectStop(new Error("停止协作空间超时"));
    }, 3_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      error === undefined ? resolveStop() : rejectStop(error);
    };
    socket.once("connect", () => socket.write(encodeEnvelope(probe)));
    socket.on("data", (chunk) => {
      for (const decoded of decoder.push(chunk)) {
        if (!decoded.ok) return finish(new Error(decoded.error));
        const message = decoded.value as BrokerEnvelope;
        if (message.type === "error") return finish(new Error(message.payload.message));
        if (
          message.type === "broker.ready" &&
          message.payload.requestId === probe.id &&
          !requested
        ) {
          requested = true;
          socket.write(encodeEnvelope(shutdown));
        }
        if (
          message.type === "broker.stopping" &&
          message.payload.requestId === shutdown.id
        ) {
          finish();
        }
      }
    });
    socket.once("error", (error) => finish(error));
  });

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await probeBroker(endpoint)).status === "unreachable") return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("协作空间未能完全停止");
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
