import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAddressOnOrdinaryNetwork } from "../src/broker/server.js";
import { NetworkAccessStore } from "../src/discovery/network-access.js";
import { primaryOrdinaryNetwork } from "../src/discovery/network.js";

describe("普通网络授权", () => {
  let directory: string | undefined;

  it("只允许当前普通网络所在的局域网地址", () => {
    expect(isAddressOnOrdinaryNetwork("192.168.8.42", "192.168.8.10")).toBe(true);
    expect(isAddressOnOrdinaryNetwork("::ffff:192.168.8.42", "192.168.8.10"))
      .toBe(true);
    expect(isAddressOnOrdinaryNetwork("10.8.0.2", "192.168.8.10")).toBe(false);
  });

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("记住已确认网络，VPN 开关不改变普通网络身份", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-network-"));
    const store = new NetworkAccessStore(join(directory, "comms.db"));
    const withoutVpn = primaryOrdinaryNetwork({
      en0: [{
        address: "192.168.1.20",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:01",
        internal: false,
        cidr: "192.168.1.20/24",
      }],
    })!;
    const withVpn = primaryOrdinaryNetwork({
      en0: [{
        address: "192.168.1.20",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:01",
        internal: false,
        cidr: "192.168.1.20/24",
      }],
      utun4: [{
        address: "10.8.0.2",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:02",
        internal: false,
        cidr: "10.8.0.2/24",
      }],
    })!;

    await store.confirm(withoutVpn);
    expect(withVpn.networkKey).toBe(withoutVpn.networkKey);
    await expect(store.isConfirmed(withVpn)).resolves.toBe(true);
  });

  it("新的普通网络必须单独确认", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-network-"));
    const store = new NetworkAccessStore(join(directory, "comms.db"));
    const first = {
      interfaceName: "en0",
      address: "192.168.1.20",
      networkKey: "en0:192.168.1",
    };
    const second = {
      interfaceName: "en0",
      address: "192.168.50.20",
      networkKey: "en0:192.168.50",
    };
    await store.confirm(first);
    await expect(store.isConfirmed(second)).resolves.toBe(false);
    await store.confirm(second);
    await expect(store.confirmedKeys()).resolves.toEqual([
      second.networkKey,
      first.networkKey,
    ]);
  });
});
