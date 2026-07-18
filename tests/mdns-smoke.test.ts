import { expect, it } from "vitest";
import {
  BrokerDiscovery,
  publishBrokerMdns,
} from "../src/discovery/mdns.js";
import { primaryOrdinaryNetwork } from "../src/discovery/network.js";

it.skipIf(process.env.PI_COMMS_MDNS_SMOKE !== "1")(
  "本机 mDNS 发布/浏览冒烟（runner 未声明组播支持时跳过）",
  async () => {
    const network = primaryOrdinaryNetwork();
    if (network === undefined) throw new Error("没有可用的普通私网 IPv4");
    const brokerId = "00000000-0000-4000-8000-000000000399";
    const publisher = publishBrokerMdns({
      brokerId,
      port: 43_127,
      interfaceAddress: network.address,
    });
    let discovery: BrokerDiscovery | undefined;
    try {
      const found = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        discovery = new BrokerDiscovery({
          interfaceAddress: network.address,
          onChanged: (brokers) => {
            if (brokers.some((broker) => broker.brokerId === brokerId)) {
              clearTimeout(timer);
              resolve(true);
            }
          },
        });
      });
      expect(found).toBe(true);
    } finally {
      discovery?.stop();
      await publisher.stop();
    }
  },
  10_000,
);
