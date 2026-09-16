import { describe, expect, it } from "vitest";
import type { EditorSnapshot, MainToWorker } from "../lib/editor-protocol";
import { resolveCoreBatch } from "../lib/transaction-batch";
import { RuntimeWorkerBridge, runtimeProjectionFromEditorSnapshot } from "./runtime-worker-bridge";
import { isRuntimeError } from "./runtime-errors";
import { RuntimeSession } from "./runtime-session";
import type { PendingProjectionTransaction } from "./runtime-projection-store";

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

  it("maps extended Runtime scene types to their canonical Core kinds", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const types = [
      ["CODE_BLOCK", "codeBlock"],
      ["COMPONENT_SET", "componentSet"],
      ["EMBED", "embed"],
      ["HIGHLIGHT", "highlight"],
      ["LINK_UNFURL", "linkUnfurl"],
      ["MEDIA", "media"],
      ["STAMP", "stamp"],
      ["STICKY", "sticky"],
      ["TABLE", "table"],
      ["TABLE_CELL", "tableCell"],
      ["WASHI_TAPE", "washiTape"],
      ["WIDGET", "widget"],
    ] as const;
    const operations = types.map(([type], index) => ({
      type: "create" as const,
      node: {
        id: `00000000-0000-4000-8000-${(0x30 + index).toString(16).padStart(12, "0")}`,
        type,
        parentId: "page",
        siblingIndex: index + 1,
        name: type,
        width: 100,
        height: 100,
      },
    })) as PendingProjectionTransaction["operations"];
    void bridge.submit({ transactionId: "tx-extended-types", baseRevision: 4, operations }).catch(() => undefined);

    expect(posted[0]!.transaction.commands.map((command) => command.type === "create" ? command.node.kind : command.type)).toEqual(types.map(([, kind]) => kind));
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

  it("lowers a Runtime deep clone to an ordered Core subtree", async () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const snapshot = snapshotAt(4);
    bridge.observe({ type: "snapshot", snapshot });
    let sequence = 0;
    const session = new RuntimeSession({
      sessionId: "clone-core-lowering",
      projection: runtimeProjectionFromEditorSnapshot(snapshot),
      transport: bridge,
      createId: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
      scheduleMicrotask: () => {},
    });
    const frame = session.createFrame();
    frame.appendChild(session.createRectangle());
    const clone = frame.clone();
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: frame.id, kind: "frame" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: frame.id, kind: "rectangle" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: clone.id, kind: "frame" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: clone.id, kind: "rectangle" }) }),
    ]);
    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: clone.id, kind: "frame" }),
      expect.objectContaining({ parentId: clone.id, kind: "rectangle" }),
    ]));

    bridge.close();
    await commit;
  });

  it("lowers a cloned Table with its cells through Core structure validation", async () => {
    const tableId = "00000000-0000-4000-8000-000000000051";
    const cellAId = "00000000-0000-4000-8000-000000000052";
    const cellBId = "00000000-0000-4000-8000-000000000053";
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: tableId, pageId: "page", kind: "table", name: "Table", x: 0, y: 0, width: 200, height: 40, rotation: 0, fill: "#fff", stroke: "#ddd", radius: 0, strokeWidth: 1, opacity: 1, tableMetadata: { rowHeights: [40], columnWidths: [100, 100] } },
        { id: cellAId, pageId: "page", parentId: tableId, kind: "tableCell", name: "A", x: 0, y: 0, width: 100, height: 40, rotation: 0, fill: "#fff", stroke: "#ddd", radius: 0, strokeWidth: 1, opacity: 1, text: "A", tableCellMetadata: { rowIndex: 0, columnIndex: 0 } },
        { id: cellBId, pageId: "page", parentId: tableId, kind: "tableCell", name: "B", x: 100, y: 0, width: 100, height: 40, rotation: 0, fill: "#fff", stroke: "#ddd", radius: 0, strokeWidth: 1, opacity: 1, text: "B", tableCellMetadata: { rowIndex: 0, columnIndex: 1 } },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    let sequence = 0x60;
    const session = new RuntimeSession({
      sessionId: "table-clone-core-lowering",
      projection: runtimeProjectionFromEditorSnapshot(snapshot),
      transport: bridge,
      createId: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
      scheduleMicrotask: () => {},
    });
    const table = session.currentPage.children.find((node) => node.id === tableId)!;
    const clone = table.clone();
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: clone.id, kind: "table" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: clone.id, kind: "tableCell", tableCellMetadata: { rowIndex: 0, columnIndex: 0 } }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: clone.id, kind: "tableCell", tableCellMetadata: { rowIndex: 0, columnIndex: 1 } }) }),
    ]);
    expect(resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands)?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: clone.id, kind: "table" }),
      expect.objectContaining({ parentId: clone.id, kind: "tableCell" }),
    ]));

    bridge.close();
    await commit;
  });

  it("lowers a cloned ComponentSet with new Component identities through Core", async () => {
    const setId = "00000000-0000-4000-8000-000000000071";
    const variantId = "00000000-0000-4000-8000-000000000072";
    const childId = "00000000-0000-4000-8000-000000000073";
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: setId, pageId: "page", kind: "componentSet", name: "Button", x: 0, y: 0, width: 200, height: 80, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentSetMetadata: { key: "button-set", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {}, variantGroupProperties: {} } },
        { id: variantId, pageId: "page", parentId: setId, kind: "component", name: "State=Default", x: 0, y: 0, width: 100, height: 40, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: { key: "button-default", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} } },
        { id: childId, pageId: "page", parentId: variantId, kind: "rectangle", name: "Surface", x: 0, y: 0, width: 100, height: 40, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    let sequence = 0x80;
    const session = new RuntimeSession({
      sessionId: "component-set-clone-core-lowering",
      projection: runtimeProjectionFromEditorSnapshot(snapshot),
      transport: bridge,
      createId: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
      scheduleMicrotask: () => {},
    });
    const set = session.currentPage.children.find((node) => node.id === setId)!;
    const clone = set.clone();
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: clone.id, kind: "componentSet", componentSetMetadata: expect.objectContaining({ key: clone.id, remote: false }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: clone.id, kind: "component", componentMetadata: expect.objectContaining({ remote: false }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "rectangle" }) }),
    ]);
    expect(resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands)?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: clone.id, kind: "componentSet" }),
      expect.objectContaining({ parentId: clone.id, kind: "component" }),
    ]));

    bridge.close();
    await commit;
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

  it("lowers Component.createSlot as one valid Core component subtree", async () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const snapshot = snapshotAt(4);
    bridge.observe({ type: "snapshot", snapshot });
    let sequence = 0x90;
    const session = new RuntimeSession({
      sessionId: "component-slot-core-lowering",
      projection: runtimeProjectionFromEditorSnapshot(snapshot),
      transport: bridge,
      createId: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
      scheduleMicrotask: () => {},
    });
    const component = session.createComponent();
    const instance = component.createInstance();
    const slot = component.createSlot();
    const propertyName = Object.keys(component.componentPropertyDefinitions)[0]!;
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({
          id: component.id,
          kind: "component",
          componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "SLOT" } } }),
        }),
      }),
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({ id: instance.id, kind: "instance", instanceMetadata: expect.objectContaining({ mainComponentId: component.id }) }),
      }),
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({ id: slot.id, parentId: component.id, kind: "slot", slotMetadata: { propertyName } }),
      }),
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({ parentId: instance.id, kind: "slot", slotMetadata: { propertyName, sourceSlotId: slot.id } }),
      }),
    ]);
    expect(resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands)?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: component.id, kind: "component", componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "SLOT" } } }) }),
      expect.objectContaining({ id: slot.id, parentId: component.id, kind: "slot", slotMetadata: { propertyName } }),
      expect.objectContaining({ parentId: instance.id, kind: "slot", slotMetadata: { propertyName, sourceSlotId: slot.id } }),
    ]));

    bridge.close();
    await commit;
  });

  it("converts a referenced Frame and its linked clone to Slots through Core", async () => {
    const componentId = "00000000-0000-4000-8000-0000000001a1";
    const sourceFrameId = "00000000-0000-4000-8000-0000000001a2";
    const sourceChildId = "00000000-0000-4000-8000-0000000001a3";
    const instanceId = "00000000-0000-4000-8000-0000000001a4";
    const instanceFrameId = "00000000-0000-4000-8000-0000000001a5";
    const instanceChildId = "00000000-0000-4000-8000-0000000001a6";
    const propertyName = "Content#1:1";
    const sourceExtension = (sourceId: string) => ({ "figma.instance.source-node.v1": [...new TextEncoder().encode(sourceId)] });
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: { key: componentId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: { [propertyName]: { type: "SLOT" } } } },
        { id: sourceFrameId, pageId: "page", parentId: componentId, kind: "frame", name: "Content", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: sourceChildId, pageId: "page", parentId: sourceFrameId, kind: "rectangle", name: "Default content", x: 4, y: 4, width: 92, height: 52, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: instanceId, pageId: "page", kind: "instance", name: "Card instance", x: 120, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false } },
        { id: instanceFrameId, pageId: "page", parentId: instanceId, kind: "frame", name: "Content", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, extensions: sourceExtension(sourceFrameId) },
        { id: instanceChildId, pageId: "page", parentId: instanceFrameId, kind: "rectangle", name: "Default content", x: 4, y: 4, width: 92, height: 52, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, extensions: sourceExtension(sourceChildId) },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    let sequence = 0x1a6;
    const session = new RuntimeSession({
      sessionId: "slot-reference-core",
      projection: runtimeProjectionFromEditorSnapshot(snapshot),
      transport: bridge,
      createId: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
      scheduleMicrotask: () => {},
    });
    const component = session.currentPage.children.find((node) => node.id === componentId)!;
    const sourceFrame = component.children.find((node) => node.id === sourceFrameId)!;
    sourceFrame.componentPropertyReferences = { slotContentId: propertyName };
    const sourceSlot = component.children.find((node) => node.type === "SLOT")!;
    const instance = session.currentPage.children.find((node) => node.id === instanceId)!;
    const instanceSlot = instance.children.find((node) => node.type === "SLOT")!;
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: sourceSlot.id, kind: "slot", slotMetadata: { propertyName }, componentPropertyReferences: { slotContentId: propertyName } }) }),
      { type: "reparent", ids: [sourceChildId], parentId: sourceSlot.id },
      { type: "delete", ids: [sourceFrameId] },
      expect.objectContaining({ type: "reposition", positionIds: [{ id: sourceSlot.id, positionId: expect.any(String) }] }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: instanceSlot.id, kind: "slot", slotMetadata: { propertyName, sourceSlotId: sourceSlot.id }, componentPropertyReferences: { slotContentId: propertyName } }) }),
      { type: "reparent", ids: [instanceChildId], parentId: instanceSlot.id },
      { type: "delete", ids: [instanceFrameId] },
      expect.objectContaining({ type: "reposition", positionIds: [{ id: instanceSlot.id, positionId: expect.any(String) }] }),
    ]);
    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceSlot.id, kind: "slot", slotMetadata: { propertyName } }),
      expect.objectContaining({ id: sourceChildId, parentId: sourceSlot.id }),
      expect.objectContaining({ id: instanceSlot.id, kind: "slot", slotMetadata: { propertyName, sourceSlotId: sourceSlot.id } }),
      expect.objectContaining({ id: instanceChildId, parentId: instanceSlot.id }),
    ]));
    expect(resolved?.nextNodes.some((node) => node.id === sourceFrameId || node.id === instanceFrameId)).toBe(false);
    bridge.close();
    await commit;
  });

  it("deletes a Slot property and resets linked contents through Core", async () => {
    const componentId = "00000000-0000-4000-8000-0000000001b1";
    const sourceSlotId = "00000000-0000-4000-8000-0000000001b2";
    const sourceChildId = "00000000-0000-4000-8000-0000000001b3";
    const instanceId = "00000000-0000-4000-8000-0000000001b4";
    const instanceSlotId = "00000000-0000-4000-8000-0000000001b5";
    const overrideId = "00000000-0000-4000-8000-0000000001b6";
    const propertyName = "Content#1:1";
    const references = { slotContentId: propertyName };
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: { key: componentId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: { [propertyName]: { type: "SLOT" } } } },
        { id: sourceSlotId, pageId: "page", parentId: componentId, kind: "slot", name: "Content", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, slotMetadata: { propertyName }, componentPropertyReferences: references },
        { id: sourceChildId, pageId: "page", parentId: sourceSlotId, kind: "rectangle", name: "Default content", x: 4, y: 4, width: 92, height: 52, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: instanceId, pageId: "page", kind: "instance", name: "Card instance", x: 120, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false } },
        { id: instanceSlotId, pageId: "page", parentId: instanceId, kind: "slot", name: "Content", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, slotMetadata: { propertyName, sourceSlotId }, componentPropertyReferences: references, extensions: { "figma.instance.source-node.v1": [...new TextEncoder().encode(sourceSlotId)] } },
        { id: overrideId, pageId: "page", parentId: instanceSlotId, kind: "ellipse", name: "Override", x: 8, y: 8, width: 44, height: 44, rotation: 0, fill: "#f00", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    let sequence = 0x1b6;
    const session = new RuntimeSession({ sessionId: "slot-delete-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, createId: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`, scheduleMicrotask: () => {} });
    const component = session.currentPage.children.find((node) => node.id === componentId)!;
    component.deleteComponentProperty(propertyName);
    const sourceFrame = component.children[0]!;
    const instance = session.currentPage.children.find((node) => node.id === instanceId)!;
    const instanceFrame = instance.children[0]!;
    const defaultClone = instanceFrame.children[0]!;
    const commit = session.commitAsync().catch(() => undefined);

    const commands = posted[0]!.transaction.commands;
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", id: componentId, patch: { componentMetadata: expect.objectContaining({ componentPropertyDefinitions: {} }) } }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: sourceFrame.id, kind: "frame" }) }),
      { type: "reparent", ids: [sourceChildId], parentId: sourceFrame.id },
      { type: "delete", ids: [sourceSlotId] },
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: defaultClone.id, parentId: instanceSlotId, kind: "rectangle", name: "Default content" }) }),
      { type: "delete", ids: [overrideId] },
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: instanceFrame.id, kind: "frame" }) }),
      { type: "reparent", ids: [defaultClone.id], parentId: instanceFrame.id },
      { type: "delete", ids: [instanceSlotId] },
    ]));
    const resolved = resolveCoreBatch(snapshot.nodes, commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceFrame.id, kind: "frame" }),
      expect.objectContaining({ id: sourceChildId, parentId: sourceFrame.id }),
      expect.objectContaining({ id: instanceFrame.id, kind: "frame" }),
      expect.objectContaining({ id: defaultClone.id, parentId: instanceFrame.id, kind: "rectangle", name: "Default content" }),
    ]));
    expect(resolved?.nextNodes.some((node) => [sourceSlotId, instanceSlotId, overrideId].includes(node.id))).toBe(false);
    bridge.close();
    await commit;
  });

  it("resets an Instance Slot through one Core delete-create batch", async () => {
    const componentId = "00000000-0000-4000-8000-0000000000d1";
    const sourceSlotId = "00000000-0000-4000-8000-0000000000d2";
    const sourceChildId = "00000000-0000-4000-8000-0000000000d3";
    const instanceId = "00000000-0000-4000-8000-0000000000d4";
    const instanceSlotId = "00000000-0000-4000-8000-0000000000d5";
    const overrideId = "00000000-0000-4000-8000-0000000000d6";
    const propertyName = "Content";
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: { key: componentId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: { [propertyName]: { type: "SLOT" } } } },
        { id: sourceSlotId, pageId: "page", parentId: componentId, kind: "slot", name: "Content", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, slotMetadata: { propertyName } },
        { id: sourceChildId, pageId: "page", parentId: sourceSlotId, kind: "rectangle", name: "Default content", x: 4, y: 4, width: 92, height: 52, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: instanceId, pageId: "page", kind: "instance", name: "Card instance", x: 120, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false } },
        { id: instanceSlotId, pageId: "page", parentId: instanceId, kind: "slot", name: "Content", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, slotMetadata: { propertyName, sourceSlotId } },
        { id: overrideId, pageId: "page", parentId: instanceSlotId, kind: "ellipse", name: "Override", x: 8, y: 8, width: 44, height: 44, rotation: 0, fill: "#f00", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "reset-slot-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    const instance = session.currentPage.children.find((node) => node.id === instanceId)!;
    instance.children.find((node) => node.id === instanceSlotId)!.resetSlot();
    const replacementId = instance.children.find((node) => node.id === instanceSlotId)!.children[0]!.id;
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: replacementId, parentId: instanceSlotId, kind: "rectangle", name: "Default content" }) }),
      { type: "delete", ids: [overrideId] },
    ]);
    expect(resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands)?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: instanceSlotId, kind: "slot" }),
      expect.objectContaining({ id: replacementId, parentId: instanceSlotId, kind: "rectangle", name: "Default content" }),
    ]));
    bridge.close();
    await commit;
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

  it("materializes an exposed nested swap without emitting the discarded subtree", async () => {
    const componentId = "00000000-0000-4000-8000-0000000002a1";
    const nestedSourceId = "00000000-0000-4000-8000-0000000002a2";
    const oldChildId = "00000000-0000-4000-8000-0000000002a3";
    const alternateId = "00000000-0000-4000-8000-0000000002a4";
    const replacementId = "00000000-0000-4000-8000-0000000002a5";
    const replacementChildId = "00000000-0000-4000-8000-0000000002a6";
    const propertyName = "Swap#1:1";
    const metadata = (key: string, definitions = {}) => ({ key, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: definitions });
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: metadata(componentId, { [propertyName]: { type: "INSTANCE_SWAP", defaultValue: replacementId } }) },
        { id: nestedSourceId, pageId: "page", parentId: componentId, kind: "instance", name: "Icon", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentPropertyReferences: { mainComponent: propertyName }, instanceMetadata: { mainComponentId: alternateId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false } },
        { id: oldChildId, pageId: "page", parentId: nestedSourceId, kind: "rectangle", name: "Old shape", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "#000", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: alternateId, pageId: "page", kind: "component", name: "Old icon", x: 120, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: metadata(alternateId) },
        { id: replacementId, pageId: "page", kind: "component", name: "New icon", x: 160, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: metadata(replacementId) },
        { id: replacementChildId, pageId: "page", parentId: replacementId, kind: "ellipse", name: "New shape", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    let sequence = 0x2a6;
    const session = new RuntimeSession({
      sessionId: "nested-swap-create-core",
      projection: runtimeProjectionFromEditorSnapshot(snapshot),
      transport: bridge,
      createId: () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
      scheduleMicrotask: () => {},
    });
    const component = session.currentPage.children.find((node) => node.id === componentId)!;
    const instance = component.createInstance();
    const nested = instance.children[0]!;
    const child = nested.children[0]!;
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: instance.id, kind: "instance", instanceMetadata: expect.objectContaining({ mainComponentId: componentId }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: nested.id, parentId: instance.id, kind: "instance", instanceMetadata: expect.objectContaining({ mainComponentId: replacementId }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: child.id, parentId: nested.id, kind: "ellipse", name: "New shape" }) }),
    ]);
    expect(posted[0]!.transaction.commands.some((command) => command.type === "delete" || (command.type === "create" && command.node.name === "Old shape"))).toBe(false);
    expect(resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands)?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: nested.id, kind: "instance", instanceMetadata: expect.objectContaining({ mainComponentId: replacementId }) }),
      expect.objectContaining({ id: child.id, parentId: nested.id, kind: "ellipse", name: "New shape" }),
    ]));
    bridge.close();
    await commit;
  });

  it("lowers validated Instance property writes and component swaps through Core", async () => {
    const componentId = "00000000-0000-4000-8000-0000000000a1";
    const targetId = "00000000-0000-4000-8000-0000000000a2";
    const instanceId = "00000000-0000-4000-8000-0000000000a3";
    const targetChildId = "00000000-0000-4000-8000-0000000000a4";
    const oldChildId = "00000000-0000-4000-8000-0000000000a5";
    const componentMetadata = { key: componentId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: { Enabled: { type: "BOOLEAN" as const, defaultValue: true }, Swap: { type: "INSTANCE_SWAP" as const, defaultValue: targetId } } };
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata },
        { id: targetId, pageId: "page", kind: "component", name: "Icon", x: 120, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: { ...componentMetadata, key: targetId, componentPropertyDefinitions: { Icon: { type: "TEXT", defaultValue: "Star" } } } },
        { id: targetChildId, pageId: "page", parentId: targetId, kind: "ellipse", name: "New source", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: instanceId, pageId: "page", kind: "instance", name: "Card instance", x: 0, y: 120, width: 100, height: 100, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: { Enabled: true, Swap: targetId }, overrides: [], isExposedInstance: false } },
        { id: oldChildId, pageId: "page", parentId: instanceId, kind: "rectangle", name: "Old source", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "#000", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "instance-properties-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    const instance = session.currentPage.children.find((node) => node.id === instanceId)!;
    const target = session.currentPage.children.find((node) => node.id === targetId)!;
    instance.setProperties({ Enabled: false, Swap: targetId });
    instance.swapComponent(target);
    const replacementId = instance.children[0]!.id;
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: replacementId, parentId: instanceId, kind: "ellipse", name: "New source" }) }),
      expect.objectContaining({
        type: "update",
        id: instanceId,
        patch: { instanceMetadata: expect.objectContaining({ componentProperties: { Enabled: false, Swap: targetId } }) },
      }),
      expect.objectContaining({
        type: "update",
        id: instanceId,
        patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: targetId, componentProperties: { Icon: "Star" }, overrides: [] }) }),
      }),
      { type: "delete", ids: [oldChildId] },
    ]);
    expect(resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands)?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: instanceId, instanceMetadata: expect.objectContaining({ mainComponentId: targetId, componentProperties: { Icon: "Star" }, overrides: [] }) }),
      expect.objectContaining({ id: replacementId, parentId: instanceId, kind: "ellipse", name: "New source" }),
    ]));

    bridge.close();
    await commit;
  });

  it("applies Instance properties to referenced sublayers through the same Core transaction", async () => {
    const componentId = "00000000-0000-4000-8000-0000000000b1";
    const sourceChildId = "00000000-0000-4000-8000-0000000000b2";
    const instanceId = "00000000-0000-4000-8000-0000000000b3";
    const instanceChildId = "00000000-0000-4000-8000-0000000000b4";
    const propertyName = "Enabled";
    const componentPropertyReferences = { visible: propertyName };
    const referenceExtension = {
      "figma.component-property-references.v1": [...new TextEncoder().encode(JSON.stringify(componentPropertyReferences))],
    };
    const sourceExtension = {
      "figma.instance.source-node.v1": [...new TextEncoder().encode(sourceChildId)],
    };
    const base = snapshotAt(4);
    const componentMetadata = {
      key: componentId,
      remote: false,
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      componentPropertyDefinitions: { [propertyName]: { type: "BOOLEAN" as const, defaultValue: true } },
    };
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata },
        { id: sourceChildId, pageId: "page", parentId: componentId, kind: "rectangle", name: "Surface", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, visible: true, componentPropertyReferences, extensions: referenceExtension },
        { id: instanceId, pageId: "page", kind: "instance", name: "Card instance", x: 120, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: { [propertyName]: true }, overrides: [], isExposedInstance: false } },
        { id: instanceChildId, pageId: "page", parentId: instanceId, kind: "rectangle", name: "Surface", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, visible: true, componentPropertyReferences, extensions: { ...referenceExtension, ...sourceExtension } },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "component-property-reference-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    session.currentPage.children.find((node) => node.id === instanceId)!.setProperties({ [propertyName]: false });
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({
        type: "update",
        id: instanceId,
        patch: { instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: false } }) },
      }),
      { type: "update", id: instanceChildId, patch: { visible: false } },
    ]);
    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: instanceId, instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: false } }) }),
      expect.objectContaining({ id: instanceChildId, visible: false, extensions: expect.objectContaining(referenceExtension) }),
    ]));
    bridge.close();
    await commit;
  });

  it("rebuilds a referenced nested Instance through the same Core transaction", async () => {
    const componentId = "00000000-0000-4000-8000-0000000000d1";
    const sourceNestedId = "00000000-0000-4000-8000-0000000000d2";
    const instanceId = "00000000-0000-4000-8000-0000000000d3";
    const nestedId = "00000000-0000-4000-8000-0000000000d4";
    const oldChildId = "00000000-0000-4000-8000-0000000000d5";
    const alternateId = "00000000-0000-4000-8000-0000000000d6";
    const alternateChildId = "00000000-0000-4000-8000-0000000000d7";
    const replacementId = "00000000-0000-4000-8000-0000000000d8";
    const replacementChildId = "00000000-0000-4000-8000-0000000000d9";
    const propertyName = "Swap";
    const references = { mainComponent: propertyName };
    const referenceExtension = { "figma.component-property-references.v1": [...new TextEncoder().encode(JSON.stringify(references))] };
    const sourceExtension = (sourceId: string) => ({ "figma.instance.source-node.v1": [...new TextEncoder().encode(sourceId)] });
    const componentMetadata = (id: string, definitions = {}) => ({ key: id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: definitions });
    const instanceMetadata = (mainComponentId: string, componentProperties = {}) => ({ mainComponentId, scaleFactor: 1, componentProperties, overrides: [], isExposedInstance: false });
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: componentMetadata(componentId, { [propertyName]: { type: "INSTANCE_SWAP", defaultValue: alternateId } }) },
        { id: sourceNestedId, pageId: "page", parentId: componentId, kind: "instance", name: "Icon", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentPropertyReferences: references, extensions: referenceExtension, instanceMetadata: instanceMetadata(alternateId) },
        { id: alternateId, pageId: "page", kind: "component", name: "Old icon", x: 120, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: componentMetadata(alternateId) },
        { id: alternateChildId, pageId: "page", parentId: alternateId, kind: "rectangle", name: "Old shape", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "#000", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: replacementId, pageId: "page", kind: "component", name: "New icon", x: 160, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: componentMetadata(replacementId) },
        { id: replacementChildId, pageId: "page", parentId: replacementId, kind: "ellipse", name: "New shape", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "#fff", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 },
        { id: instanceId, pageId: "page", kind: "instance", name: "Card instance", x: 0, y: 100, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: instanceMetadata(componentId, { [propertyName]: alternateId }) },
        { id: nestedId, pageId: "page", parentId: instanceId, kind: "instance", name: "Icon", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentPropertyReferences: references, extensions: { ...referenceExtension, ...sourceExtension(sourceNestedId) }, instanceMetadata: instanceMetadata(alternateId) },
        { id: oldChildId, pageId: "page", parentId: nestedId, kind: "rectangle", name: "Old shape", x: 0, y: 0, width: 24, height: 24, rotation: 0, fill: "#000", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, extensions: sourceExtension(alternateChildId) },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "component-swap-reference-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    const instance = session.currentPage.children.find((node) => node.id === instanceId)!;
    instance.setProperties({ [propertyName]: replacementId });
    const newChildId = session.projectionStore.listLiveNodes().find((node) => node.parentId === nestedId)!.id;
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: newChildId, parentId: nestedId, kind: "ellipse", name: "New shape" }) }),
      expect.objectContaining({ type: "update", id: instanceId, patch: { instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: replacementId } }) } }),
      expect.objectContaining({ type: "update", id: nestedId, patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: replacementId }) }) }),
      { type: "delete", ids: [oldChildId] },
    ]);
    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: nestedId, instanceMetadata: expect.objectContaining({ mainComponentId: replacementId }) }),
      expect.objectContaining({ id: newChildId, parentId: nestedId, kind: "ellipse", name: "New shape" }),
    ]));
    expect(resolved?.nextNodes.some((node) => node.id === oldChildId)).toBe(false);
    bridge.close();
    await commit;
  });

  it("writes Component property definitions and linked Instance defaults through Core", async () => {
    const componentId = "00000000-0000-4000-8000-000000000046";
    const instanceId = "00000000-0000-4000-8000-000000000047";
    const componentMetadata = { key: componentId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} };
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: componentId, pageId: "page", kind: "component", name: "Card", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata },
        { id: instanceId, pageId: "page", kind: "instance", name: "Card instance", x: 120, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false } },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "component-properties-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    const component = session.currentPage.children.find((node) => node.id === componentId)!;
    const propertyName = component.addComponentProperty("Enabled", "BOOLEAN", true);
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({
        type: "update",
        id: componentId,
        patch: { componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "BOOLEAN", defaultValue: true } } }) },
      }),
      expect.objectContaining({
        type: "update",
        id: instanceId,
        patch: { instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: true } }) },
      }),
    ]);
    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: componentId, componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "BOOLEAN", defaultValue: true } } }) }),
      expect.objectContaining({ id: instanceId, instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: true } }) }),
    ]));
    bridge.close();
    await commit;
  });

  it("writes shared ComponentSet properties to every variant and linked Instance through Core", async () => {
    const setId = "00000000-0000-4000-8000-0000000000c1";
    const baseId = "00000000-0000-4000-8000-0000000000c2";
    const hoverId = "00000000-0000-4000-8000-0000000000c3";
    const baseInstanceId = "00000000-0000-4000-8000-0000000000c4";
    const hoverInstanceId = "00000000-0000-4000-8000-0000000000c5";
    const variantDefinition = { State: { type: "VARIANT" as const, defaultValue: "Default", variantOptions: ["Default", "Hover"] } };
    const setMetadata = { key: setId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: variantDefinition, variantGroupProperties: { State: { values: ["Default", "Hover"] } } };
    const componentMetadata = (id: string) => ({ key: id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} });
    const instanceMetadata = (mainComponentId: string) => ({ mainComponentId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false });
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: setId, pageId: "page", kind: "componentSet", name: "Button", x: 0, y: 0, width: 240, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentSetMetadata: setMetadata },
        { id: baseId, pageId: "page", parentId: setId, kind: "component", name: "State=Default", x: 0, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: componentMetadata(baseId) },
        { id: hoverId, pageId: "page", parentId: setId, kind: "component", name: "State=Hover", x: 140, y: 0, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: componentMetadata(hoverId) },
        { id: baseInstanceId, pageId: "page", kind: "instance", name: "Default instance", x: 0, y: 100, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: instanceMetadata(baseId) },
        { id: hoverInstanceId, pageId: "page", kind: "instance", name: "Hover instance", x: 140, y: 100, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, instanceMetadata: instanceMetadata(hoverId) },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "component-set-properties-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    const set = session.currentPage.children.find((node) => node.id === setId)!;
    const propertyName = set.addComponentProperty("Enabled", "BOOLEAN", true);
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands).toEqual([
      expect.objectContaining({ type: "update", id: setId, patch: { componentSetMetadata: expect.objectContaining({ componentPropertyDefinitions: expect.objectContaining({ [propertyName]: { type: "BOOLEAN", defaultValue: true } }) }) } }),
      expect.objectContaining({ type: "update", id: baseId, patch: { componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "BOOLEAN", defaultValue: true } } }) } }),
      expect.objectContaining({ type: "update", id: hoverId, patch: { componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "BOOLEAN", defaultValue: true } } }) } }),
      expect.objectContaining({ type: "update", id: baseInstanceId, patch: { instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: true } }) } }),
      expect.objectContaining({ type: "update", id: hoverInstanceId, patch: { instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: true } }) } }),
    ]);
    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: setId, componentSetMetadata: expect.objectContaining({ componentPropertyDefinitions: expect.objectContaining({ [propertyName]: { type: "BOOLEAN", defaultValue: true } }) }) }),
      expect.objectContaining({ id: baseId, componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "BOOLEAN", defaultValue: true } } }) }),
      expect.objectContaining({ id: hoverId, componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "BOOLEAN", defaultValue: true } } }) }),
      expect.objectContaining({ id: baseInstanceId, instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: true } }) }),
      expect.objectContaining({ id: hoverInstanceId, instanceMetadata: expect.objectContaining({ componentProperties: { [propertyName]: true } }) }),
    ]));
    bridge.close();
    await commit;
  });

  it("renames ComponentSet variants and switches linked Instances through one Core batch", async () => {
    const setId = "00000000-0000-4000-8000-0000000000d1";
    const baseId = "00000000-0000-4000-8000-0000000000d2";
    const hoverId = "00000000-0000-4000-8000-0000000000d3";
    const baseChildId = "00000000-0000-4000-8000-0000000000d4";
    const hoverChildId = "00000000-0000-4000-8000-0000000000d5";
    const instanceId = "00000000-0000-4000-8000-0000000000d6";
    const instanceChildId = "00000000-0000-4000-8000-0000000000d7";
    const variantDefinition = { State: { type: "VARIANT" as const, defaultValue: "Default", variantOptions: ["Default", "Hover"] } };
    const setMetadata = { key: setId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: variantDefinition, variantGroupProperties: { State: { values: ["Default", "Hover"] } } };
    const componentMetadata = (id: string) => ({ key: id, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} });
    const base = snapshotAt(4);
    const common = { rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1 };
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes,
        { ...common, id: setId, pageId: "page", positionId: "30000000000000000000000000000000:000000000000400080000000000000d1", kind: "componentSet", name: "Button", x: 0, y: 0, width: 240, height: 60, componentSetMetadata: setMetadata },
        { ...common, id: baseId, pageId: "page", parentId: setId, positionId: "40000000000000000000000000000000:000000000000400080000000000000d2", kind: "component", name: "State=Default", x: 0, y: 0, width: 100, height: 60, componentMetadata: componentMetadata(baseId) },
        { ...common, id: hoverId, pageId: "page", parentId: setId, positionId: "80000000000000000000000000000000:000000000000400080000000000000d3", kind: "component", name: "State=Hover", x: 140, y: 0, width: 100, height: 60, componentMetadata: componentMetadata(hoverId) },
        { ...common, id: baseChildId, pageId: "page", parentId: baseId, positionId: "80000000000000000000000000000000:000000000000400080000000000000d4", kind: "rectangle", name: "Surface", x: 0, y: 0, width: 100, height: 60 },
        { ...common, id: hoverChildId, pageId: "page", parentId: hoverId, positionId: "80000000000000000000000000000000:000000000000400080000000000000d5", kind: "rectangle", name: "Surface", x: 0, y: 0, width: 100, height: 60 },
        { ...common, id: instanceId, pageId: "page", positionId: "b0000000000000000000000000000000:000000000000400080000000000000d6", kind: "instance", name: "Button instance", x: 0, y: 100, width: 100, height: 60, extensions: { "figma.instance.source-node.v1": [...new TextEncoder().encode(baseId)] }, instanceMetadata: { mainComponentId: baseId, scaleFactor: 1, componentProperties: { State: "Default" }, overrides: [], isExposedInstance: false } },
        { ...common, id: instanceChildId, pageId: "page", parentId: instanceId, positionId: "80000000000000000000000000000000:000000000000400080000000000000d7", kind: "rectangle", name: "Surface", x: 0, y: 0, width: 100, height: 60, extensions: { "figma.instance.source-node.v1": [...new TextEncoder().encode(baseChildId)] } },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "component-set-variant-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    const set = session.currentPage.children.find((node) => node.id === setId)!;
    const instance = session.currentPage.children.find((node) => node.id === instanceId)!;
    set.addComponentProperty("Theme", "VARIANT", "Light");
    set.editComponentProperty("State", { name: "Mode" });
    instance.setProperties({ Mode: "Hover" });
    const replacementChildId = instance.children[0]!.id;
    const commit = session.commitAsync().catch(() => undefined);

    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: setId, componentSetMetadata: expect.objectContaining({ componentPropertyDefinitions: expect.objectContaining({ Mode: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] }, Theme: { type: "VARIANT", defaultValue: "Light", variantOptions: ["Light"] } }) }) }),
      expect.objectContaining({ id: baseId, name: "Mode=Default, Theme=Light" }),
      expect.objectContaining({ id: hoverId, name: "Mode=Hover, Theme=Light" }),
      expect.objectContaining({ id: instanceId, instanceMetadata: expect.objectContaining({ mainComponentId: hoverId, componentProperties: { Mode: "Hover", Theme: "Light" } }) }),
      expect.objectContaining({ id: replacementChildId, parentId: instanceId, kind: "rectangle" }),
    ]));
    expect(resolved?.nextNodes.some((node) => node.id === instanceChildId)).toBe(false);
    bridge.close();
    await commit;
  });

  it("combines Components into a ComponentSet through one Core batch", async () => {
    const baseId = "00000000-0000-4000-8000-000000000048";
    const hoverId = "00000000-0000-4000-8000-000000000049";
    const metadata = { key: baseId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} };
    const base = snapshotAt(4);
    const snapshot: EditorSnapshot = {
      ...base,
      nodes: [
        ...base.nodes.map((node) => ({
          ...node,
          pageId: node.pageId ?? "page",
          positionId: node.positionId ?? "20000000000000000000000000000000:00000000000040008000000000000001",
        })),
        { id: baseId, pageId: "page", positionId: "40000000000000000000000000000000:00000000000040008000000000000048", kind: "component", name: "State=Default", x: 120, y: 40, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: metadata },
        { id: hoverId, pageId: "page", positionId: "80000000000000000000000000000000:00000000000040008000000000000049", kind: "component", name: "State=Hover", x: 260, y: 40, width: 100, height: 60, rotation: 0, fill: "transparent", stroke: "transparent", radius: 0, strokeWidth: 0, opacity: 1, componentMetadata: { ...metadata, key: hoverId } },
      ],
    };
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot });
    const session = new RuntimeSession({ sessionId: "combine-variants-core", projection: runtimeProjectionFromEditorSnapshot(snapshot), transport: bridge, scheduleMicrotask: () => {} });
    const componentSet = session.combineAsVariants(
      session.currentPage.children.filter((node) => node.id === baseId || node.id === hoverId),
      session.currentPage,
    );
    const commit = session.commitAsync().catch(() => undefined);

    expect(posted[0]!.transaction.commands.map((command) => command.type)).toEqual(["componentSet"]);
    expect(posted[0]!.transaction.commands[0]).toEqual(expect.objectContaining({
      type: "componentSet",
      id: componentSet.id,
      ids: [baseId, hoverId],
      metadata: expect.objectContaining({
        componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } },
        variantGroupProperties: { State: { values: ["Default", "Hover"] } },
      }),
    }));
    const resolved = resolveCoreBatch(snapshot.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: componentSet.id, kind: "componentSet" }),
      expect.objectContaining({ id: baseId, parentId: componentSet.id, x: 0, y: 0 }),
      expect.objectContaining({ id: hoverId, parentId: componentSet.id, x: 140, y: 0 }),
    ]));
    bridge.close();
    await commit;
  });

  it("keeps component conversion as an ordering barrier before same-turn instance creation", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    bridge.observe({ type: "snapshot", snapshot: snapshotAt(4) });
    const sourceId = "00000000-0000-4000-8000-000000000028";
    const childId = "00000000-0000-4000-8000-000000000029";
    const componentId = "00000000-0000-4000-8000-00000000002a";
    const instanceId = "00000000-0000-4000-8000-00000000002b";
    const finalPositionId = "80000000000000000000000000000000:00000000000040008000000000000028";
    const temporaryPositionId = "fffffffffffffffffffffffffffffffe:0000000000004000800000000000002a";
    const componentMetadata = { key: componentId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} };
    void bridge.submit({
      transactionId: "tx-component-conversion",
      baseRevision: 4,
      operations: [
        { type: "create", node: { id: sourceId, type: "FRAME", parentId: "page", pageId: "page", siblingIndex: 1, positionId: finalPositionId, name: "Card", x: 40, y: 24, width: 160, height: 100 } },
        { type: "create", node: { id: childId, type: "RECTANGLE", parentId: sourceId, pageId: "page", siblingIndex: 0, name: "Surface", x: 8, y: 12, width: 120, height: 60, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 12 } } },
        {
          type: "componentFromNode",
          sourceId,
          replacement: { id: componentId, type: "COMPONENT", parentId: "page", pageId: "page", siblingIndex: 1, positionId: finalPositionId, name: "Card", x: 40, y: 24, width: 160, height: 100, componentMetadata },
          childIds: [childId],
          temporaryPositionId,
          finalPositionId,
        },
        {
          type: "create",
          node: {
            id: instanceId,
            type: "INSTANCE",
            parentId: "page",
            pageId: "page",
            siblingIndex: 2,
            name: "Card instance",
            x: 56,
            y: 40,
            width: 160,
            height: 100,
            instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false },
          },
        },
      ],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands.map((command) => command.type)).toEqual([
      "create", "create", "create", "reparent", "delete", "reposition", "create",
    ]);
    expect(posted[0]?.transaction.commands[2]).toEqual(expect.objectContaining({
      type: "create",
      node: expect.objectContaining({ id: componentId, kind: "component", positionId: temporaryPositionId }),
    }));
    expect(posted[0]?.transaction.commands[5]).toEqual({ type: "reposition", positionIds: [{ id: componentId, positionId: finalPositionId }] });
    expect(posted[0]?.transaction.commands[6]).toEqual(expect.objectContaining({
      type: "create",
      node: expect.objectContaining({ id: instanceId, kind: "instance", instanceMetadata: expect.objectContaining({ mainComponentId: componentId }) }),
    }));
    const resolved = resolveCoreBatch(snapshotAt(4).nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: componentId, kind: "component", positionId: finalPositionId }),
      expect.objectContaining({ id: childId, parentId: componentId, x: 8, y: 12 }),
      expect.objectContaining({ id: instanceId, kind: "instance" }),
    ]));
    expect(resolved?.nextNodes.some((node) => node.id === sourceId)).toBe(false);
    bridge.close();
  });

  it("lowers Instance detachment as an ordered replacement with its final layer position restored", () => {
    const posted: Extract<MainToWorker, { type: "transaction" }>[] = [];
    const bridge = new RuntimeWorkerBridge((message) => posted.push(message));
    const componentId = "00000000-0000-4000-8000-000000000041";
    const instanceId = "00000000-0000-4000-8000-000000000042";
    const instanceChildId = "00000000-0000-4000-8000-000000000043";
    const frameId = "00000000-0000-4000-8000-000000000044";
    const frameChildId = "00000000-0000-4000-8000-000000000045";
    const finalPositionId = "80000000000000000000000000000000:00000000000040008000000000000042";
    const temporaryPositionId = "fffffffffffffffffffffffffffffffe:00000000000040008000000000000044";
    const base = {
      ...snapshotAt(4),
      nodes: [
        ...snapshotAt(4).nodes,
        {
          id: componentId,
          kind: "component" as const,
          pageId: "page",
          name: "Card",
          x: 0,
          y: 0,
          width: 120,
          height: 80,
          componentMetadata: { key: componentId, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} },
        },
        {
          id: instanceId,
          kind: "instance" as const,
          pageId: "page",
          positionId: finalPositionId,
          name: "Card instance",
          x: 160,
          y: 20,
          width: 120,
          height: 80,
          instanceMetadata: { mainComponentId: componentId, scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false },
          extensions: { "figma.instance.source-node.v1": [1] },
        },
        {
          id: instanceChildId,
          kind: "rectangle" as const,
          parentId: instanceId,
          pageId: "page",
          name: "Surface",
          x: 8,
          y: 12,
          width: 104,
          height: 56,
          extensions: { "figma.instance.source-node.v1": [2] },
        },
      ],
    } satisfies EditorSnapshot;
    bridge.observe({ type: "snapshot", snapshot: base });
    void bridge.submit({
      transactionId: "tx-detach-instance",
      baseRevision: 4,
      operations: [{
        type: "detachInstance",
        sourceId: instanceId,
        sourceIds: [instanceId, instanceChildId],
        replacements: [
          { id: frameId, type: "FRAME", parentId: "page", pageId: "page", siblingIndex: 2, positionId: finalPositionId, name: "Card instance detached", x: 160, y: 20, width: 120, height: 80, extensions: {} },
          { id: frameChildId, type: "RECTANGLE", parentId: frameId, pageId: "page", siblingIndex: 0, name: "Surface", x: 8, y: 12, width: 104, height: 56, extensions: {} },
        ],
        temporaryPositionId,
        finalPositionId,
      }],
    }).catch(() => undefined);

    expect(posted[0]?.transaction.commands.map((command) => command.type)).toEqual(["create", "create", "delete", "reposition"]);
    expect(posted[0]?.transaction.commands[0]).toEqual(expect.objectContaining({
      type: "create",
      node: expect.objectContaining({ id: frameId, kind: "frame", positionId: temporaryPositionId }),
    }));
    expect(posted[0]?.transaction.commands[1]).toEqual(expect.objectContaining({
      type: "create",
      node: expect.objectContaining({ id: frameChildId, kind: "rectangle", parentId: frameId }),
    }));
    expect(posted[0]?.transaction.commands[2]).toEqual({ type: "delete", ids: [instanceId] });
    expect(posted[0]?.transaction.commands[3]).toEqual({ type: "reposition", positionIds: [{ id: frameId, positionId: finalPositionId }] });
    const resolved = resolveCoreBatch(base.nodes, posted[0]!.transaction.commands);
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: frameId, kind: "frame", positionId: finalPositionId, name: "Card instance detached" }),
      expect.objectContaining({ id: frameChildId, kind: "rectangle", parentId: frameId }),
    ]));
    expect(resolved?.nextNodes.some((node) => node.id === instanceId || node.id === instanceChildId)).toBe(false);
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
