import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ordinaryNetworks,
  primaryOrdinaryNetwork,
} from "../src/discovery/network.js";

function address(value: string): NetworkInterfaceInfo {
  return {
    address: value,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${value}/24`,
  };
}

describe("普通网络选择", () => {
  it("VPN 开关不改变选中的普通网络", () => {
    const wifi = { wlan0: [address("192.168.10.23")] };
    const before = primaryOrdinaryNetwork(wifi);
    const after = primaryOrdinaryNetwork({
      ...wifi,
      tun0: [address("10.8.0.2")],
      wg0: [address("10.9.0.2")],
    });
    expect(after).toEqual(before);
    expect(ordinaryNetworks({
      ...wifi,
      utun4: [address("10.10.0.2")],
    })).toEqual([expect.objectContaining({ interfaceName: "wlan0" })]);
  });

  it("普通网络变化会得到新的网络标识", () => {
    const first = primaryOrdinaryNetwork({
      en0: [address("192.168.1.20")],
    });
    const second = primaryOrdinaryNetwork({
      en0: [address("192.168.2.20")],
    });
    expect(first?.networkKey).not.toBe(second?.networkKey);
  });
});
