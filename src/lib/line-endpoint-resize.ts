export type LineEndpoint = "start" | "end";
export type LineGeometry = Readonly<{ x: number; y: number; width: number; rotation: number }>;
export type LinePoint = Readonly<{ x: number; y: number }>;

const MIN_LINE_LENGTH = 4;

export function lineEndpoints(geometry: LineGeometry): Readonly<{ start: LinePoint; end: LinePoint }> {
  const radians = geometry.rotation * Math.PI / 180;
  return {
    start: { x: geometry.x, y: geometry.y },
    end: { x: geometry.x + Math.cos(radians) * geometry.width, y: geometry.y + Math.sin(radians) * geometry.width },
  };
}

/** Keeps the opposite endpoint fixed while moving one Line endpoint. Lines
 * retain the Phase 2 minimum length instead of silently creating a zero-length
 * cap whose bounds and hit semantics are intentionally not yet supported. */
export function resizeLegacyLineEndpoint(
  geometry: LineGeometry,
  endpoint: LineEndpoint,
  current: LinePoint,
  minLength = MIN_LINE_LENGTH,
): LineGeometry {
  const { start: originalStart, end } = lineEndpoints(geometry);
  const fixed = endpoint === "start" ? end : originalStart;
  const requested = current;
  const dx = endpoint === "start" ? fixed.x - requested.x : requested.x - fixed.x;
  const dy = endpoint === "start" ? fixed.y - requested.y : requested.y - fixed.y;
  const distance = Math.hypot(dx, dy);
  const fallback = geometry.rotation * Math.PI / 180;
  const radians = distance > 1e-9 ? Math.atan2(dy, dx) : fallback;
  const length = Math.max(minLength, distance);
  const offsetX = Math.abs(Math.cos(radians) * length) < 1e-12 ? 0 : Math.cos(radians) * length;
  const offsetY = Math.abs(Math.sin(radians) * length) < 1e-12 ? 0 : Math.sin(radians) * length;
  const nextStart = endpoint === "start"
    ? { x: fixed.x - offsetX, y: fixed.y - offsetY }
    : fixed;
  return { x: nextStart.x, y: nextStart.y, width: length, rotation: radians * 180 / Math.PI };
}

export function hasCommittedLineEndpointResize(before: LineGeometry, after: LineGeometry): boolean {
  return before.x !== after.x || before.y !== after.y || before.width !== after.width || before.rotation !== after.rotation;
}
