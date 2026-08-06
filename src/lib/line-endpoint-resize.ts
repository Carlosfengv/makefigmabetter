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
  const { start, end } = lineEndpoints(geometry);
  const nextStart = endpoint === "start" ? current : start;
  const nextEnd = endpoint === "end" ? current : end;
  const x = nextStart.x;
  const y = nextStart.y;
  const dx = nextEnd.x - nextStart.x;
  const dy = nextEnd.y - nextStart.y;
  const distance = Math.hypot(dx, dy);
  const fallback = geometry.rotation * Math.PI / 180;
  const radians = distance > 1e-9 ? Math.atan2(dy, dx) : fallback;
  return { x, y, width: Math.max(minLength, distance), rotation: radians * 180 / Math.PI };
}

export function hasCommittedLineEndpointResize(before: LineGeometry, after: LineGeometry): boolean {
  return before.x !== after.x || before.y !== after.y || before.width !== after.width || before.rotation !== after.rotation;
}
