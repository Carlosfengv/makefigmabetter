import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../lib/editor-protocol";
import { orderedRenderExecution } from "./ordered-render-ir";
import { compileScene, findTopmostSceneHit, sceneNodesInPaintOrder } from "./scene-compiler";

const pageId = "00000000-0000-0000-0000-000000000001";
function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, pageId, name: id, kind: "rectangle", x: 0, y: 0, width: 20, height: 20, rotation: 0,
    fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1,
    ...patch,
  };
}

describe("Scene compiler", () => {
  it("compiles one Canonical order for draws, clipping, masks and compositing contexts", () => {
    const compiled = compileScene({
      revision: 7,
      pageId,
      nodes: [
        node("frame", { kind: "frame", width: 100, height: 100, opacity: .6 }),
        node("back", { parentId: "frame", x: 5, y: 5 }),
        node("mask", { parentId: "frame", x: 10, y: 10, width: 40, height: 40, isMask: true }),
        node("masked", { parentId: "frame", x: 20, y: 20, width: 80, height: 80, reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }] }),
      ],
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(orderedRenderExecution(compiled.scene).filter((step) => step.type === "draw").map((step) => step.nodeId)).toEqual(["frame", "back", "masked"]);
    const masked = compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === "masked");
    expect(masked).toMatchObject({ visible: true, prototypeInteractive: true, maskNodeIds: ["mask"], clipBounds: { left: 10, top: 10, right: 50, bottom: 50 } });
    expect(compiled.scene.root.items[0]).toMatchObject({ type: "group", group: { ownerNodeId: "frame", opacity: .6, clipBounds: { left: 0, top: 0, right: 100, bottom: 100 } } });
  });

  it("uses the same reverse semantic order for hit candidates and reports conservative dirty regions", () => {
    const first = compileScene({ revision: 8, pageId, nodes: [node("bottom", { x: 0, y: 0, width: 40, height: 40 }), node("top", { x: 10, y: 10, width: 40, height: 40 })] });
    expect(findTopmostSceneHit(first.scene, { x: 20, y: 20 })?.nodeId).toBe("top");
    expect(findTopmostSceneHit(first.scene, { x: 20, y: 20 }, (id) => id !== "top")?.nodeId).toBe("bottom");

    const second = compileScene({ revision: 9, pageId, previousScene: first.scene, nodes: [node("bottom", { x: 0, y: 0, width: 40, height: 40 }), node("top", { x: 70, y: 10, width: 40, height: 40 })] });
    expect(second.dirtyRegions).toEqual([{ kind: "region", reason: "node-changed", bounds: { left: 10, top: 10, right: 110, bottom: 50 } }]);
  });

  it("orders a culled Canvas subset from the shared scene and retains unknown recovery records", () => {
    const compiled = compileScene({ revision: 10, pageId, nodes: [node("back"), node("front", { x: 10 })] });
    expect(sceneNodesInPaintOrder(compiled.scene, [{ id: "front" }, { id: "unknown" }, { id: "back" }]).map((candidate) => candidate.id)).toEqual(["back", "front", "unknown"]);
  });
});
