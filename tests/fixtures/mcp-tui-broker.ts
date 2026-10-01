import { writeFileSync } from "node:fs";
import { createBrokerServer } from "../../src/broker/server.js";

const broker = createBrokerServer({
  listen: { host: process.env.PI_COMMS_E2E_MODE === "lan" ? "0.0.0.0" : "127.0.0.1", port: 0 },
  dbPath: process.env.PI_COMMS_E2E_DB!,
  networkAccessRequired: false,
  mdnsPublisherFactory: () => ({ stop: async () => {} }),
});
await broker.start();
const state = { tcpPort: broker.endpoint.port, mcpPort: broker.mcpPort, brokerId: broker.brokerId };
writeFileSync(process.env.PI_COMMS_E2E_STATE!, JSON.stringify(state));
console.log(JSON.stringify(state));
process.once("SIGTERM", () => void broker.close());
process.once("SIGINT", () => void broker.close());
