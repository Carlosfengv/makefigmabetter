import { once } from "node:events";
import { createMockBackend, editorContract } from "./server.mjs";

const server = createMockBackend();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (typeof address !== "object" || !address) throw new Error("Mock backend did not bind a TCP port");

try {
  const health = await fetch(`http://127.0.0.1:${address.port}/health`);
  const contract = await fetch(`http://127.0.0.1:${address.port}/contracts/v1/editor`);
  if (!health.ok || !contract.ok) throw new Error("Mock backend contract endpoint check failed");
  const healthBody = await health.json();
  const contractBody = await contract.json();
  if (healthBody.protocolVersion !== editorContract.protocolVersion || contractBody.protocolVersion !== editorContract.protocolVersion) throw new Error("Mock backend returned an incompatible protocol version");
  console.log(`Mock backend independently verified on ephemeral port ${address.port}.`);
} finally {
  server.close();
  await once(server, "close");
}
