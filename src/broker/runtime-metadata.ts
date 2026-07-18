import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type BrokerMode = "local" | "lan-host";

export interface BrokerRuntimeMetadata {
  brokerId: string;
  brokerInstanceId: string;
  pid: number;
  host: string;
  port: number;
  mode: BrokerMode;
  startedAt: number;
}

export function brokerRuntimeMetadataPath(dbPath: string): string {
  return `${dbPath}.broker.json`;
}

export async function readBrokerRuntimeMetadata(
  dbPath: string,
): Promise<BrokerRuntimeMetadata | undefined> {
  try {
    const value = JSON.parse(
      await readFile(brokerRuntimeMetadataPath(dbPath), "utf8"),
    ) as Partial<BrokerRuntimeMetadata>;
    return typeof value.brokerId === "string" &&
        typeof value.brokerInstanceId === "string" &&
        Number.isInteger(value.pid) &&
        typeof value.host === "string" &&
        Number.isInteger(value.port) &&
        (value.mode === "local" || value.mode === "lan-host") &&
        typeof value.startedAt === "number"
      ? value as BrokerRuntimeMetadata
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function writeBrokerRuntimeMetadata(
  dbPath: string,
  metadata: BrokerRuntimeMetadata,
): Promise<void> {
  const path = brokerRuntimeMetadataPath(dbPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function removeBrokerRuntimeMetadata(
  dbPath: string,
  brokerInstanceId: string,
): Promise<void> {
  const current = await readBrokerRuntimeMetadata(dbPath);
  if (current?.brokerInstanceId !== brokerInstanceId) return;
  try {
    await unlink(brokerRuntimeMetadataPath(dbPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
