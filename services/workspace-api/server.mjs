#!/usr/bin/env node

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const DEMO_WORKSPACE_KEY = "design-lab-2026";
export const TEST_OPERATIONS_DASHBOARD_ID = "6e0f7a4b-3e8b-4e7f-a1fd-4cf216c8db91";
export const workspaceContract = Object.freeze({
  protocolVersion: 1,
  service: "makefigma-workspace-api",
  endpoints: Object.freeze({
    health: "GET /health",
    readWorkspace: "GET /v1/workspaces/:workspaceKey",
    writeWorkspace: "PUT /v1/workspaces/:workspaceKey",
  }),
});

const date = (offsetHours = 0) => new Date(Date.now() - offsetHours * 3_600_000).toISOString();

/**
 * The authoritative seed for the shared test workspace. Kept byte-identical with
 * the web app's offline `createSeedWorkspace` cache so the first GET a client
 * receives from this independent service matches what it may already hold.
 */
export function createSeedWorkspace(key) {
  const workspaceId = "49cb844d-ea8e-4b73-b35d-7d9800ec5bb0";
  const projects = [
    { id: "9ca7cffa-4b20-4dcb-a461-522eef24a08c", workspaceId, name: "产品探索", description: "概念与方向探索", createdAt: date(240), updatedAt: date(24) },
    { id: "82e09e2c-c2b0-4afd-bb9d-5d6c70ecbb2a", workspaceId, name: "发布准备", description: "上线前设计资产", createdAt: date(120), updatedAt: date(48) },
  ];
  return {
    id: workspaceId,
    key,
    name: "Makefigma 测试工作区",
    status: "active",
    revision: 1,
    projects,
    documents: [
      { id: TEST_OPERATIONS_DASHBOARD_ID, workspaceId, projectId: projects[0].id, name: "测试运营后台 Dashboard", status: "active", version: 1, createdAt: date(2), updatedAt: date(0), lastOpenedAt: date(0), thumbnail: "mint" },
      { id: "c46e30b5-4e63-4ec4-83ba-6b0fa3c9a7df", workspaceId, projectId: projects[0].id, name: "Orbit 卡片探索", status: "active", version: 4, createdAt: date(96), updatedAt: date(1), lastOpenedAt: date(1), thumbnail: "sun" },
      { id: "7b1d7e17-a0da-43d1-b499-eb46a48a1b70", workspaceId, projectId: projects[0].id, name: "设计系统：颜色与排版", status: "active", version: 8, createdAt: date(144), updatedAt: date(5), lastOpenedAt: date(5), thumbnail: "violet" },
      { id: "554d0985-f8b1-4e4c-9eef-920ce46e4846", workspaceId, projectId: projects[1].id, name: "新功能发布页面", status: "active", version: 2, createdAt: date(48), updatedAt: date(18), lastOpenedAt: date(18), thumbnail: "mint" },
      { id: "91914309-6b8c-437c-9c0c-fad11307bbfc", workspaceId, name: "移动端流程草图", status: "active", version: 1, createdAt: date(72), updatedAt: date(36), thumbnail: "sand" },
    ],
  };
}

/**
 * A deliberately separate process boundary. The web app reaches this service
 * only through the Next `/workspace-api` rewrite proxy; it never imports it, so
 * web and backend stay independently deployable. The persistence, per-key write
 * serialization, cross-process catalogue lock, and optimistic-concurrency
 * semantics are ported verbatim from the retired Next route handler.
 */
export function createWorkspaceBackend({ dataDir = path.join(process.cwd(), ".local") } = {}) {
  const catalogFile = path.join(dataDir, "workspace-catalog.json");
  const catalogLockFile = `${catalogFile}.lock`;
  const writeQueues = new Map();

  async function readCatalog() {
    try { return JSON.parse(await fs.readFile(catalogFile, "utf8")); } catch { return {}; }
  }

  function serializeWorkspaceWrite(key, mutation) {
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(mutation);
    writeQueues.set(key, task.then(() => undefined, () => undefined));
    return task;
  }

  // The in-process queue handles same-instance traffic; this lock also protects a
  // shared local catalogue when two service processes are running against it.
  async function withCatalogLock(mutation) {
    const deadline = Date.now() + 5_000;
    await fs.mkdir(path.dirname(catalogFile), { recursive: true });
    while (true) {
      try {
        const handle = await fs.open(catalogLockFile, "wx");
        try { return await mutation(); }
        finally { await handle.close(); await fs.unlink(catalogLockFile).catch(() => undefined); }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        const stale = await fs.stat(catalogLockFile).then((entry) => Date.now() - entry.mtimeMs > 30_000).catch(() => false);
        if (stale) { await fs.unlink(catalogLockFile).catch(() => undefined); continue; }
        if (Date.now() >= deadline) throw new Error("WORKSPACE_LOCK_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  async function readWorkspace(key) {
    if (key !== DEMO_WORKSPACE_KEY) return undefined;
    try {
      const catalog = await readCatalog();
      const stored = catalog[key];
      return stored ? { ...stored, revision: Number.isSafeInteger(stored.revision) ? stored.revision : 1 } : createSeedWorkspace(key);
    } catch { return createSeedWorkspace(key); }
  }

  async function writeWorkspace(key, workspace, ifMatch) {
    if (key !== DEMO_WORKSPACE_KEY) return { status: 404, body: { error: "WORKSPACE_NOT_FOUND" } };
    if (!workspace || workspace.key !== key || typeof workspace.id !== "string" || workspace.id.length < 1 || !Array.isArray(workspace.documents) || !Array.isArray(workspace.projects)) {
      return { status: 400, body: { error: "INVALID_WORKSPACE" } };
    }
    const expected = Number(ifMatch);
    return serializeWorkspaceWrite(key, () => withCatalogLock(async () => {
      const catalog = await readCatalog();
      const current = catalog[key] ?? createSeedWorkspace(key);
      if (!Number.isSafeInteger(expected) || expected !== current.revision) return { status: 409, body: current };
      const saved = { ...workspace, revision: current.revision + 1 };
      catalog[key] = saved;
      const temporary = `${catalogFile}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(catalog), "utf8");
      await fs.rename(temporary, catalogFile);
      return { status: 200, body: saved };
    }));
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => sendJson(response, 500, { error: "WORKSPACE_INTERNAL_ERROR" }));
  });

  async function handle(request, response) {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://workspace-api.invalid");
    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: workspaceContract.service, protocolVersion: workspaceContract.protocolVersion });
      return;
    }
    const match = /^\/v1\/workspaces\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const key = decodeURIComponent(match[1]);
      if (method === "GET") {
        const workspace = await readWorkspace(key);
        if (workspace) sendJson(response, 200, workspace);
        else sendJson(response, 404, { error: "WORKSPACE_NOT_FOUND" });
        return;
      }
      if (method === "PUT") {
        let payload;
        try { payload = JSON.parse(await readBody(request)); } catch { sendJson(response, 400, { error: "INVALID_WORKSPACE" }); return; }
        const result = await writeWorkspace(key, payload, request.headers["if-match"]);
        sendJson(response, result.status, result.body);
        return;
      }
    }
    sendJson(response, 404, { error: "WORKSPACE_NOT_FOUND" });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      // Bound the catalogue payload so a hostile client cannot exhaust memory.
      if (bytes > 8_388_608) { reject(new Error("WORKSPACE_BODY_TOO_LARGE")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
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
  const port = Number.parseInt(process.env.PORT ?? "8790", 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer from 0 to 65535");
  const server = createWorkspaceBackend({ dataDir: process.env.MAKEFIGMA_WORKSPACE_DATA_DIR ?? path.join(process.cwd(), ".local") });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "object" && address) console.log(`Makefigma workspace API listening at http://127.0.0.1:${address.port}`);
  });
}
