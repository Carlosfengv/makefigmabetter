import { createId } from "./editor-protocol";

export const DEMO_WORKSPACE_KEY = "design-lab-2026";
export const TEST_OPERATIONS_DASHBOARD_ID = "6e0f7a4b-3e8b-4e7f-a1fd-4cf216c8db91";

// The workspace catalogue lives in an independently deployable backend
// (services/workspace-api), reached same-origin through the Next `/workspace-api`
// rewrite proxy — deployment overrides the target, never the browser origin.
const workspaceApiUrl = process.env.NEXT_PUBLIC_WORKSPACE_API_URL ?? "/workspace-api";
const workspaceEndpoint = (key: string) => `${workspaceApiUrl}/v1/workspaces/${encodeURIComponent(key)}`;

export type DocumentStatus = "active" | "saving" | "save_failed" | "conflicted" | "trashed";

export type WorkspaceProject = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceDocument = {
  id: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  status: DocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  trashedAt?: string;
  thumbnail: "sun" | "violet" | "mint" | "sand";
};

export type WorkspaceData = {
  id: string;
  key: string;
  name: string;
  status: "active";
  revision: number;
  projects: WorkspaceProject[];
  documents: WorkspaceDocument[];
};

const storageKey = (key: string) => `makefigma:workspace:${key}`;
const date = (offsetHours = 0) => new Date(Date.now() - offsetHours * 3_600_000).toISOString();

function id() {
  return createId();
}

export function createSeedWorkspace(key: string): WorkspaceData {
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

/** Keeps the demo discoverable in existing local test workspaces created before
 * the dashboard prototype was introduced, without rewriting user documents. */
function includeTestOperationsDashboard(workspace: WorkspaceData): WorkspaceData {
  if (workspace.documents.some((document) => document.id === TEST_OPERATIONS_DASHBOARD_ID)) return workspace;
  const template = createSeedWorkspace(workspace.key).documents.find((document) => document.id === TEST_OPERATIONS_DASHBOARD_ID);
  if (!template) return workspace;
  return { ...workspace, documents: [template, ...workspace.documents] };
}

export function loadWorkspace(key: string): WorkspaceData | undefined {
  if (typeof window === "undefined" || key !== DEMO_WORKSPACE_KEY) return undefined;
  const stored = window.localStorage.getItem(storageKey(key));
  if (!stored) {
    const initial = createSeedWorkspace(key);
    window.localStorage.setItem(storageKey(key), JSON.stringify(initial));
    return initial;
  }
  try {
    const workspace = includeTestOperationsDashboard(JSON.parse(stored) as WorkspaceData);
    window.localStorage.setItem(storageKey(key), JSON.stringify(workspace));
    return workspace;
  } catch { return undefined; }
}

type WorkspaceSaveOptions = { suppressConflict?: boolean };

export function saveWorkspace(workspace: WorkspaceData, options?: WorkspaceSaveOptions) {
  window.localStorage.setItem(storageKey(workspace.key), JSON.stringify(workspace));
  queueWorkspaceSave(workspace, options);
  return workspace;
}

const serverRevisions = new Map<string, number>();
const saveQueues = new Map<string, Promise<void>>();

export class WorkspaceSaveError extends Error {
  constructor(public readonly code: "WORKSPACE_CONFLICT" | "WORKSPACE_SAVE_FAILED") {
    super(code);
  }
}

function notifyWorkspaceSaveError(key: string, error: WorkspaceSaveError) {
  window.dispatchEvent(new CustomEvent("makefigma:workspace-save-error", { detail: { key, error } }));
}

function queueWorkspaceSave(workspace: WorkspaceData, options?: WorkspaceSaveOptions) {
  const previous = saveQueues.get(workspace.key) ?? Promise.resolve();
  // A rejected write intentionally blocks every stale mutation queued behind it.
  // Continuing with an old full-catalogue body after a 409 would overwrite the
  // other window's successful change under its newer revision.
  const task = previous.then(async () => {
    try {
      const revision = serverRevisions.get(workspace.key) ?? workspace.revision;
      const response = await fetch(workspaceEndpoint(workspace.key), {
        method: "PUT", headers: { "content-type": "application/json", "if-match": String(revision) }, body: JSON.stringify(workspace),
      });
      if (response.status === 409) {
        const latest = await response.json() as WorkspaceData;
        serverRevisions.set(workspace.key, latest.revision);
        // Opening a document only updates recency metadata. Losing that race is
        // harmless; adopt the authoritative catalogue so it cannot surface as a
        // false editing error or block a later real mutation.
        if (options?.suppressConflict) {
          window.localStorage.setItem(storageKey(workspace.key), JSON.stringify(latest));
          return;
        }
        window.dispatchEvent(new CustomEvent("makefigma:workspace-conflict", { detail: latest }));
        throw new WorkspaceSaveError("WORKSPACE_CONFLICT");
      }
      if (!response.ok) throw new WorkspaceSaveError("WORKSPACE_SAVE_FAILED");
      const saved = await response.json() as WorkspaceData;
      serverRevisions.set(workspace.key, saved.revision);
      window.localStorage.setItem(storageKey(workspace.key), JSON.stringify(saved));
    } catch (error) {
      // Document-service edits remain durable in the local journal while the
      // workspace catalogue records only display metadata (version/recency).
      // A temporary offline failure for that metadata must not show an editor
      // failure banner or poison the later remote-operation replay queue.
      if (options?.suppressConflict) return;
      throw error;
    }
  });
  saveQueues.set(workspace.key, task);
  void task.catch((error: unknown) => notifyWorkspaceSaveError(
    workspace.key,
    error instanceof WorkspaceSaveError ? error : new WorkspaceSaveError("WORKSPACE_SAVE_FAILED"),
  ));
  return task;
}

/** Lets navigation-causing actions wait until the server has accepted the
 * catalogue mutation, so a freshly created document can be resolved by URL. */
export async function flushWorkspaceSave(key: string) {
  await (saveQueues.get(key) ?? Promise.resolve());
}

/** Server data is the shared source of truth for the test link. LocalStorage is
 * retained only as an offline cache while the next successful request repairs it. */
export async function fetchWorkspace(key: string, { allowCachedFallback = true }: { allowCachedFallback?: boolean } = {}) {
  if (key !== DEMO_WORKSPACE_KEY) return undefined;
  try {
    const response = await fetch(workspaceEndpoint(key), { cache: "no-store" });
    // A missing key is definitive, but a proxy/backend failure is transient.
    // Preserve the offline-cache contract instead of presenting a valid test
    // link as a nonexistent workspace while the independent API restarts.
    if (response.status === 404) return undefined;
    if (!response.ok) return allowCachedFallback ? loadWorkspace(key) : undefined;
    const workspace = includeTestOperationsDashboard(await response.json() as WorkspaceData);
    serverRevisions.set(key, workspace.revision);
    window.localStorage.setItem(storageKey(key), JSON.stringify(workspace));
    return workspace;
  } catch { return allowCachedFallback ? loadWorkspace(key) : undefined; }
}

/** Call only after a failed queued mutation has settled and the caller has
 * reloaded the authoritative catalogue. This deliberately never retries a
 * stale full-catalogue payload. */
export function resetWorkspaceSaveQueue(key: string) {
  saveQueues.delete(key);
}

export function createWorkspaceDocument(workspace: WorkspaceData, projectId?: string) {
  const now = date();
  const document: WorkspaceDocument = {
    id: id(), workspaceId: workspace.id, projectId, name: "未命名设计", status: "active", version: 1,
    createdAt: now, updatedAt: now, lastOpenedAt: now, thumbnail: "sun",
  };
  return saveWorkspace({ ...workspace, documents: [document, ...workspace.documents] });
}

export function patchWorkspaceDocument(workspace: WorkspaceData, documentId: string, patch: Partial<WorkspaceDocument>, options?: WorkspaceSaveOptions) {
  const now = date();
  return saveWorkspace({ ...workspace, documents: workspace.documents.map((document) => document.id === documentId ? { ...document, ...patch, updatedAt: patch.status === "trashed" ? document.updatedAt : now } : document) }, options);
}

export function removeWorkspaceDocument(workspace: WorkspaceData, documentId: string) {
  return saveWorkspace({ ...workspace, documents: workspace.documents.filter((document) => document.id !== documentId) });
}

export function duplicateWorkspaceDocument(workspace: WorkspaceData, documentId: string, persist = true) {
  const source = workspace.documents.find((document) => document.id === documentId);
  if (!source) return workspace;
  const now = date();
  const copy: WorkspaceDocument = { ...source, id: id(), name: `${source.name} - 副本`, version: 1, status: "active", createdAt: now, updatedAt: now, lastOpenedAt: now };
  const next = { ...workspace, documents: [copy, ...workspace.documents] };
  return persist ? saveWorkspace(next) : next;
}

export function createWorkspaceProject(workspace: WorkspaceData, name: string, description?: string) {
  const now = date();
  const project: WorkspaceProject = { id: id(), workspaceId: workspace.id, name, description, createdAt: now, updatedAt: now };
  return saveWorkspace({ ...workspace, projects: [...workspace.projects, project] });
}

export function patchWorkspaceProject(workspace: WorkspaceData, projectId: string, patch: Partial<WorkspaceProject>) {
  const now = date();
  return saveWorkspace({ ...workspace, projects: workspace.projects.map((project) => project.id === projectId ? { ...project, ...patch, updatedAt: now } : project) });
}

export function removeWorkspaceProject(workspace: WorkspaceData, projectId: string) {
  return saveWorkspace({ ...workspace, projects: workspace.projects.filter((project) => project.id !== projectId) });
}
