import type { Socket } from "node:net";
import type { Envelope } from "../protocol.js";
import { encodeEnvelope } from "../protocol.js";

export interface ClientPeer {
  readonly kind: "pi" | "web";
  readonly remoteAddress?: string;
  readonly destroyed: boolean;
  send(envelope: Envelope): void;
  end(): void;
  destroy(): void;
}

export function tcpPeer(socket: Socket): ClientPeer {
  return {
    kind: "pi",
    get remoteAddress() { return socket.remoteAddress; },
    get destroyed() { return socket.destroyed; },
    send: (message) => { if (!socket.destroyed) socket.write(encodeEnvelope(message)); },
    end: () => { socket.end(); },
    destroy: () => { socket.destroy(); },
  };
}
