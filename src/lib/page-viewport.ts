import type { CanvasNode, Viewport } from "./editor-protocol";
import { clampCanvasZoom } from "./canvas-grid";
import { visibleNodesOnPage } from "./hierarchy-visibility";
import { worldBoundsForNode, type TransformBounds } from "./scene-transform";

export const PAGE_FIT_PADDING = 48;

export interface ViewportReprojectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A raster from another camera is only a temporary gesture preview. Its page
 * and surface dimensions alone cannot prove that newly exposed content exists. */
export function isSameRenderedViewport(previous: Viewport | undefined, next: Viewport) {
  return previous !== undefined && previous.x === next.x && previous.y === next.y && previous.zoom === next.zoom;
}

/** Maps a previously rendered full-surface frame into a new camera viewport.
 * Coordinates stay in CSS pixels; callers can apply their backing-store DPR
 * after this calculation. This keeps pan/zoom input on the compositor-sized
 * raster path while the exact scene is redrawn after the gesture settles. */
export function viewportReprojectionRect(
  previous: Viewport,
  next: Viewport,
  previousSurface: Readonly<{ width: number; height: number }>,
  nextSurface: Readonly<{ width: number; height: number }>,
): ViewportReprojectionRect {
  const previousZoom = Math.max(.01, Number.isFinite(previous.zoom) ? previous.zoom : 1);
  const nextZoom = Math.max(.01, Number.isFinite(next.zoom) ? next.zoom : 1);
  const scale = nextZoom / previousZoom;
  return {
    x: nextSurface.width / 2 - previousSurface.width / 2 * scale + (next.x - previous.x) * nextZoom,
    y: nextSurface.height / 2 - previousSurface.height / 2 * scale + (next.y - previous.y) * nextZoom,
    width: previousSurface.width * scale,
    height: previousSurface.height * scale,
  };
}

/** Reuse one complete view, never a patchwork of independently composited
 * rasters. Even the same scene can have different effect/LOD results at two
 * cameras. If no cached view covers the surface, repaint the newly visible
 * scene instead of filling its gaps with a differently shaded frame. */
export function selectCoveringViewportFrame<T extends Readonly<{ viewport: Viewport; width: number; height: number }>>(
  frames: readonly T[],
  viewport: Viewport,
  surface: Readonly<{ width: number; height: number }>,
): { frame: T; rect: ViewportReprojectionRect } | undefined {
  for (const frame of frames) {
    const rect = viewportReprojectionRect(frame.viewport, viewport, frame, surface);
    if (rect.x <= 0 && rect.y <= 0 && rect.x + rect.width >= surface.width && rect.y + rect.height >= surface.height)
      return { frame, rect };
  }
  return undefined;
}

/** During an active camera gesture, prefer a complete cached view but fall
 * back to the widest available raster when zoom-out or pan exposes new space.
 * The caller paints the uncovered area with the canvas backdrop, then replaces
 * this preview with an exact render after input settles. */
export function selectViewportFrameForInteraction<T extends Readonly<{ viewport: Viewport; width: number; height: number }>>(
  frames: readonly T[],
  viewport: Viewport,
  surface: Readonly<{ width: number; height: number }>,
): { frame: T; rect: ViewportReprojectionRect } | undefined {
  const covering = selectCoveringViewportFrame(frames, viewport, surface);
  if (covering) return covering;
  const widest = frames.reduce<T | undefined>((selected, candidate) =>
    !selected || candidate.viewport.zoom < selected.viewport.zoom ? candidate : selected, undefined);
  return widest
    ? { frame: widest, rect: viewportReprojectionRect(widest.viewport, viewport, widest, surface) }
    : undefined;
}

/** Finds the visible top-level content on a page. Descendants are intentionally
 * excluded because a frame's world bounds already describe the canvas area that
 * should be revealed when the page is first opened. */
export function pageContentBounds(
  nodes: readonly CanvasNode[],
  pageId: string,
  defaultPageId: string,
): TransformBounds | undefined {
  const visible = visibleNodesOnPage(nodes, pageId, defaultPageId);
  const visibleIds = new Set(visible.map((node) => node.id));
  const bounds = visible
    .filter((node) => !node.parentId || !visibleIds.has(node.parentId))
    .map((node) => worldBoundsForNode(nodes, node))
    .filter((candidate): candidate is TransformBounds => Boolean(candidate));

  if (!bounds.length) return undefined;
  const [first, ...rest] = bounds;
  return rest.reduce<TransformBounds>((combined, candidate) => ({
    left: Math.min(combined.left, candidate.left),
    top: Math.min(combined.top, candidate.top),
    right: Math.max(combined.right, candidate.right),
    bottom: Math.max(combined.bottom, candidate.bottom),
  }), first);
}

/** Resolves the translation-before-scale viewport used by the Engine Worker so
 * the supplied world bounds are centred and wholly visible. */
export function fitViewportToBounds(
  bounds: TransformBounds | undefined,
  surface: Readonly<{ width: number; height: number }>,
  padding = PAGE_FIT_PADDING,
): Viewport {
  if (!bounds || surface.width <= 0 || surface.height <= 0) return { x: 0, y: 0, zoom: 1 };

  const contentWidth = Math.max(1, bounds.right - bounds.left);
  const contentHeight = Math.max(1, bounds.bottom - bounds.top);
  const availableWidth = Math.max(1, surface.width - Math.max(0, padding) * 2);
  const availableHeight = Math.max(1, surface.height - Math.max(0, padding) * 2);
  const zoom = clampCanvasZoom(Math.min(availableWidth / contentWidth, availableHeight / contentHeight));

  return {
    x: -(bounds.left + bounds.right) / 2,
    y: -(bounds.top + bounds.bottom) / 2,
    zoom,
  };
}
