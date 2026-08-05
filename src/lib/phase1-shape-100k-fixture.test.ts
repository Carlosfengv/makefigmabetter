import { describe, expect, it } from "vitest";
import { createPhase1Shape100kFixture, PHASE1_SHAPE_100K_NODE_COUNT } from "./phase1-shape-100k-fixture";

describe("F-SHAPE-100K fixture", () => {
  it("is deterministic and contains the declared 100k shape/text distribution", () => {
    const fixture = createPhase1Shape100kFixture();
    expect(fixture.nodes).toHaveLength(PHASE1_SHAPE_100K_NODE_COUNT);
    expect(fixture.nodes.slice(0, 4)).toEqual(createPhase1Shape100kFixture().nodes.slice(0, 4));
    expect(fixture.nodes.reduce<Record<string, number>>((counts, node) => ({ ...counts, [node.kind]: (counts[node.kind] ?? 0) + 1 }), {})).toEqual({ rectangle: 80_000, ellipse: 10_000, text: 6_000, frame: 4_000 });
  });
});
