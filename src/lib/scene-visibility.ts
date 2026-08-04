import type { CanvasNode, Viewport } from "./editor-protocol";
import { rotatedNodeBounds } from "./marquee-selection";

export interface Bounds { x: number; y: number; width: number; height: number; }

/** Converts screen bounds to the world rectangle, with a small screen-space safety margin. */
export function viewportWorldBounds(viewport: Viewport, width: number, height: number, overscanPx = 100): Bounds {
  const zoom = Math.max(Number.EPSILON, viewport.zoom);
  const margin = Math.max(0, overscanPx) / zoom;
  return {
    x: -viewport.x - width / (2 * zoom) - margin,
    y: -viewport.y - height / (2 * zoom) - margin,
    width: width / zoom + margin * 2,
    height: height / zoom + margin * 2,
  };
}

export function boundsIntersect(left: Bounds, right: Bounds) {
  return left.x <= right.x + right.width && left.x + left.width >= right.x && left.y <= right.y + right.height && left.y + left.height >= right.y;
}

/** Linear, allocation-light culling that preserves document z-order. */
export function collectVisibleNodes(nodes: readonly CanvasNode[], viewportBounds: Bounds, boundsFor: (node: CanvasNode) => Bounds = rotatedNodeBounds): CanvasNode[] {
  return nodes.filter((node) => node.visible !== false && boundsIntersect(boundsFor(node), viewportBounds));
}
