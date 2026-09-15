import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../lib/editor-protocol";
import { orderedRenderExecution, sceneClipGeometryByNodeId, sceneMaskSourceByNodeId } from "./ordered-render-ir";
import { clipStateContainsPoint, compileScene, findTopmostSceneHit, sceneNodesInPaintOrder } from "./scene-compiler";

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

  it("freezes ordered owner effects and complete pre-effect subtree source bounds", () => {
    const effect = { layerBlur: { visible: true, radius: 4 } };
    const group = node("group", { kind: "group", width: 40, height: 40, effectStack: [effect] });
    const child = node("child", { parentId: group.id, x: 80, width: 20, height: 20 });
    const compiled = compileScene({ revision: 71, pageId, nodes: [group, child] });
    const item = compiled.scene.root.items[0];

    expect(item).toMatchObject({
      type: "group",
      group: {
        ownerNodeId: group.id,
        hasEffects: true,
        effects: [effect],
        sourceBounds: { left: 80, top: 0, right: 100, bottom: 20 },
      },
    });
    if (item?.type !== "group") throw new Error("Expected frame compositing group");
    expect(Object.isFrozen(item.group.effects?.[0])).toBe(true);
    expect(Object.isFrozen(item.group.effects?.[0]?.layerBlur)).toBe(true);
  });

  it("uses the same reverse semantic order for hit candidates and reports conservative dirty regions", () => {
    const first = compileScene({ revision: 8, pageId, nodes: [node("bottom", { x: 0, y: 0, width: 40, height: 40 }), node("top", { x: 10, y: 10, width: 40, height: 40 })] });
    expect(findTopmostSceneHit(first.scene, { x: 20, y: 20 })?.nodeId).toBe("top");
    expect(findTopmostSceneHit(first.scene, { x: 20, y: 20 }, (id) => id !== "top")?.nodeId).toBe("bottom");

    const second = compileScene({ revision: 9, pageId, previousScene: first.scene, nodes: [node("bottom", { x: 0, y: 0, width: 40, height: 40 }), node("top", { x: 70, y: 10, width: 40, height: 40 })] });
    expect(second.dirtyRegions).toEqual([{ kind: "region", reason: "node-changed", bounds: { left: 10, top: 10, right: 110, bottom: 50 } }]);
  });

  it("keeps a hanging list marker inside Scene effect and hit bounds", () => {
    const text = node("hanging", {
      kind: "text", text: "One", width: 100, height: 40,
      textProperties: {
        runs: [{ start: 0, end: 3, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left", paragraphSpacing: 0, listType: "ordered", hangingList: true },
        autoSize: "fixed",
      },
    });
    const compiled = compileScene({ revision: 10, pageId, nodes: [text] });

    expect(compiled.scene.semanticNodes[0]?.effectBounds).toEqual({ left: -75, top: 0, right: 100, bottom: 40 });
    expect(findTopmostSceneHit(compiled.scene, { x: -20, y: 15 }, () => true)?.nodeId).toBe(text.id);
  });

  it("invalidates Connector presentation when an attached target moves", () => {
    const target = node("connector-target", { x: 200, y: 40, width: 80, height: 60 });
    const connector = node("attached-connector", {
      kind: "connector",
      width: 100,
      height: 0,
      stroke: "#000",
      strokeWidth: 2,
      connectorMetadata: {
        lineType: "STRAIGHT",
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0, endpointNodeId: target.id, magnet: "LEFT" },
        startStrokeCap: "NONE",
        endStrokeCap: "NONE",
        text: "",
      },
    });
    const first = compileScene({ revision: 40, pageId, nodes: [connector, target] });
    const moved = compileScene({ revision: 41, pageId, previousScene: first.scene, nodes: [connector, { ...target, x: 260 }] });

    expect(first.scene.semanticNodes.find((candidate) => candidate.nodeId === connector.id)?.effectBounds).toMatchObject({ right: 204, bottom: 74 });
    expect(moved.scene.semanticNodes.find((candidate) => candidate.nodeId === connector.id)?.effectBounds).toMatchObject({ right: 264, bottom: 74 });
    expect(moved.dirtyRegions).toEqual([{ kind: "full-scene", reason: "presentation-changed" }]);
  });

  it.each([
    ["fill", { fill: "#f00" }, { fill: "#0f0" }],
    ["text", { kind: "text" as const, text: "same width" }, { kind: "text" as const, text: "new glyphs" }],
    ["mask alpha", { isMask: true, opacity: .25 }, { isMask: true, opacity: .75 }],
    ["group effect", { kind: "group" as const, opacity: .5 }, { kind: "group" as const, opacity: .8 }],
  ])("invalidates the full scene for equal-bounds %s changes", (_label, beforePatch, afterPatch) => {
    const first = compileScene({ revision: 20, pageId, nodes: [node("target", beforePatch)] });
    const second = compileScene({ revision: 21, pageId, previousScene: first.scene, nodes: [node("target", afterPatch)] });

    expect(second.dirtyRegions).toEqual([{ kind: "full-scene", reason: "presentation-changed" }]);
  });

  it.each([
    ["image", node("image", { kind: "image", assetId: "asset-1" })],
    ["font", node("text", { kind: "text", text: "Delayed face" })],
  ])("invalidates a %s that becomes ready without a canonical revision change", (_label, resourceNode) => {
    const first = compileScene({ revision: 30, resourceGeneration: 1, pageId, nodes: [resourceNode] });
    const second = compileScene({ revision: 30, resourceGeneration: 2, pageId, previousScene: first.scene, nodes: [resourceNode] });

    expect(second.dirtyRegions).toEqual([{ kind: "full-scene", reason: "resource-changed" }]);
  });

  it("invalidates the full scene when an earlier sibling changes behind a Background Blur reader", () => {
    const backdropReader = node("blur", {
      x: 10,
      width: 30,
      effectStack: [{ backgroundBlur: { visible: true, radius: 8 } }],
    });
    const first = compileScene({ revision: 40, pageId, nodes: [node("back", { x: 0 }), backdropReader] });
    const second = compileScene({ revision: 41, pageId, previousScene: first.scene, nodes: [node("back", { x: 4 }), backdropReader] });

    expect(first.scene.root.items[1]).toMatchObject({ type: "group", group: { requiresBackdrop: true } });
    expect(second.dirtyRegions).toEqual([{ kind: "full-scene", reason: "dependency-changed" }]);
  });

  it("invalidates the full scene for clip changes that can reveal descendants", () => {
    const firstFrame = node("frame", { kind: "frame", width: 40, height: 40, clipsContent: true });
    const secondFrame = { ...firstFrame, clipsContent: false };
    const child = node("child", { parentId: "frame", x: 30, width: 30 });
    const first = compileScene({ revision: 50, pageId, nodes: [firstFrame, child] });
    const second = compileScene({ revision: 51, pageId, previousScene: first.scene, nodes: [secondFrame, child] });

    expect(second.dirtyRegions).toEqual([{ kind: "full-scene", reason: "presentation-changed" }]);
  });

  it("invalidates both old and new geometry for a pure transform change", () => {
    const first = compileScene({ revision: 60, pageId, nodes: [node("target", { x: 0, width: 20 })] });
    const second = compileScene({ revision: 61, pageId, previousScene: first.scene, nodes: [node("target", { x: 80, width: 20 })] });

    expect(second.dirtyRegions).toEqual([{ kind: "region", reason: "node-changed", bounds: { left: 0, top: 0, right: 100, bottom: 20 } }]);
  });

  it("invalidates structural dependencies for a same-bounds reparent", () => {
    const left = node("left", { kind: "group" });
    const right = node("right", { kind: "group" });
    const firstChild = node("child", { parentId: left.id });
    const secondChild = { ...firstChild, parentId: right.id };
    const first = compileScene({ revision: 70, pageId, nodes: [left, right, firstChild] });
    const second = compileScene({ revision: 71, pageId, previousScene: first.scene, nodes: [left, right, secondChild] });

    expect(second.dirtyRegions).toEqual([{ kind: "full-scene", reason: "dependency-changed" }]);
  });

  it("invalidates both sides of a mask-run boundary reorder", () => {
    const mask = node("mask", { isMask: true });
    const target = node("target");
    const first = compileScene({ revision: 80, pageId, nodes: [mask, target] });
    const second = compileScene({ revision: 81, pageId, previousScene: first.scene, nodes: [target, mask] });

    expect(second.dirtyRegions).toEqual([{ kind: "full-scene", reason: "dependency-changed" }]);
  });

  it("ignores stale singular mirrors when ordered paint and effect stacks own presentation", () => {
    const effect = { layerBlur: { radius: 4, visible: true } } as const;
    const firstNode = node("target", {
      fill: "#00f",
      fills: [{ css: "#f00" }],
      dropShadow: { offsetX: 1, offsetY: 1, blurRadius: 2, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .2 }, visible: true },
      effectStack: [effect],
    });
    const secondNode = node("target", {
      ...firstNode,
      fill: "#0f0",
      dropShadow: { ...firstNode.dropShadow!, offsetX: 99 },
    });
    const first = compileScene({ revision: 31, pageId, nodes: [firstNode] });
    const second = compileScene({ revision: 32, pageId, previousScene: first.scene, nodes: [secondNode] });

    expect(second.dirtyRegions).toEqual([]);
  });

  it("orders a culled Canvas subset from the shared scene and retains unknown recovery records", () => {
    const compiled = compileScene({ revision: 10, pageId, nodes: [node("back"), node("front", { x: 10 })] });
    expect(sceneNodesInPaintOrder(compiled.scene, [{ id: "front" }, { id: "unknown" }, { id: "back" }]).map((candidate) => candidate.id)).toEqual(["back", "front", "unknown"]);
  });

  it.each(["frame", "component", "instance", "slot", "componentSet"] as const)("uses the shared %s child-clip and own-paint semantics", (kind) => {
    const parent = node("parent", { kind, width: 100, height: 100, clipsContent: true });
    const child = node("child", { kind: kind === "componentSet" ? "component" : "rectangle", parentId: parent.id, x: 80, width: 40 });
    const compiled = compileScene({ revision: 11, pageId, nodes: [parent, child] });

    expect(compiled.diagnostics).toEqual([]);
    expect(orderedRenderExecution(compiled.scene).filter((step) => step.type === "draw").map((step) => step.nodeId)).toEqual(["parent", "child"]);
    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === "child")?.clipBounds).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
    expect(compiled.scene.root.items[0]).toMatchObject({ type: "group", group: { ownerNodeId: "parent", clipBounds: { left: 0, top: 0, right: 100, bottom: 100 } } });
  });

  it("keeps Section paint in the scene while treating its descendants as unclipped", () => {
    const section = node("section", { kind: "section", width: 100, height: 100 });
    const child = node("child", { parentId: section.id, x: 120 });
    const compiled = compileScene({ revision: 12, pageId, nodes: [section, child] });

    expect(orderedRenderExecution(compiled.scene).filter((step) => step.type === "draw").map((step) => step.nodeId)).toEqual(["section", "child"]);
    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === "child")?.clipBounds).toBeUndefined();
  });

  it("propagates an empty nested clip without letting descendants become unbounded", () => {
    const outer = node("outer", { kind: "frame", width: 40, height: 40, clipsContent: true });
    const inner = node("inner", { kind: "frame", parentId: outer.id, x: 60, width: 40, height: 40, clipsContent: true });
    const target = node("target", { parentId: inner.id, x: -60, width: 100, height: 40 });
    const compiled = compileScene({ revision: 13, pageId, nodes: [outer, inner, target] });
    const semanticTarget = compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id);

    expect(semanticTarget).toMatchObject({ visible: false, paintable: false, clipState: { kind: "empty" } });
    expect(orderedRenderExecution(compiled.scene).filter((step) => step.type === "draw").map((step) => step.nodeId)).not.toContain(target.id);
    expect(findTopmostSceneHit(compiled.scene, { x: 10, y: 10 })?.nodeId).not.toBe(target.id);
  });

  it("uses frozen rotated clip geometry after the AABB broad phase", () => {
    const frame = node("frame", { kind: "frame", width: 100, height: 100, rotation: 45, clipsContent: true });
    const child = node("child", { parentId: frame.id, x: -200, y: -200, width: 500, height: 500 });
    const compiled = compileScene({ revision: 14, pageId, nodes: [frame, child] });
    const clipState = compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === child.id)!.clipState;

    expect(clipState).toMatchObject({ kind: "bounded", chain: [expect.objectContaining({ nodeId: frame.id, width: 100, height: 100 })] });
    expect(clipStateContainsPoint(clipState, { x: 50, y: 50 })).toBe(true);
    expect(clipStateContainsPoint(clipState, { x: -20, y: -20 })).toBe(false);
    expect(findTopmostSceneHit(compiled.scene, { x: -20, y: -20 }, () => true)?.nodeId).not.toBe(child.id);
  });

  it("freezes affine clip geometry for backend execution", () => {
    const frame = node("frame", {
      kind: "frame",
      width: 120,
      height: 80,
      radius: 12,
      cornerSmoothing: .4,
      clipsContent: true,
      relativeTransform: { a: -1, b: .2, c: .35, d: 1, e: 180, f: 25 },
    });
    const child = node("child", { parentId: frame.id, width: 200, height: 140 });
    const compiled = compileScene({ revision: 141, pageId, nodes: [frame, child] });
    const geometry = sceneClipGeometryByNodeId(compiled.scene).get(frame.id);

    expect(geometry).toMatchObject({
      width: 120,
      height: 80,
      radius: 12,
      cornerSmoothing: .4,
      worldTransform: { a: -1, b: .2, c: .35, d: 1, e: 180, f: 25 },
    });
    expect(Object.isFrozen(compiled.scene)).toBe(true);
    expect(Object.isFrozen(geometry)).toBe(true);
    expect(Object.isFrozen(geometry?.worldTransform)).toBe(true);

    frame.width = 999;
    frame.radius = 0;
    frame.relativeTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    expect(geometry).toMatchObject({
      width: 120,
      radius: 12,
      worldTransform: { a: -1, b: .2, c: .35, d: 1, e: 180, f: 25 },
    });
  });

  it("closes a target run when its active mask is hidden", () => {
    const mask = node("mask", { isMask: true, visible: false });
    const target = node("target", { x: 5, y: 5 });
    const compiled = compileScene({ revision: 15, pageId, nodes: [mask, target] });

    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id)).toMatchObject({
      visible: false,
      paintable: false,
      clipState: { kind: "empty" },
      maskNodeIds: [mask.id],
    });
  });

  it("uses a paint-owning container mask subtree as the target run broad-phase clip", () => {
    const mask = node("mask-frame", { kind: "frame", isMask: true, fill: "#00000000", strokeWidth: 0, width: 100, height: 100 });
    const maskChild = node("mask-child", { kind: "ellipse", parentId: mask.id, x: 20, y: 20, width: 40, height: 40 });
    const target = node("target", { width: 100, height: 100 });
    const compiled = compileScene({ revision: 150, pageId, nodes: [mask, maskChild, target] });

    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id)).toMatchObject({
      visible: true,
      paintable: true,
      clipState: { kind: "bounded", bounds: { left: 20, top: 20, right: 60, bottom: 60 } },
      maskNodeIds: [mask.id],
    });
    expect(orderedRenderExecution(compiled.scene).filter((step) => step.type === "draw").map((step) => step.nodeId)).toEqual([target.id]);
  });

  it("derives a structural Group mask broad phase from descendant alpha", () => {
    const mask = node("mask-group", { kind: "group", isMask: true, width: 100, height: 100 });
    const maskChild = node("group-mask-child", { kind: "ellipse", parentId: mask.id, x: 25, y: 15, width: 30, height: 50 });
    const target = node("target", { width: 100, height: 100 });
    const compiled = compileScene({ revision: 1501, pageId, nodes: [mask, maskChild, target] });

    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id)).toMatchObject({
      visible: true,
      paintable: true,
      clipState: { kind: "bounded", bounds: { left: 25, top: 15, right: 55, bottom: 65 } },
      maskNodeIds: [mask.id],
    });
    expect(orderedRenderExecution(compiled.scene).filter((step) => step.type === "draw").map((step) => step.nodeId)).toEqual([target.id]);
  });

  it("derives a live Boolean mask broad phase from its Vector operand subtree", () => {
    const mask = node("boolean-mask", { kind: "booleanOperation", isMask: true, width: 100, height: 80, fill: "transparent", booleanOperation: "subtract" });
    const outer = node("boolean-outer", { kind: "vector", parentId: mask.id, width: 100, height: 80, vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true, points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 }, { id: "c", x: 100, y: 80 }, { id: "d", x: 0, y: 80 }] }] } });
    const cutout = node("boolean-cutout", { kind: "vector", parentId: mask.id, x: 20, y: 20, width: 40, height: 40, vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true, points: [{ id: "e", x: 0, y: 0 }, { id: "f", x: 40, y: 0 }, { id: "g", x: 40, y: 40 }, { id: "h", x: 0, y: 40 }] }] } });
    const target = node("target", { width: 100, height: 80 });
    const compiled = compileScene({ revision: 1502, pageId, nodes: [mask, outer, cutout, target] });

    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id)).toMatchObject({
      visible: true,
      paintable: true,
      clipState: { kind: "bounded", bounds: { left: 0, top: 0, right: 100, bottom: 80 } },
      maskNodeIds: [mask.id],
    });
    expect(sceneMaskSourceByNodeId(compiled.scene).get(mask.id)?.node).toMatchObject({ kind: "booleanOperation", isMask: true });
    expect(orderedRenderExecution(compiled.scene).filter((step) => step.type === "draw").map((step) => step.nodeId)).toEqual([target.id]);
  });

  it("freezes the complete alpha-mask paint and world transform for execution", () => {
    const mask = node("mask", {
      isMask: true,
      fill: "#ff0000",
      fillStack: { layers: [{ visible: true, opacity: .5, blendMode: "multiply", paint: { css: "#00ff00" } }] },
      assetId: "asset-1",
      relativeTransform: { a: .8, b: .2, c: -.1, d: 1, e: 30, f: 40 },
    });
    const target = node("target", { x: 5, y: 5 });
    const compiled = compileScene({ revision: 151, pageId, nodes: [mask, target] });
    const frozen = sceneMaskSourceByNodeId(compiled.scene).get(mask.id);

    expect(frozen).toMatchObject({
      node: { fill: "#ff0000", assetId: "asset-1", fillStack: { layers: [{ opacity: .5, blendMode: "multiply" }] } },
      worldTransform: { a: .8, b: .2, c: -.1, d: 1, e: 30, f: 40 },
    });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen?.node)).toBe(true);
    expect(Object.isFrozen(frozen?.node.fillStack?.layers[0])).toBe(true);
    expect(Object.isFrozen(frozen?.worldTransform)).toBe(true);

    mask.fill = "#0000ff";
    mask.assetId = "asset-2";
    mask.relativeTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    expect(frozen).toMatchObject({
      node: { fill: "#ff0000", assetId: "asset-1" },
      worldTransform: { a: .8, b: .2, c: -.1, d: 1, e: 30, f: 40 },
    });
  });

  it("compiles one alpha-mask group for the entire contiguous target run", () => {
    const mask = node("mask", { isMask: true });
    const first = node("first", { x: 5 });
    const second = node("second", { x: 10 });
    const nextMask = node("next-mask", { isMask: true, x: 30 });
    const third = node("third", { x: 35 });
    const compiled = compileScene({ revision: 16, pageId, nodes: [mask, first, second, nextMask, third] });

    expect(compiled.scene.root.items).toMatchObject([
      {
        type: "group",
        group: {
          id: `mask:${mask.id}`,
          ownerNodeId: mask.id,
          maskNodeIds: [mask.id],
          items: [
            { type: "draw", primitive: { nodeId: first.id } },
            { type: "draw", primitive: { nodeId: second.id } },
          ],
        },
      },
      {
        type: "group",
        group: {
          id: `mask:${nextMask.id}`,
          ownerNodeId: nextMask.id,
          maskNodeIds: [nextMask.id],
          items: [{ type: "draw", primitive: { nodeId: third.id } }],
        },
      },
    ]);
    expect(orderedRenderExecution(compiled.scene)).toEqual([
      { type: "begin-group", groupId: `mask:${mask.id}` },
      { type: "draw", nodeId: first.id, materialKey: "shape" },
      { type: "draw", nodeId: second.id, materialKey: "shape" },
      { type: "apply-alpha-mask", groupId: `mask:${mask.id}`, maskNodeIds: [mask.id] },
      { type: "composite-group", groupId: `mask:${mask.id}` },
      { type: "begin-group", groupId: `mask:${nextMask.id}` },
      { type: "draw", nodeId: third.id, materialKey: "shape" },
      { type: "apply-alpha-mask", groupId: `mask:${nextMask.id}`, maskNodeIds: [nextMask.id] },
      { type: "composite-group", groupId: `mask:${nextMask.id}` },
    ]);
  });

  it("uses exact ellipse geometry for supported alpha-mask hit clipping", () => {
    const mask = node("mask", { kind: "ellipse", isMask: true, width: 100, height: 100 });
    const target = node("target", { width: 100, height: 100 });
    const compiled = compileScene({ revision: 17, pageId, nodes: [mask, target] });
    const clipState = compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id)!.clipState;

    expect(clipState).toMatchObject({ kind: "bounded", chain: [{ nodeId: mask.id, geometry: "ellipse" }] });
    expect(clipStateContainsPoint(clipState, { x: 50, y: 50 })).toBe(true);
    expect(clipStateContainsPoint(clipState, { x: 5, y: 5 })).toBe(false);
    expect(findTopmostSceneHit(compiled.scene, { x: 5, y: 5 }, () => true)?.nodeId).not.toBe(target.id);
  });

  it("closes an alpha-mask target run when the source opacity is zero", () => {
    const mask = node("mask", { isMask: true, opacity: 0 });
    const target = node("target");
    const compiled = compileScene({ revision: 18, pageId, nodes: [mask, target] });

    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id)).toMatchObject({
      visible: false,
      paintable: false,
      clipState: { kind: "empty" },
      maskNodeIds: [mask.id],
    });
    expect(compiled.scene.root.items).toEqual([]);
  });

  it("closes an alpha-mask target run when solid fill and stroke are fully transparent", () => {
    const mask = node("mask", { isMask: true, fill: "#00000000", stroke: "#00000000", strokeWidth: 4 });
    const target = node("target");
    const compiled = compileScene({ revision: 19, pageId, nodes: [mask, target] });

    expect(compiled.scene.semanticNodes.find((candidate) => candidate.nodeId === target.id)).toMatchObject({
      visible: false,
      paintable: false,
      clipState: { kind: "empty" },
    });
    expect(compiled.scene.root.items).toEqual([]);
  });
});
