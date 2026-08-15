"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "@/lib/editor-protocol";
import { LAYER_ROW_HEIGHT, virtualRange } from "@/lib/virtual-range";
import { layerKeyboardTarget, type LayerNavigationKey } from "@/lib/layer-keyboard-navigation";
import type { LayerNestingIntent } from "@/lib/layer-keyboard-nesting";
import { layerTreeRows } from "@/lib/layer-tree";

const MAX_LAYER_DOM_ROWS = 150;

function icon(kind: CanvasNode["kind"]) {
  return kind === "ellipse" ? "○" : kind === "polygon" ? "⬠" : kind === "star" ? "☆" : kind === "line" ? "／" : kind === "text" ? "T" : kind === "frame" ? "#" : kind === "section" ? "§" : kind === "group" ? "◇" : kind === "slice" ? "▣" : kind === "image" ? "▧" : "□";
}

export function VirtualLayerList({ nodes, selectedIds, canEdit, onSelect, onDrop, onNest, onRename }: {
  nodes: readonly CanvasNode[];
  selectedIds: readonly string[];
  canEdit: boolean;
  onSelect(id: string, options?: { additive?: boolean }): void;
  onDrop(draggedId: string, target?: { beforeId?: string; parentId?: string }): void;
  onNest(id: string, intent: LayerNestingIntent): void;
  onRename(id: string, name: string): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ scrollTop: 0, height: 0 });
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; inside: boolean }>();
  const [renaming, setRenaming] = useState<{ id: string; draft: string }>();
  const renamingRef = useRef<{ id: string; draft: string } | undefined>(undefined);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const selectedId = selectedIds[0];
  const treeNodes = useMemo(() => layerTreeRows(nodes, collapsedIds), [nodes, collapsedIds]);
  const renderedLayerIds = useMemo(() => treeNodes.map(({ node }) => node.id), [treeNodes]);
  const range = virtualRange(treeNodes.length, metrics.scrollTop, metrics.height);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const update = () => setMetrics({ scrollTop: element.scrollTop, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const index = treeNodes.findIndex(({ node }) => node.id === selectedId);
    if (index < 0 || !listRef.current) return;
    const top = index * LAYER_ROW_HEIGHT;
    const element = listRef.current;
    if (top < element.scrollTop || top + LAYER_ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - Math.max(0, (element.clientHeight - LAYER_ROW_HEIGHT) / 2));
    }
  }, [treeNodes, selectedId]);

  const moveKeyboardFocus = (event: React.KeyboardEvent<HTMLButtonElement>, row: (typeof treeNodes)[number]) => {
    const { node, depth, hasChildren, collapsed } = row;
    if (event.key === "Tab") {
      if (!canEdit) return;
      event.preventDefault();
      event.stopPropagation();
      onNest(node.id, event.shiftKey ? "outdent" : "indent");
      return;
    }
    if (event.key === "ArrowLeft") {
      if (hasChildren && !collapsed) {
        event.preventDefault();
        toggleCollapsed(node.id);
        return;
      }
      const parent = node.parentId && treeNodes.find((candidate) => candidate.node.id === node.parentId);
      if (parent) {
        event.preventDefault();
        onSelect(parent.node.id);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`button[data-layer-id="${parent.node.id}"]`)?.focus());
      }
      return;
    }
    if (event.key === "ArrowRight") {
      if (hasChildren && collapsed) {
        event.preventDefault();
        toggleCollapsed(node.id);
        return;
      }
      const index = treeNodes.indexOf(row);
      const child = hasChildren && index >= 0 ? treeNodes.slice(index + 1).find((candidate) => candidate.depth === depth + 1) : undefined;
      if (child) {
        event.preventDefault();
        onSelect(child.node.id);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`button[data-layer-id="${child.node.id}"]`)?.focus());
      }
      return;
    }
    if (!(["ArrowUp", "ArrowDown", "Home", "End"] as const).includes(event.key as LayerNavigationKey)) return;
    const target = layerKeyboardTarget(renderedLayerIds, node.id, event.key as LayerNavigationKey);
    if (!target || target === node.id) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(target);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`button[data-layer-id="${target}"]`)?.focus());
  };
  const focusLayerRow = (id: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`button[data-layer-id="${id}"]`)?.focus());
  const finishRename = (node: CanvasNode, save: boolean, restoreFocus: boolean) => {
    const current = renamingRef.current;
    // Enter causes the input to unmount, which can immediately emit blur. Use a
    // ref as the one-shot ownership token so that blur cannot enqueue the same
    // rename a second time.
    if (!current || current.id !== node.id) return;
    renamingRef.current = undefined;
    setRenaming(undefined);
    if (save) {
      const name = current.draft.trim();
      if (name && name !== node.name) onRename(node.id, name);
    }
    // A pointer-initiated blur should keep the pointer's new focus target. The
    // keyboard paths must instead return focus to their virtualized row.
    if (restoreFocus) focusLayerRow(node.id);
  };
  const beginRename = (event: React.KeyboardEvent<HTMLButtonElement>, node: CanvasNode) => {
    if (event.key !== "F2" || !canEdit) return false;
    event.preventDefault();
    event.stopPropagation();
    const next = { id: node.id, draft: node.name };
    renamingRef.current = next;
    setRenaming(next);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>(`input[data-layer-rename="${node.id}"]`)?.focus());
    return true;
  };
  const toggleCollapsed = (id: string) => setCollapsedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const rows = [];
  for (let virtualIndex = range.start; virtualIndex < range.end; virtualIndex += 1) {
    const row = treeNodes[virtualIndex];
    if (!row) continue;
    const { node, depth, hasChildren, collapsed } = row;
    rows.push(
      <div key={node.id} role="listitem" aria-setsize={treeNodes.length} aria-posinset={virtualIndex + 1}>
      {hasChildren && <button type="button" className="layer-collapse" style={{ transform: `translateY(${virtualIndex * LAYER_ROW_HEIGHT}px)`, left: `${8 + depth * 16}px` }} aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.name}`} aria-expanded={!collapsed} onClick={() => toggleCollapsed(node.id)}>{collapsed ? "›" : "⌄"}</button>}{renaming?.id === node.id ? <input data-layer-rename={node.id} className="layer-row layer-row-rename" style={{ transform: `translateY(${virtualIndex * LAYER_ROW_HEIGHT}px)`, paddingLeft: `${hasChildren ? 28 + depth * 16 : 12 + depth * 16}px` }} autoFocus maxLength={100} aria-label={`Rename ${node.name}`} value={renaming.draft} onChange={(event) => setRenaming((current) => {
        if (current?.id !== node.id) return current;
        const next = { ...current, draft: event.target.value };
        renamingRef.current = next;
        return next;
      })} onBlur={() => finishRename(node, true, false)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishRename(node, true, true); } if (event.key === "Escape") { event.preventDefault(); finishRename(node, false, true); } }} /> : <button data-layer-id={node.id} draggable={canEdit} className={`layer-row ${selectedIds.includes(node.id) ? "selected" : ""} ${dropTarget?.id === node.id ? dropTarget.inside ? "drop-inside" : "drop-before" : ""} ${draggedId === node.id ? "dragging" : ""}`} style={{ transform: `translateY(${virtualIndex * LAYER_ROW_HEIGHT}px)`, paddingLeft: `${hasChildren ? 28 + depth * 16 : 12 + depth * 16}px` }} onClick={(event) => onSelect(node.id, { additive: event.shiftKey || event.metaKey || event.ctrlKey })} onKeyDown={(event) => { if (!beginRename(event, node)) moveKeyboardFocus(event, row); }} onDragStart={(event) => {
        if (!canEdit) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", node.id);
        setDraggedId(node.id);
      }} onDragOver={(event) => {
        if (!draggedId || draggedId === node.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        const middle = (event.clientY - bounds.top) / Math.max(1, bounds.height);
        setDropTarget({ id: node.id, inside: ["frame", "group", "section"].includes(node.kind) && middle > .25 && middle < .75 });
      }} onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = draggedId ?? event.dataTransfer.getData("text/plain");
        const inside = dropTarget?.id === node.id && dropTarget.inside;
        if (id && id !== node.id) onDrop(id, inside ? { parentId: node.id } : { beforeId: node.id });
        setDraggedId(undefined); setDropTarget(undefined);
      }} onDragEnd={() => { setDraggedId(undefined); setDropTarget(undefined); }}>
        <span className={`node-icon ${node.kind}`}>{icon(node.kind)}</span><span>{node.name}</span><span className="layer-visibility">{node.visible === false ? "○" : "◉"}</span>
      </button>}</div>,
    );
  }
  // This protects the intended performance property if the constants are changed.
  if (rows.length > MAX_LAYER_DOM_ROWS) throw new Error("Virtual layer list exceeded its DOM row budget");
  return <div ref={listRef} className="layer-list" role="list" onDragOver={(event) => { if (draggedId) event.preventDefault(); }} onDrop={(event) => {
    const id = draggedId ?? event.dataTransfer.getData("text/plain");
    if (id && !dropTarget) onDrop(id);
    setDraggedId(undefined); setDropTarget(undefined);
  }} onScroll={(event) => {
    // React may invalidate currentTarget before a functional state updater runs.
    // Read the native value synchronously while the scroll event is still live.
    const scrollTop = event.currentTarget.scrollTop;
    setMetrics((current) => current.scrollTop === scrollTop ? current : { ...current, scrollTop });
  }}>
    <div className="virtual-layer-spacer" style={{ height: treeNodes.length * LAYER_ROW_HEIGHT }}>{rows}</div>
  </div>;
}
