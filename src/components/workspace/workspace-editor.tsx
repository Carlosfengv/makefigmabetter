"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FileQuestion, LoaderCircle } from "lucide-react";
import { EditorShell } from "@/components/editor/editor-shell";
import {
  fetchWorkspace,
  loadWorkspace,
  patchWorkspaceDocument,
  resetWorkspaceSaveQueue,
  TEST_OPERATIONS_DASHBOARD_ID,
  type WorkspaceDocument,
} from "@/lib/workspace-store";

export function WorkspaceEditor({
  workspaceKey,
  documentId,
}: {
  workspaceKey: string;
  documentId: string;
}) {
  const [document, setDocument] = useState<WorkspaceDocument>();
  const [missing, setMissing] = useState<
    "workspace" | "document" | "trashed"
  >();
  const [saveError, setSaveError] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchWorkspace(workspaceKey).then((workspace) => {
      if (!active) return;
      if (!workspace) {
        setMissing("workspace");
        return;
      }
      const item = workspace.documents.find(
        (candidate) => candidate.id === documentId,
      );
      if (!item) {
        setMissing("document");
        return;
      }
      if (item.status === "trashed") {
        setMissing("trashed");
        return;
      }
      setDocument(item);
      patchWorkspaceDocument(
        workspace,
        item.id,
        { lastOpenedAt: new Date().toISOString() },
        { suppressConflict: true },
      );
    });
    return () => {
      active = false;
    };
  }, [documentId, workspaceKey]);
  useEffect(() => {
    const onSaveError = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string }>).detail;
      if (detail.key !== workspaceKey) return;
      setSaveError(true);
      void fetchWorkspace(workspaceKey, { allowCachedFallback: false }).then(
        (latest) => {
          if (!latest) return;
          resetWorkspaceSaveQueue(workspaceKey);
          const item = latest.documents.find(
            (candidate) => candidate.id === documentId,
          );
          if (item && item.status === "active") setDocument(item);
        },
      );
    };
    window.addEventListener("makefigma:workspace-save-error", onSaveError);
    return () =>
      window.removeEventListener("makefigma:workspace-save-error", onSaveError);
  }, [documentId, workspaceKey]);
  if (missing)
    return (
      <main className="grid min-h-svh place-items-center p-6">
        <Empty className="max-w-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileQuestion />
            </EmptyMedia>
            <EmptyTitle>
              {missing === "workspace"
                ? "工作区不存在"
                : missing === "trashed"
                  ? "文档已进入回收站"
                  : "文档不存在或已被删除"}
            </EmptyTitle>
            <EmptyDescription>
              {missing === "trashed"
                ? "请先在回收站恢复该文档，再继续编辑。"
                : "该链接可能已失效。返回工作区后可以新建设计文档。"}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<a href={`/workspace/${workspaceKey}`} />}>
              返回工作区
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    );
  if (!document)
    return (
      <main className="grid min-h-svh place-items-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在加载设计文档…
        </div>
      </main>
    );
  return (
    <>
      {saveError && (
        <Alert className="fixed top-3 left-1/2 z-50 w-auto max-w-lg -translate-x-1/2 shadow-lg">
          <AlertDescription className="flex items-center gap-3">
            文档目录保存失败，已恢复最近一次服务器数据。
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => window.location.reload()}
            >
              重新加载
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <EditorShell
        documentId={document.id}
        documentName={document.name}
        workspaceHref={`/workspace/${workspaceKey}`}
        writerLock={false}
        initialFixture={
          document.id === TEST_OPERATIONS_DASHBOARD_ID
            ? "test-operations-dashboard"
            : undefined
        }
        onRenameDocument={(name) => {
          const workspace = loadWorkspace(workspaceKey);
          if (!workspace) return;
          const next = patchWorkspaceDocument(workspace, document.id, { name });
          const updated = next.documents.find(
            (candidate) => candidate.id === document.id,
          );
          if (updated) setDocument(updated);
        }}
        onDocumentSaved={(version) => {
          const workspace = loadWorkspace(workspaceKey);
          // The document service is authoritative for editor operations. This
          // catalogue version is display metadata only, so another tab updating
          // recency must not surface as an editor-save failure after a successful
          // Core transaction.
          if (workspace)
            patchWorkspaceDocument(
              workspace,
              document.id,
              { version },
              { suppressConflict: true },
            );
        }}
      />
    </>
  );
}
