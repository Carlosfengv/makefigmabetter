import { describe, expect, it } from "vitest";
import type { EditorSnapshot, MainToWorker } from "../lib/editor-protocol";
import { resolveCoreBatch } from "../lib/transaction-batch";
import { RuntimeWorkerBridge, runtimeProjectionFromEditorSnapshot } from "./runtime-worker-bridge";
import { isRuntimeError } from "./runtime-errors";

describe("RuntimeWorkerBridge", () => {
  it("resolves on-demand Boolean paths only for the requested Worker revision", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const pending = bridge.resolveBooleanPathsAsync(7, ["boolean"]);
    const request = posted[0] as Extract<MainToWorker, { type: "runtime-export-boolean-paths" }>;
    expect(request).toMatchObject({ type: "runtime-export-boolean-paths", revision: 7, nodeIds: ["boolean"] });
    const path = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [{ id: "boolean:runtime-export:0:0", x: 0, y: 0, pointType: "corner" as const }] }] };
    bridge.observe({ type: "runtime-export-boolean-paths-result", requestId: request.requestId, revision: 7, paths: { boolean: path } });
    await expect(pending).resolves.toEqual(new Map([["boolean", path]]));
    bridge.close();
  });

  it("rejects stale and invalid Boolean export responses and closes pending requests", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const stale = bridge.resolveBooleanPathsAsync(7, ["boolean"]);
    const staleRequest = posted[0] as Extract<MainToWorker, { type: "runtime-export-boolean-paths" }>;
    bridge.observe({ type: "runtime-export-boolean-paths-result", requestId: staleRequest.requestId, revision: 8 });
    await expect(stale).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "REVISION_CONFLICT"));
    await expect(bridge.resolveBooleanPathsAsync(7, [])).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "INVALID_ARGUMENT"));
    const closing = bridge.resolveBooleanPathsAsync(7, ["boolean"]);
    bridge.close();
    await expect(closing).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RUNTIME_CLOSED"));
  });

  it("waits for both Worker Ack and the matching projection before accepting a transaction", async () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const pending = bridge.submit({
      transactionId: "tx-1",
      baseRevision: 4,
      operations: [{ type: "update", nodeId: "rect", patch: { x: 42 } }],
    });
    expect(bridge.hasPendingTransactions).toBe(true);
    bridge.observe({ type: "ack", transactionId: "tx-1", acceptedRevision: 5 });
    expect(posted[0]!.transaction.commands).toEqual([{ type: "update", id: "rect", patch: { x: 42 } }]);

    bridge.observe({ type: "snapshot", snapshot: snapshotAt(5) });
    await expect(pending).resolves.toMatchObject({ type: "accepted", acceptedRevision: 5, projection: { revision: 5 } });
    expect(bridge.hasPendingTransactions).toBe(false);
  });

  it("maps variable resource writes to worker commands", async () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const collection = { id: "VC:tokens", key: "", name: "Tokens", remote: false, hiddenFromPublishing: false, modes: [{ modeId: "default", name: "Mode 1" }], defaultModeId: "default" };
    const variable = { id: "V:spacing", key: "", name: "Spacing", description: "", remote: false, hiddenFromPublishing: false, collectionId: collection.id, resolvedType: "FLOAT" as const, valuesByMode: { default: 0 }, scopes: ["ALL_SCOPES"] };
    const pending = bridge.submit({
      transactionId: "tx-variable",
      baseRevision: 4,
      operations: [
        { type: "registerVariableCollection", collection },
        { type: "registerVariable", variable },
        { type: "setVariable", variable: { ...variable, name: "Space" } },
        { type: "deleteVariable", id: variable.id },
        { type: "setVariableCollection", collection: { ...collection, name: "Design tokens" }, variables: [] },
        { type: "deleteVariableCollection", id: collection.id },
      ],
    });

    expect(posted[0]?.transaction.commands).toEqual([
      { type: "register-variable-collection", collection },
      { type: "register-variable", variable },
      { type: "set-variable", variable: { ...variable, name: "Space" } },
      { type: "delete-variable", id: variable.id },
      { type: "set-variable-collection", collection: { ...collection, name: "Design tokens" }, variables: [] },
      { type: "delete-variable-collection", id: collection.id },
    ]);
    bridge.close();
    await expect(pending).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RUNTIME_CLOSED"));
  });

  it("accepts a transaction when the matching projection arrives before its Worker Ack", async () => {
    const bridge = new RuntimeWorkerBridge(() => undefined);
    const pending = bridge.submit({
      transactionId: "tx-snapshot-first",
      baseRevision: 4,
      operations: [{ type: "update", nodeId: "rect", patch: { x: 42 } }],
    });

    bridge.observe({ type: "snapshot", snapshot: snapshotAt(5) });
    bridge.observe({ type: "ack", transactionId: "tx-snapshot-first", acceptedRevision: 5 });

    await expect(pending).resolves.toMatchObject({ type: "accepted", acceptedRevision: 5, projection: { revision: 5 } });
    expect(bridge.hasPendingTransactions).toBe(false);
  });

  it("projects document/page ownership and omits non-Plugin IMAGE records", () => {
    const projection = runtimeProjectionFromEditorSnapshot(snapshotAt(4));
    expect(projection.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "DOCUMENT" }),
      expect.objectContaining({ id: "page", type: "PAGE" }),
      expect.objectContaining({ id: "rect", type: "RECTANGLE", parentId: "page" }),
    ]));
  });

  it("carries the canonical TextStyle catalog into the runtime projection", () => {
    const textStyles = [{
      id: "S:body",
      key: "",
      name: "Body",
      description: "Body copy",
      remote: false,
      style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 },
    }];
    const projection = runtimeProjectionFromEditorSnapshot({ ...snapshotAt(4), textStyles });

    expect(projection.textStyles).toEqual(textStyles);
    expect(projection.textStyles).not.toBe(textStyles);
  });

  it.each([1_000, 5_000, 10_000, 100_000])("assigns sibling indexes in one pass for %i flat nodes", (nodeCount) => {
    let parentReads = 0;
    const nodes: EditorSnapshot["nodes"] = Array.from({ length: nodeCount }, (_, index) => {
      const node = {
        id: `rect-${index}`,
        kind: "rectangle" as const,
        name: `Rectangle ${index}`,
        x: index,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        fill: "#fff",
        stroke: "transparent",
        radius: 0,
        strokeWidth: 0,
        opacity: 1,
      };
      Object.defineProperty(node, "parentId", {
        enumerable: true,
        get() {
          parentReads += 1;
          return undefined;
        },
      });
      return node;
    });

    const projection = runtimeProjectionFromEditorSnapshot({ ...snapshotAt(4), nodes });
    const sceneNodes = projection.nodes.filter((node) => node.type === "RECTANGLE");

    expect(sceneNodes).toHaveLength(nodeCount);
    expect(sceneNodes[0]).toMatchObject({ id: "rect-0", parentId: "page", siblingIndex: 0 });
    expect(sceneNodes.at(-1)).toMatchObject({ id: `rect-${nodeCount - 1}`, parentId: "page", siblingIndex: nodeCount - 1 });
    expect(parentReads).toBeLessThanOrEqual(nodeCount * 2);
  });

  it("gives created nodes a deterministic Core layer position", async () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-2",
      baseRevision: 4,
      operations: [{
        type: "create",
        node: { id: "00000000-0000-4000-8000-000000000002", type: "RECTANGLE", parentId: "page", name: "Card", x: 0, y: 0, width: 100, height: 80 },
      }],
    }).catch(() => undefined);

    expect(posted[0]!.transaction.commands[0]).toEqual(expect.objectContaining({
      type: "create",
      node: expect.objectContaining({ positionId: "80000000000000000000000000000000:00000000000040008000000000000002" }),
    }));
    expect(posted[0]!.transaction.commands[0]).toEqual(expect.objectContaining({
      node: expect.not.objectContaining({ parentId: "page" }),
    }));
    bridge.close();
  });

  it("maps an M1 frame create and setter batch to a concrete Core batch", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-3",
      baseRevision: 4,
      operations: [
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000003", type: "FRAME", parentId: "page", name: "M1 card", x: 48, y: 64, width: 320, height: 180, autoLayout: { mode: "vertical", padding: [20, 16, 20, 16], itemSpacing: 12, wrap: false, primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed", counterSizing: "fixed", absolute: false } } },
        { type: "update", nodeId: "00000000-0000-4000-8000-000000000003", patch: { x: 49 } },
      ],
    }).catch(() => undefined);

    expect(resolveCoreBatch([
      { id: "00000000-0000-4000-8000-000000000001", pageId: "00000000-0000-0000-0000-000000000001", kind: "frame", name: "Product card", x: -250, y: -170, width: 500, height: 340, rotation: 0, fill: "#fbfbf8", stroke: "#d4d5cb", strokeWidth: 1, radius: 18, opacity: 1, visible: true },
      { id: "00000000-0000-4000-8000-000000000002", pageId: "00000000-0000-0000-0000-000000000001", kind: "ellipse", name: "Sun disc", x: -194, y: -112, width: 130, height: 130, rotation: 0, fill: "#f6ad62", stroke: "#b4612d", strokeWidth: 1, radius: 0, opacity: 1, visible: true },
    ], posted[0]!.transaction.commands)).toBeDefined();
    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000003",
          x: 49,
          autoLayout: expect.objectContaining({ mode: "vertical", itemSpacing: 12 }),
        }),
      }),
    ]);
    bridge.close();
  });

  it("preserves parametric and vector geometry when lowering Runtime creates", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-geometry-create",
      baseRevision: 4,
      operations: [
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000021", type: "POLYGON", parentId: "page", name: "Polygon", width: 100, height: 100, fill: "#d9f99d", stroke: "#4d7c0f", strokeWidth: 1, parametricShape: { kind: "polygon", pointCount: 8 } } },
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000022", type: "VECTOR", parentId: "page", name: "Vector", width: 80, height: 60, vectorPath: { fillRule: "nonZero", subpaths: [{ closed: false, points: [{ id: "point-1", x: 0, y: 0, pointType: "corner" }, { id: "point-2", x: 80, y: 60, pointType: "corner" }] }] } } },
      ],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "polygon", fill: "#d9f99d", stroke: "#4d7c0f", strokeWidth: 1, parametricShape: { kind: "polygon", pointCount: 8 } }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "vector", vectorPath: expect.objectContaining({ fillRule: "nonZero" }) }) }),
    ]);
    bridge.close();
  });

  it("lowers Component and Slice creates with their durable creation metadata", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-component-slice-create",
      baseRevision: 4,
      operations: [
        {
          type: "create",
          node: {
            id: "00000000-0000-4000-8000-000000000023",
            type: "COMPONENT",
            parentId: "page",
            siblingIndex: 1,
            name: "Card",
            width: 100,
            height: 100,
            componentMetadata: {
              key: "00000000-0000-4000-8000-000000000023",
              remote: false,
              description: "",
              descriptionMarkdown: "",
              documentationLinks: [],
              componentPropertyDefinitions: {},
            },
          },
        },
        {
          type: "create",
          node: {
            id: "00000000-0000-4000-8000-000000000024",
            type: "SLICE",
            parentId: "page",
            siblingIndex: 2,
            name: "Slice",
            width: 320,
            height: 180,
            fill: "transparent",
            stroke: "transparent",
            strokeWidth: 0,
          },
        },
      ],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "component", componentMetadata: expect.objectContaining({ remote: false }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "slice", width: 320, height: 180, strokeWidth: 0 }) }),
    ]);
    expect(resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands)).toBeDefined();
    bridge.close();
  });

  it("lowers a linked Instance subtree and preserves its source-node identities", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const sourceExtension = (sourceId: string) => ({ "figma.instance.source-node.v1": [...new TextEncoder().encode(sourceId)] });
    void bridge.submit({
      transactionId: "tx-instance-create",
      baseRevision: 4,
      operations: [
        {
          type: "create",
          node: {
            id: "00000000-0000-4000-8000-000000000025",
            type: "COMPONENT",
            parentId: "page",
            pageId: "page",
            siblingIndex: 1,
            name: "Card",
            width: 100,
            height: 100,
            componentMetadata: { key: "card", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} },
          },
        },
        {
          type: "create",
          node: {
            id: "00000000-0000-4000-8000-000000000026",
            type: "INSTANCE",
            parentId: "page",
            pageId: "page",
            siblingIndex: 2,
            name: "Card instance",
            width: 100,
            height: 100,
            extensions: sourceExtension("00000000-0000-4000-8000-000000000025"),
            instanceMetadata: { mainComponentId: "00000000-0000-4000-8000-000000000025", scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false },
          },
        },
        {
          type: "create",
          node: {
            id: "00000000-0000-4000-8000-000000000027",
            type: "RECTANGLE",
            parentId: "00000000-0000-4000-8000-000000000026",
            pageId: "page",
            siblingIndex: 0,
            name: "Card surface",
            width: 100,
            height: 100,
            extensions: sourceExtension("source-rectangle"),
          },
        },
      ],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "component" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "instance", instanceMetadata: expect.objectContaining({ mainComponentId: "00000000-0000-4000-8000-000000000025" }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "rectangle", parentId: "00000000-0000-4000-8000-000000000026", extensions: sourceExtension("source-rectangle") }) }),
    ]);
    const resolved = resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000026", kind: "instance", instanceMetadata: expect.objectContaining({ mainComponentId: "00000000-0000-4000-8000-000000000025" }) }),
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000027", parentId: "00000000-0000-4000-8000-000000000026" }),
    ]));
    bridge.close();
  });

  it("lowers bounded special-node Runtime creates without dropping their durable metadata", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-special-create",
      baseRevision: 4,
      operations: [
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000031", type: "CONNECTOR", parentId: "page", name: "Connector", width: 200, height: 0, connectorMetadata: { lineType: "ELBOWED", start: { x: 0, y: 0 }, end: { x: 200, y: 80 }, startStrokeCap: "NONE", endStrokeCap: "TRIANGLE_FILLED", text: "Review" } } },
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000032", type: "SHAPE_WITH_TEXT", parentId: "page", name: "Decision", width: 208, height: 208, shapeWithTextType: "DIAMOND", characters: "Approve" } },
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000033", type: "TEXT_PATH", parentId: "page", name: "Text path", width: 160, height: 120, characters: "Curve", vectorPath: { fillRule: "nonZero", subpaths: [] }, textPathMetadata: { startSegment: 0, startPosition: .25, autoRename: true, textAlignHorizontal: "LEFT", textAlignVertical: "CENTER" } } },
      ],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "connector", connectorMetadata: expect.objectContaining({ lineType: "ELBOWED", text: "Review" }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "shapeWithText", shapeWithTextType: "DIAMOND", text: "Approve" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "textPath", textPathMetadata: expect.objectContaining({ startPosition: .25 }), text: "Curve" }) }),
    ]);
    expect(resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands)).toBeDefined();
    bridge.close();
  });

  it("lowers an existing vector-like node to an identity-preserving TextPath conversion", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const vectorPath = {
      fillRule: "nonZero" as const,
      subpaths: [{
        closed: false,
        points: [
          { id: "point-1", x: 0, y: 40, pointType: "corner" as const },
          { id: "point-2", x: 100, y: 40, pointType: "corner" as const },
        ],
      }],
    };
    const textPathMetadata = {
      startSegment: 0,
      startPosition: .25,
      autoRename: true,
      textAlignHorizontal: "LEFT" as const,
      textAlignVertical: "CENTER" as const,
    };

    void bridge.submit({
      transactionId: "tx-convert-text-path",
      baseRevision: 4,
      operations: [{
        type: "update",
        nodeId: "rect",
        convertToTextPath: true,
        patch: { type: "TEXT_PATH", vectorPath, textPathMetadata },
      }],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([{
      type: "convertToTextPath",
      id: "rect",
      vectorPath,
      metadata: textPathMetadata,
    }]);
    const resolved = resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands);
    expect(resolved?.batch).toEqual([
      expect.objectContaining({
        type: "convertToTextPath",
        node: expect.objectContaining({ id: "rect", kind: "textPath", x: 0, y: 0, width: 100, height: 80 }),
      }),
    ]);
    expect(resolved?.nextNodes).toContainEqual(expect.objectContaining({ id: "rect", kind: "textPath" }));
    bridge.close();
  });

  it("lowers Runtime Boolean and flatten operations to forced-ID structural commands", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-boolean",
      baseRevision: 4,
      operations: [{
        type: "boolean",
        node: { id: "boolean-id", type: "BOOLEAN_OPERATION", parentId: "page", siblingIndex: 0 },
        operandIds: ["vector-a", "vector-b"],
        operandPatches: [{}, {}],
        siblingIndexes: [],
        wrapperPatch: {},
        operation: "exclude",
      }],
    }).catch(() => undefined);
    void bridge.submit({
      transactionId: "tx-flatten",
      baseRevision: 4,
      operations: [{
        type: "flattenBoolean",
        booleanId: "boolean-id",
        operandIds: ["vector-a", "vector-b"],
        replacement: { id: "flat-id", type: "VECTOR", parentId: "page" },
        siblingIndexes: [],
      }],
    }).catch(() => undefined);
    const vectorPath = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [{ id: "p1", x: 0, y: 0, pointType: "corner" as const }] }] };
    void bridge.submit({
      transactionId: "tx-flatten-node",
      baseRevision: 4,
      operations: [{
        type: "flattenNode",
        sourceId: "rect",
        replacement: { id: "flat-rect-id", type: "VECTOR", parentId: "page", siblingIndex: 1, vectorPath },
        siblingIndexes: [],
      }],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([{ type: "boolean", ids: ["vector-a", "vector-b"], operation: "exclude", id: "boolean-id", pageId: "page", index: 0 }]);
    expect(posted[1]?.transaction.commands).toEqual([{ type: "flattenBoolean", id: "boolean-id", replacementId: "flat-id", pageId: "page" }]);
    expect(posted[2]?.transaction.commands).toEqual([{ type: "flattenNode", id: "rect", replacementId: "flat-rect-id", vectorPath, pageId: "page", index: 1 }]);
    bridge.close();
  });

  it("lowers a same-turn linear Repeat to the official target parent and index", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const modifier = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 2, unitType: "PIXELS" as const, offset: 240, axis: "HORIZONTAL" as const }];
    void bridge.submit({
      transactionId: "tx-repeat",
      baseRevision: 4,
      operations: [
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000041", type: "RECTANGLE", parentId: "page", siblingIndex: 1, x: 20, y: 30, width: 100, height: 80 } },
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000042", type: "ELLIPSE", parentId: "page", siblingIndex: 2, x: 140, y: 30, width: 80, height: 80 } },
        {
          type: "transformGroup",
          node: { id: "00000000-0000-4000-8000-000000000043", type: "TRANSFORM_GROUP", parentId: "page", siblingIndex: 0, x: 20, y: 30, width: 200, height: 80, transformModifiers: modifier },
          childIds: ["00000000-0000-4000-8000-000000000041", "00000000-0000-4000-8000-000000000042"],
          childPatches: [{ x: 0, y: 0 }, { x: 120, y: 0 }],
          siblingIndexes: [{ nodeId: "rect", siblingIndex: 1 }],
          modifiers: modifier,
          wrapperPatch: {},
        },
        { type: "update", nodeId: "00000000-0000-4000-8000-000000000043", patch: { name: "Repeated pair" } },
      ],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands.map((command) => command.type)).toEqual(["create", "create", "transformGroup"]);
    expect(posted[0]?.transaction.commands.at(-1)).toEqual({
      type: "transformGroup",
      ids: ["00000000-0000-4000-8000-000000000041", "00000000-0000-4000-8000-000000000042"],
      id: "00000000-0000-4000-8000-000000000043",
      pageId: "page",
      index: 0,
      modifiers: modifier,
      patch: { name: "Repeated pair" },
    });
    expect(resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands)).toBeDefined();
    bridge.close();
  });

  it("lowers same-turn Vector creation and Boolean wrapping to one resolvable Core batch", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const path = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [{ id: "p1", x: 0, y: 0, pointType: "corner" as const }, { id: "p2", x: 100, y: 0, pointType: "corner" as const }, { id: "p3", x: 0, y: 100, pointType: "corner" as const }] }] };
    void bridge.submit({
      transactionId: "tx-create-boolean",
      baseRevision: 4,
      operations: [
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000201", type: "VECTOR", parentId: "page", siblingIndex: 1, x: 40, y: 40, width: 100, height: 100, vectorPath: path } },
        { type: "create", node: { id: "00000000-0000-4000-8000-000000000202", type: "VECTOR", parentId: "page", siblingIndex: 2, x: 40, y: 40, width: 100, height: 100, vectorPath: path } },
        { type: "boolean", node: { id: "00000000-0000-4000-8000-000000000203", type: "BOOLEAN_OPERATION", parentId: "page", siblingIndex: 0 }, operandIds: ["00000000-0000-4000-8000-000000000201", "00000000-0000-4000-8000-000000000202"], operandPatches: [{}, {}], siblingIndexes: [{ nodeId: "rect", siblingIndex: 1 }], wrapperPatch: {}, operation: "subtract" },
        { type: "update", nodeId: "00000000-0000-4000-8000-000000000203", patch: { name: "Runtime Boolean" } },
      ],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands.map((command) => command.type)).toEqual(["create", "create", "boolean"]);
    expect(posted[0]?.transaction.commands.at(-1)).toMatchObject({ type: "boolean", patch: { name: "Runtime Boolean" } });
    expect(resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands)).toBeDefined();
    bridge.close();
  });

  it("lowers Runtime insertChild order to one atomic reparent and reposition", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-ordered-reparent",
      baseRevision: 4,
      operations: [{
        type: "update",
        nodeId: "rect",
        patch: {
          parentId: "frame",
          siblingIndex: 0,
          positionId: "40000000000000000000000000000000:00000000000000000000000000000007",
        },
      }],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([
      { type: "reparent", ids: ["rect"], parentId: "frame" },
      { type: "reposition", positionIds: [{ id: "rect", positionId: "40000000000000000000000000000000:00000000000000000000000000000007" }] },
    ]);
    bridge.close();
  });

  it("lowers an isMask update to Core's dedicated SetMask operation", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    void bridge.submit({
      transactionId: "tx-mask",
      baseRevision: 4,
      operations: [{ type: "update", nodeId: "rect", patch: { name: "Mask source", isMask: true } }],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands).toEqual([
      { type: "update", id: "rect", patch: { name: "Mask source" } },
      { type: "setMask", id: "rect", enabled: true },
    ]);
    expect(resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands)?.batch.map((command) => command.type)).toEqual(["update", "setMask"]);
    bridge.close();
  });

  it("waits for the Worker Snapshot that confirms an admitted font is ready", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4, { "font-1": "idle" }) });
    const loading = bridge.loadFontAsync("font-1");
    expect(posted).toContainEqual({ type: "load-font", assetId: "font-1" });
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4, { "font-1": "ready" }) });
    await expect(loading).resolves.toBeUndefined();
    bridge.close();
  });

  it("registers admitted image metadata before resolving the asset Snapshot fence", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const asset = { assetId: "image-1", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: 3, pixelWidth: 1, pixelHeight: 1 };
    const registered = bridge.registerAssetAsync(asset, Uint8Array.of(1, 2, 3));
    expect(posted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "register-asset", asset }),
      expect.objectContaining({ type: "asset-bytes", assetId: "image-1", mediaType: "image/png" }),
    ]));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(5, undefined, [asset]) });
    await expect(registered).resolves.toBeUndefined();
    bridge.close();
  });

  it("fences selection writes on the matching shared Worker view-state", async () => {
    const posted: MainToWorker[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const observed: string[][] = [];
    bridge.subscribeViewState((state) => observed.push([...state.selectedIds]));
    const selected = bridge.setSelectionAsync(["rect"]);
    expect(posted).toContainEqual({ type: "command", command: { type: "select", ids: ["rect"] } });
    bridge.observe({ type: "view-state", activePageId: "page", selectedIds: ["rect"], viewport: { x: 0, y: 0, zoom: 1 }, performance: { rollingInputToRenderMs: [], currentInputToRenderMs: 0, p95InputToRenderMs: 0, maxInputToRenderMs: 0, violationsOver100Ms: 0, renderSamples: 0, lastRenderMs: 0, p95RenderMs: 0, maxRenderMs: 0, gpuSceneBuildSamples: 0, lastGpuSceneBuildMs: 0, p95GpuSceneBuildMs: 0, maxGpuSceneBuildMs: 0 }, viewportChanged: false });
    await expect(selected).resolves.toBeUndefined();
    expect(observed).toEqual([["rect"]]);
    bridge.close();
  });
});

function snapshotAt(revision: number, fontAvailability?: EditorSnapshot["fontAvailability"], assets?: EditorSnapshot["assets"]): EditorSnapshot {
  return {
    documentId: "doc",
    revision,
    nodes: [{ id: "rect", kind: "rectangle", name: "Rectangle", x: 0, y: 0, width: 100, height: 80, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 }],
    assets: assets ?? (fontAvailability ? [{ assetId: "font-1", contentHash: "f".repeat(64), mediaType: "font/ttf", byteLength: 10 }] : []),
    fontAvailability,
    pages: [{ id: "page", name: "Page 1", positionId: "a" }],
    activePageId: "page",
    selectedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    canUndo: false,
    canRedo: false,
    renderer: "Canvas 2D",
    documentCore: "Rust/WASM bridge ready",
  };
}
