import type { Viewport } from "../lib/editor-protocol";
import type { TransformBounds } from "../lib/scene-transform";
import type { SceneDirtyRegion } from "./scene-compiler";

export type DirtyReplayRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  worldBounds: TransformBounds;
}>;

export type DirtyRegionReplayPlan =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "full-scene"; reason: string }>
  | Readonly<{ kind: "regions"; rects: readonly DirtyReplayRect[]; coveredPixels: number }>;

export type DirtyRegionReplayOptions = Readonly<{
  dirtyRegions: readonly SceneDirtyRegion[];
  viewport: Viewport;
  width: number;
  height: number;
  /** CSS-pixel expansion for antialiasing and half-pixel strokes. */
  padding?: number;
  maxRegions?: number;
  maxCoverageRatio?: number;
  /** Current-scene visual bounds whose complete pixels must be replayed. */
  replayBounds?: readonly TransformBounds[];
}>;

/**
 * Converts conservative world-space invalidation into a bounded screen replay
 * plan. It only decides whether regions are economical; the renderer remains
 * responsible for proving that its scene, camera and composition path support
 * partial replay.
 */
export function planDirtyRegionReplay(options: DirtyRegionReplayOptions): DirtyRegionReplayPlan {
  const { dirtyRegions, viewport, width, height } = options;
  if (!dirtyRegions.length) return { kind: "none" };
  const full = dirtyRegions.find((region) => region.kind === "full-scene");
  if (full) return { kind: "full-scene", reason: full.reason };
  if (!finitePositive(width) || !finitePositive(height) || !finitePositive(viewport.zoom)) {
    return { kind: "full-scene", reason: "invalid-viewport" };
  }

  const padding = finiteNonNegative(options.padding) ? options.padding! : 2;
  const maxRegions = Math.max(1, Math.floor(options.maxRegions ?? 8));
  const maxCoverageRatio = Math.min(1, Math.max(0, options.maxCoverageRatio ?? 0.4));
  const rects: ScreenRect[] = [];
  for (const region of dirtyRegions) {
    if (!region.bounds || !finiteBounds(region.bounds)) {
      return { kind: "full-scene", reason: "invalid-region" };
    }
    const expanded = expandToIntersectingVisualBounds(region.bounds, options.replayBounds ?? []);
    const screen = worldBoundsToScreen(expanded, viewport, width, height, padding);
    if (screen) mergeInto(rects, screen);
  }
  if (!rects.length) return { kind: "none" };
  if (rects.length > maxRegions) return { kind: "full-scene", reason: "too-many-screen-regions" };

  const coveredPixels = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  if (coveredPixels / (width * height) > maxCoverageRatio) {
    return { kind: "full-scene", reason: "coverage-limit" };
  }
  return {
    kind: "regions",
    coveredPixels,
    rects: rects.map((rect) => ({
      ...rect,
      worldBounds: screenRectToWorld(rect, viewport, width, height),
    })),
  };
}

type ScreenRect = Readonly<{ x: number; y: number; width: number; height: number }>;

function worldBoundsToScreen(
  bounds: TransformBounds,
  viewport: Viewport,
  width: number,
  height: number,
  padding: number,
): ScreenRect | undefined {
  const left = Math.max(0, Math.floor((bounds.left + viewport.x) * viewport.zoom + width / 2 - padding));
  const top = Math.max(0, Math.floor((bounds.top + viewport.y) * viewport.zoom + height / 2 - padding));
  const right = Math.min(width, Math.ceil((bounds.right + viewport.x) * viewport.zoom + width / 2 + padding));
  const bottom = Math.min(height, Math.ceil((bounds.bottom + viewport.y) * viewport.zoom + height / 2 + padding));
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined;
}

function screenRectToWorld(rect: ScreenRect, viewport: Viewport, width: number, height: number): TransformBounds {
  return {
    left: (rect.x - width / 2) / viewport.zoom - viewport.x,
    top: (rect.y - height / 2) / viewport.zoom - viewport.y,
    right: (rect.x + rect.width - width / 2) / viewport.zoom - viewport.x,
    bottom: (rect.y + rect.height - height / 2) / viewport.zoom - viewport.y,
  };
}

function mergeInto(rects: ScreenRect[], candidate: ScreenRect) {
  let merged = candidate;
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    if (!touches(rects[index]!, merged)) continue;
    merged = union(rects[index]!, merged);
    rects.splice(index, 1);
    // The expanded union can now touch an earlier region. Restart so the
    // output never contains overlapping clips or double-counted area.
    index = rects.length;
  }
  rects.push(merged);
}

function touches(left: ScreenRect, right: ScreenRect) {
  return left.x <= right.x + right.width
    && right.x <= left.x + left.width
    && left.y <= right.y + right.height
    && right.y <= left.y + left.height;
}

function union(left: ScreenRect, right: ScreenRect): ScreenRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function expandToIntersectingVisualBounds(
  initial: TransformBounds,
  replayBounds: readonly TransformBounds[],
): TransformBounds {
  let expanded = initial;
  let changed = true;
  const included = new Set<number>();
  while (changed) {
    changed = false;
    replayBounds.forEach((bounds, index) => {
      if (included.has(index) || !finiteBounds(bounds) || !boundsTouch(expanded, bounds)) return;
      included.add(index);
      const next = unionBounds(expanded, bounds);
      if (!sameBounds(next, expanded)) changed = true;
      expanded = next;
    });
  }
  return expanded;
}

function boundsTouch(left: TransformBounds, right: TransformBounds) {
  return left.left <= right.right
    && right.left <= left.right
    && left.top <= right.bottom
    && right.top <= left.bottom;
}

function unionBounds(left: TransformBounds, right: TransformBounds): TransformBounds {
  return {
    left: Math.min(left.left, right.left),
    top: Math.min(left.top, right.top),
    right: Math.max(left.right, right.right),
    bottom: Math.max(left.bottom, right.bottom),
  };
}

function sameBounds(left: TransformBounds, right: TransformBounds) {
  return left.left === right.left
    && left.top === right.top
    && left.right === right.right
    && left.bottom === right.bottom;
}

function finiteBounds(bounds: TransformBounds) {
  return Number.isFinite(bounds.left)
    && Number.isFinite(bounds.top)
    && Number.isFinite(bounds.right)
    && Number.isFinite(bounds.bottom)
    && bounds.right >= bounds.left
    && bounds.bottom >= bounds.top;
}

function finitePositive(value: number) { return Number.isFinite(value) && value > 0; }
function finiteNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
