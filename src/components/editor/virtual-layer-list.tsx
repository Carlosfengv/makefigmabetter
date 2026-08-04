"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNode } from "@/lib/editor-protocol";
import { LAYER_ROW_HEIGHT, reversedIndex, virtualRange } from "@/lib/virtual-range";

const MAX_LAYER_DOM_ROWS = 150;

function icon(kind: CanvasNode["kind"]) {
  return kind === "ellipse" ? "○" : kind === "text" ? "T" : kind === "frame" ? "#" : "□";
}

export function VirtualLayerList({ nodes, selectedIds, onSelect }: {
  nodes: readonly CanvasNode[];
  selectedIds: readonly string[];
  onSelect(id: string): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ scrollTop: 0, height: 0 });
  const selectedId = selectedIds[0];
  const range = virtualRange(nodes.length, metrics.scrollTop, metrics.height);

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
    const index = nodes.findIndex((node) => node.id === selectedId);
    if (index < 0 || !listRef.current) return;
    const reversed = reversedIndex(nodes.length, index);
    const top = reversed * LAYER_ROW_HEIGHT;
    const element = listRef.current;
    if (top < element.scrollTop || top + LAYER_ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - Math.max(0, (element.clientHeight - LAYER_ROW_HEIGHT) / 2));
    }
  }, [nodes, selectedId]);

  const rows = [];
  for (let virtualIndex = range.start; virtualIndex < range.end; virtualIndex += 1) {
    const node = nodes[reversedIndex(nodes.length, virtualIndex)];
    if (!node) continue;
    rows.push(
      <div key={node.id} role="listitem" aria-setsize={nodes.length} aria-posinset={virtualIndex + 1}>
      <button className={`layer-row ${selectedIds.includes(node.id) ? "selected" : ""}`} style={{ transform: `translateY(${virtualIndex * LAYER_ROW_HEIGHT}px)` }} onClick={() => onSelect(node.id)}>
        <span className={`node-icon ${node.kind}`}>{icon(node.kind)}</span><span>{node.name}</span><span className="layer-visibility">{node.visible === false ? "○" : "◉"}</span>
      </button></div>,
    );
  }
  // This protects the intended performance property if the constants are changed.
  if (rows.length > MAX_LAYER_DOM_ROWS) throw new Error("Virtual layer list exceeded its DOM row budget");
  return <div ref={listRef} className="layer-list" role="list" onScroll={(event) => {
    // React may invalidate currentTarget before a functional state updater runs.
    // Read the native value synchronously while the scroll event is still live.
    const scrollTop = event.currentTarget.scrollTop;
    setMetrics((current) => current.scrollTop === scrollTop ? current : { ...current, scrollTop });
  }}>
    <div className="virtual-layer-spacer" style={{ height: nodes.length * LAYER_ROW_HEIGHT }}>{rows}</div>
  </div>;
}
