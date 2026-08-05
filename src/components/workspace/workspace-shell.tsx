"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createWorkspaceDocument, createWorkspaceProject, duplicateWorkspaceDocument, fetchWorkspace, flushWorkspaceSave, loadWorkspace, patchWorkspaceDocument, patchWorkspaceProject, resetWorkspaceSaveQueue,
  removeWorkspaceDocument, removeWorkspaceProject, saveWorkspace, type WorkspaceData, type WorkspaceDocument,
} from "@/lib/workspace-store";
import { copyLocalDocument, removeLocalDocument } from "@/lib/local-document";
import { DocumentApiTransport } from "@/lib/document-api-transport";

type View = "recent" | "all" | "trash" | `project:${string}`;
type Sort = "updated-desc" | "updated-asc" | "created-desc" | "created-asc" | "name-asc" | "name-desc";
const documentApiUrl = process.env.NEXT_PUBLIC_DOCUMENT_API_URL ?? "/document-api";
const localDevTenantId = "00000000-0000-0000-0000-000000000002";
const localDevActorId = "00000000-0000-0000-0000-000000000007";

export function WorkspaceShell({ workspaceKey }: { workspaceKey: string }) {
  const [workspace, setWorkspace] = useState<WorkspaceData>();
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("recent");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated-desc");
  const [activeMenu, setActiveMenu] = useState<string>();
  const [dialog, setDialog] = useState<{ kind: "rename" | "move" | "trash" | "purge" | "project" | "project-rename" | "project-delete"; id?: string }>();
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo?: () => void }>();
  const [conflict, setConflict] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { let active = true; void fetchWorkspace(workspaceKey).then((next) => { if (active) { setWorkspace(next); setLoaded(true); } }); return () => { active = false; }; }, [workspaceKey]);
  useEffect(() => {
    const onConflict = (event: Event) => { setWorkspace((event as CustomEvent<WorkspaceData>).detail); setConflict(true); };
    window.addEventListener("makefigma:workspace-conflict", onConflict);
    return () => window.removeEventListener("makefigma:workspace-conflict", onConflict);
  }, [workspaceKey]);
  useEffect(() => { window.localStorage.setItem("makefigma:workspace-view", layout); }, [layout]);
  useEffect(() => { setLayout((window.localStorage.getItem("makefigma:workspace-view") as "grid" | "list") ?? "grid"); }, []);
  useEffect(() => { debounce.current = setTimeout(() => setQuery(search.trim().toLocaleLowerCase()), 300); return () => { if (debounce.current) clearTimeout(debounce.current); }; }, [search]);

  const projectId = view.startsWith("project:") ? view.slice(8) : undefined;
  const title = view === "recent" ? "最近编辑" : view === "all" ? "全部文档" : view === "trash" ? "回收站" : workspace?.projects.find((project) => project.id === projectId)?.name ?? "项目";
  const documents = useMemo(() => {
    if (!workspace) return [];
    const textMatches = (document: WorkspaceDocument) => !query || document.name.toLocaleLowerCase().includes(query) || (document.projectId && workspace.projects.find((project) => project.id === document.projectId)?.name.toLocaleLowerCase().includes(query));
    const filtered = workspace.documents.filter((document) => {
      if (!textMatches(document)) return false;
      if (view === "trash") return document.status === "trashed";
      if (document.status === "trashed") return false;
      if (projectId) return document.projectId === projectId;
      return true;
    });
    const recent = view === "recent" ? filtered.sort((a, b) => new Date(b.lastOpenedAt ?? b.updatedAt).getTime() - new Date(a.lastOpenedAt ?? a.updatedAt).getTime()).slice(0, 20) : filtered;
    return [...recent].sort((a, b) => {
      if (sort === "name-asc") return a.name.localeCompare(b.name, "zh");
      if (sort === "name-desc") return b.name.localeCompare(a.name, "zh");
      const field = sort.startsWith("created") ? "createdAt" : "updatedAt";
      const direction = sort.endsWith("asc") ? 1 : -1;
      return direction * (new Date(a[field]).getTime() - new Date(b[field]).getTime());
    });
  }, [projectId, query, sort, view, workspace]);

  if (!loaded) return <main className="workspace-loading"><span className="workspace-logo">M</span><p>正在加载工作区…</p></main>;
  if (!workspace) return <main className="workspace-error"><span className="workspace-logo">M</span><h1>工作区不存在</h1><p>工作区加载失败，请确认链接是否正确。</p><button className="primary-button" onClick={() => window.location.reload()}>重新加载</button></main>;
  const update = (next: WorkspaceData) => setWorkspace(next);
  const projectName = (id?: string) => workspace.projects.find((project) => project.id === id)?.name ?? "未分组";
  const openDialog = (kind: NonNullable<typeof dialog>["kind"], id?: string, value = "") => { setActiveMenu(undefined); setDraft(value); setDialog({ kind, id }); };
  const selected = dialog?.id ? workspace.documents.find((document) => document.id === dialog.id) : undefined;
  const announce = (message: string, undo?: () => void) => { setToast({ message, undo }); window.setTimeout(() => setToast(undefined), 8_000); };
  const persist = async (next: WorkspaceData, successMessage?: string) => {
    update(next);
    try {
      await flushWorkspaceSave(workspaceKey);
      if (successMessage) announce(successMessage);
      return true;
    } catch {
      resetWorkspaceSaveQueue(workspaceKey);
      const restored = await fetchWorkspace(workspaceKey, { allowCachedFallback: false });
      update(restored ?? workspace);
      announce(restored ? "保存失败，已恢复到最新已保存版本" : "保存失败，未能确认服务器状态；请重新加载");
      return false;
    }
  };
  const createDocument = async () => {
    if (creating) return;
    setCreating(true);
    const next = createWorkspaceDocument(workspace, projectId);
    const created = next.documents[0];
    if (await persist(next)) {
      window.location.assign(`/workspace/${workspaceKey}/design/${created.id}`);
    }
    setCreating(false);
  };
  const trash = async (document: WorkspaceDocument) => persist(patchWorkspaceDocument(workspace, document.id, { status: "trashed", trashedAt: new Date().toISOString() }), "已移至回收站");
  const restore = async (document: WorkspaceDocument) => { const projectExists = document.projectId && workspace.projects.some((project) => project.id === document.projectId); await persist(patchWorkspaceDocument(workspace, document.id, { status: "active", trashedAt: undefined, projectId: projectExists ? document.projectId : undefined }), "文档已恢复"); };
  const duplicate = async (document: WorkspaceDocument) => {
    const next = duplicateWorkspaceDocument(workspace, document.id, false);
    const copy = next.documents[0];
    if (!copy || copy.id === document.id) return;
    setSavingAction(true);
    try {
      await new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId }).cloneDocument(document.id, copy.id);
      await copyLocalDocument(document.id, copy.id);
      if (!await persist(saveWorkspace(next), "文档副本已创建")) {
        await new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId }).deleteDocument(copy.id).catch(() => undefined);
      }
    } catch { announce("复制失败，请重试"); }
    finally { setSavingAction(false); }
  };
  const purge = async (document: WorkspaceDocument) => {
    setSavingAction(true);
    try {
      if (!await persist(removeWorkspaceDocument(workspace, document.id))) return;
      try {
        await new DocumentApiTransport({ baseUrl: documentApiUrl, tenantId: localDevTenantId, actorId: localDevActorId }).deleteDocument(document.id);
        await removeLocalDocument(document.id).catch(() => undefined);
        announce("文档已永久删除");
        setDialog(undefined);
      } catch {
        // The catalogue was removed first to invalidate the link immediately;
        // if durable cleanup rejects, restore that catalogue entry before
        // reporting failure so the document is not silently stranded.
        await persist(saveWorkspace(workspace));
        announce("永久删除失败，文档已恢复");
      }
    } catch { announce("永久删除失败，请重试"); }
    finally { setSavingAction(false); }
  };
  const confirmDialog = async () => {
    const name = draft.trim();
    if (dialog?.kind === "purge" && selected) { await purge(selected); return; }
    if (dialog?.kind === "rename" && selected && name) await persist(patchWorkspaceDocument(workspace, selected.id, { name }), "文档已重命名");
    if (dialog?.kind === "move" && selected) await persist(patchWorkspaceDocument(workspace, selected.id, { projectId: draft || undefined }), "文档已移动");
    if (dialog?.kind === "trash" && selected) await trash(selected);
    if (dialog?.kind === "project" && name) await persist(createWorkspaceProject(workspace, name), "项目已创建");
    if (dialog?.kind === "project-rename" && dialog.id && name) await persist(patchWorkspaceProject(workspace, dialog.id, { name }), "项目已重命名");
    if (dialog?.kind === "project-delete" && dialog.id && await persist(removeWorkspaceProject(workspace, dialog.id), "项目已删除")) setView("all");
    setDialog(undefined);
  };
  const projectDocumentCount = projectId ? workspace.documents.filter((document) => document.projectId === projectId && document.status !== "trashed").length : 0;

  return <main className="workspace-shell" onClick={() => setActiveMenu(undefined)}>
    <aside className="workspace-sidebar">
      <Link href={`/workspace/${workspaceKey}`} className="workspace-brand"><span className="workspace-logo">M</span><span>makefigma</span></Link>
      <div className="workspace-label"><strong>{workspace.name}</strong><span>测试工作区</span></div>
      <nav aria-label="工作区导航">
        <button className={view === "recent" ? "active" : ""} onClick={() => setView("recent")}>◷ <span>最近编辑</span></button>
        <button className={view === "all" ? "active" : ""} onClick={() => setView("all")}>▦ <span>全部文档</span><em>{workspace.documents.filter((document) => document.status !== "trashed").length}</em></button>
        <div className="sidebar-section"><span>项目</span><button aria-label="新建项目" onClick={() => openDialog("project")}>＋</button></div>
        <div className="project-list">{workspace.projects.map((project) => <button key={project.id} className={view === `project:${project.id}` ? "active" : ""} onClick={() => setView(`project:${project.id}`)}><i /> <span>{project.name}</span><em>{workspace.documents.filter((document) => document.projectId === project.id && document.status !== "trashed").length}</em></button>)}</div>
        <button className={view === "trash" ? "active" : ""} onClick={() => setView("trash")}>⌫ <span>回收站</span></button>
      </nav>
      <p className="workspace-warning">测试环境，请勿存放正式或敏感资料。</p>
    </aside>
    <section className="workspace-content">
      {conflict && <div className="workspace-conflict" role="alert">该工作区已在其他窗口发生变化。<button onClick={() => window.location.reload()}>重新加载最新版本</button></div>}
      <header className="workspace-toolbar">
        <div><p className="eyebrow">{workspace.name}</p><h1>{title}<span>{documents.length}</span></h1></div>
        <div className="toolbar-actions"><label className="workspace-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文档或项目" aria-label="搜索文档或项目" /></label><select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="排序方式"><option value="updated-desc">最近修改</option><option value="updated-asc">最早修改</option><option value="created-desc">创建时间：最新</option><option value="created-asc">创建时间：最早</option><option value="name-asc">文档名称：A–Z</option><option value="name-desc">文档名称：Z–A</option></select><div className="view-toggle"><button className={layout === "grid" ? "active" : ""} onClick={() => setLayout("grid")} aria-label="卡片视图">▦</button><button className={layout === "list" ? "active" : ""} onClick={() => setLayout("list")} aria-label="列表视图">☷</button></div>{view !== "trash" && <button className="new-document" disabled={creating} onClick={createDocument}>{creating ? "正在创建…" : "＋ 新建设计文档"}</button>}</div>
      </header>
      {view.startsWith("project:") && <div className="project-context"><span>项目 · {workspace.projects.find((project) => project.id === projectId)?.description || "暂无描述"}</span><button onClick={() => openDialog("project-rename", projectId, title)}>重命名</button><button disabled={projectDocumentCount > 0} title={projectDocumentCount ? "项目中仍有文档，无法删除" : "删除空项目"} onClick={() => openDialog("project-delete", projectId)}>删除项目</button></div>}
      {documents.length === 0 ? <EmptyState view={view} query={query} onClear={() => setSearch("")} onCreate={() => void createDocument()} /> : <div className={layout === "grid" ? "document-grid" : "document-list"}>{layout === "list" && <div className="document-list-head"><span>文档名称</span><span>所属项目</span><span>创建时间</span><span>最近修改</span><span>状态</span><span /></div>}{documents.map((document) => <DocumentItem key={document.id} document={document} workspaceKey={workspaceKey} projectName={projectName(document.projectId)} layout={layout} menuOpen={activeMenu === document.id} onMenu={(event) => { event.stopPropagation(); setActiveMenu(activeMenu === document.id ? undefined : document.id); }} onAction={(action) => { if (action === "open") window.location.assign(`/workspace/${workspaceKey}/design/${document.id}`); if (action === "restore") void restore(document); if (action === "rename") openDialog("rename", document.id, document.name); if (action === "copy") void duplicate(document); if (action === "move") openDialog("move", document.id, document.projectId ?? ""); if (action === "trash") openDialog("trash", document.id); if (action === "purge") openDialog("purge", document.id); }} />)}</div>}
    </section>
    {dialog && <Dialog title={dialog.kind === "trash" ? "移至回收站" : dialog.kind === "purge" ? "永久删除文档" : dialog.kind === "move" ? "移动到项目" : dialog.kind === "project" ? "新建项目" : dialog.kind === "project-delete" ? "删除项目" : "重命名"} onClose={() => setDialog(undefined)}>
      {dialog.kind === "trash" && selected && <p>确定将“{selected.name}”移至回收站吗？所有通过当前工作区链接访问的用户都将无法继续打开该文档。你可以稍后从回收站恢复。</p>}
      {dialog.kind === "purge" && selected && <p>永久删除“{selected.name}”？该操作无法撤销，文档内容也无法恢复。</p>}
      {dialog.kind === "move" && selected && <select className="dialog-input" value={draft} onChange={(event) => setDraft(event.target.value)}><option value="">未分组</option>{workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.id === selected.projectId ? "（当前位置）" : ""}</option>)}</select>}
      {["rename", "project", "project-rename"].includes(dialog.kind) && <input className="dialog-input" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setDialog(undefined); }} maxLength={dialog.kind === "project" || dialog.kind === "project-rename" ? 50 : 100} />}
      <footer><button className="secondary-button" disabled={savingAction} onClick={() => setDialog(undefined)}>取消</button><button disabled={savingAction} className={dialog.kind === "trash" || dialog.kind === "purge" || dialog.kind === "project-delete" ? "danger-button" : "primary-button"} onClick={() => void confirmDialog()}>{savingAction ? "正在保存…" : dialog.kind === "move" ? "完成" : dialog.kind === "trash" ? "移至回收站" : dialog.kind === "purge" ? "永久删除" : dialog.kind === "project-delete" ? "删除项目" : "保存"}</button></footer>
    </Dialog>}
    {toast && <div className="workspace-toast" role="status">{toast.message}{toast.undo && <button onClick={() => { toast.undo?.(); setToast(undefined); }}>撤销</button>}</div>}
  </main>;
}

function DocumentItem({ document, workspaceKey, projectName, layout, menuOpen, onMenu, onAction }: { document: WorkspaceDocument; workspaceKey: string; projectName: string; layout: "grid" | "list"; menuOpen: boolean; onMenu: (event: React.MouseEvent) => void; onAction: (action: string) => void }) {
  const href = `/workspace/${workspaceKey}/design/${document.id}`;
  const time = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(Math.round((new Date(document.updatedAt).getTime() - Date.now()) / 3_600_000), "hour");
  return <article className={`document-item ${layout}`} onDoubleClick={() => document.status !== "trashed" && onAction("open")}><Link href={href} className={`thumbnail ${document.thumbnail}`} aria-label={`打开 ${document.name}`} onClick={(event) => document.status === "trashed" && event.preventDefault()}><span className="canvas-shape one" /><span className="canvas-shape two" /><span className="canvas-shape three" /></Link><div className="document-info"><Link href={href} onClick={(event) => document.status === "trashed" && event.preventDefault()} title={document.name}>{document.name}</Link><span>{projectName}</span>{layout === "list" && <><span>{new Date(document.createdAt).toLocaleDateString("zh-CN")}</span><span>{time}</span><span className={`status ${document.status}`}>{document.status === "trashed" ? "回收站" : document.status === "conflicted" ? "发生冲突" : "已保存"}</span></>}</div><div className="item-actions"><button aria-label={`${document.name} 的更多操作`} onClick={onMenu}>•••</button>{menuOpen && <div className="document-menu" onClick={(event) => event.stopPropagation()}>{document.status === "trashed" ? <><button onClick={() => onAction("restore")}>恢复</button><button className="menu-danger" onClick={() => onAction("purge")}>永久删除</button></> : <><button onClick={() => onAction("open")}>打开</button><a href={href} target="_blank" rel="noreferrer">在新标签页打开</a><button onClick={() => onAction("rename")}>重命名</button><button onClick={() => onAction("copy")}>复制</button><button onClick={() => onAction("move")}>移动到项目</button><hr /><button className="menu-danger" onClick={() => onAction("trash")}>移至回收站</button></>}</div>}</div></article>;
}

function EmptyState({ view, query, onClear, onCreate }: { view: View; query: string; onClear: () => void; onCreate: () => void }) {
  if (query) return <div className="workspace-empty"><span>⌕</span><h2>没有找到相关设计文档</h2><p>没有找到与“{query}”相关的设计文档。</p><button className="secondary-button" onClick={onClear}>清除搜索</button></div>;
  if (view === "trash") return <div className="workspace-empty"><span>⌫</span><h2>回收站是空的</h2><p>移至回收站的文档会显示在这里。</p></div>;
  return <div className="workspace-empty"><span>＋</span><h2>{view.startsWith("project:") ? "这个项目中还没有设计文档" : "还没有设计文档"}</h2><p>从一个空白画布开始，随时可以继续编辑。</p><button className="primary-button" onClick={onCreate}>新建设计文档</button></div>;
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="workspace-dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button onClick={onClose} aria-label="关闭">×</button></header>{children}</section></div>;
}
