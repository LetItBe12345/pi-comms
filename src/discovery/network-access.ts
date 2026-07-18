import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OrdinaryNetwork } from "./network.js";

interface StoredNetworkAccess {
  confirmed: Array<{
    networkKey: string;
    confirmedAt: number;
  }>;
}

export class NetworkAccessStore {
  readonly #path: string;

  constructor(dbPath: string) {
    this.#path = `${dbPath}.networks.json`;
  }

  async isConfirmed(network: OrdinaryNetwork): Promise<boolean> {
    const data = await this.#read();
    return data.confirmed.some((item) => item.networkKey === network.networkKey);
  }

  async confirm(network: OrdinaryNetwork): Promise<void> {
    const data = await this.#read();
    const confirmed = data.confirmed
      .filter((item) => item.networkKey !== network.networkKey);
    confirmed.unshift({
      networkKey: network.networkKey,
      confirmedAt: Date.now(),
    });
    await this.#write({ confirmed: confirmed.slice(0, 8) });
  }

  async confirmedKeys(): Promise<string[]> {
    return (await this.#read()).confirmed.map((item) => item.networkKey);
  }

  async #read(): Promise<StoredNetworkAccess> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as
        Partial<StoredNetworkAccess>;
      return {
        confirmed: Array.isArray(parsed.confirmed)
          ? parsed.confirmed.filter((item) =>
              typeof item?.networkKey === "string" &&
              typeof item.confirmedAt === "number"
            )
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { confirmed: [] };
      }
      throw error;
    }
  }

  async #write(value: StoredNetworkAccess): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }
}
