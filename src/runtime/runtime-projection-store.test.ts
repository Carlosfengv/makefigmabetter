import { describe, expect, it } from "vitest";
import { RuntimeProjectionStore } from "./runtime-projection-store";
import { isRuntimeError } from "./runtime-errors";
import { resolveRevisionConflict } from "./runtime-transaction-policy";

const initial = {
  revision: 7,
  nodes: [
    { id: "page", type: "PAGE" },
    { id: "frame", type: "FRAME", parentId: "page", x: 0, y: 0 },
  ],
} as const;

describe("RuntimeProjectionStore", () => {
  it("provides synchronous read-your-writes across a created parent and child", () => {
    const store = new RuntimeProjectionStore(initial);
    store.stage({
      transactionId: "tx-create-card",
      baseRevision: 7,
      operations: [
        { type: "create", node: { id: "card", type: "FRAME", parentId: "page", x: 10 } },
        { type: "create", node: { id: "title", type: "TEXT", parentId: "card", characters: "Pending" } },
        { type: "update", nodeId: "frame", patch: { x: 120 } },
      ],
    });

    expect(store.getNode("card")).toMatchObject({ parentId: "page", x: 10, removed: false });
    expect(store.getNode("title")).toMatchObject({ parentId: "card", characters: "Pending" });
    expect(store.getNode("frame")).toMatchObject({ x: 120 });
    expect(initial.nodes[1].x).toBe(0);
  });

  it("projects Boolean wrapping and flatten replacement synchronously", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "a", type: "VECTOR", parentId: "page", siblingIndex: 0, x: 10 },
        { id: "b", type: "VECTOR", parentId: "page", siblingIndex: 1, x: 20 },
      ],
    });
    store.stage({
      transactionId: "tx-boolean",
      baseRevision: 7,
      operations: [{
        type: "boolean",
        node: { id: "boolean", type: "BOOLEAN_OPERATION", parentId: "page", siblingIndex: 0, booleanOperation: "subtract" },
        operandIds: ["a", "b"],
        operandPatches: [{ x: 0 }, { x: 10 }],
        siblingIndexes: [],
        wrapperPatch: {},
        operation: "subtract",
      }],
    });
    expect(store.getNode("boolean")).toMatchObject({ type: "BOOLEAN_OPERATION", booleanOperation: "subtract" });
    expect(store.getNode("a")).toMatchObject({ parentId: "boolean", siblingIndex: 0, x: 0 });
    expect(store.getNode("b")).toMatchObject({ parentId: "boolean", siblingIndex: 1, x: 10 });

    store.append("tx-boolean", [{
      type: "flattenBoolean",
      booleanId: "boolean",
      operandIds: ["a", "b"],
      replacement: { id: "flat", type: "VECTOR", parentId: "page", siblingIndex: 0, vectorPath: { fillRule: "nonZero", subpaths: [] } },
      siblingIndexes: [],
    }]);
    expect(store.getNode("boolean")).toMatchObject({ removed: true });
    expect(store.getNode("a")).toMatchObject({ removed: true });
    expect(store.getNode("flat")).toMatchObject({ type: "VECTOR", parentId: "page", removed: false });
  });

  it("dissolves a neutral Group when Boolean creation adopts every child", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "outer", type: "GROUP", parentId: "page", siblingIndex: 0, opacity: 1, visible: true },
        { id: "group", type: "GROUP", parentId: "outer", siblingIndex: 0, opacity: 1, visible: true },
        { id: "a", type: "VECTOR", parentId: "group", siblingIndex: 0 },
        { id: "b", type: "VECTOR", parentId: "group", siblingIndex: 1 },
      ],
    });

    store.stage({
      transactionId: "tx-boolean-group",
      baseRevision: 7,
      operations: [{
        type: "boolean",
        node: { id: "boolean", type: "BOOLEAN_OPERATION", parentId: "page", siblingIndex: 0, booleanOperation: "union" },
        operandIds: ["a", "b"],
        operandPatches: [{ x: 0 }, { x: 10 }],
        siblingIndexes: [],
        wrapperPatch: {},
        operation: "union",
      }],
    });

    expect(store.getNode("group")).toMatchObject({ removed: true });
    expect(store.getNode("outer")).toMatchObject({ removed: true });
    expect(store.getNode("a")).toMatchObject({ parentId: "boolean", siblingIndex: 0 });
    expect(store.getNode("b")).toMatchObject({ parentId: "boolean", siblingIndex: 1 });
  });

  it("projects ComponentSet creation and Component adoption atomically", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "default", type: "COMPONENT", parentId: "page", siblingIndex: 0, x: 10, y: 20 },
        { id: "hover", type: "COMPONENT", parentId: "page", siblingIndex: 1, x: 80, y: 50 },
        { id: "sibling", type: "RECTANGLE", parentId: "page", siblingIndex: 2 },
      ],
    });
    store.stage({
      transactionId: "tx-component-set",
      baseRevision: 7,
      operations: [{
        type: "componentSet",
        node: {
          id: "button",
          type: "COMPONENT_SET",
          parentId: "page",
          siblingIndex: 0,
          componentSetMetadata: { key: "button", remote: false, componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } }, variantGroupProperties: { State: { values: ["Default", "Hover"] } } },
        },
        childIds: ["default", "hover"],
        childPatches: [
          { parentId: "button", x: 0, y: 0 },
          { parentId: "button", x: 70, y: 30 },
        ],
        siblingIndexes: [{ nodeId: "sibling", siblingIndex: 1 }],
      }],
    });

    expect(store.getNode("button")).toMatchObject({ type: "COMPONENT_SET", parentId: "page", siblingIndex: 0, removed: false });
    expect(store.getNode("default")).toMatchObject({ parentId: "button", siblingIndex: 0, x: 0, y: 0 });
    expect(store.getNode("hover")).toMatchObject({ parentId: "button", siblingIndex: 1, x: 70, y: 30 });
    expect(store.getNode("sibling")).toMatchObject({ parentId: "page", siblingIndex: 1 });

    expect(() => store.stage({
      transactionId: "tx-invalid-component-set",
      baseRevision: 7,
      operations: [{
        type: "componentSet",
        node: { id: "invalid", type: "COMPONENT_SET", parentId: "page", componentSetMetadata: { key: "invalid" } },
        childIds: ["sibling"],
        childPatches: [{ parentId: "invalid" }],
        siblingIndexes: [],
      }],
    })).toThrow();
  });

  it("projects automatic ComponentSet dissolution when its last Component leaves", () => {
    const projection = {
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "group", type: "GROUP", parentId: "page", siblingIndex: 0 },
        { id: "set", type: "COMPONENT_SET", parentId: "group", siblingIndex: 0 },
        { id: "default", type: "COMPONENT", parentId: "set", siblingIndex: 0 },
      ],
    } as const;
    const store = new RuntimeProjectionStore(projection);
    store.stage({
      transactionId: "tx-dissolve-component-set",
      baseRevision: 7,
      operations: [{ type: "update", nodeId: "default", patch: { parentId: "page", siblingIndex: 0 } }],
    });

    expect(store.getNode("default")).toMatchObject({ parentId: "page" });
    expect(store.getNode("default")).not.toHaveProperty("removed", true);
    expect(store.getNode("set")).toMatchObject({ removed: true });
    expect(store.getNode("group")).toMatchObject({ removed: true });
    expect(isRuntimeError(captureError(() => {
      store.append("tx-dissolve-component-set", [{ type: "update", nodeId: "set", patch: { name: "Gone" } }]);
    }), "NODE_REMOVED")).toBe(true);
    expect(store.transaction("tx-dissolve-component-set")?.operations).toHaveLength(1);

    store.rollback("tx-dissolve-component-set");
    expect(store.getNode("set")).not.toHaveProperty("removed", true);
    expect(store.getNode("group")).not.toHaveProperty("removed", true);
    expect(store.getNode("default")).toMatchObject({ parentId: "set" });
  });

  it("keeps a ComponentSet alive until its final child is removed", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "set", type: "COMPONENT_SET", parentId: "page", siblingIndex: 0 },
        { id: "default", type: "COMPONENT", parentId: "set", siblingIndex: 0 },
        { id: "hover", type: "COMPONENT", parentId: "set", siblingIndex: 1 },
      ],
    });
    store.stage({ transactionId: "tx-remove-default", baseRevision: 7, operations: [{ type: "remove", nodeId: "default" }] });
    expect(store.getNode("set")).not.toHaveProperty("removed", true);
    store.append("tx-remove-default", [{ type: "remove", nodeId: "hover" }]);
    expect(store.getNode("set")).toMatchObject({ removed: true });
  });

  it("projects one leaf flatten replacement synchronously", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "rect", type: "RECTANGLE", parentId: "page", siblingIndex: 0, width: 40, height: 30 },
        { id: "sibling", type: "VECTOR", parentId: "page", siblingIndex: 1 },
      ],
    });
    store.stage({
      transactionId: "tx-flatten-node",
      baseRevision: 7,
      operations: [{
        type: "flattenNode",
        sourceId: "rect",
        replacement: { id: "flat", type: "VECTOR", parentId: "page", siblingIndex: 1, vectorPath: { fillRule: "nonZero", subpaths: [] } },
        siblingIndexes: [{ nodeId: "sibling", siblingIndex: 0 }],
      }],
    });

    expect(store.getNode("rect")).toMatchObject({ removed: true });
    expect(store.getNode("flat")).toMatchObject({ type: "VECTOR", parentId: "page", siblingIndex: 1, removed: false });
    expect(store.getNode("sibling")).toMatchObject({ siblingIndex: 0 });
  });

  it("projects a multi-leaf flatten replacement synchronously", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "rect", type: "RECTANGLE", parentId: "page", siblingIndex: 0, width: 40, height: 30 },
        { id: "ellipse", type: "ELLIPSE", parentId: "page", siblingIndex: 1, width: 40, height: 30 },
        { id: "sibling", type: "VECTOR", parentId: "page", siblingIndex: 2 },
      ],
    });
    store.stage({
      transactionId: "tx-flatten-nodes",
      baseRevision: 7,
      operations: [{
        type: "flattenNodes",
        sourceIds: ["rect", "ellipse"],
        replacement: { id: "flat", type: "VECTOR", parentId: "page", siblingIndex: 1, vectorPath: { fillRule: "nonZero", subpaths: [] } },
        siblingIndexes: [{ nodeId: "sibling", siblingIndex: 0 }],
      }],
    });

    expect(store.getNode("rect")).toMatchObject({ removed: true });
    expect(store.getNode("ellipse")).toMatchObject({ removed: true });
    expect(store.getNode("flat")).toMatchObject({ type: "VECTOR", parentId: "page", siblingIndex: 1, removed: false });
    expect(store.getNode("sibling")).toMatchObject({ siblingIndex: 0 });
  });

  it("dissolves a neutral Group when flatten consumes every direct child", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "outer", type: "GROUP", parentId: "page", siblingIndex: 0, opacity: 1, visible: true },
        { id: "group", type: "GROUP", parentId: "outer", siblingIndex: 0, opacity: 1, visible: true },
        { id: "rect", type: "RECTANGLE", parentId: "group", siblingIndex: 0, width: 40, height: 30 },
        { id: "ellipse", type: "ELLIPSE", parentId: "group", siblingIndex: 1, width: 40, height: 30 },
        { id: "sibling", type: "VECTOR", parentId: "page", siblingIndex: 1 },
      ],
    });

    store.stage({
      transactionId: "tx-flatten-group",
      baseRevision: 7,
      operations: [{
        type: "flattenNodes",
        sourceIds: ["rect", "ellipse"],
        replacement: { id: "flat", type: "VECTOR", parentId: "page", siblingIndex: 0, vectorPath: { fillRule: "nonZero", subpaths: [] } },
        siblingIndexes: [{ nodeId: "sibling", siblingIndex: 1 }],
      }],
    });

    expect(store.getNode("rect")).toMatchObject({ removed: true });
    expect(store.getNode("ellipse")).toMatchObject({ removed: true });
    expect(store.getNode("group")).toMatchObject({ removed: true });
    expect(store.getNode("outer")).toMatchObject({ removed: true });
    expect(store.getNode("flat")).toMatchObject({ parentId: "page", siblingIndex: 0, removed: false });
  });

  it("validates absolute aggregate replacements inside active Auto Layout", () => {
    const ownerLayout = { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 8, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false };
    const absoluteLayout = { ...ownerLayout, mode: "none" as const, itemSpacing: 0, absolute: true };
    const projection = {
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" as const },
        { id: "frame", type: "FRAME" as const, parentId: "page", autoLayout: ownerLayout },
        { id: "a", type: "VECTOR" as const, parentId: "frame", siblingIndex: 0, autoLayout: absoluteLayout },
        { id: "b", type: "VECTOR" as const, parentId: "frame", siblingIndex: 1, autoLayout: absoluteLayout },
      ],
    };
    const store = new RuntimeProjectionStore(projection);
    store.stage({
      transactionId: "tx-absolute-layout-boolean",
      baseRevision: 7,
      operations: [{
        type: "boolean",
        node: { id: "boolean", type: "BOOLEAN_OPERATION", parentId: "frame", siblingIndex: 0, booleanOperation: "union", autoLayout: absoluteLayout },
        operandIds: ["a", "b"],
        operandPatches: [{ x: 0 }, { x: 10 }],
        siblingIndexes: [],
        wrapperPatch: {},
        operation: "union",
      }],
    });
    expect(store.getNode("boolean")).toMatchObject({ autoLayout: { mode: "none", absolute: true } });

    const flowProjection = structuredClone(projection);
    flowProjection.nodes[3]!.autoLayout = { ...absoluteLayout, absolute: false };
    const flowStore = new RuntimeProjectionStore(flowProjection);
    expect(isRuntimeError(captureError(() => flowStore.stage({
      transactionId: "tx-flow-layout-boolean",
      baseRevision: 7,
      operations: [{
        type: "boolean",
        node: { id: "boolean", type: "BOOLEAN_OPERATION", parentId: "frame", siblingIndex: 0, booleanOperation: "union", autoLayout: absoluteLayout },
        operandIds: ["a", "b"],
        operandPatches: [{ x: 0 }, { x: 10 }],
        siblingIndexes: [],
        wrapperPatch: {},
        operation: "union",
      }],
    })), "INVALID_ARGUMENT")).toBe(true);

    const missingLayoutStore = new RuntimeProjectionStore(projection);
    expect(isRuntimeError(captureError(() => missingLayoutStore.stage({
      transactionId: "tx-missing-layout-flatten",
      baseRevision: 7,
      operations: [{
        type: "flattenNodes",
        sourceIds: ["a", "b"],
        replacement: { id: "flat", type: "VECTOR", parentId: "frame", siblingIndex: 0, vectorPath: { fillRule: "nonZero", subpaths: [] } },
        siblingIndexes: [],
      }],
    })), "INVALID_ARGUMENT")).toBe(true);
  });

  it("projects Frame-to-Component replacement and child adoption atomically", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "frame", type: "FRAME", parentId: "page", siblingIndex: 0, positionId: "40000000000000000000000000000000:00000000000000000000000000000001" },
        { id: "child", type: "RECTANGLE", parentId: "frame", siblingIndex: 0, x: 8, y: 12 },
      ],
    });
    const finalPositionId = "40000000000000000000000000000000:00000000000000000000000000000001";
    store.stage({
      transactionId: "tx-component-from-node",
      baseRevision: 7,
      operations: [{
        type: "componentFromNode",
        sourceId: "frame",
        replacement: {
          id: "component",
          type: "COMPONENT",
          parentId: "page",
          siblingIndex: 0,
          positionId: finalPositionId,
          componentMetadata: { key: "component", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} },
        },
        childIds: ["child"],
        temporaryPositionId: "fffffffffffffffffffffffffffffffe:00000000000000000000000000000002",
        finalPositionId,
      }],
    });

    expect(store.getNode("frame")).toMatchObject({ removed: true });
    expect(store.getNode("component")).toMatchObject({ type: "COMPONENT", parentId: "page", positionId: finalPositionId, removed: false });
    expect(store.getNode("child")).toMatchObject({ parentId: "component", siblingIndex: 0, x: 8, y: 12 });
  });

  it("projects detached Instance replacement trees atomically", () => {
    const finalPositionId = "40000000000000000000000000000000:00000000000000000000000000000003";
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "instance", type: "INSTANCE", parentId: "page", siblingIndex: 0, positionId: finalPositionId, instanceMetadata: { mainComponentId: "component" } },
        { id: "instance-child", type: "RECTANGLE", parentId: "instance", siblingIndex: 0, x: 8, y: 12 },
      ],
    });
    store.stage({
      transactionId: "tx-detach-instance",
      baseRevision: 7,
      operations: [{
        type: "detachInstance",
        sourceId: "instance",
        sourceIds: ["instance", "instance-child"],
        replacements: [
          { id: "frame", type: "FRAME", parentId: "page", siblingIndex: 0, positionId: finalPositionId, name: "Card detached" },
          { id: "frame-child", type: "RECTANGLE", parentId: "frame", siblingIndex: 0, x: 8, y: 12 },
        ],
        temporaryPositionId: "fffffffffffffffffffffffffffffffe:00000000000000000000000000000004",
        finalPositionId,
      }],
    });

    expect(store.getNode("instance")).toMatchObject({ removed: true });
    expect(store.getNode("instance-child")).toMatchObject({ removed: true });
    expect(store.getNode("frame")).toMatchObject({ type: "FRAME", parentId: "page", positionId: finalPositionId, removed: false });
    expect(store.getNode("frame-child")).toMatchObject({ type: "RECTANGLE", parentId: "frame", x: 8, y: 12, removed: false });
  });

  it("projects same-page cross-parent Boolean moves and reindexes each source parent", () => {
    const store = new RuntimeProjectionStore({
      revision: 7,
      nodes: [
        { id: "page", type: "PAGE" },
        { id: "frame-a", type: "FRAME", parentId: "page", siblingIndex: 0 },
        { id: "frame-b", type: "FRAME", parentId: "page", siblingIndex: 1 },
        { id: "a", type: "VECTOR", parentId: "frame-a", siblingIndex: 0 },
        { id: "a-sibling", type: "VECTOR", parentId: "frame-a", siblingIndex: 1 },
        { id: "b", type: "VECTOR", parentId: "frame-b", siblingIndex: 0 },
        { id: "b-sibling", type: "VECTOR", parentId: "frame-b", siblingIndex: 1 },
      ],
    });

    store.stage({
      transactionId: "tx-cross-parent-boolean",
      baseRevision: 7,
      operations: [{
        type: "boolean",
        node: { id: "boolean", type: "BOOLEAN_OPERATION", parentId: "page", siblingIndex: 1, booleanOperation: "union" },
        operandIds: ["a", "b"],
        operandPatches: [{ x: 0 }, { x: 100 }],
        siblingIndexes: [
          { nodeId: "a-sibling", siblingIndex: 0 },
          { nodeId: "b-sibling", siblingIndex: 0 },
        ],
        wrapperPatch: {},
        operation: "union",
      }],
    });

    expect(store.getNode("a")).toMatchObject({ parentId: "boolean", siblingIndex: 0, x: 0 });
    expect(store.getNode("b")).toMatchObject({ parentId: "boolean", siblingIndex: 1, x: 100 });
    expect(store.getNode("a-sibling")).toMatchObject({ parentId: "frame-a", siblingIndex: 0 });
    expect(store.getNode("b-sibling")).toMatchObject({ parentId: "frame-b", siblingIndex: 0 });
  });

  it("does not settle a write until the matching accepted projection arrives", () => {
    const store = new RuntimeProjectionStore(initial);
    store.stage({ transactionId: "tx-1", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 42 } }] });
    store.acknowledge({ transactionId: "tx-1", acceptedRevision: 8 });

    expect(store.pendingTransactionIds()).toEqual(["tx-1"]);
    expect(store.applyConfirmedProjection({ revision: 9, nodes: [{ id: "page", type: "PAGE" }, { id: "frame", type: "FRAME", parentId: "page", x: 99 }] })).toEqual({ committedTransactionIds: [] });
    expect(store.getNode("frame")).toMatchObject({ x: 42 });
    expect(store.pendingTransactionIds()).toEqual(["tx-1"]);

    const fresh = new RuntimeProjectionStore(initial);
    fresh.stage({ transactionId: "tx-2", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 42 } }] });
    fresh.acknowledge({ transactionId: "tx-2", acceptedRevision: 8 });
    expect(fresh.applyConfirmedProjection({ revision: 8, nodes: [{ id: "page", type: "PAGE" }, { id: "frame", type: "FRAME", parentId: "page", x: 42 }] })).toEqual({ committedTransactionIds: ["tx-2"] });
    expect(fresh.pendingTransactionIds()).toEqual([]);
    expect(fresh.getNode("frame")).toMatchObject({ x: 42 });
  });

  it("exposes a removed node immediately and restores the view on rollback", () => {
    const store = new RuntimeProjectionStore(initial);
    store.stage({ transactionId: "tx-remove", baseRevision: 7, operations: [{ type: "remove", nodeId: "frame" }] });
    expect(store.getNode("frame")).toMatchObject({ id: "frame", type: "FRAME", removed: true });
    expect(store.listLiveNodes().map((node) => node.id)).toEqual(["page"]);
    store.rollback("tx-remove");
    expect(store.getNode("frame")).toMatchObject({ x: 0 });
    expect(store.getNode("frame")).not.toHaveProperty("removed");
  });

  it("reuses composed node objects until the projection generation changes", () => {
    const store = new RuntimeProjectionStore(initial);
    const confirmed = store.getNode("frame");

    expect(store.getNode("frame")).toBe(confirmed);
    expect(store.listLiveNodes().find((node) => node.id === "frame")).toBe(confirmed);
    expect(new Set(Array.from({ length: 1_000 }, () => store.getNode("frame"))).size).toBe(1);

    store.stage({ transactionId: "tx-cache", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 20 } }] });
    const pending = store.getNode("frame");
    expect(pending).not.toBe(confirmed);
    expect(store.getNode("frame")).toBe(pending);
    expect(store.listLiveNodes().find((node) => node.id === "frame")).toBe(pending);

    store.rollback("tx-cache");
    expect(store.getNode("frame")).toBe(confirmed);

    store.applyConfirmedProjection({
      revision: 7,
      nodes: [{ id: "page", type: "PAGE" }, { id: "frame", type: "FRAME", parentId: "page", x: 30 }],
    });
    expect(store.getNode("frame")).toMatchObject({ x: 30 });
    expect(store.getNode("frame")).not.toBe(confirmed);
  });

  it("rejects an append that would invalidate a later pending transaction", () => {
    const store = new RuntimeProjectionStore(initial);
    store.stage({ transactionId: "tx-first", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 10 } }] });
    store.stage({ transactionId: "tx-second", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 20 } }] });
    const visibleBeforeFailure = store.getNode("frame");

    const error = captureError(() => store.append("tx-first", [{ type: "remove", nodeId: "frame" }]));

    expect(isRuntimeError(error, "NODE_REMOVED")).toBe(true);
    expect(store.transaction("tx-first")?.operations).toHaveLength(1);
    expect(store.getNode("frame")).toBe(visibleBeforeFailure);
    expect(store.getNode("frame")).toMatchObject({ x: 20 });
  });

  it("rejects stale base revisions and writes through a removed node", () => {
    const store = new RuntimeProjectionStore(initial);
    const staleError = captureError(() => store.stage({ transactionId: "old", baseRevision: 6, operations: [{ type: "update", nodeId: "frame", patch: { x: 1 } }] }));
    expect(isRuntimeError(staleError, "REVISION_CONFLICT")).toBe(true);
    store.stage({ transactionId: "remove", baseRevision: 7, operations: [{ type: "remove", nodeId: "frame" }] });
    const removedError = captureError(() => store.stage({ transactionId: "update-removed", baseRevision: 7, operations: [{ type: "update", nodeId: "frame", patch: { x: 1 } }] }));
    expect(isRuntimeError(removedError, "NODE_REMOVED")).toBe(true);
  });
});

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}

describe("M0B transaction policies", () => {
  it("requires rebase for commands derived from a stale projection", () => {
    expect(resolveRevisionConflict("register-asset")).toEqual({ type: "retry" });
    expect(resolveRevisionConflict("reparent-node")).toEqual({ type: "rebase" });
    expect(resolveRevisionConflict("text-range-update")).toEqual({ type: "rebase" });
    expect(resolveRevisionConflict("external-authorized-import")).toEqual({ type: "reject" });
  });
});
