import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceBackend, workspaceContract, DEMO_WORKSPACE_KEY } from "./server.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "makefigma-workspace-api-check-"));
const server = createWorkspaceBackend({ dataDir });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (typeof address !== "object" || !address) throw new Error("Workspace API did not bind a TCP port");
const base = `http://127.0.0.1:${address.port}`;

try {
  const health = await fetch(`${base}/health`);
  if (!health.ok) throw new Error("Workspace API health check failed");
  if ((await health.json()).protocolVersion !== workspaceContract.protocolVersion) throw new Error("Workspace API returned an incompatible protocol version");

  const read = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`);
  if (!read.ok) throw new Error("Workspace API seed read failed");
  const seed = await read.json();
  if (seed.revision !== 1 || !Array.isArray(seed.documents)) throw new Error("Workspace API seed payload malformed");

  const write = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`, {
    method: "PUT", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify({ ...seed, name: "renamed" }),
  });
  if (!write.ok || (await write.json()).revision !== 2) throw new Error("Workspace API optimistic write did not advance the revision");

  const stale = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`, {
    method: "PUT", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify({ ...seed, name: "stale" }),
  });
  if (stale.status !== 409) throw new Error("Workspace API did not reject a stale revision with 409");

  console.log(`Workspace API independently verified on ephemeral port ${address.port}.`);
} finally {
  server.close();
  await once(server, "close");
  rmSync(dataDir, { recursive: true, force: true });
}
