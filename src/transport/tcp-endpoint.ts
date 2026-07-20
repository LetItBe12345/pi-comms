import { isIP } from "node:net";

export interface TcpListenEndpoint {
  host: string;
  port: number;
}

export interface TcpConnectEndpoint {
  host: string;
  port: number;
}

export const DEFAULT_BROKER_ENDPOINT: Readonly<TcpConnectEndpoint> = Object.freeze({
  host: "127.0.0.1",
  port: 43_127,
});

export function validateListenEndpoint(endpoint: TcpListenEndpoint): TcpListenEndpoint {
  validateHost(endpoint.host, true);
  validatePort(endpoint.port, true);
  return { ...endpoint };
}

export function validateConnectEndpoint(endpoint: TcpConnectEndpoint): TcpConnectEndpoint {
  validateHost(endpoint.host, false);
  validatePort(endpoint.port, false);
  return { ...endpoint };
}

export function sameEndpoint(
  left: TcpConnectEndpoint,
  right: TcpConnectEndpoint,
): boolean {
  return left.host === right.host && left.port === right.port;
}

export function formatEndpoint(endpoint: TcpListenEndpoint | TcpConnectEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

function validateHost(host: string, listening: boolean): void {
  const family = isIP(host);
  if (family === 6) {
    throw new Error("当前版本暂不支持 IPv6，请使用普通网络的 IPv4 地址");
  }
  if (family !== 4) {
    throw new Error("当前版本请使用 IPv4 地址，不支持主机名连接");
  }
  if (!listening && host === "0.0.0.0") {
    throw new Error("0.0.0.0 只能作为监听地址");
  }
}

function validatePort(port: number, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`TCP port 无效：${port}`);
  }
}
