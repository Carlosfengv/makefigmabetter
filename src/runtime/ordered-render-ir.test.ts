import { describe, expect, it } from "vitest";
import { orderedDrawBatches, orderedRenderExecution, type OrderedRenderScene } from "./ordered-render-ir";

describe("ordered render IR", () => {
  it("preserves interleaved Canonical paint order instead of globally grouping by primitive type", () => {
    const scene: OrderedRenderScene = {
      revision: 12,
      semanticNodes: [],
      root: {
        id: "root", ownerNodeId: "page", requiresBackdrop: false, hasEffects: false,
        items: [
          { type: "draw", primitive: { nodeId: "rectangle-before", kind: "shape", materialKey: "shape" } },
          { type: "draw", primitive: { nodeId: "title", kind: "glyph-run", materialKey: "text" } },
          { type: "draw", primitive: { nodeId: "hero", kind: "image", materialKey: "image" } },
          { type: "draw", primitive: { nodeId: "rectangle-after", kind: "shape", materialKey: "shape" } },
        ],
      },
    };
    const steps = orderedRenderExecution(scene);
    expect(steps.filter((step) => step.type === "draw").map((step) => step.nodeId)).toEqual(["rectangle-before", "title", "hero", "rectangle-after"]);
    expect(orderedDrawBatches(steps)).toEqual([
      { materialKey: "shape", nodeIds: ["rectangle-before"] },
      { materialKey: "text", nodeIds: ["title"] },
      { materialKey: "image", nodeIds: ["hero"] },
      { materialKey: "shape", nodeIds: ["rectangle-after"] },
    ]);
  });

  it("captures the exact prior backdrop and composites a child group at its original position", () => {
    const scene: OrderedRenderScene = {
      revision: 13,
      semanticNodes: [],
      root: {
        id: "root", ownerNodeId: "page", requiresBackdrop: false, hasEffects: false,
        items: [
          { type: "draw", primitive: { nodeId: "background", kind: "shape", materialKey: "shape" } },
          {
            type: "group",
            group: {
              id: "blur-card", ownerNodeId: "card", requiresBackdrop: true, hasEffects: true,
              items: [{ type: "draw", primitive: { nodeId: "card", kind: "shape", materialKey: "shape" } }],
            },
          },
          { type: "draw", primitive: { nodeId: "foreground", kind: "glyph-run", materialKey: "text" } },
        ],
      },
    };
    expect(orderedRenderExecution(scene)).toEqual([
      { type: "draw", nodeId: "background", materialKey: "shape" },
      { type: "begin-group", groupId: "blur-card" },
      { type: "capture-backdrop", groupId: "blur-card" },
      { type: "draw", nodeId: "card", materialKey: "shape" },
      { type: "apply-group-effects", groupId: "blur-card" },
      { type: "composite-group", groupId: "blur-card" },
      { type: "draw", nodeId: "foreground", materialKey: "text" },
    ]);
  });

  it("never batches draws across a compositing barrier even when their material matches", () => {
    const steps = orderedRenderExecution({
      revision: 14,
      semanticNodes: [],
      root: {
        id: "root", ownerNodeId: "page", requiresBackdrop: false, hasEffects: false,
        items: [
          { type: "draw", primitive: { nodeId: "before", kind: "shape", materialKey: "shape" } },
          { type: "group", group: { id: "isolated", ownerNodeId: "group", requiresBackdrop: false, hasEffects: false, items: [] } },
          { type: "draw", primitive: { nodeId: "after", kind: "shape", materialKey: "shape" } },
        ],
      },
    });

    expect(orderedDrawBatches(steps)).toEqual([
      { materialKey: "shape", nodeIds: ["before"] },
      { materialKey: "shape", nodeIds: ["after"] },
    ]);
  });
});
