import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode } from "./editor-protocol";
import { nodeContainsWorldPoint } from "./hit-test";
import { findTopmostTransformGroupRepeatHit } from "./transform-group-repeat-hit";

const pageId = "00000000-0000-4000-8000-00000000f001";

function repeatFixture(): CanvasNode[] {
  const behind = { ...createNode("rectangle", 0, 0), id: "behind", pageId, width: 400, height: 200, positionId: "10000000000000000000000000000000:00000000000000000000000000000000" };
  const group = {
    ...createNode("transformGroup", 0, 0), id: "repeat", pageId, width: 100, height: 80,
    positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 2, unitType: "PIXELS" as const, offset: 120, axis: "HORIZONTAL" as const }],
  };
  const low = { ...createNode("rectangle", 0, 0), id: "low", pageId, parentId: group.id, width: 30, height: 30, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
  const high = { ...createNode("ellipse", 0, 0), id: "high", pageId, parentId: group.id, width: 30, height: 30, positionId: "40000000000000000000000000000000:00000000000000000000000000000000" };
  const above = { ...createNode("rectangle", 120, 0), id: "above", pageId, width: 30, height: 30, positionId: "50000000000000000000000000000000:00000000000000000000000000000000" };
  return [behind, group, low, high, above];
}

describe("TransformGroup Repeat hit testing", () => {
  it("maps a derived point back to the topmost source leaf and reports its paint boundary", () => {
    const nodes = repeatFixture();
    const hit = findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 135, y: 15 },
      containsSourcePoint: nodeContainsWorldPoint,
    });
    expect(hit?.node.id).toBe("high");
    expect(hit?.groupId).toBe("repeat");
    expect(hit?.paintAfterIndex).toBe(3);
    expect(hit?.matrix).toMatchObject({ e: 120, f: 0 });
  });

  it("searches later derived copies first and rejects points outside every copy", () => {
    const nodes = repeatFixture();
    nodes.filter((node) => node.parentId === "repeat").forEach((node) => { node.width = 300; });
    const overlap = findTopmostTransformGroupRepeatHit({ documentNodes: nodes, paintOrderNodes: nodes, point: { x: 255, y: 15 }, containsSourcePoint: nodeContainsWorldPoint });
    expect(overlap?.matrix).toMatchObject({ e: 240, f: 0 });
    expect(findTopmostTransformGroupRepeatHit({ documentNodes: repeatFixture(), paintOrderNodes: repeatFixture(), point: { x: 119, y: 60 }, containsSourcePoint: nodeContainsWorldPoint })).toBeUndefined();
  });

  it("applies the derived visibility gate at the painted world point", () => {
    const nodes = repeatFixture();
    expect(findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 135, y: 15 },
      containsSourcePoint: nodeContainsWorldPoint,
      isDerivedPointVisible: () => false,
    })).toBeUndefined();
  });

  it("uses source-space alpha-mask visibility and never returns the mask identity", () => {
    const nodes = repeatFixture();
    const groupIndex = nodes.findIndex((node) => node.id === "repeat");
    nodes.splice(groupIndex + 1, 2,
      { ...createNode("ellipse", 0, 0), id: "mask", pageId, parentId: "repeat", width: 20, height: 20, isMask: true, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" },
      { ...createNode("rectangle", 0, 0), id: "masked-target", pageId, parentId: "repeat", width: 40, height: 20, positionId: "40000000000000000000000000000000:00000000000000000000000000000000" },
    );
    const sourcePoints: number[] = [];
    const hit = findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 135, y: 10 },
      containsSourcePoint: nodeContainsWorldPoint,
      isSourcePointVisible: (node, point) => {
        sourcePoints.push(point.x);
        return node.id === "masked-target" && point.x <= 20;
      },
    });
    expect(hit?.node.id).toBe("masked-target");
    expect(sourcePoints).toEqual([15]);
    expect(findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 145, y: 10 },
      containsSourcePoint: nodeContainsWorldPoint,
      isSourcePointVisible: (_node, point) => point.x <= 20,
    })).toBeUndefined();
  });

  it("admits standalone foreground, backdrop and ordered mixed effect stacks", () => {
    const nodes = repeatFixture();
    const high = nodes.find((node) => node.id === "high")!;
    high.effectStack = [{ layerBlur: { visible: true, radius: 4 } }];
    expect(findTopmostTransformGroupRepeatHit({ documentNodes: nodes, paintOrderNodes: nodes, point: { x: 135, y: 15 }, containsSourcePoint: nodeContainsWorldPoint })?.node.id).toBe("high");
    high.effectStack = [{ backgroundBlur: { visible: true, radius: 4 } }];
    expect(findTopmostTransformGroupRepeatHit({ documentNodes: nodes, paintOrderNodes: nodes, point: { x: 135, y: 15 }, containsSourcePoint: nodeContainsWorldPoint })?.node.id).toBe("high");
    high.effectStack = [
      { backgroundBlur: { visible: true, radius: 4 } },
      { layerBlur: { visible: true, radius: 4 } },
    ];
    expect(findTopmostTransformGroupRepeatHit({ documentNodes: nodes, paintOrderNodes: nodes, point: { x: 135, y: 15 }, containsSourcePoint: nodeContainsWorldPoint })?.node.id).toBe("high");
  });

  it("resolves a derived hit to the topmost leaf inside a nested container", () => {
    const nodes = repeatFixture();
    const groupIndex = nodes.findIndex((node) => node.id === "repeat");
    nodes.splice(groupIndex + 1, 2,
      { ...createNode("group", 0, 0), id: "nested", pageId, parentId: "repeat", width: 30, height: 30, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" },
      { ...createNode("frame", 0, 0), id: "nested-frame", pageId, parentId: "nested", width: 30, height: 30, clipsContent: true, positionId: "31000000000000000000000000000000:00000000000000000000000000000000" },
      { ...createNode("ellipse", 0, 0), id: "nested-leaf", pageId, parentId: "nested-frame", width: 30, height: 30, positionId: "32000000000000000000000000000000:00000000000000000000000000000000" },
    );
    const visibility: Array<{ sourceX: number; derivedX: number; groupId: string }> = [];
    const hit = findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 135, y: 15 },
      containsSourcePoint: nodeContainsWorldPoint,
      isSourcePointVisible: (_node, point, groupId) => {
        visibility.push({ sourceX: point.x, derivedX: 135, groupId });
        return true;
      },
      isDerivedPointVisible: (_node, point, groupId) => {
        visibility.push({ sourceX: 15, derivedX: point.x, groupId });
        return true;
      },
    });
    expect(hit?.node.id).toBe("nested-leaf");
    expect(hit?.paintAfterIndex).toBe(4);
    expect(visibility).toContainEqual({ sourceX: 15, derivedX: 135, groupId: "repeat" });
  });

  it("resolves a derived hit through an effected descendant-owning container", () => {
    const nodes = repeatFixture();
    const groupIndex = nodes.findIndex((node) => node.id === "repeat");
    nodes.splice(groupIndex + 1, 2,
      {
        ...createNode("group", 0, 0), id: "effected-group", pageId, parentId: "repeat",
        effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
        positionId: "30000000000000000000000000000000:00000000000000000000000000000000",
      },
      { ...createNode("ellipse", 0, 0), id: "effected-child", pageId, parentId: "effected-group", width: 30, height: 30, positionId: "31000000000000000000000000000000:00000000000000000000000000000000" },
    );
    const hit = findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 135, y: 15 },
      containsSourcePoint: nodeContainsWorldPoint,
      isSourcePointVisible: () => true,
      isDerivedPointVisible: () => true,
    });
    expect(hit?.node.id).toBe("effected-child");
    expect(hit?.groupId).toBe("repeat");
    expect(hit?.matrix).toMatchObject({ e: 120, f: 0 });
  });

  it("composes outer and nested Repeat matrices for derived hit testing", () => {
    const outer = {
      ...createNode("transformGroup", 0, 0), id: "outer-repeat", pageId, width: 100, height: 80,
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const inner = {
      ...createNode("transformGroup", 0, 0), id: "inner-repeat", pageId, parentId: outer.id, width: 40, height: 40,
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 40, axis: "VERTICAL" as const }],
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const leaf = {
      ...createNode("ellipse", 0, 0), id: "nested-leaf", pageId, parentId: inner.id, width: 10, height: 10,
      positionId: "30000000000000000000000000000000:00000000000000000000000000000000",
    };
    const nodes = [outer, inner, leaf];
    const hit = findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 105, y: 45 },
      containsSourcePoint: nodeContainsWorldPoint,
    });
    expect(hit).toMatchObject({ node: { id: leaf.id }, groupId: outer.id, matrix: { e: 100, f: 40 } });
  });

  it("composes nested Repeat matrices while applying the inner source mask", () => {
    const outer = {
      ...createNode("transformGroup", 0, 0), id: "masked-outer-repeat", pageId, width: 100, height: 80,
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const inner = {
      ...createNode("transformGroup", 0, 0), id: "masked-inner-repeat", pageId, parentId: outer.id, width: 40, height: 40,
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 40, axis: "VERTICAL" as const }],
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const mask = { ...createNode("ellipse", 0, 0), id: "nested-mask", pageId, parentId: inner.id, width: 10, height: 10, isMask: true, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
    const target = { ...createNode("rectangle", 0, 0), id: "nested-masked-target", pageId, parentId: inner.id, width: 30, height: 20, positionId: "40000000000000000000000000000000:00000000000000000000000000000000" };
    const nodes = [outer, inner, mask, target];
    const visible = findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 105, y: 45 },
      containsSourcePoint: nodeContainsWorldPoint,
      isSourcePointVisible: (node, point) => node.id === target.id && point.x <= 10 && point.y <= 10,
    });
    expect(visible).toMatchObject({ node: { id: target.id }, groupId: outer.id, matrix: { e: 100, f: 40 } });
    expect(findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 115, y: 45 },
      containsSourcePoint: nodeContainsWorldPoint,
      isSourcePointVisible: (_node, point) => point.x <= 10 && point.y <= 10,
    })).toBeUndefined();
  });

  it("treats a derived Boolean as one hit outline instead of exposing its operands", () => {
    const nodes = repeatFixture();
    const groupIndex = nodes.findIndex((node) => node.id === "repeat");
    const boolean = { ...createNode("booleanOperation", 0, 0), id: "boolean", pageId, parentId: "repeat", width: 30, height: 30, booleanOperation: "subtract" as const, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
    const path = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 0 }, { id: "c", x: 30, y: 30 }, { id: "d", x: 0, y: 30 }] }] };
    nodes.splice(groupIndex + 1, 2,
      boolean,
      { ...createNode("vector", 0, 0), id: "operand-a", pageId, parentId: boolean.id, width: 30, height: 30, vectorPath: path, positionId: "31000000000000000000000000000000:00000000000000000000000000000000" },
      { ...createNode("vector", 8, 8), id: "operand-b", pageId, parentId: boolean.id, width: 14, height: 14, vectorPath: path, positionId: "32000000000000000000000000000000:00000000000000000000000000000000" },
    );
    const visited: string[] = [];
    const hit = findTopmostTransformGroupRepeatHit({
      documentNodes: nodes,
      paintOrderNodes: nodes,
      point: { x: 135, y: 15 },
      containsSourcePoint: (node) => {
        visited.push(node.id);
        return node.id === boolean.id;
      },
    });
    expect(hit?.node.id).toBe(boolean.id);
    expect(hit?.paintAfterIndex).toBe(4);
    expect(visited).toEqual([boolean.id]);
  });
});
