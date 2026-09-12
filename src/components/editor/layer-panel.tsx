"use client";

import { memo, useMemo } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Frame,
  Plus,
  Square,
  Type,
} from "lucide-react";
import type { CanvasNode, CanvasPage } from "@/lib/editor-protocol";
import {
  sortNodesByLayerOrder,
  type LayerOrderAction,
} from "@/lib/layer-order";
import type { LayerNestingIntent } from "@/lib/layer-keyboard-nesting";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { VirtualLayerList } from "./virtual-layer-list";

export const LayerPanel = memo(function LayerPanel({
  nodes,
  pages,
  activePageId,
  selectedIds,
  canEdit,
  loading,
  onSelect,
  onDrop,
  onNest,
  onRename,
  onReorder,
  onSelectPage,
  onCreatePage,
  onCreateFrame,
  onCreateRectangle,
  onCreateText,
}: {
  nodes: readonly CanvasNode[];
  pages: readonly CanvasPage[];
  activePageId: string;
  selectedIds: readonly string[];
  canEdit: boolean;
  loading?: boolean;
  onSelect(id: string, options?: { additive?: boolean }): void;
  onDrop(
    draggedId: string,
    target?: { beforeId?: string; parentId?: string },
  ): void;
  onNest(id: string, intent: LayerNestingIntent): void;
  onRename(id: string, name: string): void;
  onReorder(action: LayerOrderAction): void;
  onSelectPage(id: string): void;
  onCreatePage(): void;
  onCreateFrame(): void;
  onCreateRectangle(): void;
  onCreateText(): void;
}) {
  const orderedNodes = useMemo(
    () => (loading ? [] : sortNodesByLayerOrder(nodes).reverse()),
    [loading, nodes],
  );

  return (
    <section
      className="flex min-h-0 flex-col border-r bg-background"
      aria-label="Layers"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-medium">图层</span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canEdit || loading}
          onClick={onCreateFrame}
          aria-label="Create frame"
        >
          <Plus />
        </Button>
      </div>
      <div className="space-y-1 p-2" role="list" aria-label="Pages">
        {loading ? (
          <div className="space-y-2 px-1 py-1" aria-hidden="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : pages.map((page) => (
          <Button
            key={page.id}
            type="button"
            role="listitem"
            variant={page.id === activePageId ? "secondary" : "ghost"}
            size="sm"
            className="w-full justify-start"
            aria-current={page.id === activePageId ? "page" : undefined}
            onClick={() => onSelectPage(page.id)}
          >
            <span className="size-2 rounded-sm bg-primary" />
            {page.name}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          disabled={!canEdit || loading}
          onClick={onCreatePage}
          aria-label="Create page"
        >
          <Plus />
        </Button>
      </div>
      <Separator />
      {loading ? (
        <div
          className="min-h-0 flex-1 space-y-2 overflow-hidden px-3 py-3"
          role="status"
          aria-label="正在加载图层"
        >
          {[88, 72, 80, 61, 76, 68, 84, 57, 74, 64, 79, 55].map(
            (width, index) => (
              <div
                key={`${width}-${index}`}
                className="flex h-7 items-center gap-2"
                style={{ paddingInlineStart: `${(index % 4) * 10}px` }}
                aria-hidden="true"
              >
                <Skeleton className="size-4 shrink-0 rounded-sm" />
                <Skeleton
                  className="h-3.5"
                  style={{ width: `${width}%` }}
                />
              </div>
            ),
          )}
          <span className="sr-only">正在加载图层</span>
        </div>
      ) : (
        <VirtualLayerList
          nodes={orderedNodes}
          selectedIds={selectedIds}
          canEdit={canEdit}
          onSelect={onSelect}
          onDrop={onDrop}
          onNest={onNest}
          onRename={onRename}
        />
      )}
      <div
        className="grid grid-cols-4 gap-1 border-t p-2"
        role="group"
        aria-label="Layer order"
      >
        <ArrangeButton
          label="Send to back"
          disabled={!canEdit || loading || !selectedIds.length}
          onClick={() => onReorder("back")}
        >
          <ArrowDownToLine />
        </ArrangeButton>
        <ArrangeButton
          label="Send backward"
          disabled={!canEdit || loading || !selectedIds.length}
          onClick={() => onReorder("backward")}
        >
          ↓
        </ArrangeButton>
        <ArrangeButton
          label="Bring forward"
          disabled={!canEdit || loading || !selectedIds.length}
          onClick={() => onReorder("forward")}
        >
          ↑
        </ArrangeButton>
        <ArrangeButton
          label="Bring to front"
          disabled={!canEdit || loading || !selectedIds.length}
          onClick={() => onReorder("front")}
        >
          <ArrowUpToLine />
        </ArrangeButton>
      </div>
      <div className="grid grid-cols-3 gap-1 border-t p-2">
        <Button
          variant="outline"
          size="xs"
          disabled={!canEdit || loading}
          onClick={onCreateFrame}
        >
          <Frame />
          Frame
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={!canEdit || loading}
          onClick={onCreateRectangle}
        >
          <Square />
          矩形
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={!canEdit || loading}
          onClick={onCreateText}
        >
          <Type />
          文本
        </Button>
      </div>
    </section>
  );
});

function ArrangeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
