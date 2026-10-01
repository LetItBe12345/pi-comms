import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpAccessPayload } from "../protocol.js";
import type { TcpConnectEndpoint } from "../transport/tcp-endpoint.js";

/** Runtime-only credentials. Never append them to Pi's session file. */
export class McpRegistration {
  #token: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly pi: ExtensionAPI, readonly refresh: () => void) {}

  update(access: McpAccessPayload, endpoint: TcpConnectEndpoint) {
    if (this.#token === access.token) return;
    this.clear();
    this.#token = access.token;
    const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
    this.pi.registerMcpServer("pi-comms", {
      url: `http://${host}:${access.port}/mcp`,
      headers: { Authorization: `Bearer ${access.token}` },
      exposure: "direct",
      toolExposure: { get_group_context: "direct", read_group_messages: "direct" },
      description: "Read the latest context and public history of your current Pi Comms group.",
    });
    this.#timer = setTimeout(this.refresh, Math.max(0, access.expiresAt - Date.now() - 30_000));
    this.#timer.unref?.();
  }

  clear() {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#token !== undefined) this.pi.unregisterMcpServer("pi-comms");
    this.#token = undefined;
  }
}
