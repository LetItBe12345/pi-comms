import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { HistoryMessage, McpAccessPayload } from "../protocol.js";

export const MCP_TOKEN_TTL_MS = 5 * 60_000;

interface Grant {
  clientId: string;
  groupId: string;
  expiresAt: number;
}

export interface BrokerMcpOptions {
  host: string;
  currentGroup(clientId: string): string | undefined;
  networkAllowed(address: string | undefined): boolean;
  current(groupId: string): unknown;
  context(groupId: string): unknown;
  messages(groupId: string, options: { afterSeq?: number; throughSeq?: number; limit: number }): HistoryMessage[];
  now?: () => number;
}

/** Only projects stable public fields; the TCP history also contains private routing state. */
export function publicMcpMessage(message: HistoryMessage) {
  return {
    groupSeq: message.groupSeq,
    messageId: message.messageId,
    timestamp: message.timestamp,
    senderName: message.senderName,
    senderType: message.senderType,
    text: message.text,
    mentionIds: message.mentionIds,
    ...(message.chainId === undefined ? {} : { chainId: message.chainId }),
    ...(message.round === undefined ? {} : { round: message.round }),
  };
}

export function createBrokerMcpServer(options: BrokerMcpOptions) {
  const grants = new Map<string, Grant>();
  const now = options.now ?? Date.now;
  let port = 0;
  const active = new Set<McpServer>();
  const http = createServer((req, res) => {
    void handle().catch(() => {
      if (!res.headersSent) error(res, 500, "MCP request failed");
      else res.end();
    });

    async function handle() {
      if (req.url !== "/mcp") return error(res, 404, "MCP endpoint not found");
      if (!options.networkAllowed(req.socket.remoteAddress)) {
        return error(res, 403, "Broker network unavailable");
      }
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const grant = grants.get(token);
      if (grant === undefined || grant.expiresAt <= now()) {
        grants.delete(token);
        return error(res, 401, "MCP access token invalid or expired");
      }
      if (options.currentGroup(grant.clientId) !== grant.groupId) {
        grants.delete(token);
        return error(res, 401, "MCP Session is offline or no longer in the authorized group");
      }
      if (req.method !== "POST") return error(res, 405, "MCP stateless endpoint only supports POST");
      const authorizedGroup = () => {
        if (grants.get(token) !== grant || grant.expiresAt <= now() ||
            options.currentGroup(grant.clientId) !== grant.groupId) {
          throw new Error("MCP access token expired or Session no longer in group");
        }
        return grant.groupId;
      };
      // Stateless HTTP avoids a second session store. Every request rechecks the TCP identity.
      const mcp = new McpServer({ name: "pi-comms", version: "1.0.0" });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
      mcp.registerTool("get_group_context", {
        description: "Read the latest context of your current Pi Comms group, without generating a summary.",
        inputSchema: z.object({}).strict(),
        annotations,
      }, async () => result(options.context(authorizedGroup())));
      mcp.registerTool("read_group_messages", {
        description: "Read public messages in your current group. afterSeq is exclusive; throughSeq is inclusive. Latest 20 by default, maximum 50, ascending sequence order.",
        inputSchema: z.object({
          afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
          throughSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
          limit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
        }).strict(),
        annotations,
      }, async (args) => result({ messages: options.messages(authorizedGroup(), {
        ...args, limit: Math.min(args.limit ?? 20, 50),
      }).map(publicMcpMessage) }));
      for (const [name, uri, read] of [
        ["current", "pi-comms://group/current", options.current],
        ["context", "pi-comms://group/context", options.context],
      ] as const) {
        mcp.registerResource(name, uri, { mimeType: "application/json" }, async () => ({
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(read(authorizedGroup())) }],
        }));
      }
      active.add(mcp);
      res.once("close", () => { active.delete(mcp); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    }
  });

  return {
    get port() { return port; },
    async start() {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, options.host, () => { http.off("error", reject); resolve(); });
      });
      port = (http.address() as AddressInfo).port;
    },
    issue(clientId: string, groupId: string): McpAccessPayload {
      for (const [token, grant] of grants) {
        if (grant.clientId === clientId && grant.groupId === groupId && grant.expiresAt > now() + 60_000) {
          return { port, token, expiresAt: grant.expiresAt };
        }
      }
      for (const [token, grant] of grants) {
        if (grant.expiresAt <= now() || grant.clientId === clientId) grants.delete(token);
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + MCP_TOKEN_TTL_MS;
      grants.set(token, { clientId, groupId, expiresAt });
      return { port, token, expiresAt };
    },
    revoke(clientId: string) {
      for (const [token, grant] of grants) if (grant.clientId === clientId) grants.delete(token);
    },
    async close() {
      grants.clear();
      await Promise.all([...active].map((mcp) => mcp.close()));
      if (http.listening) {
        await new Promise<void>((resolve, reject) => {
          http.close((err) => err ? reject(err) : resolve());
          http.closeAllConnections();
        });
      }
    },
  };
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function error(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
}
