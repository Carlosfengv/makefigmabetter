import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createMockBackend, editorContract } from "./server.mjs";

const servers = [];

async function endpoint(path, options) {
  const server = createMockBackend();
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Expected a TCP server address");
  return fetch(`http://127.0.0.1:${address.port}${path}`, options);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
});

describe("independent mock backend", () => {
  it("publishes a no-store health response and versioned editor contract", async () => {
    const health = await endpoint("/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ status: "ok", service: "makefigma-mock-backend", protocolVersion: 1 });

    const contract = await endpoint("/contracts/v1/editor");
    expect(contract.status).toBe(200);
    expect(await contract.json()).toEqual(editorContract);
  });

  it("does not expose an implicit write surface", async () => {
    const response = await endpoint("/documents", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ errorCode: "NOT_FOUND", safeMessage: "No such mock backend endpoint." });
  });
});
