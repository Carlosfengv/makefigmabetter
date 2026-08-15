import type { AffineMatrix } from "./scene-transform";

export type CanvasResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Corner handles have a distinct canvas gesture: they rotate the selection.
 * Edge-centre handles remain resize-only. */
export function isCornerResizeHandle(handle: CanvasResizeHandle): boolean {
  return handle === "nw" || handle === "ne" || handle === "se" || handle === "sw";
}

export type ResizeGeometry = Readonly<{ x: number; y: number; width: number; height: number }>;
export type ResizePoint = Readonly<{ x: number; y: number }>;
export type FlipResizeGeometry = ResizeGeometry & Readonly<{
  flipX: boolean;
  flipY: boolean;
  /** Maps the new local rectangle back into the pre-gesture local axes. */
  localTransform: AffineMatrix;
}>;

const DEFAULT_MIN_SIZE = 4;

/**
 * Resolves a free corner/edge drag that has passed the opposite side. Figma
 * keeps persisted sizes positive and represents the reversal as a reflection
 * in the node transform. The returned local transform maps the new positive
 * rectangle into the original local axes, so callers can compose it with a
 * rotated, skewed, or nested node transform without approximating an AABB.
 *
 * Shift and Alt variants deliberately keep their existing resize rules; this
 * helper models the unconstrained crossing interaction only.
 */
export function resizeGeometryFromCornerWithFlip(
  geometry: ResizeGeometry,
  handle: CanvasResizeHandle,
  delta: ResizePoint,
  minSize = DEFAULT_MIN_SIZE,
): FlipResizeGeometry {
  const minimum = Math.max(1, minSize);
  const horizontal = resizeAxisWithFlip(geometry.x, geometry.width, delta.x, handle === "nw" || handle === "w" || handle === "sw", handle === "ne" || handle === "e" || handle === "se", minimum);
  const vertical = resizeAxisWithFlip(geometry.y, geometry.height, delta.y, handle === "nw" || handle === "n" || handle === "ne", handle === "sw" || handle === "s" || handle === "se", minimum);
  return {
    x: horizontal.position,
    y: vertical.position,
    width: horizontal.size,
    height: vertical.size,
    flipX: horizontal.flip,
    flipY: vertical.flip,
    localTransform: { a: horizontal.flip ? -1 : 1, b: 0, c: 0, d: vertical.flip ? -1 : 1, e: horizontal.translation, f: vertical.translation },
  };
}

function resizeAxisWithFlip(start: number, size: number, delta: number, movesStart: boolean, movesEnd: boolean, minimum: number) {
  const end = start + size;
  if (movesStart) {
    const dragged = start + delta;
    if (dragged <= end - minimum) return { position: dragged, size: end - dragged, flip: false, translation: dragged - start };
    if (dragged >= end) {
      const nextSize = Math.max(minimum, dragged - end);
      return { position: end, size: nextSize, flip: true, translation: size + nextSize };
    }
    return { position: end - minimum, size: minimum, flip: false, translation: size - minimum };
  }
  if (movesEnd) {
    const dragged = end + delta;
    if (dragged >= start + minimum) return { position: start, size: dragged - start, flip: false, translation: 0 };
    if (dragged <= start) {
      const nextSize = Math.max(minimum, start - dragged);
      return { position: start - nextSize, size: nextSize, flip: true, translation: 0 };
    }
    return { position: start, size: minimum, flip: false, translation: 0 };
  }
  return { position: start, size, flip: false, translation: 0 };
}

/**
 * Resolves a corner drag in the node's unrotated local coordinate system.
 * The opposite corner is fixed, matching Figma's ordinary corner resize
 * interaction. Keeping this free of Canvas state makes the gesture behaviour
 * directly testable and lets the Worker submit one canonical geometry update.
 */
export function resizeGeometryFromCorner(
  geometry: ResizeGeometry,
  handle: CanvasResizeHandle,
  delta: ResizePoint,
  minSize = DEFAULT_MIN_SIZE,
  preserveAspectRatio = false,
): ResizeGeometry {
  const minimum = Math.max(1, minSize);
  const right = geometry.x + geometry.width;
  const bottom = geometry.y + geometry.height;
  const movesLeft = handle === "nw" || handle === "w" || handle === "sw";
  const movesRight = handle === "ne" || handle === "e" || handle === "se";
  const movesTop = handle === "nw" || handle === "n" || handle === "ne";
  const movesBottom = handle === "sw" || handle === "s" || handle === "se";
  const left = movesLeft
    ? Math.min(right - minimum, geometry.x + delta.x)
    : geometry.x;
  const top = movesTop
    ? Math.min(bottom - minimum, geometry.y + delta.y)
    : geometry.y;
  const nextRight = movesRight
    ? Math.max(geometry.x + minimum, right + delta.x)
    : right;
  const nextBottom = movesBottom
    ? Math.max(geometry.y + minimum, bottom + delta.y)
    : bottom;

  const resized = { x: left, y: top, width: nextRight - left, height: nextBottom - top };
  if (!preserveAspectRatio || !["nw", "ne", "se", "sw"].includes(handle) || geometry.width <= 0 || geometry.height <= 0) return resized;
  const widthScale = resized.width / geometry.width;
  const heightScale = resized.height / geometry.height;
  const scale = Math.max(
    Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? widthScale : heightScale,
    minimum / geometry.width,
    minimum / geometry.height,
  );
  const width = geometry.width * scale;
  const height = geometry.height * scale;
  return {
    x: movesLeft ? right - width : geometry.x,
    y: movesTop ? bottom - height : geometry.y,
    width,
    height,
  };
}

/** Resolves the same handle drag around a fixed visual centre. This is the
 * Alt/Option variant of Figma's resize gesture and intentionally shares the
 * same minimum-size and Shift aspect-ratio rules as ordinary corner resize. */
export function resizeGeometryFromCenter(
  geometry: ResizeGeometry,
  handle: CanvasResizeHandle,
  delta: ResizePoint,
  minSize = DEFAULT_MIN_SIZE,
  preserveAspectRatio = false,
): ResizeGeometry {
  const minimum = Math.max(1, minSize);
  const movesLeft = handle === "nw" || handle === "w" || handle === "sw";
  const movesRight = handle === "ne" || handle === "e" || handle === "se";
  const movesTop = handle === "nw" || handle === "n" || handle === "ne";
  const movesBottom = handle === "sw" || handle === "s" || handle === "se";
  let width = movesLeft ? geometry.width - 2 * delta.x : movesRight ? geometry.width + 2 * delta.x : geometry.width;
  let height = movesTop ? geometry.height - 2 * delta.y : movesBottom ? geometry.height + 2 * delta.y : geometry.height;
  width = Math.max(minimum, width);
  height = Math.max(minimum, height);
  if (preserveAspectRatio && ["nw", "ne", "se", "sw"].includes(handle) && geometry.width > 0 && geometry.height > 0) {
    const widthScale = width / geometry.width;
    const heightScale = height / geometry.height;
    const scale = Math.max(
      Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? widthScale : heightScale,
      minimum / geometry.width,
      minimum / geometry.height,
    );
    width = geometry.width * scale;
    height = geometry.height * scale;
  }
  return { x: geometry.x + (geometry.width - width) / 2, y: geometry.y + (geometry.height - height) / 2, width, height };
}

/** Converts a world-space gesture into legacy x/y/width/height geometry.
 * Rotation is applied around the node's centre; translating the local origin
 * back through that rotation keeps the opposite visual corner stationary. */
export function resizeRotatedLegacyGeometry(
  geometry: ResizeGeometry & Readonly<{ rotation: number }>,
  handle: CanvasResizeHandle,
  startWorld: ResizePoint,
  currentWorld: ResizePoint,
  minSize = DEFAULT_MIN_SIZE,
  preserveAspectRatio = false,
  fromCenter = false,
): ResizeGeometry {
  const radians = geometry.rotation * Math.PI / 180;
  const worldDelta = { x: currentWorld.x - startWorld.x, y: currentWorld.y - startWorld.y };
  const localDelta = {
    x: Math.cos(radians) * worldDelta.x + Math.sin(radians) * worldDelta.y,
    y: -Math.sin(radians) * worldDelta.x + Math.cos(radians) * worldDelta.y,
  };
  const local = (fromCenter ? resizeGeometryFromCenter : resizeGeometryFromCorner)(geometry, handle, localDelta, minSize, preserveAspectRatio);
  const originDelta = { x: local.x - geometry.x, y: local.y - geometry.y };
  return {
    x: geometry.x + Math.cos(radians) * originDelta.x - Math.sin(radians) * originDelta.y,
    y: geometry.y + Math.sin(radians) * originDelta.x + Math.cos(radians) * originDelta.y,
    width: local.width,
    height: local.height,
  };
}

export function hasCommittedResize(before: ResizeGeometry, after: ResizeGeometry): boolean {
  return before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height;
}
