"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock3,
  CopyIcon,
  ExternalLink,
  FilePlus2,
  Files,
  Folder,
  FolderInput,
  Grid2X2,
  List,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { toast as notify } from "sonner";
import {
  createWorkspaceDocument,
  createWorkspaceProject,
  duplicateWorkspaceDocument,
  fetchWorkspace,
  flushWorkspaceSave,
  patchWorkspaceDocument,
  patchWorkspaceProject,
  resetWorkspaceSaveQueue,
  removeWorkspaceDocument,
  removeWorkspaceProject,
  saveWorkspace,
  type WorkspaceData,
  type WorkspaceDocument,
} from "@/lib/workspace-store";
import { copyLocalDocument, removeLocalDocument } from "@/lib/local-document";
import { DocumentApiTransport } from "@/lib/document-api-transport";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

type View = "recent" | "all" | "trash" | `project:${string}`;
type Sort =
  | "updated-desc"
  | "updated-asc"
  | "created-desc"
  | "created-asc"
  | "name-asc"
  | "name-desc";
type DialogKind =
  | "rename"
  | "move"
  | "trash"
  | "purge"
  | "project"
  | "project-rename"
  | "project-delete";

const documentApiUrl =
  process.env.NEXT_PUBLIC_DOCUMENT_API_URL ?? "/document-api";
const localDevTenantId = "00000000-0000-0000-0000-000000000002";
const localDevActorId = "00000000-0000-0000-0000-000000000007";

export function WorkspaceShell({ workspaceKey }: { workspaceKey: string }) {
  const [workspace, setWorkspace] = useState<WorkspaceData>();
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("recent");
  const [layout, setLayout] = useState<"grid" | "list">(() => {
    if (typeof window === "undefined") return "grid";
    return window.localStorage.getItem("makefigma:workspace-view") === "list"
      ? "list"
      : "grid";
  });
  const [referenceNow] = useState(() => Date.now());
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated-desc");
  const [dialog, setDialog] = useState<{ kind: DialogKind; id?: string }>();
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dialogTrigger, setDialogTrigger] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWorkspace(workspaceKey).then((next) => {
      if (active) {
        setWorkspace(next);
        setLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, [workspaceKey]);
  useEffect(() => {
    const onConflict = (event: Event) => {
      setWorkspace((event as CustomEvent<WorkspaceData>).detail);
      setConflict(true);
    };
    window.addEventListener("makefigma:workspace-conflict", onConflict);
    return () =>
      window.removeEventListener("makefigma:workspace-conflict", onConflict);
  }, [workspaceKey]);
  useEffect(() => {
    window.localStorage.setItem("makefigma:workspace-view", layout);
  }, [layout]);
  useEffect(() => {
    debounce.current = setTimeout(
      () => setQuery(search.trim().toLocaleLowerCase()),
      300,
    );
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [search]);

  const projectId = view.startsWith("project:") ? view.slice(8) : undefined;
  const title =
    view === "recent"
      ? "最近编辑"
      : view === "all"
        ? "全部文档"
        : view === "trash"
          ? "回收站"
          : (workspace?.projects.find((project) => project.id === projectId)
              ?.name ?? "项目");
  const documents = useMemo(() => {
    if (!workspace) return [];
    const textMatches = (document: WorkspaceDocument) =>
      !query ||
      document.name.toLocaleLowerCase().includes(query) ||
      (document.projectId &&
        workspace.projects
          .find((project) => project.id === document.projectId)
          ?.name.toLocaleLowerCase()
          .includes(query));
    const filtered = workspace.documents.filter((document) => {
      if (!textMatches(document)) return false;
      if (view === "trash") return document.status === "trashed";
      if (document.status === "trashed") return false;
      if (projectId) return document.projectId === projectId;
      return true;
    });
    const recent =
      view === "recent"
        ? filtered
            .sort(
              (a, b) =>
                new Date(b.lastOpenedAt ?? b.updatedAt).getTime() -
                new Date(a.lastOpenedAt ?? a.updatedAt).getTime(),
            )
            .slice(0, 20)
        : filtered;
    return [...recent].sort((a, b) => {
      if (sort === "name-asc") return a.name.localeCompare(b.name, "zh");
      if (sort === "name-desc") return b.name.localeCompare(a.name, "zh");
      const field = sort.startsWith("created") ? "createdAt" : "updatedAt";
      const direction = sort.endsWith("asc") ? 1 : -1;
      return (
        direction *
        (new Date(a[field]).getTime() - new Date(b[field]).getTime())
      );
    });
  }, [projectId, query, sort, view, workspace]);

  if (!loaded) return <WorkspaceLoading />;
  if (!workspace) return <WorkspaceError workspaceKey={workspaceKey} />;

  const update = (next: WorkspaceData) => setWorkspace(next);
  const projectName = (id?: string) =>
    workspace.projects.find((project) => project.id === id)?.name ?? "未分组";
  const openDialog = (
    kind: DialogKind,
    id?: string,
    value = "",
    trigger?: EventTarget | null,
  ) => {
    setDialogTrigger(
      trigger instanceof HTMLElement
        ? trigger
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    );
    setDraft(value);
    setDialog({ kind, id });
  };
  const selected = dialog?.id
    ? workspace.documents.find((document) => document.id === dialog.id)
    : undefined;
  const announce = (message: string, undo?: () => void) =>
    notify(
      message,
      undo ? { action: { label: "撤销", onClick: undo } } : undefined,
    );
  const persist = async (next: WorkspaceData, successMessage?: string) => {
    update(next);
    try {
      await flushWorkspaceSave(workspaceKey);
      if (successMessage) announce(successMessage);
      return true;
    } catch {
      resetWorkspaceSaveQueue(workspaceKey);
      const restored = await fetchWorkspace(workspaceKey, {
        allowCachedFallback: false,
      });
      update(restored ?? workspace);
      announce(
        restored
          ? "保存失败，已恢复到最新已保存版本"
          : "保存失败，未能确认服务器状态；请重新加载",
      );
      return false;
    }
  };
  const createDocument = async () => {
    if (creating) return;
    setCreating(true);
    const next = createWorkspaceDocument(workspace, projectId);
    const created = next.documents[0];
    if (await persist(next))
      window.location.assign(`/workspace/${workspaceKey}/design/${created.id}`);
    setCreating(false);
  };
  const trash = async (document: WorkspaceDocument) =>
    persist(
      patchWorkspaceDocument(workspace, document.id, {
        status: "trashed",
        trashedAt: new Date().toISOString(),
      }),
      "已移至回收站",
    );
  const restore = async (document: WorkspaceDocument) => {
    const projectExists =
      document.projectId &&
      workspace.projects.some((project) => project.id === document.projectId);
    await persist(
      patchWorkspaceDocument(workspace, document.id, {
        status: "active",
        trashedAt: undefined,
        projectId: projectExists ? document.projectId : undefined,
      }),
      "文档已恢复",
    );
  };
  const duplicate = async (document: WorkspaceDocument) => {
    const next = duplicateWorkspaceDocument(workspace, document.id, false);
    const copy = next.documents[0];
    if (!copy || copy.id === document.id) return;
    setSavingAction(true);
    try {
      await new DocumentApiTransport({
        baseUrl: documentApiUrl,
        tenantId: localDevTenantId,
        actorId: localDevActorId,
      }).cloneDocument(document.id, copy.id);
      await copyLocalDocument(document.id, copy.id);
      if (!(await persist(saveWorkspace(next), "文档副本已创建")))
        await new DocumentApiTransport({
          baseUrl: documentApiUrl,
          tenantId: localDevTenantId,
          actorId: localDevActorId,
        })
          .deleteDocument(copy.id)
          .catch(() => undefined);
    } catch {
      announce("复制失败，请重试");
    } finally {
      setSavingAction(false);
    }
  };
  const purge = async (document: WorkspaceDocument) => {
    setSavingAction(true);
    try {
      if (!(await persist(removeWorkspaceDocument(workspace, document.id))))
        return;
      try {
        await new DocumentApiTransport({
          baseUrl: documentApiUrl,
          tenantId: localDevTenantId,
          actorId: localDevActorId,
        }).deleteDocument(document.id);
        await removeLocalDocument(document.id).catch(() => undefined);
        announce("文档已永久删除");
        setDialog(undefined);
      } catch {
        await persist(saveWorkspace(workspace));
        announce("永久删除失败，文档已恢复");
      }
    } catch {
      announce("永久删除失败，请重试");
    } finally {
      setSavingAction(false);
    }
  };
  const confirmDialog = async () => {
    const name = draft.trim();
    if (dialog?.kind === "purge" && selected) {
      await purge(selected);
      return;
    }
    if (dialog?.kind === "rename" && selected && name)
      await persist(
        patchWorkspaceDocument(workspace, selected.id, { name }),
        "文档已重命名",
      );
    if (dialog?.kind === "move" && selected)
      await persist(
        patchWorkspaceDocument(workspace, selected.id, {
          projectId: draft || undefined,
        }),
        "文档已移动",
      );
    if (dialog?.kind === "trash" && selected) await trash(selected);
    if (dialog?.kind === "project" && name)
      await persist(createWorkspaceProject(workspace, name), "项目已创建");
    if (dialog?.kind === "project-rename" && dialog.id && name)
      await persist(
        patchWorkspaceProject(workspace, dialog.id, { name }),
        "项目已重命名",
      );
    if (
      dialog?.kind === "project-delete" &&
      dialog.id &&
      (await persist(
        removeWorkspaceProject(workspace, dialog.id),
        "项目已删除",
      ))
    )
      setView("all");
    setDialog(undefined);
  };
  const projectDocumentCount = projectId
    ? workspace.documents.filter(
        (document) =>
          document.projectId === projectId && document.status !== "trashed",
      ).length
    : 0;
  const actionContext = { workspaceKey, restore, duplicate, openDialog };

  return (
    <SidebarProvider
      style={{ "--sidebar-width": "16rem" } as React.CSSProperties}
    >
      <Sidebar collapsible="offcanvas" className="border-r">
        <SidebarHeader className="gap-3 border-b p-4">
          <Link
            href={`/workspace/${workspaceKey}`}
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
              M
            </span>
            <span>makefigma</span>
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{workspace.name}</p>
            <p className="text-xs text-muted-foreground">测试工作区</p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <WorkspaceNavItem
                  active={view === "recent"}
                  icon={<Clock3 />}
                  label="最近编辑"
                  onClick={() => setView("recent")}
                />
                <WorkspaceNavItem
                  active={view === "all"}
                  icon={<Files />}
                  label="全部文档"
                  count={
                    workspace.documents.filter(
                      (document) => document.status !== "trashed",
                    ).length
                  }
                  onClick={() => setView("all")}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>项目</SidebarGroupLabel>
            <SidebarGroupAction
              aria-label="新建项目"
              onClick={(event) =>
                openDialog("project", undefined, "", event.currentTarget)
              }
            >
              <Plus />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {workspace.projects.map((project) => (
                  <WorkspaceNavItem
                    key={project.id}
                    active={view === `project:${project.id}`}
                    icon={<Folder />}
                    label={project.name}
                    count={
                      workspace.documents.filter(
                        (document) =>
                          document.projectId === project.id &&
                          document.status !== "trashed",
                      ).length
                    }
                    onClick={() => setView(`project:${project.id}`)}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <SidebarMenu>
                <WorkspaceNavItem
                  active={view === "trash"}
                  icon={<Trash2 />}
                  label="回收站"
                  onClick={() => setView("trash")}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t p-4 text-xs leading-relaxed text-muted-foreground">
          测试环境，请勿存放正式或敏感资料。
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex min-h-16 flex-col gap-4 border-b px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger className="md:hidden" />
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">
                {workspace.name}
              </p>
              <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {title}
                <Badge variant="secondary">{documents.length}</Badge>
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-48 flex-1 md:w-64 md:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索文档或项目"
                aria-label="搜索文档或项目"
              />
            </label>
            <NativeSelect
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
              aria-label="排序方式"
            >
              <NativeSelectOption value="updated-desc">
                最近修改
              </NativeSelectOption>
              <NativeSelectOption value="updated-asc">
                最早修改
              </NativeSelectOption>
              <NativeSelectOption value="created-desc">
                创建时间：最新
              </NativeSelectOption>
              <NativeSelectOption value="created-asc">
                创建时间：最早
              </NativeSelectOption>
              <NativeSelectOption value="name-asc">
                文档名称：A–Z
              </NativeSelectOption>
              <NativeSelectOption value="name-desc">
                文档名称：Z–A
              </NativeSelectOption>
            </NativeSelect>
            <div className="flex rounded-lg border p-0.5">
              <Button
                variant={layout === "grid" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => setLayout("grid")}
                aria-label="卡片视图"
              >
                <Grid2X2 />
              </Button>
              <Button
                variant={layout === "list" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => setLayout("list")}
                aria-label="列表视图"
              >
                <List />
              </Button>
            </div>
            {view !== "trash" && (
              <Button disabled={creating} onClick={createDocument}>
                {creating ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <FilePlus2 />
                )}
                新建设计文档
              </Button>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          {conflict && (
            <Alert className="mb-4">
              <AlertDescription className="flex items-center justify-between gap-3">
                该工作区已在其他窗口发生变化。
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => window.location.reload()}
                >
                  重新加载最新版本
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {view.startsWith("project:") && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className="mr-auto text-muted-foreground">
                {workspace.projects.find((project) => project.id === projectId)
                  ?.description || "暂无项目描述"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) =>
                  openDialog(
                    "project-rename",
                    projectId,
                    title,
                    event.currentTarget,
                  )
                }
              >
                重命名
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={projectDocumentCount > 0}
                title={
                  projectDocumentCount
                    ? "项目中仍有文档，无法删除"
                    : "删除空项目"
                }
                onClick={(event) =>
                  openDialog(
                    "project-delete",
                    projectId,
                    "",
                    event.currentTarget,
                  )
                }
              >
                删除项目
              </Button>
            </div>
          )}
          {documents.length === 0 ? (
            <WorkspaceEmpty
              view={view}
              query={query}
              onClear={() => setSearch("")}
              onCreate={() => void createDocument()}
            />
          ) : layout === "grid" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {documents.map((document) => (
                <DocumentCard
                  key={document.id}
                  document={document}
                  workspaceKey={workspaceKey}
                  projectName={projectName(document.projectId)}
                  referenceNow={referenceNow}
                  onAction={(action, trigger) =>
                    handleDocumentAction(
                      action,
                      document,
                      trigger,
                      actionContext,
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <div className="hidden grid-cols-[minmax(220px,2fr)_minmax(120px,1fr)_110px_110px_90px_36px] items-center gap-4 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
                <span>文档名称</span>
                <span>所属项目</span>
                <span>创建时间</span>
                <span>最近修改</span>
                <span>状态</span>
                <span />
              </div>
              {documents.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  workspaceKey={workspaceKey}
                  projectName={projectName(document.projectId)}
                  referenceNow={referenceNow}
                  onAction={(action, trigger) =>
                    handleDocumentAction(
                      action,
                      document,
                      trigger,
                      actionContext,
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      </SidebarInset>

      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
      >
        {dialog && (
          <DialogContent
            className="sm:max-w-md"
            finalFocus={() => dialogTrigger}
          >
            <DialogHeader>
              <DialogTitle>{dialogTitle(dialog.kind)}</DialogTitle>
              <DialogDescription>
                {dialogDescription(dialog.kind, selected?.name)}
              </DialogDescription>
            </DialogHeader>
            {dialog.kind === "move" && selected && (
              <NativeSelect
                className="w-full"
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              >
                <NativeSelectOption value="">未分组</NativeSelectOption>
                {workspace.projects.map((project) => (
                  <NativeSelectOption key={project.id} value={project.id}>
                    {project.name}
                    {project.id === selected.projectId ? "（当前位置）" : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            {["rename", "project", "project-rename"].includes(dialog.kind) && (
              <Input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void confirmDialog();
                }}
                maxLength={
                  dialog.kind === "project" || dialog.kind === "project-rename"
                    ? 50
                    : 100
                }
              />
            )}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={savingAction}
                onClick={() => setDialog(undefined)}
              >
                取消
              </Button>
              <Button
                disabled={savingAction}
                variant={
                  ["trash", "purge", "project-delete"].includes(dialog.kind)
                    ? "destructive"
                    : "default"
                }
                onClick={() => void confirmDialog()}
              >
                {savingAction && <LoaderCircle className="animate-spin" />}
                {dialogActionLabel(dialog.kind)}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </SidebarProvider>
  );
}

function WorkspaceNavItem({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={onClick}>
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
      {count !== undefined && <SidebarMenuBadge>{count}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

type DocumentItemProps = {
  document: WorkspaceDocument;
  workspaceKey: string;
  projectName: string;
  referenceNow: number;
  onAction: (action: string, trigger?: HTMLElement) => void;
};

function DocumentCard({
  document,
  workspaceKey,
  projectName,
  referenceNow,
  onAction,
}: DocumentItemProps) {
  const href = `/workspace/${workspaceKey}/design/${document.id}`;
  const time = relativeTime(document.updatedAt, referenceNow);
  return (
    <Card
      className="group gap-0 overflow-hidden py-0 transition-colors hover:bg-muted/20"
      onDoubleClick={() => document.status !== "trashed" && onAction("open")}
    >
      <Link
        href={href}
        className={`relative aspect-[4/3] overflow-hidden border-b ${thumbnailClasses[document.thumbnail] ?? "bg-muted"}`}
        aria-label={`打开 ${document.name}`}
        onClick={(event) =>
          document.status === "trashed" && event.preventDefault()
        }
      >
        <span className="absolute top-[36%] left-[23%] h-[28%] w-[43%] rounded-full bg-background/90" />
        <span className="absolute top-[27%] right-[18%] size-8 rounded-full bg-foreground/20" />
        <span className="absolute bottom-[29%] left-[32%] h-1 w-[31%] rounded-full bg-foreground/70" />
      </Link>
      <CardContent className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 p-3">
        <div className="min-w-0">
          <Link
            href={href}
            className="block truncate text-sm font-medium hover:underline"
            onClick={(event) =>
              document.status === "trashed" && event.preventDefault()
            }
          >
            {document.name}
          </Link>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {projectName} · {time}
          </p>
        </div>
        <DocumentActions document={document} href={href} onAction={onAction} />
      </CardContent>
    </Card>
  );
}

function DocumentRow({
  document,
  workspaceKey,
  projectName,
  referenceNow,
  onAction,
}: DocumentItemProps) {
  const href = `/workspace/${workspaceKey}/design/${document.id}`;
  return (
    <div
      className="grid min-h-16 grid-cols-[minmax(0,1fr)_36px] items-center gap-3 border-b px-4 py-2 last:border-b-0 md:grid-cols-[minmax(220px,2fr)_minmax(120px,1fr)_110px_110px_90px_36px] md:gap-4"
      onDoubleClick={() => document.status !== "trashed" && onAction("open")}
    >
      <Link
        href={href}
        className="min-w-0 truncate text-sm font-medium hover:underline"
        onClick={(event) =>
          document.status === "trashed" && event.preventDefault()
        }
      >
        {document.name}
      </Link>
      <span className="hidden truncate text-sm text-muted-foreground md:block">
        {projectName}
      </span>
      <span className="hidden text-sm text-muted-foreground md:block">
        {new Date(document.createdAt).toLocaleDateString("zh-CN")}
      </span>
      <span className="hidden text-sm text-muted-foreground md:block">
        {relativeTime(document.updatedAt, referenceNow)}
      </span>
      <Badge
        className="hidden w-fit md:inline-flex"
        variant={
          document.status === "trashed"
            ? "outline"
            : document.status === "conflicted"
              ? "destructive"
              : "secondary"
        }
      >
        {document.status === "trashed"
          ? "回收站"
          : document.status === "conflicted"
            ? "发生冲突"
            : "已保存"}
      </Badge>
      <DocumentActions document={document} href={href} onAction={onAction} />
    </div>
  );
}

function DocumentActions({
  document,
  href,
  onAction,
}: {
  document: WorkspaceDocument;
  href: string;
  onAction: (action: string, trigger?: HTMLElement) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${document.name} 的更多操作`}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {document.status === "trashed" ? (
          <>
            <DropdownMenuItem
              onClick={(event) => onAction("restore", event.currentTarget)}
            >
              <RotateCcw />
              恢复
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={(event) => onAction("purge", event.currentTarget)}
            >
              <Trash2 />
              永久删除
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={() => onAction("open")}>
              <Files />
              打开
            </DropdownMenuItem>
            <DropdownMenuItem
              render={<a href={href} target="_blank" rel="noreferrer" />}
            >
              <ExternalLink />
              在新标签页打开
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(event) => onAction("rename", event.currentTarget)}
            >
              <Pencil />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction("copy")}>
              <CopyIcon />
              复制
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(event) => onAction("move", event.currentTarget)}
            >
              <FolderInput />
              移动到项目
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={(event) => onAction("trash", event.currentTarget)}
            >
              <Trash2 />
              移至回收站
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function handleDocumentAction(
  action: string,
  document: WorkspaceDocument,
  trigger: HTMLElement | undefined,
  context: {
    workspaceKey: string;
    restore: (document: WorkspaceDocument) => Promise<void>;
    duplicate: (document: WorkspaceDocument) => Promise<void>;
    openDialog: (
      kind: DialogKind,
      id?: string,
      value?: string,
      trigger?: EventTarget | null,
    ) => void;
  },
) {
  if (action === "open")
    window.location.assign(
      `/workspace/${context.workspaceKey}/design/${document.id}`,
    );
  if (action === "restore") void context.restore(document);
  if (action === "rename")
    context.openDialog("rename", document.id, document.name, trigger);
  if (action === "copy") void context.duplicate(document);
  if (action === "move")
    context.openDialog("move", document.id, document.projectId ?? "", trigger);
  if (action === "trash") context.openDialog("trash", document.id, "", trigger);
  if (action === "purge") context.openDialog("purge", document.id, "", trigger);
}

function WorkspaceEmpty({
  view,
  query,
  onClear,
  onCreate,
}: {
  view: View;
  query: string;
  onClear: () => void;
  onCreate: () => void;
}) {
  const searching = Boolean(query);
  const trashed = view === "trash";
  return (
    <Empty className="min-h-[55vh] border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {searching ? <Search /> : trashed ? <Trash2 /> : <FilePlus2 />}
        </EmptyMedia>
        <EmptyTitle>
          {searching
            ? "没有找到相关设计文档"
            : trashed
              ? "回收站是空的"
              : view.startsWith("project:")
                ? "这个项目中还没有设计文档"
                : "还没有设计文档"}
        </EmptyTitle>
        <EmptyDescription>
          {searching
            ? `没有找到与“${query}”相关的设计文档。`
            : trashed
              ? "移至回收站的文档会显示在这里。"
              : "从一个空白画布开始，随时可以继续编辑。"}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {searching ? (
          <Button variant="outline" onClick={onClear}>
            清除搜索
          </Button>
        ) : (
          !trashed && (
            <Button onClick={onCreate}>
              <Plus />
              新建设计文档
            </Button>
          )
        )}
      </EmptyContent>
    </Empty>
  );
}

function WorkspaceLoading() {
  return (
    <main className="grid min-h-svh grid-cols-[16rem_1fr]">
      <aside className="space-y-4 border-r p-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-12 w-full" />
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </aside>
      <section className="space-y-5 p-6">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="aspect-[4/3] w-full rounded-xl" />
          ))}
        </div>
      </section>
    </main>
  );
}

function WorkspaceError({ workspaceKey }: { workspaceKey: string }) {
  return (
    <main className="grid min-h-svh place-items-center p-6">
      <Empty className="max-w-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Files />
          </EmptyMedia>
          <EmptyTitle>工作区不存在</EmptyTitle>
          <EmptyDescription>
            工作区“{workspaceKey}”加载失败，请确认链接是否正确。
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}

function relativeTime(value: string, referenceNow: number) {
  return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(
    Math.round((new Date(value).getTime() - referenceNow) / 3_600_000),
    "hour",
  );
}

function dialogTitle(kind: DialogKind) {
  return kind === "trash"
    ? "移至回收站"
    : kind === "purge"
      ? "永久删除文档"
      : kind === "move"
        ? "移动到项目"
        : kind === "project"
          ? "新建项目"
          : kind === "project-delete"
            ? "删除项目"
            : "重命名";
}

function dialogDescription(kind: DialogKind, name?: string) {
  if (kind === "trash")
    return `确定将“${name ?? "该文档"}”移至回收站吗？你可以稍后恢复。`;
  if (kind === "purge")
    return `永久删除“${name ?? "该文档"}”？该操作无法撤销。`;
  if (kind === "project-delete") return "确定删除这个空项目吗？";
  if (kind === "move") return "选择文档的新归属项目。";
  if (kind === "project") return "为新项目输入一个清晰的名称。";
  return "输入新的名称并保存。";
}

function dialogActionLabel(kind: DialogKind) {
  return kind === "move"
    ? "完成"
    : kind === "trash"
      ? "移至回收站"
      : kind === "purge"
        ? "永久删除"
        : kind === "project-delete"
          ? "删除项目"
          : "保存";
}

const thumbnailClasses: Record<string, string> = {
  sun: "bg-amber-100",
  violet: "bg-violet-100",
  mint: "bg-emerald-100",
  sand: "bg-stone-100",
};
