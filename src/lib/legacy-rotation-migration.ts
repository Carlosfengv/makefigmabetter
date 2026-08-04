/**
 * Carries rotation and stroke out of the pre-v9 presentation sidecar exactly
 * once. The resulting value deliberately clears the old canonical hash: these
 * fields were not present in that old Core payload, so WASM must compute the
 * v9 hash anew.
 */
export function migrateLegacyCoreRotationSnapshot(coreSnapshot: string, presentation: ReadonlyArray<{ id: string; rotation?: unknown; stroke?: unknown; strokeWidth?: unknown }>, legacySource = false): string {
  let parsed: { schemaVersion?: unknown; canonicalHash?: unknown; nodes?: unknown };
  try { parsed = JSON.parse(coreSnapshot) as typeof parsed; } catch { return coreSnapshot; }
  if (!Number.isInteger(parsed.schemaVersion) || ((parsed.schemaVersion as number) >= 9 && !legacySource) || !Array.isArray(parsed.nodes)) return coreSnapshot;
  const rotations = new Map(presentation.flatMap(({ id, rotation }) => typeof id === "string" && typeof rotation === "number" && Number.isFinite(rotation) ? [[id, rotation] as const] : []));
  const strokes = new Map(presentation.flatMap(({ id, stroke, strokeWidth }) => {
    if (typeof id !== "string" || typeof stroke !== "string" || typeof strokeWidth !== "number" || !Number.isFinite(strokeWidth) || strokeWidth < 0) return [];
    const css = stroke === "transparent" ? "#00000000" : stroke;
    return [[id, { stroke: css, strokeWidth }] as const];
  }));
  if (!rotations.size && !strokes.size) return coreSnapshot;
  const nodes = parsed.nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const id = (node as { id?: unknown }).id;
    const rotation = typeof id === "string" ? rotations.get(id) : undefined;
    const stroke = typeof id === "string" ? strokes.get(id) : undefined;
    return rotation === undefined && !stroke ? node : { ...(node as Record<string, unknown>), ...(rotation === undefined ? {} : { rotation }), ...stroke };
  });
  // Schema 8 intentionally bypasses persisted-hash validation while the WASM
  // loader installs newly Canonical fields, then emits a validated v9 snapshot.
  return JSON.stringify({ ...parsed, schemaVersion: 8, canonicalHash: "", nodes });
}
