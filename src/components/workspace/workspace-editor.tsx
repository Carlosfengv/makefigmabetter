"use client";

import { useEffect, useState } from "react";
import { EditorShell } from "@/components/editor/editor-shell";
import { fetchWorkspace, loadWorkspace, patchWorkspaceDocument, resetWorkspaceSaveQueue, type WorkspaceDocument } from "@/lib/workspace-store";

export function WorkspaceEditor({ workspaceKey, documentId }: { workspaceKey: string; documentId: string }) {
  const [document, setDocument] = useState<WorkspaceDocument>();
  const [missing, setMissing] = useState<"workspace" | "document" | "trashed">();
  const [saveError, setSaveError] = useState(false);
  useEffect(() => { let active = true; void fetchWorkspace(workspaceKey).then((workspace) => {
    if (!active) return;
    if (!workspace) { setMissing("workspace"); return; }
    const item = workspace.documents.find((candidate) => candidate.id === documentId);
    if (!item) { setMissing("document"); return; }
    if (item.status === "trashed") { setMissing("trashed"); return; }
    setDocument(item);
    patchWorkspaceDocument(workspace, item.id, { lastOpenedAt: new Date().toISOString() });
  }); return () => { active = false; }; }, [documentId, workspaceKey]);
  useEffect(() => {
    const onSaveError = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string }>).detail;
      if (detail.key !== workspaceKey) return;
      setSaveError(true);
      void fetchWorkspace(workspaceKey, { allowCachedFallback: false }).then((latest) => {
        if (!latest) return;
        resetWorkspaceSaveQueue(workspaceKey);
        const item = latest.documents.find((candidate) => candidate.id === documentId);
        if (item && item.status === "active") setDocument(item);
      });
    };
    window.addEventListener("makefigma:workspace-save-error", onSaveError);
    return () => window.removeEventListener("makefigma:workspace-save-error", onSaveError);
  }, [documentId, workspaceKey]);
  if (missing) return <main className="workspace-error"><span className="workspace-logo">M</span><h1>{missing === "workspace" ? "工作区不存在" : missing === "trashed" ? "文档已进入回收站" : "文档不存在或已被删除"}</h1><p>{missing === "trashed" ? "请先在回收站恢复该文档，再继续编辑。" : "该链接可能已失效。返回工作区后可以新建设计文档。"}</p><a className="primary-button" href={`/workspace/${workspaceKey}`}>返回工作区</a></main>;
  if (!document) return <main className="workspace-error"><span className="workspace-logo">M</span><p>正在加载设计文档…</p></main>;
  return <><>{saveError && <div className="workspace-conflict" role="alert">文档目录保存失败，已恢复最近一次服务器数据。<button onClick={() => window.location.reload()}>重新加载</button></div>}</><EditorShell documentId={document.id} documentName={document.name} workspaceHref={`/workspace/${workspaceKey}`} writerLock={false} onRenameDocument={(name) => {
    const workspace = loadWorkspace(workspaceKey);
    if (!workspace) return;
    const next = patchWorkspaceDocument(workspace, document.id, { name });
    const updated = next.documents.find((candidate) => candidate.id === document.id);
    if (updated) setDocument(updated);
  }} onDocumentSaved={(version) => {
    const workspace = loadWorkspace(workspaceKey);
    if (workspace) patchWorkspaceDocument(workspace, document.id, { version });
  }} /></>;
}
