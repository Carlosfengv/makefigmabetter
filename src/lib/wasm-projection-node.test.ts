import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { coreProjectionNode } from "./transaction-batch";
import { canvasNodeFromWasmProjection } from "./wasm-projection-node";

describe("canvasNodeFromWasmProjection", () => {
  it("keeps Canonical Blend Mode and alpha Mask state after the post-commit projection refresh", () => {
    const coreNode = coreProjectionNode({ ...createNode("rectangle", 10, 20), blendMode: "multiply", isMask: true });

    expect(canvasNodeFromWasmProjection(coreNode)).toMatchObject({ blendMode: "multiply", isMask: true });
  });
});
