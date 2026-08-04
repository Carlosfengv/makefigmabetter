#!/usr/bin/env node

import { createServer } from "node:http";

export const editorContract = Object.freeze({
  protocolVersion: 1,
  service: "makefigma-mock-backend",
  endpoints: Object.freeze({
    health: "GET /health",
    editorContract: "GET /contracts/v1/editor",
  }),
  documentWrites: "unimplemented",
  securityAudit: Object.freeze({
    schemaVersion: 1,
    eventSchemas: Object.freeze(["authorization-v1", "asset-probe-v1"]),
    delivery: "future authenticated server-side sink",
  }),
});

/**
 * A deliberately separate process boundary for Phase 0. The web app must not
 * import or proxy this server through Next route handlers; future authenticated
 * document and asset services will replace these explicit contract endpoints.
 */
export function createMockBackend() {
  return createServer((request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://mock-backend.invalid");
    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: editorContract.service, protocolVersion: editorContract.protocolVersion });
      return;
    }
    if (method === "GET" && url.pathname === "/contracts/v1/editor") {
      sendJson(response, 200, editorContract);
      return;
    }
    sendJson(response, 404, { errorCode: "NOT_FOUND", safeMessage: "No such mock backend endpoint." });
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer from 0 to 65535");
  const server = createMockBackend();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "object" && address) console.log(`Makefigma mock backend listening at http://127.0.0.1:${address.port}`);
  });
}
