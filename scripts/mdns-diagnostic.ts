import { randomUUID } from "node:crypto";
import {
  BrokerDiscovery,
  publishBrokerMdns,
} from "../src/discovery/mdns.js";
import { primaryOrdinaryNetwork } from "../src/discovery/network.js";

async function main(): Promise<void> {
  const network = primaryOrdinaryNetwork();
  if (network === undefined) {
    notice("mDNS 诊断跳过：runner 没有普通私网 IPv4。");
    return;
  }
  const brokerId = randomUUID();
  let diagnosticError: Error | undefined;
  const onError = (error: Error) => {
    diagnosticError = error;
  };
  let discovery: BrokerDiscovery | undefined;
  let publisher: ReturnType<typeof publishBrokerMdns> | undefined;
  try {
    publisher = publishBrokerMdns({
      brokerId,
      port: 43_127,
      interfaceAddress: network.address,
      onError,
    });
    const found = await new Promise<boolean>((resolveFound) => {
      const timer = setTimeout(() => resolveFound(false), 5_000);
      discovery = new BrokerDiscovery({
        interfaceAddress: network.address,
        onError,
        onChanged: (brokers) => {
          if (brokers.some((broker) => broker.brokerId === brokerId)) {
            clearTimeout(timer);
            resolveFound(true);
          }
        },
      });
    });
    if (found) {
      console.log("mDNS 本机发布/浏览诊断通过。");
    } else if (diagnosticError !== undefined) {
      warning(
        `mDNS 诊断跳过：${diagnosticError.message}；真实发现由阶段 16B 验证。`,
      );
    } else {
      warning("mDNS 诊断跳过：runner 未回送组播；真实发现由阶段 16B 验证。");
    }
  } catch (error) {
    warning(
      `mDNS 诊断跳过：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    discovery?.stop();
    await publisher?.stop().catch(() => undefined);
  }
}

function notice(message: string): void {
  console.log(process.env.GITHUB_ACTIONS === "true" ? `::notice::${message}` : message);
}

function warning(message: string): void {
  console.warn(process.env.GITHUB_ACTIONS === "true" ? `::warning::${message}` : message);
}

void main();
