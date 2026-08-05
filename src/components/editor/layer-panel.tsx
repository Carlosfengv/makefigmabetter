"use client";

import { memo } from "react";
import type { CanvasNode, CanvasPage } from "@/lib/editor-protocol";
import { sortNodesByLayerOrder, type LayerOrderAction } from "@/lib/layer-order";
import { VirtualLayerList } from "./virtual-layer-list";

export const LayerPanel = memo(function LayerPanel({ nodes, pages, activePageId, selectedIds, canEdit, onSelect, onDropBefore, onReorder, onSelectPage, onCreatePage, onCreateFrame, onCreateRectangle, onCreateText }: {
  nodes: readonly CanvasNode[];
  pages: readonly CanvasPage[];
  activePageId: string;
  selectedIds: readonly string[];
  canEdit: boolean;
  onSelect(id: string): void;
  onDropBefore(draggedId: string, beforeId?: string): void;
  onReorder(action: LayerOrderAction): void;
  onSelectPage(id: string): void;
  onCreatePage(): void;
  onCreateFrame(): void;
  onCreateRectangle(): void;
  onCreateText(): void;
}) {
  return <section className="layers-panel panel" aria-label="Layers">
    <div className="panel-heading"><span>Layers</span><button disabled={!canEdit} onClick={onCreateFrame} aria-label="Create frame">+</button></div>
    <div className="page-list" role="list" aria-label="Pages">{pages.map((page) => <button key={page.id} type="button" role="listitem" className={`page-label ${page.id === activePageId ? "active" : ""}`} aria-current={page.id === activePageId ? "page" : undefined} onClick={() => onSelectPage(page.id)}><span className="page-square" />{page.name}</button>)}<button type="button" className="page-add" disabled={!canEdit} onClick={onCreatePage} aria-label="Create page">+</button></div>
    <VirtualLayerList nodes={sortNodesByLayerOrder(nodes)} selectedIds={selectedIds} canEdit={canEdit} onSelect={onSelect} onDropBefore={onDropBefore} />
    <div className="layer-order-actions" role="group" aria-label="Layer order">
      <button disabled={!canEdit || !selectedIds.length} title="Send to back (⌘⌥[)" onClick={() => onReorder("back")}>⇤</button><button disabled={!canEdit || !selectedIds.length} title="Send backward (⌘[)" onClick={() => onReorder("backward")}>←</button><button disabled={!canEdit || !selectedIds.length} title="Bring forward (⌘])" onClick={() => onReorder("forward")}>→</button><button disabled={!canEdit || !selectedIds.length} title="Bring to front (⌘⌥])" onClick={() => onReorder("front")}>⇥</button>
    </div>
    <div className="quick-add"><p>New layer</p><div><button disabled={!canEdit} onClick={onCreateRectangle}>Rectangle</button><button disabled={!canEdit} onClick={onCreateText}>Text</button></div></div>
  </section>;
});
