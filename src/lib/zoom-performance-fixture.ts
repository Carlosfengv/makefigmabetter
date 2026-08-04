import type { CanvasNode, NodeKind, Viewport } from "./editor-protocol";

export const ZOOM_PERFORMANCE_FIXTURE_NODE_COUNT = 50_000;
export const ZOOM_PERFORMANCE_FIXTURE_SEED = 0x5a17c0de;

export interface ZoomPerformanceFixture { nodes: CanvasNode[]; viewport: Viewport; }

/** Deterministic development-only 50K scene; it bypasses UI command creation. */
export function createZoomPerformanceFixture(seed = ZOOM_PERFORMANCE_FIXTURE_SEED): ZoomPerformanceFixture {
  const random = mulberry32(seed);
  const nodes: CanvasNode[] = [];
  const kinds: Array<{ kind: NodeKind; count: number }> = [
    { kind: "rectangle", count: 40_000 }, { kind: "ellipse", count: 5_000 },
    { kind: "text", count: 3_000 }, { kind: "frame", count: 2_000 },
  ];
  let index = 0;
  for (const { kind, count } of kinds) {
    for (let item = 0; item < count; item += 1, index += 1) {
      // A broad distribution plus a deterministic dense cluster keeps ordinary
      // viewports in the intended 200–1,000 candidate range.
      const dense = index % 30 === 0;
      const x = Math.round((dense ? random() * 2_400 - 1_200 : random() * 60_000 - 30_000) / 4) * 4;
      const y = Math.round((dense ? random() * 1_600 - 800 : random() * 45_000 - 22_500) / 4) * 4;
      const width = 36 + Math.round(random() * 220);
      const height = 28 + Math.round(random() * 150);
      nodes.push({ id: fixtureId(index), name: `${kind} ${index + 1}`, kind, x, y, width, height, rotation: Math.round((random() - .5) * 90), fill: kind === "text" ? "#23251f" : index % 3 === 0 ? "#e6edff" : "#ffd8b7", stroke: kind === "text" ? "transparent" : "#0048FF", strokeWidth: kind === "text" ? 0 : 1, radius: kind === "frame" ? 12 : 6, opacity: 1, visible: true, ...(kind === "text" ? { text: `Benchmark label ${index + 1}` } : {}) });
    }
  }
  return { nodes, viewport: { x: 0, y: 0, zoom: 1 } };
}

function fixtureId(index: number) { return `50000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; }
function mulberry32(seed: number) { return () => { let value = seed += 0x6d2b79f5; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4_294_967_296; }; }
