import type { CanvasNode } from "./editor-protocol";

export interface MarqueePoint { x: number; y: number }
export interface MarqueeRect { x: number; y: number; width: number; height: number }

export function marqueeRect(start: MarqueePoint, end: MarqueePoint): MarqueeRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function rotatedNodeBounds(node: Pick<CanvasNode, "x" | "y" | "width" | "height" | "rotation">): MarqueeRect {
  const radians = node.rotation * Math.PI / 180;
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  const extentX = Math.abs(Math.cos(radians)) * halfWidth + Math.abs(Math.sin(radians)) * halfHeight;
  const extentY = Math.abs(Math.sin(radians)) * halfWidth + Math.abs(Math.cos(radians)) * halfHeight;
  return { x: node.x + halfWidth - extentX, y: node.y + halfHeight - extentY, width: extentX * 2, height: extentY * 2 };
}

function overlaps(first: MarqueeRect, second: MarqueeRect): boolean {
  return first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;
}

/** Returns visible layers touched by a world-space marquee, in document order. */
export function selectNodesInMarquee(nodes: readonly CanvasNode[], start: MarqueePoint, end: MarqueePoint): string[] {
  const selection = marqueeRect(start, end);
  return nodes.filter((node) => node.visible !== false && overlaps(selection, rotatedNodeBounds(node))).map((node) => node.id);
}

/** Shift-marquee appends layers; an ordinary marquee replaces the selection. */
export function resolveMarqueeSelection(initialIds: readonly string[], marqueeIds: readonly string[], additive: boolean): string[] {
  return additive ? [...new Set([...initialIds, ...marqueeIds])] : [...marqueeIds];
}
