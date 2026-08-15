import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceBackend, createSeedWorkspace, workspaceContract, DEMO_WORKSPACE_KEY } from "./server.mjs";

const servers = [];
const dataDirs = [];

async function backend() {
  const dataDir = mkdtempSync(join(tmpdir(), "makefigma-workspace-api-"));
  dataDirs.push(dataDir);
  const server = createWorkspaceBackend({ dataDir });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Expected a TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => { server.close(); await once(server, "close"); }));
  dataDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("independent workspace API", () => {
  it("publishes a no-store health response with the versioned contract", async () => {
    const base = await backend();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ status: "ok", service: "makefigma-workspace-api", protocolVersion: workspaceContract.protocolVersion });
  });

  it("returns the seed workspace on first read", async () => {
    const base = await backend();
    const response = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({ key: DEMO_WORKSPACE_KEY, revision: 1 }));
  });

  it("advances the revision on an if-match write and persists it", async () => {
    const base = await backend();
    const seed = createSeedWorkspace(DEMO_WORKSPACE_KEY);
    const write = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`, {
      method: "PUT", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify({ ...seed, name: "renamed" }),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual(expect.objectContaining({ name: "renamed", revision: 2 }));

    const read = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`);
    expect(await read.json()).toEqual(expect.objectContaining({ name: "renamed", revision: 2 }));
  });

  it("rejects a stale revision with 409 and returns the current catalogue", async () => {
    const base = await backend();
    const seed = createSeedWorkspace(DEMO_WORKSPACE_KEY);
    await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify({ ...seed, name: "first" }) });
    const stale = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify({ ...seed, name: "second" }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual(expect.objectContaining({ name: "first", revision: 2 }));
  });

  it("rejects an unknown workspace key", async () => {
    const base = await backend();
    expect((await fetch(`${base}/v1/workspaces/other`)).status).toBe(404);
    const write = await fetch(`${base}/v1/workspaces/other`, { method: "PUT", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify(createSeedWorkspace("other")) });
    expect(write.status).toBe(404);
  });

  it("rejects a malformed catalogue body with 400", async () => {
    const base = await backend();
    const response = await fetch(`${base}/v1/workspaces/${DEMO_WORKSPACE_KEY}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": "1" }, body: JSON.stringify({ key: DEMO_WORKSPACE_KEY }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_WORKSPACE" });
  });

  it("does not expose an implicit write surface", async () => {
    const base = await backend();
    const response = await fetch(`${base}/v1/workspaces`, { method: "POST" });
    expect(response.status).toBe(404);
  });
});
