import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { DEMO_WORKSPACE_KEY, createSeedWorkspace, type WorkspaceData } from "@/lib/workspace-store";

export const dynamic = "force-dynamic";
const catalogFile = path.join(process.cwd(), ".local", "workspace-catalog.json");
const writeQueues = new Map<string, Promise<void>>();
const catalogLockFile = `${catalogFile}.lock`;

async function readCatalog() {
  try { return JSON.parse(await fs.readFile(catalogFile, "utf8")) as Record<string, WorkspaceData>; } catch { return {}; }
}

function serializeWorkspaceWrite<T>(key: string, mutation: () => Promise<T>) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(mutation);
  writeQueues.set(key, task.then(() => undefined, () => undefined));
  return task;
}

/** The in-process queue handles same-instance traffic; this lock also protects
 * a shared local catalogue when two Next processes are running against it. */
async function withCatalogLock<T>(mutation: () => Promise<T>): Promise<T> {
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

async function readWorkspace(key: string) {
  if (key !== DEMO_WORKSPACE_KEY) return undefined;
  try {
    const catalog = await readCatalog();
    const stored = catalog[key];
    return stored ? { ...stored, revision: Number.isSafeInteger(stored.revision) ? stored.revision : 1 } : createSeedWorkspace(key);
  } catch { return createSeedWorkspace(key); }
}

export async function GET(_: Request, { params }: { params: Promise<{ workspaceKey: string }> }) {
  const { workspaceKey } = await params;
  const workspace = await readWorkspace(workspaceKey);
  return workspace ? NextResponse.json(workspace, { headers: { "cache-control": "no-store" } }) : NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });
}

export async function PUT(request: Request, { params }: { params: Promise<{ workspaceKey: string }> }) {
  const { workspaceKey } = await params;
  if (workspaceKey !== DEMO_WORKSPACE_KEY) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });
  try {
    const workspace = await request.json() as WorkspaceData;
    if (workspace.key !== workspaceKey || workspace.id.length < 1 || !Array.isArray(workspace.documents) || !Array.isArray(workspace.projects)) throw new Error("invalid");
    const expected = Number(request.headers.get("if-match"));
    return await serializeWorkspaceWrite(workspaceKey, () => withCatalogLock(async () => {
      const catalog = await readCatalog();
      const current = catalog[workspaceKey] ?? createSeedWorkspace(workspaceKey);
      if (!Number.isSafeInteger(expected) || expected !== current.revision) return NextResponse.json(current, { status: 409, headers: { "cache-control": "no-store" } });
      const saved = { ...workspace, revision: current.revision + 1 };
      catalog[workspaceKey] = saved;
      const temporary = `${catalogFile}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(catalog), "utf8");
      await fs.rename(temporary, catalogFile);
      return NextResponse.json(saved, { headers: { "cache-control": "no-store" } });
    }));
  } catch { return NextResponse.json({ error: "INVALID_WORKSPACE" }, { status: 400 }); }
}
