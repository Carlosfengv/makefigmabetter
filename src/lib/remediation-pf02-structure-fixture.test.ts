import { describe, expect, it } from "vitest";
import { wasmHydrationBatches } from "./wasm-hydration-batches";
import {
  createRemediationPf02LayoutCascadeFixture,
  createRemediationPf02StructureFixture,
  REMEDIATION_PF02_LAYOUT_FRAME_ID,
} from "./remediation-pf02-structure-fixture";

describe("PF-02 structural browser fixture", () => {
  it("is deterministic and never splits a Group from its required child", () => {
    const first = createRemediationPf02StructureFixture(10_000);
    const second = createRemediationPf02StructureFixture(10_000);
    expect(first.nodes).toHaveLength(10_000);
    expect(first.nodes.slice(0, 4)).toEqual(second.nodes.slice(0, 4));
    expect(first.nodes.filter((node) => node.kind === "group")).toHaveLength(5_000);
    expect(first.nodes.filter((node) => node.kind === "rectangle")).toHaveLength(5_000);

    for (const batch of wasmHydrationBatches(first.nodes)) {
      const ids = new Set(batch.map((node) => node.id));
      for (const [index, node] of batch.entries()) {
        if (node.kind === "group") expect(ids.has(batch[index + 1]!.id)).toBe(true);
        if (node.parentId) expect(ids.has(node.parentId)).toBe(true);
      }
    }
  });

  it("rejects counts that cannot form complete structural pairs", () => {
    expect(() => createRemediationPf02StructureFixture(9_999)).toThrow("INVALID_REMEDIATION_PF02_NODE_COUNT");
  });

  it("builds a deterministic layout cascade without enabling layout during hydration", () => {
    const fixture = createRemediationPf02LayoutCascadeFixture(10_000, 999);
    const frame = fixture.nodes[0]!;
    expect(fixture.nodes).toHaveLength(10_000);
    expect(frame).toMatchObject({
      id: REMEDIATION_PF02_LAYOUT_FRAME_ID,
      kind: "frame",
      width: 200_000,
    });
    expect(frame.autoLayout).toBeUndefined();
    expect(
      fixture.nodes.filter(
        (node) => node.parentId === REMEDIATION_PF02_LAYOUT_FRAME_ID,
      ),
    ).toHaveLength(999);
    expect(new Set(fixture.nodes.map((node) => node.id)).size).toBe(10_000);
    expect(fixture.targetWidth).toBe(210_000);
  });

  it("rejects layout fixtures outside the Core cascade budget", () => {
    expect(() => createRemediationPf02LayoutCascadeFixture(10_000, 10_000)).toThrow(
      "INVALID_REMEDIATION_PF02_LAYOUT_SIZE",
    );
  });
});
