import { describe, expect, it } from "vitest";
import { createZoomPerformanceFixture, ZOOM_PERFORMANCE_FIXTURE_NODE_COUNT } from "./zoom-performance-fixture";

describe("50K zoom performance fixture", () => {
  it("is deterministic and has the specified node-kind distribution", () => {
    const fixture = createZoomPerformanceFixture();
    expect(fixture.nodes).toHaveLength(ZOOM_PERFORMANCE_FIXTURE_NODE_COUNT);
    expect(fixture.nodes.slice(0, 4)).toEqual(createZoomPerformanceFixture().nodes.slice(0, 4));
    expect(fixture.nodes.reduce<Record<string, number>>((counts, node) => ({ ...counts, [node.kind]: (counts[node.kind] ?? 0) + 1 }), {})).toEqual({ rectangle: 40_000, ellipse: 5_000, text: 3_000, frame: 2_000 });
  });
});
