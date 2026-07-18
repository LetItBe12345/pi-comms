import { describe, expect, it, vi } from "vitest";
import {
  FakeBrokerDiscovery,
  type DiscoveredBroker,
} from "../src/discovery/mdns.js";
import {
  collectNearbyCatalog,
  collectNearbyGroups,
} from "../src/discovery/group-catalog.js";

function broker(overrides: Partial<DiscoveredBroker> = {}): DiscoveredBroker {
  return {
    brokerId: "broker-a",
    host: "host.local",
    addresses: ["10.0.0.5"],
    port: 43_127,
    protocolVersion: 4,
    appVersion: "0.1.0",
    ...overrides,
  };
}

describe("附近发现", () => {
  it("假发现器按 brokerId 更新、去重和下线", () => {
    const onChanged = vi.fn();
    const discovery = new FakeBrokerDiscovery(onChanged);
    discovery.setBrokers([
      broker(),
      broker({ addresses: ["10.0.0.9"] }),
      broker({ brokerId: "broker-b" }),
    ]);
    expect(discovery.brokers).toHaveLength(2);
    expect(discovery.brokers.find((item) => item.brokerId === "broker-a")?.addresses)
      .toEqual(["10.0.0.9"]);
    discovery.remove("broker-a");
    expect(discovery.brokers.map((item) => item.brokerId)).toEqual(["broker-b"]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("假发现器按 TTL 清理过期设备", () => {
    const discovery = new FakeBrokerDiscovery();
    discovery.setBrokers([broker()]);
    discovery.expireOlderThan(1, Date.now() + 2);
    expect(discovery.brokers).toEqual([]);
  });

  it("合并多台设备的同名群组，并优先普通私网 IPv4", async () => {
    const fetcher = vi.fn(async (_endpoint, brokerId: string) => [{
      groupId: "same-id",
      groupName: "开发组",
      onlineSessionCount: brokerId === "broker-a" ? 1 : 2,
    }]);
    const groups = await collectNearbyGroups([
      broker({
        brokerId: "broker-a",
        addresses: ["100.64.0.1", "192.168.1.8"],
      }),
      broker({ brokerId: "broker-b", addresses: ["10.0.0.8"] }),
    ], fetcher);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => `${group.brokerId}:${group.groupId}`)).toEqual([
      "broker-a:same-id",
      "broker-b:same-id",
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      { host: "192.168.1.8", port: 43_127 },
      "broker-a",
      800,
    );
  });

  it("逐个回退候选地址，并汇总需要更新的设备", async () => {
    const fetcher = vi.fn(async (endpoint) => {
      if (endpoint.host === "192.168.1.8") throw new Error("旧地址");
      return [{
        groupId: "group-a",
        groupName: "开发组",
        onlineSessionCount: 1,
      }];
    });
    const catalog = await collectNearbyCatalog([
      broker({ addresses: ["192.168.1.8", "fe80::1%en0"] }),
      broker({ brokerId: "old", protocolVersion: 3 }),
    ], fetcher);
    expect(catalog.updateRequiredCount).toBe(1);
    expect(catalog.groups[0]?.endpoint.host).toBe("fe80::1%en0");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
