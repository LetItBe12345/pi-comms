import { writeFileSync } from "node:fs";
import { createBrokerServer } from "../../src/broker/server.js";
import { FakeProactiveRouter } from "../../src/broker/proactive-provider.js";

const broker = createBrokerServer({
  listen: { host: process.env.PI_COMMS_E2E_MODE === "lan" ? "0.0.0.0" : "127.0.0.1", port: 0 },
  dbPath: process.env.PI_COMMS_E2E_DB!,
  webPort: 0,
  networkAccessRequired: false,
  ...(process.env.PI_COMMS_E2E_ROUTER === "1" ? { proactiveProvider: new FakeProactiveRouter() } : {}),
  mdnsPublisherFactory: () => ({ stop: async () => {} }),
});
await broker.start();
const state = { tcpPort: broker.endpoint.port, webPort: broker.webPort, mcpPort: broker.mcpPort, brokerId: broker.brokerId };
writeFileSync(process.env.PI_COMMS_E2E_STATE!, JSON.stringify(state));
console.log(JSON.stringify(state));
process.once("SIGTERM", () => void broker.close());
process.once("SIGINT", () => void broker.close());
