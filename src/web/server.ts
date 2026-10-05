import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientPeer } from "../broker/client-peer.js";
import { createEnvelope, MAX_JSONL_FRAME_BYTES, type Envelope } from "../protocol.js";

export const DEFAULT_WEB_PORT = 43128;
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const visibleTypes = new Set(["snapshot", "membership.welcome", "chat.message", "presence.changed", "presence.removed", "chain.paused", "chain.resolved", "send.failed", "pong", "error"]);

export function createWebServer(options: {
  host: string;
  port?: number;
  allowed(address: string | undefined): boolean;
  group(groupId: string): { groupId: string; groupName: string } | undefined;
  connect(peer: ClientPeer): { message(value: unknown): void; close(): void };
}) {
  let port: number | undefined;
  let error: string | undefined;
  const server = createServer(async (request, response) => {
    if (!options.allowed(request.socket.remoteAddress)) { response.writeHead(403); response.end("当前网络不允许手机加入"); return; }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/groups/")) {
      const group = options.group(decodeURIComponent(url.pathname.slice("/api/groups/".length)));
      response.writeHead(group ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(group ?? { error: "群组不可用或尚未开放附近加入" }));
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { response.writeHead(404); response.end(); return; }
    try {
      const body = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
      response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
      response.end(body);
    } catch { response.writeHead(500); response.end("页面资源不可用"); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_JSONL_FRAME_BYTES });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws" || !options.allowed(request.socket.remoteAddress)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const peer: ClientPeer = {
        kind: "web", remoteAddress: request.socket.remoteAddress,
        get destroyed() { return ws.readyState !== WebSocket.OPEN; },
        send(envelope: Envelope) {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (envelope.type === "client.welcome") {
            ws.send(JSON.stringify({ ...envelope, type: "web.welcome" })); return;
          }
          if (!visibleTypes.has(envelope.type)) return;
          if (envelope.type === "snapshot") {
            const { mcpAccess: _mcp, groups: _groups, proactiveStatus: _status, ownProactiveEnabled: _enabled, ownerRecoveryAvailable: _recovery, ...payload } = envelope.payload as Record<string, unknown>;
            ws.send(JSON.stringify({ ...envelope, payload })); return;
          }
          ws.send(JSON.stringify(envelope));
        },
        end: () => ws.close(), destroy: () => ws.terminate(),
      };
      const connection = options.connect(peer);
      ws.on("message", (data, binary) => {
        if (binary) { peer.send(createEnvelope("error", { code: "invalid_json", message: "只支持文本消息" })); return; }
        try { connection.message(JSON.parse(data.toString())); }
        catch { peer.send(createEnvelope("error", { code: "invalid_json", message: "消息不是合法 JSON" })); }
      });
      ws.on("error", () => ws.terminate());
      ws.once("close", () => connection.close());
    });
  });
  return {
    get port() { return port; }, get error() { return error; },
    async start() {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(options.port ?? DEFAULT_WEB_PORT, options.host, () => { server.off("error", reject); resolve(); });
        });
        port = (server.address() as { port: number }).port;
      } catch (cause) {
        error = (cause as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? `手机 Web 端口 ${options.port ?? DEFAULT_WEB_PORT} 已被占用，TCP 群聊仍可用`
          : `手机 Web 无法启动：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      port = undefined;
    },
  };
}
