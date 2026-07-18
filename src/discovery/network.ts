import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export interface OrdinaryNetwork {
  interfaceName: string;
  address: string;
  networkKey: string;
}

export function ordinaryNetworks(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): OrdinaryNetwork[] {
  const physical: OrdinaryNetwork[] = [];
  const fallback: OrdinaryNetwork[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (
        address.family !== "IPv4" ||
        address.internal ||
        !isPrivateIPv4(address.address)
      ) continue;
      const candidate = {
        interfaceName: name,
        address: address.address,
        networkKey: `${name}:${address.address.split(".").slice(0, 3).join(".")}`,
      };
      fallback.push(candidate);
      if (!isVpnOrVirtualInterface(name)) physical.push(candidate);
    }
  }
  return uniqueByAddress(physical.length > 0 ? physical : fallback);
}

export function primaryOrdinaryNetwork(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): OrdinaryNetwork | undefined {
  return ordinaryNetworks(interfaces)[0];
}

export function isVpnOrVirtualInterface(name: string): boolean {
  return /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|wg|tailscale|zt)/i
    .test(name);
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function uniqueByAddress(networks: OrdinaryNetwork[]): OrdinaryNetwork[] {
  return [...new Map(networks.map((network) => [network.address, network])).values()];
}
