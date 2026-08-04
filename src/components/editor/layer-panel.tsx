"use client";

import { memo } from "react";
import type { CanvasNode } from "@/lib/editor-protocol";
import { VirtualLayerList } from "./virtual-layer-list";

export const LayerPanel = memo(function LayerPanel({ nodes, selectedIds, canEdit, onSelect, onCreateFrame, onCreateRectangle, onCreateText }: {
  nodes: readonly CanvasNode[];
  selectedIds: readonly string[];
  canEdit: boolean;
  onSelect(id: string): void;
  onCreateFrame(): void;
  onCreateRectangle(): void;
  onCreateText(): void;
}) {
  return <section className="layers-panel panel" aria-label="Layers">
    <div className="panel-heading"><span>Layers</span><button disabled={!canEdit} onClick={onCreateFrame} aria-label="Create frame">+</button></div>
    <div className="page-label"><span className="page-square" />Page 1</div>
    <VirtualLayerList nodes={nodes} selectedIds={selectedIds} onSelect={onSelect} />
    <div className="quick-add"><p>New layer</p><div><button disabled={!canEdit} onClick={onCreateRectangle}>Rectangle</button><button disabled={!canEdit} onClick={onCreateText}>Text</button></div></div>
  </section>;
});
