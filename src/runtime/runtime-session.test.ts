import { describe, expect, it } from "vitest";
import { RuntimeSession } from "./runtime-session";
import { M1_NODE_TYPES, RUNTIME_MIXED } from "./node-proxy";
import { RuntimeContainerNodeProxy } from "./container-node-proxy";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";
import { isRuntimeError } from "./runtime-errors";
import { vi } from "vitest";
import { createNode } from "../lib/editor-protocol";
import { NORMAL_BLEND_ISOLATION_EXTENSION } from "../lib/node-blend-semantics";
import { fontFamilyForAsset } from "../lib/font-face-registry";

const initial: RuntimeProjection = {
  revision: 0,
  nodes: [
    { id: "document", type: "DOCUMENT", name: "Document" },
    { id: "page", type: "PAGE", name: "Page 1", parentId: "document", siblingIndex: 0 },
    { id: "frame", type: "FRAME", name: "Existing frame", parentId: "page", x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, siblingIndex: 0 },
  ],
};

describe("M1 RuntimeSession", () => {
  it("persists plugin-scoped node data through the ordinary transaction fence", async () => {
    const transport = new InMemoryTransport(initial);
    const session = new RuntimeSession({ sessionId: "plugin-data-a", pluginId: "com.example.alpha", projection: initial, transport, scheduleMicrotask: () => {} });
    const frame = (await session.getNodeByIdAsync("frame"))!;

    expect(frame.getPluginData("missing")).toBe("");
    frame.setPluginData("z-key", "last");
    frame.setPluginData("a-key", "first 😀");
    frame.setSharedPluginData("com.example.tokens", "accent", "#ff0066");
    frame.setSharedPluginData("com.example.tokens", "background", "#ffffff");
    expect(frame.getPluginData("a-key")).toBe("first 😀");
    expect(frame.getPluginDataKeys()).toEqual(["a-key", "z-key"]);
    expect(frame.getSharedPluginData("com.example.tokens", "accent")).toBe("#ff0066");
    expect(frame.getSharedPluginDataKeys("com.example.tokens")).toEqual(["accent", "background"]);
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => frame.setPluginData("", "invalid")), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => frame.setPluginData("large", "x".repeat(64 * 1024 + 1))), "RESOURCE_LIMIT")).toBe(true);
    expect(isRuntimeError(captureError(() => frame.setSharedPluginData("bad/namespace", "key", "invalid")), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);

    frame.setPluginData("z-key", "");
    expect(frame.getPluginData("z-key")).toBe("");
    expect(frame.getPluginDataKeys()).toEqual(["a-key"]);
    await session.commitAsync();

    const other = new RuntimeSession({ sessionId: "plugin-data-b", pluginId: "com.example.beta", projection: transport.currentProjection(), transport: new InMemoryTransport(transport.currentProjection()), scheduleMicrotask: () => {} });
    const otherFrame = (await other.getNodeByIdAsync("frame"))!;
    expect(otherFrame.getPluginData("a-key")).toBe("");
    expect(otherFrame.getPluginDataKeys()).toEqual([]);
    expect(otherFrame.getSharedPluginData("com.example.tokens", "accent")).toBe("#ff0066");
    expect(otherFrame.getSharedPluginDataKeys("com.example.tokens")).toEqual(["accent", "background"]);

    const unscoped = new RuntimeSession({ sessionId: "plugin-data-none", projection: transport.currentProjection(), transport: new InMemoryTransport(transport.currentProjection()), scheduleMicrotask: () => {} });
    const unscopedFrame = (await unscoped.getNodeByIdAsync("frame"))!;
    expect(isRuntimeError(captureError(() => unscopedFrame.getPluginData("a-key")), "PERMISSION_DENIED")).toBe(true);
    expect(unscopedFrame.getSharedPluginData("com.example.tokens", "background")).toBe("#ffffff");
  });

  it("projects Figma-shaped fill and stroke stacks before Ack and validates image hashes", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", assets: [{ assetId: "image-1", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: 4, pixelWidth: 2, pixelHeight: 2 }] },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "rect", type: "RECTANGLE", name: "Painted", parentId: "page", siblingIndex: 0, fill: "#000000", stroke: "transparent", x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1 },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "paint-stack", projection, transport, scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync("rect"))!;

    rectangle.fills = [
      { type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5, blendMode: "MULTIPLY" },
      { type: "IMAGE", imageHash: "image-1", scaleMode: "CROP", imageTransform: [[1, 0, .1], [0, 1, .2]] },
    ];
    rectangle.strokes = [];
    expect(rectangle.fills).toEqual([
      { type: "SOLID", color: { r: 1, g: 0, b: 0 }, visible: true, opacity: .5, blendMode: "MULTIPLY" },
      { type: "IMAGE", imageHash: "image-1", scaleMode: "CROP", imageTransform: [[1, 0, .1], [0, 1, .2]], visible: true, opacity: 1, blendMode: "NORMAL" },
    ]);
    expect(rectangle.strokes).toEqual([]);
    expect(session.projectionStore.pendingTransactionIds()).toHaveLength(1);
    expect(isRuntimeError(captureError(() => { rectangle.fills = [{ type: "IMAGE", imageHash: "missing", scaleMode: "FILL" }]; }), "RESOURCE_UNAVAILABLE")).toBe(true);
    expect(rectangle.fills).toHaveLength(2);
    await session.commitAsync();
    expect(rectangle.fills).toHaveLength(2);
  });

  it("rejects Paint properties outside each node type's declared fill/stroke surface", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "line", type: "LINE", name: "Line", parentId: "page", siblingIndex: 0, fill: "transparent", stroke: "#000000" },
        { id: "text", type: "TEXT", name: "Text", parentId: "page", siblingIndex: 1, fill: "#000000", stroke: "transparent" },
        { id: "boolean", type: "BOOLEAN_OPERATION", name: "Boolean", parentId: "page", siblingIndex: 2, fill: "transparent", stroke: "transparent" },
      ],
    };
    const session = new RuntimeSession({ sessionId: "paint-surfaces", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const line = (await session.getNodeByIdAsync("line"))!;
    const text = (await session.getNodeByIdAsync("text"))!;
    const boolean = (await session.getNodeByIdAsync("boolean"))!;
    expect(line.strokes).toHaveLength(1);
    expect(text.fills).toHaveLength(1);
    expect(isRuntimeError(captureError(() => line.fills), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => text.strokes), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => boolean.fills), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(session.projectionStore.pendingTransactionIds()).toEqual([]);
  });

  it("projects resizeWithoutConstraints immediately and preserves its transaction intent", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = (await session.getNodeByIdAsync("frame"))!;

    frame.resizeWithoutConstraints(320, 180);
    expect(frame).toMatchObject({ width: 320, height: 180 });
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    expect(session.projectionStore.transaction(transactionId)?.operations).toEqual([
      expect.objectContaining({ type: "update", nodeId: "frame", patch: { width: 320, height: 180 }, ignoreConstraints: true }),
    ]);
    await session.commitAsync();
    expect(transport.submitted[0]?.operations[0]).toMatchObject({ ignoreConstraints: true });
  });

  it("returns stable common-property proxies for every projected local node type", async () => {
    const sceneTypes = M1_NODE_TYPES.filter((type) => type !== "DOCUMENT" && type !== "PAGE");
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        ...sceneTypes.map((type, siblingIndex) => ({ id: `node-${siblingIndex}`, type, name: type, parentId: "page", siblingIndex })),
      ],
    };
    const session = new RuntimeSession({ sessionId: "all-node-types", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });

    const proxies = session.currentPage.findAll(() => true);
    expect(proxies.map((proxy) => proxy.type)).toEqual(sceneTypes);
    await expect(session.getNodeByIdAsync("node-0")).resolves.toBe(proxies[0]);
    const polygon = proxies.find((proxy) => proxy.type === "POLYGON")!;
    expect(isRuntimeError(captureError(() => polygon.characters), "UNSUPPORTED_PROPERTY")).toBe(true);
  });

  it("exposes exact imported component relationships and keeps remote resources read-only", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        {
          id: "component",
          type: "COMPONENT",
          name: "Card",
          parentId: "page",
          siblingIndex: 0,
          componentMetadata: {
            key: "library-card",
            remote: true,
            description: "Card description",
            descriptionMarkdown: "**Card description**",
            documentationLinks: [{ uri: "https://example.com/card" }],
            componentPropertyDefinitions: { Enabled: { type: "BOOLEAN", defaultValue: true } },
          },
        },
        {
          id: "instance",
          type: "INSTANCE",
          name: "Card instance",
          parentId: "page",
          siblingIndex: 1,
          instanceMetadata: {
            mainComponentId: "component",
            scaleFactor: 1.25,
            componentProperties: { Enabled: false },
            overrides: [{ id: "instance-child", overriddenFields: ["fill"] }],
            isExposedInstance: true,
          },
        },
        {
          id: "set",
          type: "COMPONENT_SET",
          name: "Cards",
          parentId: "page",
          siblingIndex: 2,
          componentSetMetadata: {
            key: "library-cards",
            remote: false,
            description: "Variants",
            descriptionMarkdown: "Variants",
            documentationLinks: [],
            componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } },
            variantGroupProperties: { State: { values: ["Default", "Hover"] } },
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "component-metadata", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const component = (await session.getNodeByIdAsync("component"))!;
    const instance = (await session.getNodeByIdAsync("instance"))!;
    const set = (await session.getNodeByIdAsync("set"))!;

    expect(component).toMatchObject({ key: "library-card", remote: true, description: "Card description" });
    expect(component.componentPropertyDefinitions).toEqual({ Enabled: { type: "BOOLEAN", defaultValue: true } });
    expect(await instance.getMainComponentAsync()).toBe(component);
    expect(await component.getInstancesAsync()).toEqual([instance]);
    expect(instance.componentPropertyValues).toEqual({ Enabled: false });
    expect(instance.overrides).toEqual([{ id: "instance-child", overriddenFields: ["fill"] }]);
    expect(instance.scaleFactor).toBe(1.25);
    expect(instance.isExposedInstance).toBe(true);
    expect(set.variantGroupProperties).toEqual({ State: { values: ["Default", "Hover"] } });
    expect(set.componentPropertyDefinitions).toEqual({ State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } });
    expect(isRuntimeError(captureError(() => { component.name = "Changed"; }), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => component.remove()), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => component.createInstance()), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(captureError(() => instance.getInstancesAsync()), "UNSUPPORTED_PROPERTY")).toBe(true);

    instance.removeOverrides();
    expect(instance.overrides).toEqual([]);
    expect(instance.componentPropertyValues).toEqual({ Enabled: true });
    await session.commitAsync();
    expect(instance.overrides).toEqual([]);
    expect(instance.componentPropertyValues).toEqual({ Enabled: true });
  });

  it("keeps one proxy identity and coalesces synchronous setters into one fenced transaction", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = await session.getNodeByIdAsync("frame");
    expect(frame).not.toBeNull();
    expect(session.root.findOne((node) => node.id === "frame")).toBe(frame);

    frame!.x = 120;
    frame!.y = 240;
    frame!.opacity = .5;
    frame!.blendMode = "PASS_THROUGH";
    expect(frame!.blendMode).toBe("PASS_THROUGH");
    frame!.blendMode = "LINEAR_DODGE";
    expect(frame!.x).toBe(120);
    expect(frame!.y).toBe(240);
    expect(await session.commitAsync()).toBe(1);
    expect(transport.submitted).toHaveLength(1);
    expect(transport.submitted[0]!.operations).toHaveLength(5);
    expect(frame!.opacity).toBe(.5);
    expect(frame!.blendMode).toBe("LINEAR_DODGE");
  });

  it("projects BlendMixin isMask writes, including descendant-owning Group and TransformGroup masks", async () => {
    const path = {
      fillRule: "nonZero" as const,
      subpaths: [{ closed: true, points: [
        { id: "p1", x: 0, y: 0, pointType: "corner" as const },
        { id: "p2", x: 40, y: 0, pointType: "corner" as const },
        { id: "p3", x: 0, y: 40, pointType: "corner" as const },
      ] }],
    };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "rect", type: "RECTANGLE", name: "Mask", parentId: "page", siblingIndex: 0, isMask: false },
        { id: "group", type: "GROUP", name: "Group", parentId: "page", siblingIndex: 1 },
        { id: "group-child", type: "ELLIPSE", name: "Group alpha", parentId: "group", siblingIndex: 0 },
        { id: "empty-group", type: "GROUP", name: "Empty Group", parentId: "page", siblingIndex: 2 },
        { id: "boolean-mask", type: "BOOLEAN_OPERATION", name: "Boolean mask", parentId: "page", siblingIndex: 3, booleanOperation: "subtract" },
        { id: "boolean-first", type: "VECTOR", name: "Boolean first", parentId: "boolean-mask", siblingIndex: 0, vectorPath: path },
        { id: "boolean-second", type: "VECTOR", name: "Boolean second", parentId: "boolean-mask", siblingIndex: 1, vectorPath: path },
        { id: "boolean-target", type: "RECTANGLE", name: "Boolean target", parentId: "page", siblingIndex: 4 },
        { id: "invalid-boolean", type: "BOOLEAN_OPERATION", name: "Unsupported Boolean mask", parentId: "page", siblingIndex: 5, booleanOperation: "union" },
        { id: "invalid-boolean-first", type: "RECTANGLE", name: "Unsupported operand A", parentId: "invalid-boolean", siblingIndex: 0 },
        { id: "invalid-boolean-second", type: "ELLIPSE", name: "Unsupported operand B", parentId: "invalid-boolean", siblingIndex: 1 },
        { id: "invalid-boolean-target", type: "RECTANGLE", name: "Unsupported Boolean target", parentId: "page", siblingIndex: 6 },
        { id: "transform-mask", type: "TRANSFORM_GROUP", name: "Transform mask", parentId: "page", siblingIndex: 7, transformModifiers: [{ type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 40, axis: "VERTICAL" }] },
        { id: "transform-child", type: "ELLIPSE", name: "Transform alpha", parentId: "transform-mask", siblingIndex: 0 },
        { id: "transform-target", type: "RECTANGLE", name: "Transform target", parentId: "page", siblingIndex: 8 },
        { id: "section", type: "SECTION", name: "Section", parentId: "page", siblingIndex: 9 },
        { id: "slice", type: "SLICE", name: "Slice", parentId: "page", siblingIndex: 10 },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "mask-property", projection, transport, scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync("rect"))!;
    const group = (await session.getNodeByIdAsync("group"))!;
    const emptyGroup = (await session.getNodeByIdAsync("empty-group"))!;
    const boolean = (await session.getNodeByIdAsync("boolean-mask"))!;
    const invalidBoolean = (await session.getNodeByIdAsync("invalid-boolean"))!;
    const transformMask = (await session.getNodeByIdAsync("transform-mask"))!;
    const section = (await session.getNodeByIdAsync("section"))!;
    const slice = (await session.getNodeByIdAsync("slice"))!;
    const page = (await session.getNodeByIdAsync("page"))!;

    expect(rectangle.isMask).toBe(false);
    rectangle.isMask = true;
    expect(rectangle.isMask).toBe(true);
    group.isMask = true;
    expect(group.isMask).toBe(true);
    boolean.isMask = true;
    expect(boolean.isMask).toBe(true);
    transformMask.isMask = true;
    expect(transformMask.isMask).toBe(true);
    expect(isRuntimeError(captureError(() => { invalidBoolean.isMask = true; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => section.isMask), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => slice.isMask), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => { slice.isMask = true; }), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => { emptyGroup.isMask = true; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => page.isMask), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(session.projectionStore.pendingTransactionIds()).toHaveLength(1);
    await session.commitAsync();
    expect(rectangle.isMask).toBe(true);
  });

  it("exposes legacy NORMAL containers as pass-through and persists explicit NORMAL isolation", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "group", type: "GROUP", name: "Legacy group", parentId: "page", siblingIndex: 0, extensions: { "example.keep": [7] } },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "normal-isolation", projection, transport, scheduleMicrotask: () => {} });
    const group = (await session.getNodeByIdAsync("group"))!;

    expect(group.blendMode).toBe("PASS_THROUGH");
    group.blendMode = "NORMAL";
    expect(group.blendMode).toBe("NORMAL");
    let transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    expect(session.projectionStore.transaction(transactionId)?.operations.at(-1)).toMatchObject({
      type: "update",
      nodeId: "group",
      patch: { blendMode: "normal", extensions: { "example.keep": [7], [NORMAL_BLEND_ISOLATION_EXTENSION]: [1] } },
    });
    await session.commitAsync();
    expect(group.blendMode).toBe("NORMAL");

    group.blendMode = "PASS_THROUGH";
    transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    expect(session.projectionStore.transaction(transactionId)?.operations.at(-1)).toMatchObject({
      type: "update",
      nodeId: "group",
      patch: { blendMode: "pass-through", extensions: { "example.keep": [7] } },
    });
    await session.commitAsync();
    expect(group.blendMode).toBe("PASS_THROUGH");
  });

  it("supports synchronous creation, reparenting, pre-order queries, and clone before Ack", () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = session.createFrame();
    const text = session.createText();
    frame.appendChild(text);
    const clone = text.clone();

    expect(text.parent).toBe(frame);
    expect(frame.children).toEqual([text]);
    expect(session.currentPage.findAll(() => true).map((node) => node.id)).toEqual(["frame", frame.id, text.id, clone.id]);
    expect(clone.parent).toBe(session.currentPage);
    expect(clone.name).toBe("Text");
  });

  it("deep-clones a container into currentPage and remaps internal identities", async () => {
    const transport = new InMemoryTransport(initial);
    let nextId = 0;
    const session = new RuntimeSession({
      sessionId: "deep-clone",
      projection: initial,
      transport,
      scheduleMicrotask: () => {},
      createId: () => `clone-${++nextId}`,
    });
    const frame = session.createFrame();
    frame.x = 100;
    frame.y = 50;
    const rectangle = session.createRectangle();
    const connector = session.createConnector();
    const vector = session.createVector();
    frame.appendChild(rectangle);
    frame.appendChild(connector);
    frame.appendChild(vector);
    rectangle.x = 12;
    rectangle.y = 8;
    connector.connectorStart = { endpointNodeId: rectangle.id, magnet: "AUTO" };
    const clone = frame.clone();

    expect(clone).toBeInstanceOf(RuntimeContainerNodeProxy);
    const cloneChildren = (clone as RuntimeContainerNodeProxy).children;
    expect(clone.parent).toBe(session.currentPage);
    expect(clone).toMatchObject({ type: "FRAME", x: 100, y: 50, name: "Frame" });
    expect(cloneChildren.map((node) => node.type)).toEqual(["RECTANGLE", "CONNECTOR", "VECTOR"]);
    expect(cloneChildren.map((node) => node.id)).not.toEqual([rectangle.id, connector.id, vector.id]);
    expect(cloneChildren[1]!.connectorStart).toEqual({ endpointNodeId: cloneChildren[0]!.id, magnet: "AUTO" });
    const sourcePointIds = (session.projectionStore.getNode(vector.id)?.vectorPath as { subpaths: Array<{ points: Array<{ id: string }> }> }).subpaths[0]!.points.map((point) => point.id);
    const clonedPointIds = (session.projectionStore.getNode(cloneChildren[2]!.id)?.vectorPath as { subpaths: Array<{ points: Array<{ id: string }> }> }).subpaths[0]!.points.map((point) => point.id);
    expect(clonedPointIds).not.toEqual(sourcePointIds);

    await session.commitAsync();
    expect((await session.getNodeByIdAsync(clone.id))?.removed).not.toBe(true);
  });

  it("gives cloned components fresh local publication identities", () => {
    const session = sessionFor(new InMemoryTransport(initial));
    const component = session.createComponent();
    component.appendChild(session.createRectangle());
    const clone = component.clone();

    expect(clone).toBeInstanceOf(RuntimeContainerNodeProxy);
    expect(clone).toMatchObject({ type: "COMPONENT", key: clone.id, remote: false });
    expect((clone as RuntimeContainerNodeProxy).children).toHaveLength(1);
    expect(clone.id).not.toBe(component.id);
    expect(clone.key).not.toBe(component.key);
  });

  it("duplicates ComponentSet variants as new Components", () => {
    const componentMetadata = {
      key: "variant-key",
      remote: false,
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      componentPropertyDefinitions: {},
    };
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [
        ...initial.nodes,
        {
          id: "set",
          type: "COMPONENT_SET",
          name: "Button",
          parentId: "page",
          siblingIndex: 1,
          x: 120,
          y: 40,
          width: 200,
          height: 100,
          componentSetMetadata: { key: "set-key", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {}, variantGroupProperties: {} },
        },
        { id: "variant", type: "COMPONENT", name: "State=Default", parentId: "set", siblingIndex: 0, width: 100, height: 40, componentMetadata },
        { id: "variant-child", type: "RECTANGLE", name: "Surface", parentId: "variant", siblingIndex: 0, width: 100, height: 40 },
      ],
    };
    let sequence = 0;
    const session = new RuntimeSession({ sessionId: "component-set-clone", projection, transport: new InMemoryTransport(projection), createId: () => `set-clone-${++sequence}`, scheduleMicrotask: () => {} });
    const source = session.currentPage.children.find((node) => node.id === "set") as RuntimeContainerNodeProxy;
    const clone = source.clone() as RuntimeContainerNodeProxy;
    const clonedVariant = clone.children[0] as RuntimeContainerNodeProxy;

    expect(clone).toMatchObject({ type: "COMPONENT_SET", key: clone.id, remote: false });
    expect(clonedVariant).toMatchObject({ type: "COMPONENT", key: clonedVariant.id, remote: false });
    expect(clonedVariant.children).toHaveLength(1);
    expect(clonedVariant.key).not.toBe("variant-key");
  });

  it("turns a nested component into an instance of the original when cloning a frame", async () => {
    const session = sessionFor(new InMemoryTransport(initial));
    const frame = session.createFrame();
    const component = session.createComponent();
    component.appendChild(session.createRectangle());
    frame.appendChild(component);

    const clone = frame.clone() as RuntimeContainerNodeProxy;
    const clonedInstance = clone.children[0] as RuntimeContainerNodeProxy;

    expect(clonedInstance.type).toBe("INSTANCE");
    expect(await clonedInstance.getMainComponentAsync()).toBe(component);
    expect(clonedInstance.children).toHaveLength(1);
    expect(clonedInstance.children[0]?.type).toBe("RECTANGLE");
  });

  it("returns a plain Frame for a cloned Slot and rejects unsupported hierarchy clones", () => {
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [...initial.nodes, {
        id: "slot",
        type: "SLOT",
        name: "Content",
        parentId: "page",
        siblingIndex: 1,
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        slotMetadata: { sourceSlotId: "source-slot" },
        extensions: { "figma.slot.metadata.v1": [1, 2, 3] },
      }],
    };
    const session = new RuntimeSession({
      sessionId: "slot-clone",
      projection,
      transport: new InMemoryTransport(projection),
      createId: () => "slot-clone",
      scheduleMicrotask: () => {},
    });
    const slot = session.currentPage.children.find((node) => node.id === "slot")!;
    const clone = slot.clone();

    expect(clone.type).toBe("FRAME");
    expect(session.projectionStore.getNode(clone.id)).not.toHaveProperty("slotMetadata");
    expect(session.projectionStore.getNode(clone.id)?.extensions).not.toHaveProperty("figma.slot.metadata.v1");
    const transactionCount = session.projectionStore.pendingTransactionIds().length;
    expect(isRuntimeError(captureError(() => session.currentPage.clone()), "UNSUPPORTED_NODE_TYPE")).toBe(true);
    expect(session.projectionStore.pendingTransactionIds()).toHaveLength(transactionCount);
  });

  it("clones TableCell descendants only as part of their Table", () => {
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [
        ...initial.nodes,
        { id: "table", type: "TABLE", name: "Table", parentId: "page", siblingIndex: 1, width: 200, height: 40, tableMetadata: { rowHeights: [40], columnWidths: [100, 100] } },
        { id: "cell-a", type: "TABLE_CELL", name: "A", parentId: "table", siblingIndex: 0, width: 100, height: 40, text: "A", tableCellMetadata: { rowIndex: 0, columnIndex: 0 } },
        { id: "cell-b", type: "TABLE_CELL", name: "B", parentId: "table", siblingIndex: 1, width: 100, height: 40, text: "B", tableCellMetadata: { rowIndex: 0, columnIndex: 1 } },
      ],
    };
    let sequence = 0;
    const session = new RuntimeSession({ sessionId: "table-clone", projection, transport: new InMemoryTransport(projection), createId: () => `table-clone-${++sequence}`, scheduleMicrotask: () => {} });
    const table = session.currentPage.children.find((node) => node.id === "table") as RuntimeContainerNodeProxy;
    const clone = table.clone() as RuntimeContainerNodeProxy;

    expect(clone.type).toBe("TABLE");
    expect(clone.children.map((cell) => cell.type)).toEqual(["TABLE_CELL", "TABLE_CELL"]);
    expect(clone.children.map((cell) => cell.id)).not.toEqual(["cell-a", "cell-b"]);
    const transactionCount = session.projectionStore.pendingTransactionIds().length;
    expect(isRuntimeError(captureError(() => table.children[0]!.clone()), "UNSUPPORTED_NODE_TYPE")).toBe(true);
    expect(session.projectionStore.pendingTransactionIds()).toHaveLength(transactionCount);
  });

  it("creates a Slot and its component property atomically", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const component = session.createComponent();
    const instance = component.createInstance();
    const slot = component.createSlot();
    const definitions = component.componentPropertyDefinitions;
    const propertyName = Object.keys(definitions)[0]!;

    expect(slot).toBeInstanceOf(RuntimeContainerNodeProxy);
    expect(slot).toMatchObject({ type: "SLOT", name: "Slot", parent: component, width: 50, height: 50 });
    expect(definitions[propertyName]).toEqual({ type: "SLOT" });
    expect(slot.componentPropertyReferences).toEqual({ slotContentId: propertyName });
    expect(session.projectionStore.getNode(slot.id)?.slotMetadata).toEqual({ propertyName });
    expect(component.children).toEqual([slot]);
    expect(instance.children).toHaveLength(1);
    expect(session.projectionStore.getNode(instance.children[0]!.id)?.slotMetadata).toEqual({ propertyName, sourceSlotId: slot.id });

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: component.id, type: "COMPONENT" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: instance.id, type: "INSTANCE" }) }),
      expect.objectContaining({ type: "update", nodeId: component.id, patch: { componentMetadata: expect.objectContaining({ componentPropertyDefinitions: { [propertyName]: { type: "SLOT" } } }) } }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: slot.id, type: "SLOT", parentId: component.id, slotMetadata: { propertyName } }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "SLOT", parentId: instance.id, slotMetadata: { propertyName, sourceSlotId: slot.id } }) }),
    ]);
  });

  it("binds an existing Frame to a Slot property across linked Instances", () => {
    const session = sessionFor(new InMemoryTransport(initial));
    const component = session.createComponent();
    const frame = session.createFrame() as RuntimeContainerNodeProxy;
    frame.name = "Content";
    const sourceChild = session.createRectangle();
    frame.appendChild(sourceChild);
    component.appendChild(frame);
    const instance = component.createInstance();
    const instanceFrame = instance.children[0] as RuntimeContainerNodeProxy;
    const instanceChild = instanceFrame.children[0]!;
    const propertyName = component.addComponentProperty("Content", "SLOT", "");

    frame.componentPropertyReferences = { slotContentId: propertyName };

    const sourceSlot = component.children[0] as RuntimeContainerNodeProxy;
    const instanceSlot = instance.children[0] as RuntimeContainerNodeProxy;
    expect(frame.removed).toBe(true);
    expect(instanceFrame.removed).toBe(true);
    expect(sourceSlot).toMatchObject({ type: "SLOT", name: "Content" });
    expect(instanceSlot).toMatchObject({ type: "SLOT", name: "Content" });
    expect(sourceSlot.componentPropertyReferences).toEqual({ slotContentId: propertyName });
    expect(instanceSlot.componentPropertyReferences).toEqual({ slotContentId: propertyName });
    expect(session.projectionStore.getNode(sourceSlot.id)?.slotMetadata).toEqual({ propertyName });
    expect(session.projectionStore.getNode(instanceSlot.id)?.slotMetadata).toEqual({ propertyName, sourceSlotId: sourceSlot.id });
    expect(sourceSlot.children[0]).toMatchObject({ id: sourceChild.id, parent: sourceSlot });
    expect(instanceSlot.children[0]).toMatchObject({ id: instanceChild.id, parent: instanceSlot });

    const nested = session.createFrame();
    sourceSlot.appendChild(nested);
    expect(isRuntimeError(captureError(() => { nested.componentPropertyReferences = { slotContentId: propertyName }; }), "INVALID_ARGUMENT")).toBe(true);
  });

  it("deletes a Slot property by restoring Frames and resetting linked contents", () => {
    const session = sessionFor(new InMemoryTransport(initial));
    const component = session.createComponent();
    const sourceSlot = component.createSlot();
    const propertyName = sourceSlot.componentPropertyReferences!.slotContentId!;
    const sourceChild = session.createRectangle();
    sourceChild.name = "Default content";
    sourceSlot.appendChild(sourceChild);
    const instance = component.createInstance();
    const instanceSlot = instance.children[0] as RuntimeContainerNodeProxy;
    instanceSlot.children[0]!.remove();
    const override = session.createEllipse();
    override.name = "Override";
    instanceSlot.appendChild(override);

    component.deleteComponentProperty(propertyName);

    const sourceFrame = component.children[0] as RuntimeContainerNodeProxy;
    const instanceFrame = instance.children[0] as RuntimeContainerNodeProxy;
    expect(sourceSlot.removed).toBe(true);
    expect(instanceSlot.removed).toBe(true);
    expect(override.removed).toBe(true);
    expect(component.componentPropertyDefinitions).not.toHaveProperty(propertyName);
    expect(sourceFrame.type).toBe("FRAME");
    expect(sourceFrame.componentPropertyReferences).toBeNull();
    expect(sourceFrame.children[0]).toMatchObject({ id: sourceChild.id, name: "Default content" });
    expect(instanceFrame.type).toBe("FRAME");
    expect(instanceFrame.componentPropertyReferences).toBeNull();
    expect(instanceFrame.children).toEqual([expect.objectContaining({ type: "RECTANGLE", name: "Default content" })]);
    expect(instanceFrame.children[0]!.id).not.toBe(sourceChild.id);
  });

  it("resets an Instance Slot from its source contents atomically", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const component = session.createComponent();
    const instance = component.createInstance();
    const sourceSlot = component.createSlot();
    const sourceChild = session.createRectangle();
    sourceChild.name = "Default content";
    sourceSlot.appendChild(sourceChild);
    const instanceSlot = instance.children.find((child) => child.type === "SLOT") as RuntimeContainerNodeProxy;
    const override = session.createEllipse();
    override.name = "Override";
    instanceSlot.appendChild(override);

    instanceSlot.resetSlot();
    expect(override.removed).toBe(true);
    expect(instanceSlot.children).toHaveLength(1);
    expect(instanceSlot.children[0]).toMatchObject({ type: "RECTANGLE", name: "Default content", parent: instanceSlot });
    expect(instanceSlot.children[0]!.id).not.toBe(sourceChild.id);
    expect(session.projectionStore.getNode(instanceSlot.children[0]!.id)?.extensions).toHaveProperty("figma.instance.source-node.v1");
    expect(isRuntimeError(captureError(() => sourceSlot.resetSlot()), "UNSUPPORTED_FEATURE")).toBe(true);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      { type: "remove", nodeId: override.id },
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "RECTANGLE", parentId: instanceSlot.id, name: "Default content" }) }),
    ]));
  });

  it("adds, edits, renames and deletes Component properties with linked Instance projection", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const component = session.createComponent();
    const target = session.createComponent();
    const instance = component.createInstance();

    const enabled = component.addComponentProperty("Enabled", "BOOLEAN", true);
    const icon = component.addComponentProperty("Icon", "INSTANCE_SWAP", target.id);
    expect(enabled).toMatch(/^Enabled#/);
    expect(icon).toMatch(/^Icon#/);
    expect(component.componentPropertyDefinitions).toMatchObject({
      [enabled]: { type: "BOOLEAN", defaultValue: true },
      [icon]: { type: "INSTANCE_SWAP", defaultValue: target.id },
    });
    expect(instance.componentPropertyValues).toMatchObject({ [enabled]: true, [icon]: target.id });
    expect(instance.componentProperties).toMatchObject({
      [enabled]: { type: "BOOLEAN", value: true },
      [icon]: { type: "INSTANCE_SWAP", value: target.id },
    });

    instance.setProperties({ [enabled]: false });
    const renamed = component.editComponentProperty(enabled, { name: "Active", defaultValue: false });
    expect(renamed).toMatch(/^Active#/);
    expect(component.componentPropertyDefinitions).not.toHaveProperty(enabled);
    expect(component.componentPropertyDefinitions[renamed]).toEqual({ type: "BOOLEAN", defaultValue: false });
    expect(instance.componentPropertyValues).not.toHaveProperty(enabled);
    expect(instance.componentPropertyValues[renamed]).toBe(false);

    const slot = component.createSlot();
    const slotName = Object.keys(component.componentPropertyDefinitions).find((name) => component.componentPropertyDefinitions[name]?.type === "SLOT")!;
    const renamedSlot = component.editComponentProperty(slotName, { name: "Content" });
    expect(session.projectionStore.getNode(slot.id)?.slotMetadata).toMatchObject({ propertyName: renamedSlot });
    expect(session.projectionStore.getNode(instance.children.find((child) => child.type === "SLOT")!.id)?.slotMetadata).toMatchObject({ propertyName: renamedSlot });

    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => component.addComponentProperty("Bound", "BOOLEAN", { type: "VARIABLE_ALIAS", id: "variable" })), "RESOURCE_UNAVAILABLE")).toBe(true);
    expect(isRuntimeError(captureError(() => component.addComponentProperty("Preferred", "TEXT", "value", { preferredValues: [] })), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);

    component.deleteComponentProperty(renamed);
    expect(component.componentPropertyDefinitions).not.toHaveProperty(renamed);
    expect(instance.componentPropertyValues).not.toHaveProperty(renamed);
    await session.commitAsync();
    expect((await session.getNodeByIdAsync(component.id))?.componentPropertyDefinitions).not.toHaveProperty(renamed);
    expect((await session.getNodeByIdAsync(instance.id))?.componentPropertyValues).not.toHaveProperty(renamed);
  });

  it("stores preferred values and reports Slot setting violations", () => {
    const session = sessionFor(new InMemoryTransport(initial));
    const component = session.createComponent();
    const preferred = session.createComponent();
    const swap = component.addComponentProperty("Icon", "INSTANCE_SWAP", preferred.id, {
      preferredValues: [{ type: "COMPONENT", key: preferred.key }],
    });
    expect(component.componentPropertyDefinitions[swap]?.preferredValues).toEqual([{ type: "COMPONENT", key: preferred.key }]);

    const slot = component.createSlot();
    const slotName = Object.keys(component.componentPropertyDefinitions).find((name) => component.componentPropertyDefinitions[name]?.type === "SLOT")!;
    component.editComponentProperty(slotName, {
      description: "One preferred icon",
      preferredValues: [{ type: "COMPONENT", key: preferred.key }],
      slotSettings: { minChildren: 1, maxChildren: 1, allowPreferredValuesOnly: true, displayEmptyByDefault: false, stretchChildOnInsert: true },
    });
    expect(component.componentPropertyDefinitions[slotName]).toMatchObject({
      type: "SLOT",
      description: "One preferred icon",
      preferredValues: [{ type: "COMPONENT", key: preferred.key }],
      slotSettings: { minChildren: 1, maxChildren: 1, allowPreferredValuesOnly: true, displayEmptyByDefault: false, stretchChildOnInsert: true },
    });
    expect(slot.limitViolations).toEqual(["BELOW_MIN"]);

    slot.appendChild(preferred.createInstance());
    expect(slot.limitViolations).toEqual([]);
    slot.appendChild(session.createRectangle());
    expect(slot.limitViolations).toEqual(["ABOVE_MAX", "HAS_NON_PREFERRED"]);

    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => component.editComponentProperty(slotName, { slotSettings: { minChildren: 2, maxChildren: 1 } })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => component.editComponentProperty(swap, { slotSettings: { minChildren: 0 } })), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);
  });

  it("inherits exposed nested Instance state into linked component Instances", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const icon = session.createComponent();
    icon.name = "Icon";
    icon.appendChild(session.createRectangle());
    const card = session.createComponent();
    card.name = "Card";
    const nested = icon.createInstance();
    card.appendChild(nested);
    const cardInstance = card.createInstance();
    const inherited = cardInstance.children.find((child) => child.type === "INSTANCE")!;

    expect(nested.isExposedInstance).toBe(false);
    expect(cardInstance.exposedInstances).toEqual([]);
    nested.isExposedInstance = true;
    expect(nested.isExposedInstance).toBe(true);
    expect(inherited.isExposedInstance).toBe(true);
    expect(cardInstance.exposedInstances).toEqual([inherited]);

    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => { inherited.isExposedInstance = false; }), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: nested.id, patch: { instanceMetadata: expect.objectContaining({ isExposedInstance: true }) } }),
      expect.objectContaining({ type: "update", nodeId: inherited.id, patch: { instanceMetadata: expect.objectContaining({ isExposedInstance: true }) } }),
    ]));
  });

  it("resolves and preserves VariableAlias component defaults", () => {
    const projection: RuntimeProjection = {
      ...initial,
      variableCollections: [{ id: "collection", key: "", name: "Properties", remote: false, hiddenFromPublishing: false, modes: [{ modeId: "default", name: "Default" }], defaultModeId: "default" }],
      variables: [
        { id: "enabled-variable", key: "", name: "Enabled", description: "", remote: false, hiddenFromPublishing: false, collectionId: "collection", resolvedType: "BOOLEAN", valuesByMode: { default: false }, scopes: ["ALL_SCOPES"] },
        { id: "label-variable", key: "", name: "Label", description: "", remote: false, hiddenFromPublishing: false, collectionId: "collection", resolvedType: "STRING", valuesByMode: { default: "Continue" }, scopes: ["ALL_SCOPES"] },
      ],
    };
    const session = new RuntimeSession({ sessionId: "component-property-alias", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const component = session.createComponent();
    const enabled = component.addComponentProperty("Enabled", "BOOLEAN", { type: "VARIABLE_ALIAS", id: "enabled-variable" });
    const label = component.addComponentProperty("Label", "TEXT", { type: "VARIABLE_ALIAS", id: "label-variable" });

    expect(component.componentPropertyDefinitions[enabled]).toEqual({ type: "BOOLEAN", defaultValue: false, boundVariables: { defaultValue: { type: "VARIABLE_ALIAS", id: "enabled-variable" } } });
    expect(component.componentPropertyDefinitions[label]).toEqual({ type: "TEXT", defaultValue: "Continue", boundVariables: { defaultValue: { type: "VARIABLE_ALIAS", id: "label-variable" } } });
    const instance = component.createInstance();
    expect(instance.componentPropertyValues).toMatchObject({ [enabled]: false, [label]: "Continue" });
    expect(instance.componentProperties[enabled]).toEqual({
      type: "BOOLEAN",
      value: false,
      boundVariables: { defaultValue: { type: "VARIABLE_ALIAS", id: "enabled-variable" } },
    });
    expect(session.variableIsBound("enabled-variable")).toBe(true);

    session.setVariable({ ...projection.variables![0]!, valuesByMode: { default: true } });
    expect(component.componentPropertyDefinitions[enabled]).toEqual({ type: "BOOLEAN", defaultValue: true, boundVariables: { defaultValue: { type: "VARIABLE_ALIAS", id: "enabled-variable" } } });
    expect(instance.componentPropertyValues[enabled]).toBe(true);

    expect(isRuntimeError(captureError(() => component.addComponentProperty("Wrong", "BOOLEAN", { type: "VARIABLE_ALIAS", id: "label-variable" })), "INVALID_ARGUMENT")).toBe(true);
    component.editComponentProperty(enabled, { defaultValue: false });
    expect(component.componentPropertyDefinitions[enabled]).toEqual({ type: "BOOLEAN", defaultValue: false });
  });

  it("binds VariableAlias values to Instance properties and recomputes referenced layers", async () => {
    const projection: RuntimeProjection = {
      ...initial,
      variableCollections: [{
        id: "instance-properties",
        key: "",
        name: "Instance properties",
        remote: false,
        hiddenFromPublishing: false,
        modes: [{ modeId: "default", name: "Default" }, { modeId: "dark", name: "Dark" }],
        defaultModeId: "default",
      }],
      variables: [
        { id: "instance-enabled", key: "", name: "Enabled", description: "", remote: false, hiddenFromPublishing: false, collectionId: "instance-properties", resolvedType: "BOOLEAN", valuesByMode: { default: false, dark: true }, scopes: ["ALL_SCOPES"] },
        { id: "instance-swap", key: "", name: "Swap", description: "", remote: false, hiddenFromPublishing: false, collectionId: "instance-properties", resolvedType: "STRING", valuesByMode: { default: "pending", dark: "pending" }, scopes: ["ALL_SCOPES"] },
        { id: "wrong-instance-value", key: "", name: "Wrong", description: "", remote: false, hiddenFromPublishing: false, collectionId: "instance-properties", resolvedType: "STRING", valuesByMode: { default: "wrong", dark: "wrong" }, scopes: ["ALL_SCOPES"] },
      ],
    };
    const session = new RuntimeSession({ sessionId: "instance-property-alias", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const component = session.createComponent();
    const alternate = session.createComponent();
    alternate.appendChild(session.createRectangle());
    const replacement = session.createComponent();
    replacement.appendChild(session.createEllipse());
    session.setVariable({ ...projection.variables![1]!, valuesByMode: { default: alternate.id, dark: replacement.id } });
    const surface = session.createRectangle();
    const nested = alternate.createInstance();
    component.appendChild(surface);
    component.appendChild(nested);
    const enabled = component.addComponentProperty("Enabled", "BOOLEAN", true);
    const swap = component.addComponentProperty("Swap", "INSTANCE_SWAP", alternate.id);
    surface.componentPropertyReferences = { visible: enabled };
    nested.componentPropertyReferences = { mainComponent: swap };
    const instance = component.createInstance();
    const instanceSurface = instance.children.find((child) => child.type === "RECTANGLE")!;
    const instanceNested = instance.children.find((child) => child.type === "INSTANCE")!;

    instance.setProperties({
      [enabled]: { type: "VARIABLE_ALIAS", id: "instance-enabled" },
      [swap]: { type: "VARIABLE_ALIAS", id: "instance-swap" },
    });
    expect(instance.componentPropertyValues).toMatchObject({ [enabled]: false, [swap]: alternate.id });
    expect(instance.componentProperties[enabled]?.boundVariables).toEqual({ defaultValue: { type: "VARIABLE_ALIAS", id: "instance-enabled" } });
    expect(instance.boundVariables).toMatchObject({
      componentProperties: {
        [enabled]: { type: "VARIABLE_ALIAS", id: "instance-enabled" },
        [swap]: { type: "VARIABLE_ALIAS", id: "instance-swap" },
      },
    });
    expect(instanceSurface.visible).toBe(false);
    expect((await instanceNested.getMainComponentAsync())?.id).toBe(alternate.id);
    expect(session.variableIsBound("instance-enabled")).toBe(true);

    session.setVariable({ ...projection.variables![0]!, valuesByMode: { default: true, dark: true } });
    expect(instance.componentPropertyValues[enabled]).toBe(true);
    expect(instanceSurface.visible).toBe(true);
    session.setVariable(projection.variables![0]!);
    expect(instance.componentPropertyValues[enabled]).toBe(false);
    expect(instanceSurface.visible).toBe(false);

    const collection = session.variables.getVariableCollectionById("instance-properties")!;
    instance.setExplicitVariableModeForCollection(collection, "dark");
    expect(instance.componentPropertyValues).toMatchObject({ [enabled]: true, [swap]: replacement.id });
    expect(instanceSurface.visible).toBe(true);
    expect((await instanceNested.getMainComponentAsync())?.id).toBe(replacement.id);
    expect(instanceNested.children).toEqual([expect.objectContaining({ type: "ELLIPSE" })]);

    const shown = component.editComponentProperty(enabled, { name: "Shown" });
    expect(instance.componentProperties[shown]?.boundVariables).toEqual({ defaultValue: { type: "VARIABLE_ALIAS", id: "instance-enabled" } });
    expect(instance.boundVariables?.componentProperties).toMatchObject({ [shown]: { type: "VARIABLE_ALIAS", id: "instance-enabled" } });
    expect(instance.boundVariables?.componentProperties).not.toHaveProperty(enabled);

    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => instance.setProperties({ [shown]: { type: "VARIABLE_ALIAS", id: "wrong-instance-value" } })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => instance.setProperties({ Missing: { type: "VARIABLE_ALIAS", id: "instance-enabled" } })), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);

    instance.setProperties({ [shown]: false });
    expect(instance.componentProperties[shown]?.boundVariables).toBeUndefined();
    expect(instance.boundVariables?.componentProperties).toEqual({ [swap]: { type: "VARIABLE_ALIAS", id: "instance-swap" } });
    session.setVariable({ ...projection.variables![0]!, valuesByMode: { default: true, dark: true } });
    expect(instance.componentPropertyValues[shown]).toBe(false);
  });

  it("rebuilds referenced nested Instances when a VariableAlias swap default changes", async () => {
    const projection: RuntimeProjection = {
      ...initial,
      variableCollections: [{ id: "collection", key: "", name: "Properties", remote: false, hiddenFromPublishing: false, modes: [{ modeId: "default", name: "Default" }], defaultModeId: "default" }],
      variables: [{ id: "swap-variable", key: "", name: "Swap", description: "", remote: false, hiddenFromPublishing: false, collectionId: "collection", resolvedType: "STRING", valuesByMode: { default: "unbound" }, scopes: ["ALL_SCOPES"] }],
    };
    const session = new RuntimeSession({ sessionId: "component-property-swap-alias", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const component = session.createComponent();
    const alternate = session.createComponent();
    const oldShape = session.createRectangle();
    alternate.appendChild(oldShape);
    const replacement = session.createComponent();
    const newShape = session.createEllipse();
    replacement.appendChild(newShape);
    session.setVariable({ ...projection.variables![0]!, valuesByMode: { default: alternate.id } });
    const swap = component.addComponentProperty("Swap", "INSTANCE_SWAP", { type: "VARIABLE_ALIAS", id: "swap-variable" });
    const nested = alternate.createInstance();
    component.appendChild(nested);
    nested.componentPropertyReferences = { mainComponent: swap };
    const instance = component.createInstance();
    const instanceNested = instance.children[0]!;

    session.setVariable({ ...projection.variables![0]!, valuesByMode: { default: replacement.id } });

    expect(component.componentPropertyDefinitions[swap]).toEqual({
      type: "INSTANCE_SWAP",
      defaultValue: replacement.id,
      boundVariables: { defaultValue: { type: "VARIABLE_ALIAS", id: "swap-variable" } },
    });
    expect(instance.componentPropertyValues[swap]).toBe(replacement.id);
    expect((await nested.getMainComponentAsync())?.id).toBe(replacement.id);
    expect(nested.children).toEqual([expect.objectContaining({ type: "ELLIPSE" })]);
    expect((await instanceNested.getMainComponentAsync())?.id).toBe(replacement.id);
    expect(instanceNested.children).toEqual([expect.objectContaining({ type: "ELLIPSE" })]);
  });

  it("authors component property references and applies Instance values to linked sublayers", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const component = session.createComponent();
    const alternate = session.createComponent();
    const alternateChild = session.createRectangle();
    alternateChild.name = "Old icon";
    alternate.appendChild(alternateChild);
    const replacement = session.createComponent();
    const replacementChild = session.createEllipse();
    replacementChild.name = "New icon";
    replacement.appendChild(replacementChild);
    const surface = session.createRectangle();
    const label = session.createText();
    const nested = alternate.createInstance();
    component.appendChild(surface);
    component.appendChild(label);
    component.appendChild(nested);
    const enabled = component.addComponentProperty("Enabled", "BOOLEAN", false);
    const title = component.addComponentProperty("Title", "TEXT", "Continue");
    const swap = component.addComponentProperty("Swap", "INSTANCE_SWAP", alternate.id);

    surface.componentPropertyReferences = { visible: enabled };
    label.componentPropertyReferences = { characters: title };
    nested.componentPropertyReferences = { mainComponent: swap };
    expect(surface.visible).toBe(false);
    expect(label.characters).toBe("Continue");
    expect(surface.componentPropertyReferences).toEqual({ visible: enabled });

    const instance = component.createInstance();
    const instanceSurface = instance.children.find((child) => child.type === "RECTANGLE")!;
    const instanceLabel = instance.children.find((child) => child.type === "TEXT")!;
    const instanceNested = instance.children.find((child) => child.type === "INSTANCE")!;
    expect(instanceSurface).toMatchObject({ visible: false, componentPropertyReferences: { visible: enabled } });
    expect(instanceLabel).toMatchObject({ characters: "Continue", componentPropertyReferences: { characters: title } });
    expect((await instanceNested.getMainComponentAsync())?.id).toBe(alternate.id);
    expect(instanceNested.children).toEqual([expect.objectContaining({ type: "RECTANGLE", name: "Old icon" })]);

    instance.setProperties({ [enabled]: true, [title]: "Save", [swap]: replacement.id });
    expect(instanceSurface.visible).toBe(true);
    expect(instanceLabel.characters).toBe("Save");
    expect(instance.componentPropertyValues).toMatchObject({ [enabled]: true, [title]: "Save", [swap]: replacement.id });
    expect((await instanceNested.getMainComponentAsync())?.id).toBe(replacement.id);
    expect(instanceNested.children).toEqual([expect.objectContaining({ type: "ELLIPSE", name: "New icon" })]);

    component.editComponentProperty(swap, { defaultValue: replacement.id });
    expect((await nested.getMainComponentAsync())?.id).toBe(replacement.id);
    expect(nested.children).toEqual([expect.objectContaining({ type: "ELLIPSE", name: "New icon" })]);

    const renamedEnabled = component.editComponentProperty(enabled, { name: "Shown" });
    expect(surface.componentPropertyReferences).toEqual({ visible: renamedEnabled });
    expect(instanceSurface.componentPropertyReferences).toEqual({ visible: renamedEnabled });
    component.deleteComponentProperty(renamedEnabled);
    expect(surface.componentPropertyReferences).toBeNull();
    expect(instanceSurface.componentPropertyReferences).toBeNull();

    const operationCount = session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)!.operations.length;
    expect(isRuntimeError(captureError(() => { surface.componentPropertyReferences = { characters: title }; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { surface.componentPropertyReferences = { visible: title }; }), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)!.operations).toHaveLength(operationCount);

    label.componentPropertyReferences = null;
    expect(label.componentPropertyReferences).toBeNull();
    expect(instanceLabel.componentPropertyReferences).toBeNull();
    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: instance.id, patch: { instanceMetadata: expect.objectContaining({ componentProperties: expect.objectContaining({ [enabled]: true, [title]: "Save" }) }) } }),
      expect.objectContaining({ type: "update", nodeId: instanceLabel.id, patch: expect.objectContaining({ characters: "Save" }) }),
      expect.objectContaining({ type: "update", nodeId: instanceNested.id, patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: replacement.id }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: instanceNested.id, type: "ELLIPSE", name: "New icon" }) }),
    ]));
  });

  it("materializes exposed nested Instance swaps while creating an Instance", async () => {
    const propertyName = "Swap#1:1";
    const componentMetadata = (key: string, definitions = {}) => ({ key, remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: definitions });
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [
        ...initial.nodes,
        { id: "card", type: "COMPONENT", name: "Card", parentId: "page", siblingIndex: 1, componentMetadata: componentMetadata("card", { [propertyName]: { type: "INSTANCE_SWAP", defaultValue: "replacement" } }) },
        { id: "nested", type: "INSTANCE", name: "Icon", parentId: "card", siblingIndex: 0, componentPropertyReferences: { mainComponent: propertyName }, instanceMetadata: { mainComponentId: "alternate", scaleFactor: 1, componentProperties: {}, overrides: [], isExposedInstance: false } },
        { id: "nested-old", type: "RECTANGLE", name: "Old shape", parentId: "nested", siblingIndex: 0 },
        { id: "alternate", type: "COMPONENT", name: "Old icon", parentId: "page", siblingIndex: 2, componentMetadata: componentMetadata("alternate") },
        { id: "alternate-child", type: "RECTANGLE", name: "Old shape", parentId: "alternate", siblingIndex: 0 },
        { id: "replacement", type: "COMPONENT", name: "New icon", parentId: "page", siblingIndex: 3, componentMetadata: componentMetadata("replacement") },
        { id: "replacement-child", type: "ELLIPSE", name: "New shape", parentId: "replacement", siblingIndex: 0 },
      ],
    };
    const session = new RuntimeSession({ sessionId: "nested-instance-materialization", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const component = session.currentPage.children.find((node) => node.id === "card")!;

    const instance = component.createInstance();
    const nested = instance.children[0]!;

    expect((await nested.getMainComponentAsync())?.id).toBe("replacement");
    expect(nested.children).toEqual([expect.objectContaining({ type: "ELLIPSE", name: "New shape" })]);
    expect(nested.children.some((child) => child.name === "Old shape")).toBe(false);
  });

  it("validates and writes Instance component properties from the main Component definition", async () => {
    const componentMetadata = {
      key: "card-key",
      remote: false,
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      componentPropertyDefinitions: {
        Enabled: { type: "BOOLEAN" as const, defaultValue: true },
        Label: { type: "TEXT" as const, defaultValue: "Continue" },
        Swap: { type: "INSTANCE_SWAP" as const, defaultValue: "target" },
        State: { type: "VARIANT" as const, defaultValue: "Default" },
        Content: { type: "SLOT" as const },
      },
    };
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [
        ...initial.nodes,
        { id: "component", type: "COMPONENT", name: "Card", parentId: "page", siblingIndex: 1, componentMetadata },
        { id: "component-child", type: "RECTANGLE", name: "Old source", parentId: "component", siblingIndex: 0, width: 100, height: 40 },
        { id: "target", type: "COMPONENT", name: "Icon", parentId: "page", siblingIndex: 2, componentMetadata: { ...componentMetadata, key: "icon-key", componentPropertyDefinitions: { Icon: { type: "TEXT", defaultValue: "Star" } } } },
        { id: "target-child", type: "ELLIPSE", name: "New source", parentId: "target", siblingIndex: 0, width: 24, height: 24 },
        { id: "instance", type: "INSTANCE", name: "Card instance", parentId: "page", siblingIndex: 3, instanceMetadata: { mainComponentId: "component", scaleFactor: 1, componentProperties: { Enabled: true, Label: "Continue", Swap: "target", State: "Default" }, overrides: [], isExposedInstance: false } },
        { id: "instance-child", type: "RECTANGLE", name: "Old source", parentId: "instance", siblingIndex: 0, width: 100, height: 40, extensions: { "figma.instance.source-node.v1": [...new TextEncoder().encode("component-child")] } },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "instance-properties", projection, transport, scheduleMicrotask: () => {} });
    const instance = session.currentPage.children.find((node) => node.id === "instance")!;

    instance.setProperties({ Enabled: false, Label: "Save", Swap: "target", State: "Hover" });
    expect(instance.componentPropertyValues).toEqual({ Enabled: false, Label: "Save", Swap: "target", State: "Hover" });
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => instance.setProperties({ Enabled: "false" })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => instance.setProperties({ Missing: "value" })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => instance.setProperties({ Content: "slot" })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => instance.setProperties({ Swap: "frame" })), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)!.operations).toHaveLength(operationCount);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual([expect.objectContaining({
      type: "update",
      nodeId: "instance",
      patch: { instanceMetadata: expect.objectContaining({ componentProperties: { Enabled: false, Label: "Save", Swap: "target", State: "Hover" } }) },
    })]);

    const target = session.currentPage.children.find((node) => node.id === "target")!;
    const oldInstanceChild = instance.children[0]!;
    instance.swapComponent(target);
    expect(await instance.getMainComponentAsync()).toBe(target);
    expect(instance.componentPropertyValues).toEqual({ Icon: "Star" });
    expect(instance.overrides).toEqual([]);
    expect(oldInstanceChild.removed).toBe(true);
    expect(instance.children).toHaveLength(1);
    expect(instance.children[0]).toMatchObject({ type: "ELLIPSE", name: "New source" });
    const swapTransactionId = session.projectionStore.pendingTransactionIds()[0]!;
    expect(isRuntimeError(captureError(() => instance.swapComponent(session.currentPage.children.find((node) => node.id === "frame")!)), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(swapTransactionId)?.operations).toHaveLength(3);
    await session.commitAsync();
    expect(transport.submitted[1]?.operations).toEqual([
      expect.objectContaining({ type: "update", nodeId: "instance", patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: "target", componentProperties: { Icon: "Star" }, overrides: [] }) }) }),
      { type: "remove", nodeId: "instance-child" },
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "ELLIPSE", parentId: "instance", name: "New source" }) }),
    ]);
  });

  it("distinguishes override-preserving swapComponent from direct mainComponent assignment", async () => {
    const propertyName = "Label#shared";
    const componentMetadata = (key: string, defaultValue: string) => ({
      key,
      remote: false,
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      componentPropertyDefinitions: { [propertyName]: { type: "TEXT" as const, defaultValue } },
    });
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [
        ...initial.nodes,
        { id: "base", type: "COMPONENT", name: "Base", parentId: "page", siblingIndex: 1, componentMetadata: componentMetadata("base-key", "Base") },
        { id: "base-surface", type: "RECTANGLE", name: "Surface", parentId: "base", siblingIndex: 0, opacity: 1 },
        { id: "target", type: "COMPONENT", name: "Target", parentId: "page", siblingIndex: 2, componentMetadata: componentMetadata("target-key", "Target") },
        { id: "target-surface", type: "RECTANGLE", name: "Surface", parentId: "target", siblingIndex: 0, opacity: 0.8 },
        {
          id: "instance",
          type: "INSTANCE",
          name: "Instance",
          parentId: "page",
          siblingIndex: 3,
          instanceMetadata: {
            mainComponentId: "base",
            scaleFactor: 1,
            componentProperties: { [propertyName]: "Custom" },
            overrides: [{ id: "instance-surface", overriddenFields: ["opacity"] }],
            isExposedInstance: false,
          },
        },
        {
          id: "instance-surface",
          type: "RECTANGLE",
          name: "Surface",
          parentId: "instance",
          siblingIndex: 0,
          opacity: 0.35,
          extensions: { "figma.instance.source-node.v1": [...new TextEncoder().encode("base-surface")] },
        },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "instance-main-component", projection, transport, scheduleMicrotask: () => {} });
    const instance = session.currentPage.children.find((node) => node.id === "instance")!;
    const base = session.currentPage.children.find((node) => node.id === "base")!;
    const target = session.currentPage.children.find((node) => node.id === "target")!;

    expect(instance.mainComponent).toBe(base);
    const oldSurface = instance.children[0]!;
    instance.swapComponent(target);
    const swappedSurface = instance.children[0]!;
    expect(instance.mainComponent).toBe(target);
    expect(instance.componentPropertyValues).toEqual({ [propertyName]: "Custom" });
    expect(swappedSurface).toMatchObject({ name: "Surface", opacity: 0.35 });
    expect(instance.overrides).toEqual([{ id: swappedSurface.id, overriddenFields: ["opacity"] }]);
    expect(oldSurface.removed).toBe(true);
    await session.commitAsync();

    instance.resetOverrides();
    const resetSurface = instance.children[0]!;
    expect(instance.mainComponent).toBe(target);
    expect(instance.componentPropertyValues).toEqual({ [propertyName]: "Target" });
    expect(resetSurface).toMatchObject({ name: "Surface", opacity: 0.8 });
    expect(instance.overrides).toEqual([]);
    expect(swappedSurface.removed).toBe(true);
    await session.commitAsync();

    instance.mainComponent = base;
    expect(instance.mainComponent).toBe(base);
    expect(instance.componentPropertyValues).toEqual({ [propertyName]: "Base" });
    expect(instance.children[0]).toMatchObject({ name: "Surface", opacity: 1 });
    expect(instance.overrides).toEqual([]);
    expect(resetSurface.removed).toBe(true);
    await session.commitAsync();

    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: "instance", patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: "target", componentProperties: { [propertyName]: "Custom" } }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: "instance", name: "Surface", opacity: 0.35 }) }),
    ]));
    expect(transport.submitted[1]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: "instance", patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: "target", componentProperties: { [propertyName]: "Target" }, overrides: [] }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: "instance", name: "Surface", opacity: 0.8 }) }),
    ]));
    expect(transport.submitted[2]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: "instance", patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: "base", componentProperties: { [propertyName]: "Base" }, overrides: [] }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: "instance", name: "Surface", opacity: 1 }) }),
    ]));

    const dynamic = new RuntimeSession({
      sessionId: "instance-main-component-dynamic",
      projection,
      transport: new InMemoryTransport(projection),
      documentAccess: "dynamic-page",
      loadedPageIds: ["page"],
      scheduleMicrotask: () => {},
    });
    const dynamicInstance = dynamic.currentPage.children.find((node) => node.id === "instance")!;
    expect(isRuntimeError(captureError(() => dynamicInstance.mainComponent), "PAGE_NOT_LOADED")).toBe(true);
    expect((await dynamicInstance.getMainComponentAsync())?.id).toBe("base");
  });

  it("creates local components and paint-free slice export regions through the transaction fence", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const component = session.createComponent();
    const child = session.createRectangle();
    component.appendChild(child);
    const instance = component.createInstance();
    const slice = session.createSlice();
    slice.resize(320, 180);

    expect(component).toBeInstanceOf(RuntimeContainerNodeProxy);
    expect(component).toMatchObject({
      type: "COMPONENT",
      key: component.id,
      remote: false,
      description: "",
      descriptionMarkdown: "",
      componentPropertyDefinitions: {},
    });
    expect(component.documentationLinks).toEqual([]);
    expect(component.children).toEqual([child]);
    expect(instance).toBeInstanceOf(RuntimeContainerNodeProxy);
    expect(instance).toMatchObject({
      type: "INSTANCE",
      name: "Component instance",
      scaleFactor: 1,
      componentPropertyValues: {},
      overrides: [],
      isExposedInstance: false,
    });
    expect(instance.children).toHaveLength(1);
    expect(instance.children[0]).toMatchObject({ type: "RECTANGLE", name: "Rectangle" });
    expect(instance.children[0]?.id).not.toBe(child.id);
    expect(instance.children[0]?.parent).toBe(instance);
    expect(await instance.getMainComponentAsync()).toBe(component);
    expect(await component.getInstancesAsync()).toEqual([instance]);
    const configurable = session.createNode("COMPONENT", {
      name: "Configurable",
      componentMetadata: {
        key: "configurable",
        remote: false,
        description: "",
        descriptionMarkdown: "",
        documentationLinks: [],
        componentPropertyDefinitions: {
          Enabled: { type: "BOOLEAN", defaultValue: true },
          Label: { type: "TEXT", defaultValue: "Continue" },
          Content: { type: "SLOT" },
        },
      },
    });
    const configuredInstance = configurable.createInstance();
    expect(configuredInstance.componentPropertyValues).toEqual({ Enabled: true, Label: "Continue" });
    expect(slice).toMatchObject({ type: "SLICE", width: 320, height: 180 });
    expect(isRuntimeError(captureError(() => slice.fills), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => slice.strokes), "UNSUPPORTED_PROPERTY")).toBe(true);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({
          id: component.id,
          type: "COMPONENT",
          componentMetadata: {
            key: component.id,
            remote: false,
            description: "",
            descriptionMarkdown: "",
            documentationLinks: [],
            componentPropertyDefinitions: {},
          },
        }),
      }),
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({ id: slice.id, type: "SLICE", fill: "transparent", stroke: "transparent", strokeWidth: 0 }),
      }),
      expect.objectContaining({
        type: "create",
        node: expect.objectContaining({
          id: instance.id,
          type: "INSTANCE",
          parentId: "page",
          pageId: "page",
          instanceMetadata: expect.objectContaining({ mainComponentId: component.id, componentProperties: {} }),
          extensions: expect.objectContaining({ "figma.instance.source-node.v1": expect.any(Array) }),
        }),
      }),
    ]));
    expect((await session.getNodeByIdAsync(component.id))?.key).toBe(component.id);
    expect((await session.getNodeByIdAsync(slice.id))?.width).toBe(320);
  });

  it("detaches an Instance into a fresh Frame subtree through one replacement transaction", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const component = session.createComponent();
    const sourceChild = session.createRectangle();
    component.appendChild(sourceChild);
    const instance = component.createInstance();
    const instanceChild = instance.children[0]!;
    const detached = instance.detachInstance();

    expect(detached).toBeInstanceOf(RuntimeContainerNodeProxy);
    expect(detached).toMatchObject({ type: "FRAME", name: "Component instance detached", parent: session.currentPage });
    expect(detached.id).not.toBe(instance.id);
    expect(detached.children).toHaveLength(1);
    expect(detached.children[0]).toMatchObject({ type: "RECTANGLE", parent: detached });
    expect(detached.children[0]?.id).not.toBe(instanceChild.id);
    expect(instance.removed).toBe(true);
    expect(instanceChild.removed).toBe(true);
    expect(session.projectionStore.getNode(detached.id)).not.toHaveProperty("instanceMetadata");
    expect(session.projectionStore.getNode(detached.id)?.extensions).not.toHaveProperty("figma.instance.source-node.v1");
    expect(session.projectionStore.getNode(detached.children[0]!.id)?.extensions).not.toHaveProperty("figma.instance.source-node.v1");

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "detachInstance",
        sourceId: instance.id,
        sourceIds: [instance.id, instanceChild.id],
        replacements: [
          expect.objectContaining({ id: detached.id, type: "FRAME", name: "Component instance detached" }),
          expect.objectContaining({ id: detached.children[0]!.id, type: "RECTANGLE", parentId: detached.id }),
        ],
      }),
    ]));
    expect(await session.getNodeByIdAsync(instance.id)).toBeNull();
    expect((await session.getNodeByIdAsync(detached.id))?.type).toBe("FRAME");
  });

  it("detaches every Instance ancestor while preserving unrelated nested Instances", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const leaf = session.createComponent();
    leaf.name = "Leaf";
    leaf.appendChild(session.createRectangle());
    const middle = session.createComponent();
    middle.name = "Middle";
    const firstLeaf = leaf.createInstance();
    firstLeaf.name = "First leaf";
    const secondLeaf = leaf.createInstance();
    secondLeaf.name = "Second leaf";
    middle.appendChild(firstLeaf);
    middle.appendChild(secondLeaf);
    const outer = session.createComponent();
    outer.name = "Outer";
    outer.appendChild(middle.createInstance());
    const outerInstance = outer.createInstance();
    await session.commitAsync();

    const oldMiddle = outerInstance.children.find((node) => node.type === "INSTANCE")!;
    const oldFirstLeaf = oldMiddle.children.find((node) => node.name === "First leaf")!;
    const oldSecondLeaf = oldMiddle.children.find((node) => node.name === "Second leaf")!;
    const oldSecondLeafChild = oldSecondLeaf.children[0]!;
    const detachedLeaf = oldFirstLeaf.detachInstance();
    const detachedMiddle = detachedLeaf.parent!;
    const detachedOuter = detachedMiddle.parent!;
    const retainedLeaf = detachedMiddle.children.find((node) => node.name === "Second leaf")!;

    expect(detachedLeaf).toMatchObject({ type: "FRAME", name: "First leaf detached" });
    expect(detachedMiddle).toMatchObject({ type: "FRAME", name: "Middle instance detached" });
    expect(detachedOuter).toMatchObject({ type: "FRAME", name: "Outer instance detached", parent: session.currentPage });
    expect(retainedLeaf).toMatchObject({ type: "INSTANCE", name: "Second leaf" });
    expect(retainedLeaf.children).toHaveLength(1);
    expect(session.projectionStore.getNode(retainedLeaf.id)).toHaveProperty("instanceMetadata");
    expect(session.projectionStore.getNode(retainedLeaf.children[0]!.id)?.extensions).toHaveProperty("figma.instance.source-node.v1");
    expect(session.projectionStore.getNode(detachedLeaf.id)).not.toHaveProperty("instanceMetadata");
    expect(session.projectionStore.getNode(detachedMiddle.id)).not.toHaveProperty("instanceMetadata");
    expect(session.projectionStore.getNode(detachedOuter.id)).not.toHaveProperty("instanceMetadata");
    expect(outerInstance.removed).toBe(true);
    expect(oldMiddle.removed).toBe(true);
    expect(oldFirstLeaf.removed).toBe(true);
    expect(oldSecondLeaf.removed).toBe(true);
    expect(oldSecondLeafChild.removed).toBe(true);

    await session.commitAsync();
    expect(transport.submitted[1]?.operations).toEqual([
      expect.objectContaining({
        type: "detachInstance",
        sourceId: outerInstance.id,
        sourceIds: expect.arrayContaining([outerInstance.id, oldMiddle.id, oldFirstLeaf.id, oldSecondLeaf.id, oldSecondLeafChild.id]),
        replacements: expect.arrayContaining([
          expect.objectContaining({ id: detachedOuter.id, type: "FRAME" }),
          expect.objectContaining({ id: detachedMiddle.id, type: "FRAME", parentId: detachedOuter.id }),
          expect.objectContaining({ id: detachedLeaf.id, type: "FRAME", parentId: detachedMiddle.id }),
          expect.objectContaining({ id: retainedLeaf.id, type: "INSTANCE", parentId: detachedMiddle.id }),
        ]),
      }),
    ]);
  });

  it("combines local Components as variants while preserving world geometry and order", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const base = session.createComponent();
    base.name = "State=Default, Size=Medium";
    base.x = 120;
    base.y = 40;
    base.resize(100, 60);
    const hover = session.createComponent();
    hover.name = "State=Hover, Size=Medium";
    hover.x = 260;
    hover.y = 40;
    hover.resize(100, 60);

    const set = session.combineAsVariants([hover, base], session.currentPage, 1);
    expect(set).toBeInstanceOf(RuntimeContainerNodeProxy);
    expect(set).toMatchObject({ type: "COMPONENT_SET", name: "Component set", x: 120, y: 40, width: 240, height: 60, parent: session.currentPage });
    expect(set.variantGroupProperties).toEqual({ State: { values: ["Default", "Hover"] }, Size: { values: ["Medium"] } });
    expect(set.componentPropertyDefinitions).toEqual({
      State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
      Size: { type: "VARIANT", defaultValue: "Medium", variantOptions: ["Medium"] },
    });
    expect(base.variantProperties).toEqual({ State: "Default", Size: "Medium" });
    expect(hover.variantProperties).toEqual({ State: "Hover", Size: "Medium" });
    expect(set.defaultVariant).toBe(base);
    expect(set.children).toEqual([base, hover]);
    expect(base).toMatchObject({ parent: set, x: 0, y: 0 });
    expect(hover).toMatchObject({ parent: set, x: 140, y: 0 });
    expect(session.currentPage.children.map((node) => node.id)).toEqual(["frame", set.id]);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "componentSet",
        node: expect.objectContaining({ id: set.id, type: "COMPONENT_SET" }),
        childIds: [base.id, hover.id],
        childPatches: [
          expect.objectContaining({ parentId: set.id, siblingIndex: 0 }),
          expect.objectContaining({ parentId: set.id, siblingIndex: 1 }),
        ],
      }),
    ]));
    expect((await session.getNodeByIdAsync(set.id))?.children).toEqual([base, hover]);
  });

  it("projects ComponentSet dissolution synchronously when the last Component leaves", async () => {
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [
        ...initial.nodes,
        {
          id: "set",
          type: "COMPONENT_SET",
          name: "Button variants",
          parentId: "page",
          siblingIndex: 1,
          componentSetMetadata: {
            key: "set-key",
            remote: false,
            description: "",
            descriptionMarkdown: "",
            documentationLinks: [],
            componentPropertyDefinitions: {},
            variantGroupProperties: {},
          },
        },
        { id: "default", type: "COMPONENT", name: "State=Default", parentId: "set", siblingIndex: 0, componentMetadata: { key: "default-key", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} } },
        { id: "hover", type: "COMPONENT", name: "State=Hover", parentId: "set", siblingIndex: 1, componentMetadata: { key: "hover-key", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} } },
      ],
    };
    const session = new RuntimeSession({ sessionId: "component-set-dissolve", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const set = (await session.getNodeByIdAsync("set"))!;
    const defaultVariant = (await session.getNodeByIdAsync("default"))!;
    const hoverVariant = (await session.getNodeByIdAsync("hover"))!;

    session.currentPage.appendChild(defaultVariant);
    expect(set.removed).toBe(false);
    expect(set.children.map((node) => node.id)).toEqual(["hover"]);
    session.currentPage.appendChild(hoverVariant);
    expect(set.removed).toBe(true);
    expect(await session.getNodeByIdAsync("set")).toBeNull();
    expect(session.currentPage.children.map((node) => node.id)).toEqual(expect.arrayContaining(["default", "hover"]));
    expect(session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)?.operations)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "remove", nodeId: "set" })]));
  });

  it("mutates shared ComponentSet properties across variants, Instances and referenced sublayers", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const base = session.createComponent();
    base.name = "State=Default";
    const baseSurface = session.createRectangle();
    base.appendChild(baseSurface);
    const hover = session.createComponent();
    hover.name = "State=Hover";
    const hoverSurface = session.createRectangle();
    hover.appendChild(hoverSurface);
    const set = session.combineAsVariants([base, hover], session.currentPage);
    const baseInstance = base.createInstance();
    const hoverInstance = hover.createInstance();

    const enabled = set.addComponentProperty("Enabled", "BOOLEAN", false);
    expect(set.componentPropertyDefinitions).toMatchObject({
      State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
      [enabled]: { type: "BOOLEAN", defaultValue: false },
    });
    expect(base.componentPropertyDefinitions[enabled]).toEqual({ type: "BOOLEAN", defaultValue: false });
    expect(hover.componentPropertyDefinitions[enabled]).toEqual({ type: "BOOLEAN", defaultValue: false });
    expect(baseInstance.componentPropertyValues[enabled]).toBe(false);
    expect(hoverInstance.componentPropertyValues[enabled]).toBe(false);

    baseSurface.componentPropertyReferences = { visible: enabled };
    hoverSurface.componentPropertyReferences = { visible: enabled };
    const baseInstanceSurface = baseInstance.children[0]!;
    const hoverInstanceSurface = hoverInstance.children[0]!;
    baseInstance.setProperties({ [enabled]: true });
    expect(baseInstanceSurface.visible).toBe(true);
    expect(hoverInstanceSurface.visible).toBe(false);

    const renamed = set.editComponentProperty(enabled, { name: "Shown", defaultValue: true });
    expect(set.componentPropertyDefinitions).not.toHaveProperty(enabled);
    expect(base.componentPropertyDefinitions[renamed]).toEqual({ type: "BOOLEAN", defaultValue: true });
    expect(hover.componentPropertyDefinitions[renamed]).toEqual({ type: "BOOLEAN", defaultValue: true });
    expect(baseSurface.componentPropertyReferences).toEqual({ visible: renamed });
    expect(hoverInstanceSurface.componentPropertyReferences).toEqual({ visible: renamed });
    expect(baseInstance.componentPropertyValues[renamed]).toBe(true);
    expect(hoverInstance.componentPropertyValues[renamed]).toBe(true);

    const theme = set.addComponentProperty("Theme", "VARIANT", "Light");
    expect(theme).toBe("Theme");
    expect(set.componentPropertyDefinitions.Theme).toEqual({ type: "VARIANT", defaultValue: "Light", variantOptions: ["Light"] });
    expect(set.variantGroupProperties.Theme).toEqual({ values: ["Light"] });
    expect(base.name).toBe("State=Default, Theme=Light");
    expect(hover.name).toBe("State=Hover, Theme=Light");
    expect(base.componentPropertyDefinitions).not.toHaveProperty("Theme");
    expect(baseInstance.componentPropertyValues.Theme).toBe("Light");
    expect(hoverInstance.componentPropertyValues.Theme).toBe("Light");

    const mode = set.editComponentProperty("State", { name: "Mode" });
    expect(mode).toBe("Mode");
    expect(set.componentPropertyDefinitions).not.toHaveProperty("State");
    expect(set.componentPropertyDefinitions.Mode).toEqual({ type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] });
    expect(base.name).toBe("Mode=Default, Theme=Light");
    expect(hover.name).toBe("Mode=Hover, Theme=Light");
    expect(baseInstance.componentPropertyValues).toMatchObject({ Mode: "Default", Theme: "Light" });
    expect(hoverInstance.componentPropertyValues).toMatchObject({ Mode: "Hover", Theme: "Light" });

    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => base.addComponentProperty("Tone", "VARIANT", "Quiet")), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(captureError(() => set.addComponentProperty("Bad,Name", "VARIANT", "Quiet")), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => set.editComponentProperty("Mode", { defaultValue: "Hover" })), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(captureError(() => set.deleteComponentProperty("Mode")), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);

    set.deleteComponentProperty(renamed);
    expect(set.componentPropertyDefinitions).not.toHaveProperty(renamed);
    expect(base.componentPropertyDefinitions).not.toHaveProperty(renamed);
    expect(hover.componentPropertyDefinitions).not.toHaveProperty(renamed);
    expect(baseInstance.componentPropertyValues).not.toHaveProperty(renamed);
    expect(hoverInstance.componentPropertyValues).not.toHaveProperty(renamed);
    expect(baseSurface.componentPropertyReferences).toBeNull();
    expect(hoverInstanceSurface.componentPropertyReferences).toBeNull();

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: set.id, patch: { componentSetMetadata: expect.any(Object) } }),
      expect.objectContaining({ type: "update", nodeId: base.id, patch: { componentMetadata: expect.any(Object) } }),
      expect.objectContaining({ type: "update", nodeId: hover.id, patch: { componentMetadata: expect.any(Object) } }),
      expect.objectContaining({ type: "update", nodeId: baseInstance.id, patch: { instanceMetadata: expect.any(Object) } }),
      expect.objectContaining({ type: "update", nodeId: hoverInstance.id, patch: { instanceMetadata: expect.any(Object) } }),
    ]));
  });

  it("switches an Instance to the matching variant and preserves compatible values and overrides", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const base = session.createComponent();
    base.name = "State=Default, Size=Small";
    const baseSurface = session.createRectangle();
    baseSurface.name = "Surface";
    baseSurface.opacity = 1;
    base.appendChild(baseSurface);
    const hover = session.createComponent();
    hover.name = "State=Hover, Size=Large";
    const hoverSurface = session.createRectangle();
    hoverSurface.name = "Surface";
    hoverSurface.opacity = 0.8;
    hover.appendChild(hoverSurface);
    const set = session.combineAsVariants([base, hover], session.currentPage);
    const enabled = set.addComponentProperty("Enabled", "BOOLEAN", false);
    const instance = base.createInstance();
    const instanceId = instance.id;
    instance.x = 420;
    instance.y = 96;
    const oldSurface = instance.children[0]!;
    oldSurface.opacity = 0.35;
    session.enqueueUpdate(instance.id, {
      instanceMetadata: {
        ...(session.projectionStore.getNode(instance.id)!.instanceMetadata as Record<string, unknown>),
        overrides: [{ id: oldSurface.id, overriddenFields: ["opacity"] }],
      },
    });

    expect(instance.componentPropertyValues).toMatchObject({ State: "Default", Size: "Small", [enabled]: false });
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const beforeMissingCombination = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => instance.setProperties({ State: "Hover" })), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(beforeMissingCombination);
    instance.setProperties({ State: "Hover", Size: "Large", [enabled]: true });

    expect(instance.id).toBe(instanceId);
    expect(instance).toMatchObject({ x: 420, y: 96 });
    expect((await instance.getMainComponentAsync())?.id).toBe(hover.id);
    expect(instance.variantProperties).toEqual({ State: "Hover", Size: "Large" });
    expect(instance.componentPropertyValues).toMatchObject({ State: "Hover", Size: "Large", [enabled]: true });
    expect(instance.componentProperties).toMatchObject({
      State: { type: "VARIANT", value: "Hover" },
      Size: { type: "VARIANT", value: "Large" },
      [enabled]: { type: "BOOLEAN", value: true },
    });
    expect(oldSurface.removed).toBe(true);
    expect(instance.children).toHaveLength(1);
    expect(instance.children[0]).toMatchObject({ type: "RECTANGLE", name: "Surface", opacity: 0.35 });
    expect(instance.overrides).toEqual([{ id: instance.children[0]!.id, overriddenFields: ["opacity"] }]);

    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => instance.setProperties({ State: "Missing" })), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: instance.id, patch: expect.objectContaining({ instanceMetadata: expect.objectContaining({ mainComponentId: hover.id, componentProperties: expect.objectContaining({ State: "Hover", Size: "Large", [enabled]: true }) }) }) }),
      expect.objectContaining({ type: "remove", nodeId: oldSurface.id }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ parentId: instance.id, type: "RECTANGLE", opacity: 0.35 }) }),
    ]));
  });

  it("recomputes ComponentSet variant options when a variant Component is renamed", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const base = session.createComponent();
    base.name = "State=Default";
    const hover = session.createComponent();
    hover.name = "State=Hover";
    const set = session.combineAsVariants([base, hover], session.currentPage);
    const baseInstance = base.createInstance();
    const hoverInstance = hover.createInstance();

    hover.name = "State=Pressed";
    expect(set.variantGroupProperties).toEqual({ State: { values: ["Default", "Pressed"] } });
    expect(set.componentPropertyDefinitions.State).toEqual({ type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Pressed"] });
    expect(hover.variantProperties).toEqual({ State: "Pressed" });
    expect(baseInstance.componentPropertyValues.State).toBe("Default");
    expect(hoverInstance.componentPropertyValues.State).toBe("Pressed");

    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => { base.name = "State=Pressed"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "update",
        nodeId: set.id,
        patch: { componentSetMetadata: expect.objectContaining({ variantGroupProperties: { State: { values: ["Default", "Pressed"] } } }) },
      }),
      expect.objectContaining({ type: "update", nodeId: hover.id, patch: { name: "State=Pressed" } }),
      expect.objectContaining({ type: "update", nodeId: hoverInstance.id, patch: { instanceMetadata: expect.objectContaining({ componentProperties: expect.objectContaining({ State: "Pressed" }) }) } }),
    ]));
  });

  it("atomically replaces a Frame with a local Component and preserves its subtree", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const source = (await session.getNodeByIdAsync("frame")) as RuntimeContainerNodeProxy;
    source.x = 40;
    source.y = 24;
    const child = session.createRectangle();
    child.x = 56;
    child.y = 36;
    source.appendChild(child);

    const component = session.createComponentFromNode(source);
    const instance = component.createInstance();

    expect(source.removed).toBe(true);
    expect(component).toMatchObject({
      type: "COMPONENT",
      name: "Existing frame",
      x: 40,
      y: 24,
      key: component.id,
      remote: false,
    });
    expect(component.children).toEqual([child]);
    expect(child.parent).toBe(component);
    expect(child).toMatchObject({ x: 16, y: 12 });
    expect(await instance.getMainComponentAsync()).toBe(component);
    expect(session.currentPage.children.map((node) => node.id)).toEqual([component.id, instance.id]);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "componentFromNode",
        sourceId: "frame",
        replacement: expect.objectContaining({ id: component.id, type: "COMPONENT", name: "Existing frame" }),
        childIds: [child.id],
      }),
    ]));
    expect(await session.getNodeByIdAsync("frame")).toBeNull();
    expect((await session.getNodeByIdAsync(component.id))?.children).toEqual([child]);
  });

  it("rejects component conversion inside component ancestry without staging work", () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const component = session.createComponent();
    const nested = session.createFrame();
    component.appendChild(nested);
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operationCountBefore = session.projectionStore.transaction(transactionId)?.operations.length;

    expect(isRuntimeError(captureError(() => session.createComponentFromNode(nested)), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCountBefore!);

    const outer = session.createFrame();
    const nestedComponent = session.createComponent();
    outer.appendChild(nestedComponent);
    const operationCountBeforeNestedMain = session.projectionStore.transaction(transactionId)?.operations.length;
    expect(isRuntimeError(captureError(() => session.createComponentFromNode(outer)), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCountBeforeNestedMain!);
  });

  it("converts a newly created Group in the same transaction turn", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const group = session.createGroup();
    group.name = "Badge group";
    const ellipse = session.createEllipse();
    group.appendChild(ellipse);

    const component = session.createComponentFromNode(group);
    expect(group.removed).toBe(true);
    expect(component).toMatchObject({ type: "COMPONENT", name: "Badge group" });
    expect(component.children).toEqual([ellipse]);

    await session.commitAsync();
    expect(await session.getNodeByIdAsync(group.id)).toBeNull();
    expect((await session.getNodeByIdAsync(component.id))?.type).toBe("COMPONENT");
  });

  it("preserves a newly created child's world transform when appendChild is coalesced before Ack", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = session.createFrame();
    frame.x = 100;
    frame.y = 50;
    const child = session.createEllipse();
    child.x = 140;
    child.y = 80;

    frame.appendChild(child);

    expect(session.projectionStore.getNode(child.id)).toMatchObject({
      parentId: frame.id,
      x: 40,
      y: 30,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 30 },
    });
    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "update",
        nodeId: child.id,
        patch: expect.objectContaining({ parentId: frame.id, x: 40, y: 30, relativeTransform: expect.any(Object) }),
      }),
    ]));
  });

  it("creates parametric and SVG-path geometry with Figma stroke properties", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const polygon = session.createPolygon();
    const star = session.createStar();
    const vector = session.createVector();
    const openVector = session.createVector();
    const line = session.createLine();

    expect([polygon.type, star.type, vector.type]).toEqual(["POLYGON", "STAR", "VECTOR"]);
    expect(polygon.pointCount).toBe(5);
    polygon.pointCount = 8;
    star.pointCount = 7;
    star.innerRadius = .35;
    vector.vectorPaths = [{ windingRule: "EVENODD", data: "M 0 0 L 100 100 L 0 100 L 100 0 Z" }];
    vector.strokeWeight = 3;
    vector.strokeCap = "ROUND";
    vector.strokeJoin = "BEVEL";
    vector.strokeMiterLimit = 4;
    vector.dashPattern = [8, 4, 2];
    openVector.vectorPaths = [{ windingRule: "NONE", data: "M 0 0 C 20 0 40 40 80 40" }];
    line.strokeWeight = 5;
    line.strokeCap = "ARROW_LINES";
    line.dashPattern = [12, 6];
    expect(polygon.pointCount).toBe(8);
    expect(star.pointCount).toBe(7);
    expect(star.innerRadius).toBe(.35);
    expect(vector.vectorPaths[0]).toMatchObject({ windingRule: "EVENODD", data: expect.stringContaining("Z") });
    expect(vector.strokeWeight).toBe(3);
    expect(vector.strokeCap).toBe("ROUND");
    expect(vector.strokeJoin).toBe("BEVEL");
    expect(vector.strokeMiterLimit).toBe(4);
    expect(vector.dashPattern).toEqual([8, 4, 2, 8, 4, 2]);
    expect(openVector.vectorPaths[0]).toMatchObject({ windingRule: "NONE", data: expect.stringContaining("C") });
    expect(line.strokeCap).toBe("ARROW_LINES");
    expect(isRuntimeError(captureError(() => { polygon.pointCount = 2; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { star.innerRadius = 1; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => vector.pointCount), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => { line.dashPattern = [0, 0]; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { vector.vectorPaths = [{ windingRule: "NONZERO", data: "M 0 0 L" }]; }), "INVALID_ARGUMENT")).toBe(true);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "POLYGON", parametricShape: { kind: "polygon", pointCount: 5 } }) }),
      expect.objectContaining({ type: "update", nodeId: polygon.id, patch: { parametricShape: { kind: "polygon", pointCount: 8 } } }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "STAR", parametricShape: { kind: "star", pointCount: 5, innerRatio: .5 } }) }),
      expect.objectContaining({ type: "update", nodeId: star.id, patch: { parametricShape: { kind: "star", pointCount: 7, innerRatio: .35 } } }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "VECTOR", vectorPath: expect.objectContaining({ fillRule: "nonZero" }) }) }),
      expect.objectContaining({ type: "update", nodeId: vector.id, patch: expect.objectContaining({ vectorPath: expect.objectContaining({ fillRule: "evenOdd" }) }) }),
      expect.objectContaining({ type: "update", nodeId: vector.id, patch: { strokeDashPattern: [8, 4, 2, 8, 4, 2] } }),
      expect.objectContaining({ type: "update", nodeId: openVector.id, patch: expect.objectContaining({ vectorPath: expect.objectContaining({ subpaths: [expect.objectContaining({ closed: false })] }) }) }),
      expect.objectContaining({ type: "update", nodeId: line.id, patch: { strokeCapStart: "arrowLines", strokeCapEnd: "arrowLines" } }),
    ]));
  });

  it("creates and edits the bounded Connector, ShapeWithText, and TextPath Runtime subset", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const connector = session.createConnector();
    connector.connectorLineType = "ELBOWED";
    connector.connectorStart = { position: { x: 4, y: 8 } };
    connector.reconnect({ position: { x: 12, y: 18 } }, { endpointNodeId: "target", magnet: "AUTO" });
    connector.connectorStartStrokeCap = "CIRCLE_FILLED";
    connector.connectorEndStrokeCap = "TRIANGLE_FILLED";
    connector.connectorText = "Review";

    const shape = session.createShapeWithText();
    shape.shapeType = "DIAMOND";
    const textSublayer = shape.text;
    expect(shape.text).toBe(textSublayer);
    expect(textSublayer.lineHeight).toEqual({ value: 20, unit: "PIXELS" });
    expect(textSublayer.paragraphSpacing).toBe(0);
    textSublayer.fontSize = 17;
    textSublayer.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
    expect(textSublayer.fontSize).toBe(17);
    expect(textSublayer.fills).toEqual([{
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      visible: true,
      opacity: 1,
      blendMode: "NORMAL",
    }]);
    textSublayer.characters = "Approve";
    expect(textSublayer.getRangeFontSize(0, 7)).toBe(17);
    expect(textSublayer.getRangeFills(0, 7)).toEqual(textSublayer.fills);
    textSublayer.setRangeFontSize(0, 7, 18);
    textSublayer.setRangeLetterSpacing(0, 7, { value: 1.5, unit: "PIXELS" });
    textSublayer.setRangeFills(0, 4, [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5 }]);
    textSublayer.setRangeFills(4, 7, [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }]);

    const vector = session.createVector();
    vector.vectorPaths = [{ windingRule: "NONE", data: "M 0 60 C 40 0 120 0 160 60" }];
    const textPath = session.createTextPath(vector, 0, .25);
    textPath.characters = "Along the curve";
    textPath.textAlignHorizontal = "CENTER";
    textPath.textAlignVertical = "TOP";
    textPath.autoRename = false;

    expect(connector).toMatchObject({ type: "CONNECTOR", connectorLineType: "ELBOWED", connectorText: "Review" });
    expect(connector.connectorStart).toEqual({ position: { x: 12, y: 18 } });
    expect(connector.connectorEnd).toEqual({ endpointNodeId: "target", magnet: "AUTO" });
    connector.connectorStart = { endpointNodeId: "target", magnet: "CENTER" };
    connector.connectorEnd = { endpointNodeId: "target", magnet: "NONE" };
    expect(connector.connectorStart).toEqual({ endpointNodeId: "target", magnet: "CENTER" });
    expect(connector.connectorEnd).toEqual({ endpointNodeId: "target", magnet: "NONE" });
    expect(shape).toMatchObject({ type: "SHAPE_WITH_TEXT", shapeType: "DIAMOND", characters: "Approve" });
    expect(textSublayer).toMatchObject({ characters: "Approve", fontSize: 18, fontWeight: 400, letterSpacing: { value: 1.5, unit: "PIXELS" } });
    expect(textSublayer.fills).toBe(RUNTIME_MIXED);
    expect(textSublayer.getRangeFills(0, 4)).toEqual([{
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      visible: true,
      opacity: .5,
      blendMode: "NORMAL",
    }]);
    expect(textSublayer.getRangeFills(4, 7)).toEqual([{
      type: "SOLID",
      color: { r: 0, g: 0, b: 1 },
      visible: true,
      opacity: 1,
      blendMode: "NORMAL",
    }]);
    textSublayer.setRangeFills(0, 1, []);
    expect(textSublayer.getRangeFills(0, 1)).toEqual([]);
    textSublayer.setRangeFills(0, 1, [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5 }]);
    expect(textPath).toMatchObject({ type: "TEXT_PATH", characters: "Along the curve", textAlignHorizontal: "CENTER", textAlignVertical: "TOP", autoRename: false });
    expect(textPath.id).toBe(vector.id);
    expect(textPath.textPathStartData).toEqual({ segment: 0, position: .25 });
    expect(vector.removed).toBe(false);
    expect(isRuntimeError(captureError(() => session.createTextPath(shape, 0, 0)), "INVALID_ARGUMENT")).toBe(true);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "CONNECTOR" }) }),
      expect.objectContaining({ type: "update", nodeId: connector.id, patch: expect.objectContaining({ connectorMetadata: expect.objectContaining({ lineType: "ELBOWED", text: "Review" }) }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "SHAPE_WITH_TEXT", shapeWithTextType: "ROUNDED_RECTANGLE" }) }),
      expect.objectContaining({ type: "update", nodeId: shape.id, patch: { shapeWithTextType: "DIAMOND" } }),
      expect.objectContaining({
        type: "update",
        nodeId: shape.id,
        patch: expect.objectContaining({
          textProperties: expect.objectContaining({
            runs: expect.arrayContaining([
              expect.objectContaining({ fontSize: 18, letterSpacing: 1.5, fillStack: expect.objectContaining({ layers: [expect.objectContaining({ opacity: .5, paint: expect.objectContaining({ color: expect.objectContaining({ components: [1, 0, 0] }) }) })] }) }),
              expect.objectContaining({ fontSize: 18, letterSpacing: 1.5, fillStack: expect.objectContaining({ layers: [expect.objectContaining({ opacity: 1, paint: expect.objectContaining({ color: expect.objectContaining({ components: [0, 0, 1] }) }) })] }) }),
            ]),
          }),
        }),
      }),
      expect.objectContaining({
        type: "update",
        nodeId: vector.id,
        convertToTextPath: true,
        patch: expect.objectContaining({
          type: "TEXT_PATH",
          textPathMetadata: expect.objectContaining({ startPosition: .25 }),
        }),
      }),
    ]));
    expect((await session.getNodeByIdAsync(textPath.id))?.type).toBe("TEXT_PATH");
    shape.remove();
    expect(isRuntimeError(captureError(() => textSublayer.characters), "NODE_REMOVED")).toBe(true);
  });

  it("forwards ShapeWithText AFTER insertion to the following style run", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "shape-after",
          type: "SHAPE_WITH_TEXT",
          name: "Decision",
          parentId: "page",
          characters: "AB",
          textProperties: {
            runs: [
              { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, color: { space: "srgb", components: [1, 0, 0], alpha: 1 } },
              { start: 1, end: 2, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1, color: { space: "srgb", components: [0, 0, 1], alpha: .6 } },
            ],
            paragraph: { alignment: "center", lineHeight: 20, paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "shape-after", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const shape = (await session.getNodeByIdAsync("shape-after"))!;

    shape.text.insertCharacters(1, "x", "AFTER");

    expect(shape.text.characters).toBe("AxB");
    expect(shape.text.getRangeFontSize(1, 2)).toBe(20);
    expect(shape.text.getRangeFills(1, 2)).toEqual([{
      type: "SOLID",
      color: { r: 0, g: 0, b: 1 },
      visible: true,
      opacity: .6,
      blendMode: "NORMAL",
    }]);
    expect((session.projectionStore.getNode("shape-after")?.textProperties as { runs: Array<{ start: number; end: number; fontSize: number }> }).runs).toEqual([
      expect.objectContaining({ start: 0, end: 1, fontSize: 12 }),
      expect.objectContaining({ start: 1, end: 3, fontSize: 20 }),
    ]);
  });

  it("reads and writes ShapeWithText global paragraph spacing through the text sublayer", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "shape-paragraph",
          type: "SHAPE_WITH_TEXT",
          name: "Paragraph shape",
          parentId: "page",
          characters: "First\nSecond",
          textProperties: {
            runs: [
              { start: 0, end: 12, fontSize: 18, fontWeight: 500, italic: false, letterSpacing: 1 },
            ],
            paragraph: { alignment: "center", lineHeight: 24, paragraphSpacing: 6 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "shape-paragraph", projection, transport, scheduleMicrotask: () => {} });
    const shape = (await session.getNodeByIdAsync("shape-paragraph"))!;

    expect(shape.text.lineHeight).toEqual({ value: 24, unit: "PIXELS" });
    expect(shape.text.paragraphSpacing).toBe(6);
    expect(shape.text.paragraphIndent).toBe(0);
    expect(shape.text.textWrapStyle).toBe("AUTO");
    expect(shape.text.getRangeLineHeight(0, 1)).toEqual({ value: 24, unit: "PIXELS" });
    expect(shape.text.getRangeParagraphSpacing(6, 12)).toBe(6);
    expect(shape.text.getRangeParagraphIndent(6, 12)).toBe(0);
    expect(shape.text.getRangeTextWrapStyle(6, 12)).toBe("AUTO");
    expect(shape.text.getRangeListOptions(6, 12)).toEqual({ type: "NONE" });
    expect(shape.text.getRangeListSpacing(6, 12)).toBe(0);

    shape.text.setRangeLineHeight(0, shape.text.characters.length, { value: 32, unit: "PIXELS" });
    shape.text.setRangeParagraphSpacing(0, shape.text.characters.length, 11);
    shape.text.setRangeParagraphIndent(0, shape.text.characters.length, 12);
    shape.text.setRangeTextWrapStyle(0, shape.text.characters.length, "BALANCE");
    shape.text.setRangeListOptions(0, shape.text.characters.length, { type: "ORDERED" });
    shape.text.setRangeListSpacing(0, shape.text.characters.length, 8);

    expect(shape.text.lineHeight).toEqual({ value: 32, unit: "PIXELS" });
    expect(shape.text.paragraphSpacing).toBe(11);
    expect(shape.text.paragraphIndent).toBe(12);
    expect(shape.text.textWrapStyle).toBe("BALANCE");
    expect(shape.text.listSpacing).toBe(8);
    expect(shape.text.hangingPunctuation).toBe(false);
    shape.text.hangingPunctuation = true;
    expect(session.projectionStore.getNode("shape-paragraph")?.textProperties).toMatchObject({
      runs: [expect.objectContaining({ start: 0, end: 12, fontSize: 18, fontWeight: 500, letterSpacing: 1 })],
      paragraph: { alignment: "center", lineHeight: 32, paragraphSpacing: 11, paragraphIndent: 12, textWrapStyle: "balance", listType: "ordered", listSpacing: 8, hangingPunctuation: true },
      autoSize: "fixed",
    });

    shape.text.lineHeight = { value: 140, unit: "PERCENT" };
    expect(shape.text.lineHeight).toEqual({ value: 140, unit: "PERCENT" });
    expect(projectedParagraph(session.projectionStore.getNode("shape-paragraph"))).toMatchObject({
      lineHeight: 140,
      lineHeightUnit: "percent",
    });
    shape.text.lineHeight = { unit: "AUTO" };
    expect(shape.text.lineHeight).toEqual({ unit: "AUTO" });
    expect(projectedParagraph(session.projectionStore.getNode("shape-paragraph"))).toMatchObject({
      lineHeight: undefined,
      lineHeightUnit: "auto",
    });
    shape.text.lineHeight = { value: 140, unit: "PERCENT" };

    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    shape.text.setRangeLineHeight(6, 12, { value: 28, unit: "PIXELS" });
    expect(shape.text.getRangeLineHeight(0, 5)).toEqual({ value: 140, unit: "PERCENT" });
    expect(shape.text.getRangeLineHeight(6, 12)).toEqual({ value: 28, unit: "PIXELS" });
    expect(shape.text.lineHeight).toBe(RUNTIME_MIXED);
    shape.text.setRangeParagraphSpacing(6, 12, 4);
    expect(shape.text.getRangeParagraphSpacing(0, 5)).toBe(11);
    expect(shape.text.getRangeParagraphSpacing(6, 12)).toBe(4);
    expect(shape.text.getRangeParagraphSpacing(0, 12)).toBe(RUNTIME_MIXED);
    expect(shape.text.paragraphSpacing).toBe(RUNTIME_MIXED);
    shape.text.setRangeParagraphIndent(6, 12, 4);
    expect(shape.text.getRangeParagraphIndent(0, 5)).toBe(12);
    expect(shape.text.getRangeParagraphIndent(6, 12)).toBe(4);
    expect(shape.text.getRangeParagraphIndent(0, 12)).toBe(RUNTIME_MIXED);
    expect(shape.text.paragraphIndent).toBe(RUNTIME_MIXED);
    shape.text.setRangeTextWrapStyle(6, 12, "PRETTY");
    expect(shape.text.getRangeTextWrapStyle(0, 5)).toBe("BALANCE");
    expect(shape.text.getRangeTextWrapStyle(6, 12)).toBe("PRETTY");
    expect(shape.text.getRangeTextWrapStyle(0, 12)).toBe(RUNTIME_MIXED);
    expect(shape.text.textWrapStyle).toBe(RUNTIME_MIXED);
    shape.text.setRangeListOptions(6, 12, { type: "UNORDERED" });
    expect(shape.text.getRangeListOptions(0, 5)).toEqual({ type: "ORDERED" });
    expect(shape.text.getRangeListOptions(6, 12)).toEqual({ type: "UNORDERED" });
    expect(shape.text.getRangeListOptions(0, 12)).toBe(RUNTIME_MIXED);
    expect(session.projectionStore.getNode("shape-paragraph")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 6, listType: "unordered", paragraphSpacing: 4, paragraphIndent: 4, lineHeight: 28, textWrapStyle: "pretty" },
    ]);
    shape.text.setRangeListSpacing(6, 12, 4);
    expect(shape.text.getRangeListSpacing(0, 5)).toBe(8);
    expect(shape.text.getRangeListSpacing(6, 12)).toBe(4);
    expect(shape.text.getRangeListSpacing(0, 12)).toBe(RUNTIME_MIXED);
    expect(shape.text.listSpacing).toBe(RUNTIME_MIXED);
    expect(session.projectionStore.getNode("shape-paragraph")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 6, listType: "unordered", listSpacing: 4, paragraphSpacing: 4, paragraphIndent: 4, lineHeight: 28, textWrapStyle: "pretty" },
    ]);
    const operationCount = session.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(captureError(() => { shape.text.lineHeight = { value: 0, unit: "PIXELS" }; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.lineHeight = { value: 0, unit: "PERCENT" }; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.paragraphSpacing = Number.NaN; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.paragraphSpacing = -1; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.setRangeParagraphSpacing(0, shape.text.characters.length, -1); }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.paragraphIndent = -1; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.setRangeParagraphIndent(0, shape.text.characters.length, Number.NaN); }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { (shape.text as unknown as { textWrapStyle: string }).textWrapStyle = "STABLE"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.setRangeListOptions(0, shape.text.characters.length, { type: "BULLET" } as never); }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.listSpacing = -1; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { (shape.text as unknown as { hangingPunctuation: string }).hangingPunctuation = "yes"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { shape.text.setRangeListSpacing(0, shape.text.characters.length, Number.NaN); }), "INVALID_ARGUMENT")).toBe(true);
    expect(session.projectionStore.transaction(transactionId)!.operations).toHaveLength(operationCount);

    await session.commitAsync();
    expect(shape.text.lineHeight).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeLineHeight(6, 12)).toEqual({ value: 28, unit: "PIXELS" });
    expect(shape.text.paragraphSpacing).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeParagraphSpacing(0, 5)).toBe(11);
    expect(shape.text.getRangeParagraphSpacing(6, 12)).toBe(4);
    expect(shape.text.paragraphIndent).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeParagraphIndent(0, 5)).toBe(12);
    expect(shape.text.getRangeParagraphIndent(6, 12)).toBe(4);
    expect(shape.text.textWrapStyle).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeTextWrapStyle(0, 5)).toBe("BALANCE");
    expect(shape.text.getRangeTextWrapStyle(6, 12)).toBe("PRETTY");
    expect(shape.text.getRangeListOptions(0, shape.text.characters.length)).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeListOptions(6, 12)).toEqual({ type: "UNORDERED" });
    expect(shape.text.getRangeListSpacing(0, shape.text.characters.length)).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeListSpacing(6, 12)).toBe(4);
    expect(projectedParagraph(transport.currentProjection().nodes.find((node) => node.id === "shape-paragraph"))).toMatchObject({
      lineHeight: 140,
      lineHeightUnit: "percent",
      paragraphSpacing: 11,
      paragraphIndent: 12,
      textWrapStyle: "balance",
      listType: "ordered",
      listSpacing: 8,
    });
    expect(transport.currentProjection().nodes.find((node) => node.id === "shape-paragraph")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 6, listType: "unordered", listSpacing: 4, paragraphSpacing: 4, paragraphIndent: 4, lineHeight: 28, textWrapStyle: "pretty" },
    ]);
    expect(transport.submitted[0]?.operations.every((operation) => (
      operation.type === "update"
      && operation.nodeId === "shape-paragraph"
      && Object.keys(operation.patch).length === 1
      && Object.prototype.hasOwnProperty.call(operation.patch, "textProperties")
    ))).toBe(true);
  });

  it("admits a partial paragraph-property range when ShapeWithText has one paragraph", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "shape-single-paragraph",
          type: "SHAPE_WITH_TEXT",
          name: "Single paragraph",
          parentId: "page",
          characters: "Only one",
          textProperties: {
            runs: [{ start: 0, end: 8, fontSize: 18, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "center", lineHeight: 20, paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "shape-single-paragraph", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const shape = (await session.getNodeByIdAsync("shape-single-paragraph"))!;

    shape.text.setRangeLineHeight(2, 3, { value: 28, unit: "PIXELS" });
    shape.text.setRangeParagraphSpacing(4, 7, 9);
    shape.text.setRangeTextWrapStyle(1, 2, "PRETTY");
    shape.text.setRangeListOptions(2, 5, { type: "UNORDERED" });
    shape.text.setRangeListSpacing(3, 6, 5);

    expect(shape.text.getRangeLineHeight(0, 1)).toEqual({ value: 28, unit: "PIXELS" });
    expect(shape.text.getRangeParagraphSpacing(7, 8)).toBe(9);
    expect(shape.text.getRangeTextWrapStyle(7, 8)).toBe("PRETTY");
    expect(shape.text.getRangeListOptions(0, 8)).toEqual({ type: "UNORDERED" });
    expect(shape.text.getRangeListSpacing(0, 8)).toBe(5);
    shape.text.textWrapStyle = "AUTO";
    expect(projectedParagraph(session.projectionStore.getNode("shape-single-paragraph"))?.textWrapStyle).toBeUndefined();
  });

  it("reads and writes Text list options through the official range API", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text-list", type: "TEXT", name: "List", parentId: "page", characters: "One\nTwo",
          textProperties: {
            runs: [{ start: 0, end: 7, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "left", paragraphSpacing: 0 }, autoSize: "fixed",
          },
        },
        {
          id: "text-list-single", type: "TEXT", name: "Single list", parentId: "page", characters: "Only one",
          textProperties: {
            runs: [{ start: 0, end: 8, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "left", paragraphSpacing: 0 }, autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "text-list", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text-list"))!;
    const single = (await session.getNodeByIdAsync("text-list-single"))!;

    expect(text.getRangeListOptions(0, 3)).toEqual({ type: "NONE" });
    expect(text.textWrapStyle).toBe("AUTO");
    text.textWrapStyle = "BALANCE";
    text.setRangeTextWrapStyle(4, 7, "AUTO");
    expect(text.getRangeTextWrapStyle(0, 3)).toBe("BALANCE");
    expect(text.getRangeTextWrapStyle(4, 7)).toBe("AUTO");
    expect(text.textWrapStyle).toBe(RUNTIME_MIXED);
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, textWrapStyle: "auto" },
    ]);
    text.textWrapStyle = "PRETTY";
    expect(text.textWrapStyle).toBe("PRETTY");
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toBeUndefined();
    expect(text.lineHeight).toEqual({ value: 20, unit: "PIXELS" });
    text.setRangeLineHeight(4, 7, { value: 150, unit: "PERCENT" });
    expect(text.getRangeLineHeight(0, 3)).toEqual({ value: 20, unit: "PIXELS" });
    expect(text.getRangeLineHeight(4, 7)).toEqual({ value: 150, unit: "PERCENT" });
    expect(text.lineHeight).toBe(RUNTIME_MIXED);
    text.lineHeight = { value: 20, unit: "PIXELS" };
    expect(text.lineHeight).toEqual({ value: 20, unit: "PIXELS" });
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toBeUndefined();
    expect(text.paragraphSpacing).toBe(0);
    expect(text.listSpacing).toBe(0);
    expect(text.hangingList).toBe(false);
    expect(text.hangingPunctuation).toBe(false);
    text.setRangeListOptions(0, text.characters.length, { type: "ORDERED" });
    text.setRangeListSpacing(0, text.characters.length, 8);
    text.hangingList = true;
    text.hangingPunctuation = true;
    expect(text.getRangeIndentation(0, text.characters.length)).toBe(1);
    text.setRangeIndentation(4, 7, 2);
    expect(text.getRangeIndentation(0, 3)).toBe(1);
    expect(text.getRangeIndentation(4, 7)).toBe(2);
    expect(text.getRangeIndentation(0, 7)).toBe(RUNTIME_MIXED);
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, indentation: 2 },
    ]);
    expect(text.getRangeListOptions(4, 7)).toEqual({ type: "ORDERED" });
    expect(text.getRangeListSpacing(4, 7)).toBe(8);
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.listType).toBe("ordered");
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.listSpacing).toBe(8);
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.hangingList).toBe(true);
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.hangingPunctuation).toBe(true);
    text.setRangeListOptions(4, 7, { type: "UNORDERED" });
    expect(text.getRangeListOptions(0, 3)).toEqual({ type: "ORDERED" });
    expect(text.getRangeListOptions(4, 7)).toEqual({ type: "UNORDERED" });
    expect(text.getRangeListOptions(0, 7)).toBe(RUNTIME_MIXED);
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, indentation: 2, listType: "unordered" },
    ]);
    text.setRangeListSpacing(4, 7, 4);
    text.setRangeParagraphSpacing(4, 7, 6);
    text.setRangeParagraphIndent(4, 7, 10);
    expect(text.getRangeParagraphSpacing(0, 3)).toBe(0);
    expect(text.getRangeParagraphSpacing(4, 7)).toBe(6);
    expect(text.getRangeParagraphSpacing(0, 7)).toBe(RUNTIME_MIXED);
    expect(text.paragraphSpacing).toBe(RUNTIME_MIXED);
    expect(text.getRangeParagraphIndent(0, 3)).toBe(0);
    expect(text.getRangeParagraphIndent(4, 7)).toBe(10);
    expect(text.paragraphIndent).toBe(RUNTIME_MIXED);
    expect(text.getRangeListSpacing(0, 3)).toBe(8);
    expect(text.getRangeListSpacing(4, 7)).toBe(4);
    expect(text.getRangeListSpacing(0, 7)).toBe(RUNTIME_MIXED);
    expect(text.listSpacing).toBe(RUNTIME_MIXED);
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, indentation: 2, listType: "unordered", listSpacing: 4, paragraphSpacing: 6, paragraphIndent: 10 },
    ]);
    expect(isRuntimeError(captureError(() => text.setRangeListOptions(0, 7, { type: "BULLET" } as never)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { text.listSpacing = -1; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { (text as unknown as { hangingList: string }).hangingList = "yes"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { (text as unknown as { hangingPunctuation: string }).hangingPunctuation = "yes"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeListSpacing(0, 7, Number.NaN)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeIndentation(0, 3, 1.5)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeIndentation(0, 3, 101)), "INVALID_ARGUMENT")).toBe(true);

    text.setRangeIndentation(4, 7, 1);
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, listType: "unordered", listSpacing: 4, paragraphSpacing: 6, paragraphIndent: 10 },
    ]);
    text.setRangeListOptions(4, 7, { type: "ORDERED" });
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, listSpacing: 4, paragraphSpacing: 6, paragraphIndent: 10 },
    ]);

    text.listSpacing = 0;
    expect(text.listSpacing).toBe(0);
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.listSpacing).toBeUndefined();
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, paragraphSpacing: 6, paragraphIndent: 10 },
    ]);
    text.paragraphSpacing = 2;
    expect(text.paragraphSpacing).toBe(2);
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.paragraphSpacing).toBe(2);
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 4, paragraphIndent: 10 },
    ]);
    text.paragraphIndent = 2;
    expect(text.paragraphIndent).toBe(2);
    expect(session.projectionStore.getNode("text-list")?.textProperties?.paragraphStyleRuns).toBeUndefined();
    text.hangingList = false;
    expect(text.hangingList).toBe(false);
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.hangingList).toBeUndefined();
    text.hangingPunctuation = false;
    expect(text.hangingPunctuation).toBe(false);
    expect(projectedParagraph(session.projectionStore.getNode("text-list"))?.hangingPunctuation).toBeUndefined();

    single.setRangeIndentation(2, 4, 1);
    expect(session.projectionStore.getNode("text-list-single")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 0, indentation: 1 },
    ]);
    single.setRangeListOptions(2, 4, { type: "UNORDERED" });
    expect(session.projectionStore.getNode("text-list-single")?.textProperties?.paragraphStyleRuns).toBeUndefined();
    single.setRangeListSpacing(2, 4, 6);
    single.setRangeIndentation(2, 4, 3);
    expect(single.getRangeListOptions(0, 8)).toEqual({ type: "UNORDERED" });
    expect(single.getRangeListSpacing(0, 8)).toBe(6);
    expect(single.getRangeIndentation(0, 8)).toBe(3);
    single.setRangeListOptions(0, 8, { type: "NONE" });
    expect(projectedParagraph(session.projectionStore.getNode("text-list-single"))?.listType).toBeUndefined();
    expect(session.projectionStore.getNode("text-list-single")?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 0, indentation: 3 },
    ]);
    single.setRangeIndentation(0, 8, 0);
    expect(session.projectionStore.getNode("text-list-single")?.textProperties?.paragraphStyleRuns).toBeUndefined();
  });

  it("projects styled text segments from character and paragraph runs for Text and ShapeWithText", async () => {
    const textProperties = {
      runs: [
        { start: 0, end: 6, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0, openTypeFeatures: { LIGA: true }, textStyleId: "S:body" },
        { start: 6, end: 8, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 1, openTypeFeatures: { LIGA: false }, textStyleId: "S:caption" },
      ],
      paragraph: { alignment: "left" as const, paragraphSpacing: 3, textWrapStyle: "balance" as const, listType: "ordered" as const },
      paragraphStyleRuns: [{ start: 6, paragraphSpacing: 9, textWrapStyle: "auto" as const, listType: "none" as const }],
      autoSize: "fixed" as const,
    };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        { id: "styled-text", type: "TEXT", name: "Text", parentId: "page", characters: "A😀\nBC", fill: "#000000", textProperties },
        { id: "styled-shape", type: "SHAPE_WITH_TEXT", name: "Shape", parentId: "page", characters: "A😀\nBC", textProperties },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "styled-segments", projection, transport, scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("styled-text"))!;
    const shape = (await session.getNodeByIdAsync("styled-shape"))!;
    const fields = ["fontSize", "fontWeight", "fontStyle", "paragraphSpacing", "textWrapStyle", "listOptions"] as const;
    const expected = [
      { characters: "A😀\n", start: 0, end: 4, fontSize: 12, fontWeight: 400, fontStyle: "REGULAR", paragraphSpacing: 3, textWrapStyle: "BALANCE", listOptions: { type: "ORDERED" } },
      { characters: "BC", start: 4, end: 6, fontSize: 20, fontWeight: 700, fontStyle: "ITALIC", paragraphSpacing: 9, textWrapStyle: "AUTO", listOptions: { type: "NONE" } },
    ];

    expect(text.getStyledTextSegments(fields)).toEqual(expected);
    expect(shape.text.getStyledTextSegments(fields)).toEqual(expected);
    expect(text.fontSize).toBe(RUNTIME_MIXED);
    expect(text.fontWeight).toBe(RUNTIME_MIXED);
    expect(text.getRangeFontSize(0, 1)).toBe(12);
    expect(text.getRangeFontWeight(4, 6)).toBe(700);
    expect(text.openTypeFeatures).toBe(RUNTIME_MIXED);
    expect(text.getRangeOpenTypeFeatures(1, 3)).toEqual({ LIGA: true });
    expect(text.textStyleId).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextStyleId(0, 4)).toBe("S:body");
    expect(shape.text.getRangeFontWeight(0, 4)).toBe(400);
    expect(shape.text.openTypeFeatures).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeOpenTypeFeatures(4, 6)).toEqual({ LIGA: false });
    expect(shape.text.textStyleId).toBe(RUNTIME_MIXED);
    expect(shape.text.getRangeTextStyleId(4, 6)).toBe("S:caption");

    text.setRangeFontSize(4, 6, 24);
    text.setRangeParagraphSpacing(4, 6, 7);
    shape.text.setRangeFontSize(4, 6, 24);
    shape.text.setRangeParagraphSpacing(4, 6, 7);
    expect(text.getStyledTextSegments(fields, 4, 6)).toEqual([
      { ...expected[1], characters: "BC", start: 4, end: 6, fontSize: 24, paragraphSpacing: 7 },
    ]);
    expect(shape.text.getStyledTextSegments(fields, 4, 6)).toEqual(text.getStyledTextSegments(fields, 4, 6));
    expect(session.projectionStore.pendingTransactionIds()).toHaveLength(1);

    await session.commitAsync();
    expect(text.getStyledTextSegments(fields, 4, 6)).toEqual(shape.text.getStyledTextSegments(fields, 4, 6));
    expect(transport.submitted).toHaveLength(1);

    text.fontSize = 18;
    shape.text.fontSize = 18;
    expect(text.fontSize).toBe(18);
    expect(shape.text.fontSize).toBe(18);
    expect(isRuntimeError(captureError(() => { text.fontSize = 0; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { text.fontSize = RUNTIME_MIXED; }), "INVALID_ARGUMENT")).toBe(true);
  });

  it("reads and writes the lossless solid subset of Text range fills", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text-fills",
          type: "TEXT",
          name: "Colored text",
          parentId: "page",
          characters: "AB",
          fill: "#ff0000",
          textProperties: {
            runs: [
              { start: 0, end: 1, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
              { start: 1, end: 2, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, color: { space: "srgb", components: [0, 0, 1], alpha: 1 } },
            ],
            paragraph: { alignment: "left", lineHeight: 20, paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "text-range-fills", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text-fills"))!;

    expect(text.getRangeFills(0, 1)).toEqual([{
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      visible: true,
      opacity: 1,
      blendMode: "NORMAL",
    }]);
    expect(text.getRangeFills(0, 2)).toBe(RUNTIME_MIXED);
    text.setRangeFills(0, 1, [{ type: "SOLID", color: { r: 0, g: 1, b: 0 }, opacity: .25 }]);
    expect(text.getRangeFills(0, 1)).toEqual([{
      type: "SOLID",
      color: { r: 0, g: 1, b: 0 },
      visible: true,
      opacity: .25,
      blendMode: "NORMAL",
    }]);
    text.setRangeFills(0, 1, []);
    expect(text.getRangeFills(0, 1)).toEqual([]);
  });

  it("creates bounded linear and radial Repeat TransformGroups with stable pending structure", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const first = session.createRectangle();
    first.x = 40;
    first.y = 30;
    const second = session.createEllipse();
    second.x = 180;
    second.y = 50;
    const modifier = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 2, unitType: "PIXELS" as const, offset: 260, axis: "HORIZONTAL" as const }];
    const group = session.transformGroup([first, second], session.currentPage, 0, modifier);
    group.name = "Repeated pair";

    expect(group).toMatchObject({ type: "TRANSFORM_GROUP", name: "Repeated pair", transformModifiers: modifier });
    expect(group.children.map((child) => child.id)).toEqual([first.id, second.id]);
    expect(first.parent?.id).toBe(group.id);
    expect(second.parent?.id).toBe(group.id);
    group.transformModifiers = [{ type: "REPEAT", repeatType: "RADIAL", count: 2, unitType: "PIXELS", offset: 120 }];
    expect(group.transformModifiers).toEqual([{ type: "REPEAT", repeatType: "RADIAL", count: 2, unitType: "PIXELS", offset: 120 }]);
    group.transformModifiers = [
      { type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 120, axis: "HORIZONTAL" },
      { type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 80, axis: "VERTICAL" },
    ];
    expect(group.transformModifiers).toHaveLength(2);
    expect(isRuntimeError(captureError(() => {
      group.transformModifiers = [{ type: "REPEAT", repeatType: "RADIAL", count: 0, unitType: "PIXELS", offset: 10 }];
    }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => {
      group.transformModifiers = [
        { type: "REPEAT", repeatType: "LINEAR", count: 7, unitType: "PIXELS", offset: 10, axis: "HORIZONTAL" },
        { type: "REPEAT", repeatType: "LINEAR", count: 8, unitType: "PIXELS", offset: 10, axis: "VERTICAL" },
      ];
    }), "INVALID_ARGUMENT")).toBe(true);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "RECTANGLE" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ type: "ELLIPSE" }) }),
      expect.objectContaining({
        type: "transformGroup",
        node: expect.objectContaining({ id: group.id, type: "TRANSFORM_GROUP", siblingIndex: 0 }),
        childIds: [first.id, second.id],
        modifiers: modifier,
      }),
      expect.objectContaining({ type: "update", nodeId: group.id, patch: { name: "Repeated pair" } }),
      expect.objectContaining({ type: "update", nodeId: group.id, patch: { transformModifiers: expect.any(Array) } }),
    ]));
  });

  it("creates a bounded stacked Repeat without requiring a later modifier update", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const source = session.createRectangle();
    const modifiers = [
      { type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 120, axis: "HORIZONTAL" as const },
      { type: "REPEAT" as const, repeatType: "RADIAL" as const, count: 1, unitType: "PIXELS" as const, offset: 80 },
    ];
    const group = session.transformGroup([source], session.currentPage, 0, modifiers);
    await session.commitAsync();
    expect(group.transformModifiers).toEqual(modifiers);
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "transformGroup", childIds: [source.id], modifiers }),
    ]));
  });

  it("shares one derived-instance budget across nested Repeat writes", () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const repeat = (count: number, axis: "HORIZONTAL" | "VERTICAL") => [{
      type: "REPEAT" as const,
      repeatType: "LINEAR" as const,
      count,
      unitType: "PIXELS" as const,
      offset: 40,
      axis,
    }];
    const leaf = session.createRectangle();
    const inner = session.transformGroup([leaf], session.currentPage, 0, repeat(7, "VERTICAL"));
    const outer = session.transformGroup([inner], session.currentPage, 0, repeat(7, "HORIZONTAL"));
    expect(outer.children[0]?.id).toBe(inner.id);

    expect(isRuntimeError(captureError(() => {
      outer.transformModifiers = repeat(8, "HORIZONTAL");
    }), "INVALID_ARGUMENT")).toBe(true);

    const secondLeaf = session.createEllipse();
    const secondInner = session.transformGroup([secondLeaf], session.currentPage, 1, repeat(7, "VERTICAL"));
    expect(isRuntimeError(captureError(() => {
      session.transformGroup([secondInner], session.currentPage, 1, repeat(8, "HORIZONTAL"));
    }), "INVALID_ARGUMENT")).toBe(true);

    const thirdLeaf = session.createRectangle();
    const thirdInner = session.transformGroup([thirdLeaf], session.currentPage, 2, repeat(8, "VERTICAL"));
    expect(isRuntimeError(captureError(() => {
      session.reparent(thirdInner.id, outer.id, 1);
    }), "INVALID_ARGUMENT")).toBe(true);
  });

  it("reads asymmetric endpoint caps as mixed and replaces both with a concrete strokeCap", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        {
          id: "line",
          type: "LINE",
          name: "Asymmetric line",
          parentId: "page",
          siblingIndex: 0,
          strokeCapStart: "round",
          strokeCapEnd: "arrowEquilateral",
        },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "asymmetric-cap", projection, transport, scheduleMicrotask: () => {} });
    const line = (await session.getNodeByIdAsync("line"))!;

    expect(line.strokeCap).toBe(RUNTIME_MIXED);
    line.strokeCap = "SQUARE";
    expect(line.strokeCap).toBe("SQUARE");
    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toContainEqual({
      type: "update",
      nodeId: "line",
      patch: { strokeCapStart: "square", strokeCapEnd: "square" },
    });
    expect(line.strokeCap).toBe("SQUARE");
  });

  it("round-trips independent and bounded branched VectorNetworks", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const vector = session.createVector();
    await session.commitAsync();

    const network = vector.vectorNetwork;
    expect(network.vertices).toHaveLength(3);
    expect(network.segments).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }]);
    expect(network.regions).toEqual([{ windingRule: "NONZERO", loops: [[0, 1, 2]] }]);

    await vector.setVectorNetworkAsync({
      vertices: [
        { x: 0, y: 0, strokeCap: "ROUND", handleMirroring: "ANGLE" },
        { x: 80, y: 40, strokeCap: "ARROW_EQUILATERAL", handleMirroring: "NONE" },
      ],
      segments: [{ start: 0, end: 1, tangentStart: { x: 20, y: 0 }, tangentEnd: { x: -20, y: 0 } }],
    });

    expect(vector.vectorPaths[0]).toMatchObject({ windingRule: "NONE", data: expect.stringContaining("C") });
    expect(vector.strokeCap).toBe(RUNTIME_MIXED);
    expect(vector.vectorNetwork.vertices).toEqual([
      { x: 0, y: 0, strokeCap: "ROUND", handleMirroring: "ANGLE" },
      { x: 80, y: 40, strokeCap: "ARROW_EQUILATERAL", handleMirroring: "NONE" },
    ]);
    expect(transport.submitted[1]?.operations).toContainEqual({
      type: "update",
      nodeId: vector.id,
      patch: expect.objectContaining({
        strokeCapStart: "round",
        strokeCapEnd: "arrowEquilateral",
        vectorPath: expect.objectContaining({ subpaths: [expect.objectContaining({ closed: false })] }),
      }),
    });
    vector.strokeCap = "NONE";
    const branch = {
      vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      segments: [{ start: 0, end: 1 }, { start: 0, end: 2 }],
    } as const;
    await vector.setVectorNetworkAsync(branch);
    expect(vector.vectorNetwork).toEqual(branch);
    expect(transport.submitted[2]?.operations).toContainEqual({
      type: "update",
      nodeId: vector.id,
      patch: expect.objectContaining({
        strokeCapStart: "none",
        strokeCapEnd: "none",
        vectorPath: expect.objectContaining({ subpaths: [expect.objectContaining({ closed: false }), expect.objectContaining({ closed: false })] }),
        extensions: expect.objectContaining({ "figma.runtime.vector-network.v1": expect.any(Array) }),
      }),
    });
  });

  it("exposes Highlight through the complete VectorLike Runtime surface", async () => {
    const source = createNode("highlight", 0, 0);
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [
        ...initial.nodes,
        { ...source, id: "highlight", type: "HIGHLIGHT", name: "Marker", parentId: "page", siblingIndex: 1, highlightHandleMirroring: "ANGLE" },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "highlight-vector", projection, transport, scheduleMicrotask: () => {} });
    const highlight = (await session.getNodeByIdAsync("highlight"))!;

    expect(highlight.vectorPaths).toHaveLength(1);
    expect(highlight.vectorNetwork.vertices.length).toBeGreaterThan(0);
    expect(highlight.handleMirroring).toBe("ANGLE");

    highlight.handleMirroring = "ANGLE_AND_LENGTH";
    expect(highlight.handleMirroring).toBe("ANGLE_AND_LENGTH");
    expect(highlight.vectorNetwork.vertices.every((vertex) => vertex.handleMirroring === "ANGLE_AND_LENGTH")).toBe(true);

    await highlight.setVectorNetworkAsync({
      vertices: [
        { x: 0, y: 0, handleMirroring: "ANGLE" },
        { x: 40, y: 20, handleMirroring: "NONE" },
      ],
      segments: [{ start: 0, end: 1, tangentStart: { x: 10, y: 0 }, tangentEnd: { x: -10, y: 0 } }],
    });
    expect(highlight.handleMirroring).toBe(RUNTIME_MIXED);
    expect(highlight.vectorPaths[0]).toMatchObject({ windingRule: "NONE", data: expect.stringContaining("C") });
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: "highlight", patch: expect.objectContaining({ highlightHandleMirroring: "ANGLE_AND_LENGTH" }) }),
      expect.objectContaining({ type: "update", nodeId: "highlight", patch: expect.objectContaining({ vectorPath: expect.any(Object) }) }),
    ]));
  });

  it("creates and flattens Vector Booleans with synchronous structural projection", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const first = session.createVector();
    first.x = 10;
    first.y = 20;
    const second = session.createVector();
    second.x = 80;
    second.y = 40;
    const boolean = session.subtract([first, second], session.currentPage, 1);

    expect(boolean.type).toBe("BOOLEAN_OPERATION");
    expect(boolean.booleanOperation).toBe("SUBTRACT");
    expect(boolean.children).toEqual([first, second]);
    expect(first.parent).toBe(boolean);
    expect(first.x).toBe(0);
    expect(second.x).toBe(70);
    await session.commitAsync();
    expect(transport.submitted[0]?.operations.at(-1)).toMatchObject({ type: "boolean", operandIds: [first.id, second.id], operation: "subtract" });
    expect(isRuntimeError(captureError(() => session.union([first, second], boolean)), "UNSUPPORTED_FEATURE")).toBe(true);

    boolean.booleanOperation = "INTERSECT";
    await session.commitAsync();
    expect(boolean.booleanOperation).toBe("INTERSECT");

    const flattened = session.flatten([boolean]);
    expect(flattened.type).toBe("VECTOR");
    expect(boolean.removed).toBe(true);
    expect(first.removed).toBe(true);
    expect(flattened.parent).toBe(session.currentPage);
    await session.commitAsync();
    expect(transport.submitted.at(-1)?.operations).toEqual([
      expect.objectContaining({ type: "flattenBoolean", booleanId: boolean.id, replacement: expect.objectContaining({ id: flattened.id, type: "VECTOR" }) }),
    ]);
  });

  it("flattens one confirmed parametric leaf into a Vector without world drift", async () => {
    const projection: RuntimeProjection = {
      revision: 3,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "source-frame", type: "FRAME", name: "Source", parentId: "page", siblingIndex: 0, x: 100, y: 60, width: 200, height: 160, rotation: 0 },
        { id: "rect", type: "RECTANGLE", name: "Card", parentId: "source-frame", siblingIndex: 0, x: 20, y: 30, width: 80, height: 50, rotation: 0, radius: 8, fill: "#3366cc", isMask: false },
        { id: "source-sibling", type: "ELLIPSE", name: "Sibling", parentId: "source-frame", siblingIndex: 1, x: 120, y: 30, width: 40, height: 40 },
        { id: "target", type: "FRAME", name: "Target", parentId: "page", siblingIndex: 1, x: 300, y: 200, width: 240, height: 180, rotation: 0 },
        { id: "target-child", type: "VECTOR", name: "Target child", parentId: "target", siblingIndex: 0, x: 20, y: 20, width: 40, height: 40, vectorPath: { fillRule: "nonZero", subpaths: [] } },
      ],
    };
    let sequence = 0;
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "flatten-parametric", projection, transport, createId: () => `flatten-${++sequence}`, scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync("rect"))!;
    const target = (await session.getNodeByIdAsync("target")) as RuntimeContainerNodeProxy;

    const flattened = session.flatten([rectangle], target, 0);
    expect(flattened).toMatchObject({ type: "VECTOR", name: "Card flattened", x: -180, y: -110, width: 80, height: 50, fills: [expect.objectContaining({ type: "SOLID" })] });
    expect(flattened.parent).toBe(target);
    expect(flattened.vectorPaths[0]?.data).toContain("C");
    expect(rectangle.removed).toBe(true);
    expect(target.children.map((node) => node.id)).toEqual([flattened.id, "target-child"]);
    const sourceFrame = (await session.getNodeByIdAsync("source-frame")) as RuntimeContainerNodeProxy;
    expect(sourceFrame.children.map((node) => node.id)).toEqual(["source-sibling"]);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual([
      expect.objectContaining({
        type: "flattenNode",
        sourceId: "rect",
        replacement: expect.objectContaining({ id: flattened.id, type: "VECTOR", parentId: "target", siblingIndex: 0, vectorPath: expect.objectContaining({ subpaths: [expect.objectContaining({ closed: true })] }) }),
        siblingIndexes: expect.arrayContaining([
          { nodeId: "target-child", siblingIndex: 1 },
          { nodeId: "source-sibling", siblingIndex: 0 },
        ]),
      }),
    ]);
    expect(await session.getNodeByIdAsync("rect")).toBeNull();
    expect(await session.getNodeByIdAsync(flattened.id)).toBe(flattened);
  });

  it("creates a same-page Boolean from Vector children of different Frames", async () => {
    const closedPath = {
      fillRule: "nonZero" as const,
      subpaths: [{
        closed: true,
        points: [
          { id: "p1", x: 0, y: 0, pointType: "corner" as const },
          { id: "p2", x: 40, y: 0, pointType: "corner" as const },
          { id: "p3", x: 0, y: 40, pointType: "corner" as const },
        ],
      }],
    };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "frame-a", type: "FRAME", name: "A", parentId: "page", siblingIndex: 0, x: 100, y: 50, width: 200, height: 180, rotation: 0 },
        { id: "frame-b", type: "FRAME", name: "B", parentId: "page", siblingIndex: 1, x: 360, y: 80, width: 200, height: 180, rotation: 0 },
        { id: "a", type: "VECTOR", name: "A vector", parentId: "frame-a", siblingIndex: 0, x: 20, y: 30, width: 40, height: 40, rotation: 0, vectorPath: closedPath },
        { id: "a-sibling", type: "VECTOR", name: "A sibling", parentId: "frame-a", siblingIndex: 1, x: 90, y: 30, width: 40, height: 40, rotation: 0, vectorPath: closedPath },
        { id: "b", type: "VECTOR", name: "B vector", parentId: "frame-b", siblingIndex: 0, x: 10, y: 20, width: 40, height: 40, rotation: 0, vectorPath: closedPath },
        { id: "b-sibling", type: "VECTOR", name: "B sibling", parentId: "frame-b", siblingIndex: 1, x: 80, y: 20, width: 40, height: 40, rotation: 0, vectorPath: closedPath },
      ],
    };
    const transport = new InMemoryTransport(projection);
    let sequence = 0;
    const session = new RuntimeSession({ sessionId: "cross-parent-boolean", projection, transport, createId: () => `boolean-${sequence++}`, scheduleMicrotask: () => {} });
    const first = (await session.getNodeByIdAsync("a"))!;
    const second = (await session.getNodeByIdAsync("b"))!;

    const boolean = session.subtract([second, first], session.currentPage, 1);
    expect(boolean.children.map((node) => node.id)).toEqual(["a", "b"]);
    expect(first.parent).toBe(boolean);
    expect(second.parent).toBe(boolean);
    expect(first.x).toBe(0);
    expect(first.y).toBe(0);
    expect(second.x).toBe(250);
    expect(second.y).toBe(20);
    expect((await session.getNodeByIdAsync("a-sibling"))?.parent?.id).toBe("frame-a");
    expect((await session.getNodeByIdAsync("b-sibling"))?.parent?.id).toBe("frame-b");

    await session.commitAsync();
    expect(transport.submitted[0]?.operations.at(-1)).toMatchObject({
      type: "boolean",
      operandIds: ["a", "b"],
      operation: "subtract",
      node: { id: boolean.id, parentId: "page", siblingIndex: 1 },
    });
    expect(boolean.children.map((node) => node.id)).toEqual(["a", "b"]);
  });

  it("flattens a confirmed Boolean into an alternate same-page parent and index", async () => {
    const path = {
      fillRule: "nonZero" as const,
      subpaths: [{ closed: true, points: [
        { id: "p1", x: 0, y: 0, pointType: "corner" as const },
        { id: "p2", x: 40, y: 0, pointType: "corner" as const },
        { id: "p3", x: 0, y: 40, pointType: "corner" as const },
      ] }],
    };
    const projection: RuntimeProjection = {
      revision: 4,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "boolean", type: "BOOLEAN_OPERATION", name: "Boolean", parentId: "page", siblingIndex: 0, x: 100, y: 80, width: 90, height: 50, rotation: 0, booleanOperation: "union" },
        { id: "first", type: "VECTOR", name: "First", parentId: "boolean", siblingIndex: 0, x: 0, y: 0, width: 40, height: 40, rotation: 0, vectorPath: path },
        { id: "second", type: "VECTOR", name: "Second", parentId: "boolean", siblingIndex: 1, x: 10, y: 0, width: 40, height: 40, rotation: 0, vectorPath: path },
        { id: "target", type: "FRAME", name: "Target", parentId: "page", siblingIndex: 1, x: 300, y: 200, width: 240, height: 180, rotation: 0 },
        { id: "target-child", type: "VECTOR", name: "Target child", parentId: "target", siblingIndex: 0, x: 20, y: 20, width: 40, height: 40, rotation: 0, vectorPath: path },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "alternate-flatten-target", projection, transport, createId: () => "flattened", scheduleMicrotask: () => {} });
    const boolean = (await session.getNodeByIdAsync("boolean"))!;
    const target = (await session.getNodeByIdAsync("target")) as RuntimeContainerNodeProxy;

    const flattened = session.flatten([boolean], target, 0);
    expect(flattened.parent).toBe(target);
    expect(flattened.x).toBe(-200);
    expect(flattened.y).toBe(-120);
    expect(target.children.map((node) => node.id)).toEqual(["flattened", "target-child"]);
    expect(session.currentPage.children.map((node) => node.id)).toEqual(["target"]);

    await session.commitAsync();
    expect(transport.submitted[0]?.operations).toEqual([
      expect.objectContaining({
        type: "flattenBoolean",
        booleanId: "boolean",
        replacement: expect.objectContaining({ id: "flattened", parentId: "target", siblingIndex: 0 }),
        siblingIndexes: expect.arrayContaining([
          { nodeId: "target-child", siblingIndex: 1 },
          { nodeId: "target", siblingIndex: 0 },
        ]),
      }),
    ]);
    expect(flattened.parent).toBe(target);
  });

  it("rejects cross-parent Boolean moves across pages, active Auto Layout, Instances and remote components", async () => {
    const path = {
      fillRule: "nonZero" as const,
      subpaths: [{ closed: true, points: [
        { id: "p1", x: 0, y: 0, pointType: "corner" as const },
        { id: "p2", x: 40, y: 0, pointType: "corner" as const },
        { id: "p3", x: 0, y: 40, pointType: "corner" as const },
      ] }],
    };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        { id: "other-page", type: "PAGE", name: "Other", parentId: "document", siblingIndex: 1 },
        { id: "plain", type: "VECTOR", name: "Plain", parentId: "page", siblingIndex: 0, width: 40, height: 40, vectorPath: path },
        { id: "auto", type: "FRAME", name: "Auto", parentId: "page", siblingIndex: 1, autoLayout: { mode: "horizontal" } },
        { id: "auto-vector", type: "VECTOR", name: "Auto vector", parentId: "auto", siblingIndex: 0, width: 40, height: 40, vectorPath: path },
        { id: "instance", type: "INSTANCE", name: "Instance", parentId: "page", siblingIndex: 2 },
        { id: "instance-vector", type: "VECTOR", name: "Instance vector", parentId: "instance", siblingIndex: 0, width: 40, height: 40, vectorPath: path },
        { id: "remote", type: "COMPONENT", name: "Remote", parentId: "page", siblingIndex: 3, componentMetadata: { remote: true } },
        { id: "remote-vector", type: "VECTOR", name: "Remote vector", parentId: "remote", siblingIndex: 0, width: 40, height: 40, vectorPath: path },
        { id: "other-vector", type: "VECTOR", name: "Other vector", parentId: "other-page", siblingIndex: 0, width: 40, height: 40, vectorPath: path },
      ],
    };
    const session = new RuntimeSession({ sessionId: "cross-parent-rejections", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const plain = (await session.getNodeByIdAsync("plain"))!;

    for (const nodeId of ["auto-vector", "instance-vector", "remote-vector", "other-vector"]) {
      const candidate = (await session.getNodeByIdAsync(nodeId))!;
      expect(isRuntimeError(captureError(() => session.union([plain, candidate], session.currentPage)), "UNSUPPORTED_FEATURE")).toBe(true);
    }
  });

  it("projects Boolean geometry through rotated ancestors and rejects open Vector operands", () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = (session.root.findOne((node) => node.id === "frame") as RuntimeContainerNodeProxy);
    frame.rotation = 30;
    const first = session.createVector();
    const second = session.createVector();
    frame.appendChild(first);
    frame.appendChild(second);
    second.x = 40;
    const boolean = session.union([first, second], frame, 0);
    const projected = session.projectionStore.getNode(boolean.id)!;
    const transform = projected.relativeTransform as { a: number; b: number; c: number; d: number };

    expect(boolean.parent).toBe(frame);
    expect(boolean.children).toEqual([first, second]);
    expect(Math.atan2(transform.b, transform.a) * 180 / Math.PI).toBeCloseTo(-30);
    expect(transform.a * transform.d - transform.b * transform.c).toBeCloseTo(1);

    const closed = session.createVector();
    const open = session.createVector();
    open.vectorPaths = [{ windingRule: "NONE", data: "M 0 0 L 100 100" }];
    expect(isRuntimeError(captureError(() => session.union([closed, open], session.currentPage)), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it("keeps insertChild index stable before and after the transaction fence", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = session.createFrame();
    const first = session.createRectangle();
    const second = session.createText();
    frame.appendChild(first);
    frame.appendChild(second);
    await session.commitAsync();

    const clone = first.clone();
    frame.insertChild(0, clone);
    expect(frame.children).toEqual([clone, first, second]);
    await session.commitAsync();
    expect(frame.children).toEqual([clone, first, second]);
  });

  it("emits one structural operation for each appended child in a coalesced transaction", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const frame = session.createFrame();
    const first = session.createRectangle();
    const second = session.createText();

    frame.appendChild(first);
    frame.appendChild(second);
    await session.commitAsync();

    const reparentedIds = transport.submitted[0]!.operations
      .filter((operation) => operation.type === "update" && typeof operation.patch.parentId === "string")
      .map((operation) => operation.nodeId);
    expect(reparentedIds).toEqual([first.id, second.id]);
  });

  it("exposes Figma-shaped Auto Layout sizing, wrap, baseline, bounds and absolute-child properties synchronously", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const wrapFrame = session.createFrame();
    wrapFrame.layoutMode = "HORIZONTAL";
    wrapFrame.layoutWrap = "WRAP";
    wrapFrame.counterAxisAlignItems = "BASELINE";
    wrapFrame.primaryAxisAlignItems = "SPACE_BETWEEN";
    wrapFrame.counterAxisSpacing = 18;
    wrapFrame.counterAxisAlignContent = "SPACE_BETWEEN";

    const frame = session.createFrame();
    frame.layoutMode = "VERTICAL";
    frame.paddingTop = 20;
    frame.paddingRight = 16;
    frame.paddingBottom = 20;
    frame.paddingLeft = 16;
    frame.itemSpacing = 12;
    frame.primaryAxisSizingMode = "AUTO";
    frame.counterAxisSizingMode = "AUTO";
    frame.minWidth = 120;
    frame.maxWidth = 320;

    const fill = session.createRectangle();
    frame.appendChild(fill);
    fill.layoutSizingHorizontal = "FILL";
    fill.minHeight = 24;
    fill.maxHeight = 80;
    const aligned = session.createRectangle();
    frame.appendChild(aligned);
    aligned.layoutAlign = "CENTER";
    const stretched = session.createRectangle();
    frame.appendChild(stretched);
    stretched.layoutAlign = "STRETCH";
    const absolute = session.createRectangle();
    frame.appendChild(absolute);
    absolute.layoutPositioning = "ABSOLUTE";
    absolute.constraints = { horizontal: "MAX", vertical: "CENTER" };

    expect(wrapFrame.layoutWrap).toBe("WRAP");
    expect(wrapFrame.counterAxisAlignItems).toBe("BASELINE");
    expect(wrapFrame.primaryAxisAlignItems).toBe("SPACE_BETWEEN");
    expect(wrapFrame.counterAxisSpacing).toBe(18);
    expect(wrapFrame.counterAxisAlignContent).toBe("SPACE_BETWEEN");
    expect(frame.layoutMode).toBe("VERTICAL");
    expect(frame.primaryAxisSizingMode).toBe("AUTO");
    expect(frame.layoutSizingHorizontal).toBe("HUG");
    expect(frame.layoutSizingVertical).toBe("HUG");
    expect(frame.minWidth).toBe(120);
    expect(frame.maxWidth).toBe(320);
    expect(fill.layoutSizingHorizontal).toBe("FILL");
    expect(fill.layoutAlign).toBe("STRETCH");
    expect(aligned.layoutAlign).toBe("CENTER");
    expect(stretched.layoutAlign).toBe("STRETCH");
    expect(fill.minHeight).toBe(24);
    expect(absolute.layoutPositioning).toBe("ABSOLUTE");
    expect(absolute.constraints).toEqual({ horizontal: "MAX", vertical: "CENTER" });
    await session.commitAsync();
    expect(transport.submitted[0]!.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: wrapFrame.id, patch: { autoLayout: expect.objectContaining({ mode: "horizontal", wrap: true, primaryAlignment: "spaceBetween", counterAlignment: "baseline", trackSpacing: 18, trackAlignment: "spaceBetween" }) } }),
      expect.objectContaining({ type: "update", nodeId: frame.id, patch: { autoLayout: expect.objectContaining({ mode: "vertical", padding: [20, 16, 20, 16], itemSpacing: 12, primarySizing: "hug", counterSizing: "hug", minWidth: 120, maxWidth: 320 }) } }),
      expect.objectContaining({ type: "update", nodeId: fill.id, patch: { autoLayout: expect.objectContaining({ counterSizing: "fill", minHeight: 24, maxHeight: 80 }) } }),
      expect.objectContaining({ type: "update", nodeId: aligned.id, patch: { autoLayout: expect.objectContaining({ counterSizing: "fixed", alignSelf: "center" }) } }),
      expect.objectContaining({ type: "update", nodeId: stretched.id, patch: { autoLayout: expect.objectContaining({ counterSizing: "fill" }) } }),
      expect.objectContaining({ type: "update", nodeId: absolute.id, patch: { autoLayout: expect.objectContaining({ absolute: true }) } }),
      expect.objectContaining({ type: "update", nodeId: absolute.id, patch: { constraints: { horizontal: "max", vertical: "center" } } }),
    ]));
  });

  it("admits FILL, STRETCH and nested HUG children in a wrapped Frame", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const wrap = session.createFrame();
    wrap.layoutMode = "HORIZONTAL";
    wrap.layoutWrap = "WRAP";

    const fill = session.createRectangle();
    wrap.appendChild(fill);
    fill.minWidth = 20;
    fill.maxWidth = 80;
    fill.layoutSizingHorizontal = "FILL";
    fill.layoutAlign = "STRETCH";

    const nested = session.createFrame();
    nested.layoutMode = "HORIZONTAL";
    wrap.appendChild(nested);
    nested.primaryAxisSizingMode = "AUTO";

    const source = session.createFrame();
    source.layoutMode = "HORIZONTAL";
    const moved = session.createRectangle();
    source.appendChild(moved);
    moved.layoutSizingHorizontal = "FILL";
    wrap.appendChild(moved);

    const hugWrap = session.createFrame();
    hugWrap.layoutMode = "HORIZONTAL";
    hugWrap.layoutWrap = "WRAP";
    hugWrap.counterAxisSizingMode = "AUTO";
    hugWrap.appendChild(session.createRectangle());

    expect(fill.layoutSizingHorizontal).toBe("FILL");
    expect(fill.layoutAlign).toBe("STRETCH");
    expect(nested.layoutSizingHorizontal).toBe("HUG");
    expect(moved.parent).toBe(wrap);
    expect(hugWrap.counterAxisSizingMode).toBe("AUTO");
    await session.commitAsync();
    expect(transport.submitted[0]!.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "update", nodeId: fill.id, patch: { autoLayout: expect.objectContaining({ primarySizing: "fill", counterSizing: "fill", minWidth: 20, maxWidth: 80 }) } }),
      expect.objectContaining({ type: "update", nodeId: nested.id, patch: { autoLayout: expect.objectContaining({ primarySizing: "hug" }) } }),
      expect.objectContaining({ type: "update", nodeId: moved.id, patch: expect.objectContaining({ parentId: wrap.id }) }),
      expect.objectContaining({ type: "update", nodeId: hugWrap.id, patch: { autoLayout: expect.objectContaining({ wrap: true, counterSizing: "hug" }) } }),
    ]));
  });

  it("rejects Auto Layout combinations outside the Canonical and Figma subset", () => {
    const session = sessionFor(new InMemoryTransport(initial));
    const vertical = session.createFrame();
    vertical.layoutMode = "VERTICAL";
    const topLevel = session.createRectangle();
    const bounded = session.createRectangle();
    vertical.appendChild(bounded);
    bounded.minWidth = 80;
    const wrap = session.createFrame();
    wrap.layoutMode = "HORIZONTAL";
    wrap.layoutWrap = "WRAP";
    const hugWrap = session.createFrame();
    hugWrap.layoutMode = "HORIZONTAL";
    hugWrap.layoutWrap = "WRAP";
    hugWrap.counterAxisSizingMode = "AUTO";
    const stretchInHugWrap = session.createRectangle();
    hugWrap.appendChild(stretchInHugWrap);

    expect(isRuntimeError(captureError(() => { vertical.layoutWrap = "WRAP"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { vertical.counterAxisAlignItems = "BASELINE"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { vertical.layoutSizingVertical = "FILL"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { topLevel.layoutSizingHorizontal = "FILL"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { topLevel.layoutPositioning = "ABSOLUTE"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { bounded.maxWidth = 40; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { bounded.minHeight = 0; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { session.createGroup().constraints = { horizontal: "MIN", vertical: "MIN" }; }), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => { bounded.constraints = { horizontal: "INVALID" as never, vertical: "MIN" }; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { vertical.counterAxisSpacing = 12; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { vertical.counterAxisAlignContent = "SPACE_BETWEEN"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { wrap.counterAxisSpacing = -1; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { wrap.counterAxisAlignContent = "INVALID" as never; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => { stretchInHugWrap.layoutAlign = "STRETCH"; }), "INVALID_ARGUMENT")).toBe(true);
  });

  it("does not revive a stale proxy when a deleted canonical ID is restored by Undo", async () => {
    const transport = new InMemoryTransport(initial);
    const session = sessionFor(transport);
    const oldFrame = (await session.getNodeByIdAsync("frame"))!;
    oldFrame.remove();
    await session.commitAsync();
    expect(oldFrame.removed).toBe(true);
    expect(oldFrame.type).toBe("FRAME");

    session.applyConfirmedProjection({ revision: 2, nodes: initial.nodes });
    const restored = (await session.getNodeByIdAsync("frame"))!;
    expect(restored).not.toBe(oldFrame);
    expect(restored.handle.generation).toBe(oldFrame.handle.generation + 1);
    expect(isRuntimeError(captureError(() => oldFrame.x), "NODE_REMOVED")).toBe(true);
  });

  it("moves to the next live Page when a remote confirmed projection deletes the current Page", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", selectedIds: ["first-frame"] },
        { id: "first-page", type: "PAGE", name: "First", parentId: "document", siblingIndex: 0 },
        { id: "second-page", type: "PAGE", name: "Second", parentId: "document", siblingIndex: 1 },
        { id: "first-frame", type: "FRAME", name: "First frame", parentId: "first-page", siblingIndex: 0 },
        { id: "second-frame", type: "FRAME", name: "Second frame", parentId: "second-page", siblingIndex: 0 },
      ],
    };
    const session = new RuntimeSession({
      sessionId: "remote-page-delete",
      projection,
      transport: new InMemoryTransport(projection),
      currentPageId: "first-page",
      scheduleMicrotask: () => {},
    });
    const oldPage = session.currentPage;
    const oldFrame = (await session.getNodeByIdAsync("first-frame"))!;
    const leasedProjection = session.projectionStore.confirmedProjection;
    const viewStates: Array<{ currentPageId: string; selectedIds: readonly string[] }> = [];
    session.onViewStateChange((state) => viewStates.push(state));

    session.applyConfirmedProjection({
      revision: 1,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", selectedIds: [] },
        { id: "second-page", type: "PAGE", name: "Second", parentId: "document", siblingIndex: 0 },
        { id: "second-frame", type: "FRAME", name: "Second frame", parentId: "second-page", siblingIndex: 0 },
      ],
    });

    expect(session.currentPage.id).toBe("second-page");
    expect(session.currentPage.children.map((node) => node.id)).toEqual(["second-frame"]);
    expect(session.root.children.map((node) => node.id)).toEqual(["second-page"]);
    expect(isRuntimeError(captureError(() => oldPage.children), "NODE_REMOVED")).toBe(true);
    expect(isRuntimeError(captureError(() => oldFrame.x), "NODE_REMOVED")).toBe(true);
    expect(viewStates.at(-1)).toMatchObject({ currentPageId: "second-page", selectedIds: [] });
    expect(leasedProjection.nodes.map((node) => node.id)).toContain("first-page");
  });

  it("rolls failed batches back and invalidates every proxy after close", async () => {
    const transport = new InMemoryTransport(initial, true);
    const session = sessionFor(transport);
    const frame = (await session.getNodeByIdAsync("frame"))!;
    frame.x = 20;
    expect(isRuntimeError(await captureRejection(() => session.commitAsync()), "REVISION_CONFLICT")).toBe(true);
    expect(frame.x).toBe(0);

    await session.closeAsync();
    expect(isRuntimeError(captureError(() => frame.x), "RUNTIME_CLOSED")).toBe(true);
  });

  it("uses the browser-compatible default microtask scheduler without losing its invocation context", async () => {
    const transport = new InMemoryTransport(initial);
    const session = new RuntimeSession({
      sessionId: "default-scheduler",
      projection: initial,
      transport,
      createId: () => "new-rectangle",
    });
    expect(() => session.createRectangle()).not.toThrow();
    await session.commitAsync();
    expect(transport.submitted).toHaveLength(1);
  });

  it("gates text changes on the affected font and preserves UTF-16 range semantics", async () => {
    const font = { assetId: "font-1", faceIndex: 0 };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", fontAvailability: { "font-1": "idle" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text",
          type: "TEXT",
          name: "Text",
          parentId: "page",
          characters: "A😀中",
          textProperties: {
            runs: [{ start: 0, end: 8, font, fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "font-gate", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text"))!;
    expect(() => text.setRangeFontSize(1, 1, 20)).not.toThrow();
    expect(() => text.deleteCharacters(1, 1)).not.toThrow();
    expect(session.projectionStore.pendingTransactionIds()).toEqual([]);
    expect(isRuntimeError(captureError(() => { text.characters = "A界中"; }), "FONT_NOT_LOADED")).toBe(true);
    expect(isRuntimeError(captureError(() => text.insertCharacters(1, "Z")), "FONT_NOT_LOADED")).toBe(true);
    expect(isRuntimeError(captureError(() => text.insertCharacters(2, "Z")), "INVALID_ARGUMENT")).toBe(true);

    session.applyConfirmedProjection({
      revision: 1,
      nodes: projection.nodes.map((node) => node.id === "document" ? { ...node, fontAvailability: { "font-1": "ready" } } : node),
    });
    text.setRangeFontSize(1, 3, 20);
    text.setRangeLetterSpacing(1, 3, { value: 2, unit: "PIXELS" });
    expect(text.characters).toBe("A😀中");
    expect(text.letterSpacing).toBe(RUNTIME_MIXED);
    expect(text.getRangeLetterSpacing(1, 3)).toEqual({ value: 2, unit: "PIXELS" });
    expect(isRuntimeError(captureError(() => text.setRangeLetterSpacing(0, 1, { value: 10_001, unit: "PIXELS" })), "INVALID_ARGUMENT")).toBe(true);
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    const operation = session.projectionStore.transaction(transactionId)?.operations.at(-1);
    expect(operation).toMatchObject({ type: "update", nodeId: "text" });
    if (!operation || operation.type !== "update") throw new Error("Expected text update operation");
    expect((operation.patch.textProperties as { runs: Array<{ start: number; end: number; fontSize: number; letterSpacing: number }> }).runs[1]).toMatchObject({ start: 1, end: 5, fontSize: 20, letterSpacing: 2 });
  });

  it("maps Figma FontName through admitted assets for Text, ShapeWithText, and TextPath", async () => {
    const firstAsset = { assetId: "font-1", contentHash: "1".repeat(64), mediaType: "font/ttf", byteLength: 10 };
    const secondAsset = { assetId: "font-2", contentHash: "2".repeat(64), mediaType: "font/otf", byteLength: 20 };
    const firstName = { family: fontFamilyForAsset(firstAsset.assetId), style: "Regular" };
    const secondName = { family: fontFamilyForAsset(secondAsset.assetId), style: "Regular" };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", assets: [firstAsset, secondAsset], fontAvailability: { "font-1": "ready", "font-2": "ready" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text-font-name",
          type: "TEXT",
          name: "Mixed fonts",
          parentId: "page",
          characters: "AB",
          textProperties: {
            runs: [
              { start: 0, end: 1, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
              { start: 1, end: 2, font: { assetId: firstAsset.assetId, faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
            ],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
        {
          id: "shape-font-name",
          type: "SHAPE_WITH_TEXT",
          name: "Empty font",
          parentId: "page",
          characters: "",
          textProperties: {
            runs: [],
            paragraph: { alignment: "center", paragraphSpacing: 0 },
            autoSize: "fixed",
            baseStyle: { fontSize: 18, fontWeight: 400, italic: false, letterSpacing: 0, textStyleId: "S:empty" },
          },
        },
        {
          id: "missing-font",
          type: "TEXT_PATH",
          name: "Missing font",
          parentId: "page",
          characters: "M",
          vectorPath: { fillRule: "nonZero", subpaths: [{ closed: false, points: [{ id: "tp-1", x: 0, y: 20, pointType: "corner" }, { id: "tp-2", x: 100, y: 20, pointType: "corner" }] }] },
          textPathMetadata: { startSegment: 0, startPosition: 0, autoRename: true, textAlignHorizontal: "LEFT", textAlignVertical: "CENTER" },
          textProperties: {
            runs: [{ start: 0, end: 1, font: { assetId: "missing", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "font-name", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text-font-name"))!;
    const shape = (await session.getNodeByIdAsync("shape-font-name"))!;
    const missing = (await session.getNodeByIdAsync("missing-font"))!;

    expect(text.fontName).toBe(RUNTIME_MIXED);
    expect(text.getRangeFontName(0, 1)).toEqual({ family: "Inter", style: "Regular" });
    expect(text.getRangeFontName(1, 2)).toEqual(firstName);
    expect(text.getRangeAllFontNames(0, 2)).toEqual([{ family: "Inter", style: "Regular" }, firstName]);
    expect(text.hasMissingFont).toBe(false);
    expect(missing.hasMissingFont).toBe(true);
    expect(shape.text.fontName).toEqual({ family: "Inter", style: "Regular" });
    expect(shape.text.textStyleId).toBe("S:empty");
    expect(shape.text.getRangeTextStyleId(0, 0)).toBe("S:empty");

    text.setRangeFontName(0, 1, secondName);
    shape.text.fontName = firstName;
    missing.fontName = secondName;
    expect(text.getRangeFontName(0, 1)).toEqual(secondName);
    expect(shape.text.fontName).toEqual(firstName);
    expect(shape.text.textStyleId).toBe("S:empty");
    expect((session.projectionStore.getNode("shape-font-name")?.textProperties as { baseStyle?: { font?: unknown } }).baseStyle?.font).toEqual({ assetId: firstAsset.assetId, faceIndex: 0 });
    expect(missing.hasMissingFont).toBe(false);
    expect(missing.getRangeFontName(0, 1)).toEqual(secondName);
    expect(missing.name).toBe("Missing font");
    expect(isRuntimeError(captureError(() => text.setRangeFontName(0, 1, { family: "Unknown", style: "Regular" })), "RESOURCE_UNAVAILABLE")).toBe(true);

    await session.commitAsync();
    expect(text.getRangeFontName(0, 1)).toEqual(secondName);
    expect(shape.text.fontName).toEqual(firstName);
  });

  it("maps all Figma TextCase values across Text and ShapeWithText ranges", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", fontAvailability: { "font-1": "ready" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text-case",
          type: "TEXT",
          name: "Mixed case",
          parentId: "page",
          characters: "AbCd",
          textProperties: {
            runs: [
              { start: 0, end: 2, font: { assetId: "font-1", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, textCase: "upper" },
              { start: 2, end: 4, font: { assetId: "font-1", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, textCase: "lower" },
            ],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
        {
          id: "shape-case",
          type: "SHAPE_WITH_TEXT",
          name: "Empty case",
          parentId: "page",
          characters: "",
          textProperties: {
            runs: [],
            paragraph: { alignment: "center", paragraphSpacing: 0 },
            autoSize: "fixed",
            baseStyle: { fontSize: 18, fontWeight: 400, italic: false, letterSpacing: 0, textCase: "smallCaps" },
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "text-case", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text-case"))!;
    const shape = (await session.getNodeByIdAsync("shape-case"))!;

    expect(text.textCase).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextCase(0, 2)).toBe("UPPER");
    expect(text.getRangeTextCase(2, 4)).toBe("LOWER");
    expect(shape.text.textCase).toBe("SMALL_CAPS");

    text.setRangeTextCase(0, 2, "TITLE");
    text.setRangeTextCase(2, 4, "SMALL_CAPS_FORCED");
    shape.text.textCase = "ORIGINAL";
    expect(text.getRangeTextCase(0, 2)).toBe("TITLE");
    expect(text.getRangeTextCase(2, 4)).toBe("SMALL_CAPS_FORCED");
    expect(shape.text.textCase).toBe("ORIGINAL");
    expect((session.projectionStore.getNode("shape-case")?.textProperties as { baseStyle?: { textCase?: string } }).baseStyle?.textCase).toBeUndefined();
    expect(isRuntimeError(captureError(() => text.setRangeTextCase(0, 1, "INVALID" as never)), "INVALID_ARGUMENT")).toBe(true);

    await session.commitAsync();
    expect(text.characters).toBe("AbCd");
  });

  it("preserves Figma hyperlink metadata across Text and ShapeWithText ranges", async () => {
    const url = { type: "URL" as const, value: "https://example.com/a" };
    const nodeTarget = { type: "NODE" as const, value: "12:34" };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", fontAvailability: { "font-1": "ready" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text-link", type: "TEXT", name: "Links", parentId: "page", characters: "ABCD",
          textProperties: {
            runs: [
              { start: 0, end: 2, font: { assetId: "font-1", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: url },
              { start: 2, end: 4, font: { assetId: "font-1", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: nodeTarget },
            ],
            paragraph: { alignment: "left", paragraphSpacing: 0 }, autoSize: "fixed",
          },
        },
        {
          id: "shape-link", type: "SHAPE_WITH_TEXT", name: "Empty link", parentId: "page", characters: "",
          textProperties: {
            runs: [], paragraph: { alignment: "center", paragraphSpacing: 0 }, autoSize: "fixed",
            baseStyle: { fontSize: 18, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: url },
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "text-hyperlink", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text-link"))!;
    const shape = (await session.getNodeByIdAsync("shape-link"))!;

    expect(text.hyperlink).toBe(RUNTIME_MIXED);
    const first = text.getRangeHyperlink(0, 2);
    expect(first).toEqual(url);
    if (first && first !== RUNTIME_MIXED) (first as { value: string }).value = "mutated";
    expect(text.getRangeHyperlink(0, 2)).toEqual(url);
    expect(shape.text.hyperlink).toEqual(url);

    text.setRangeHyperlink(0, 2, nodeTarget);
    expect(text.hyperlink).toEqual(nodeTarget);
    text.setRangeHyperlink(1, 3, null);
    expect(text.getRangeHyperlink(1, 3)).toBeNull();
    expect(text.hyperlink).toBe(RUNTIME_MIXED);
    shape.text.hyperlink = null;
    expect(shape.text.hyperlink).toBeNull();
    shape.text.setRangeHyperlink(0, 0, url);
    expect(shape.text.hyperlink).toEqual(url);

    const pendingBeforeInvalid = session.projectionStore.pendingTransactionIds().length;
    for (const invalid of [
      { type: "EMAIL", value: "a@example.com" },
      { type: "URL", value: "" },
      { type: "URL", value: "nul\0value" },
      { type: "URL", value: "界".repeat(683) },
    ]) {
      expect(isRuntimeError(captureError(() => text.setRangeHyperlink(0, 1, invalid as never)), "INVALID_ARGUMENT")).toBe(true);
    }
    expect(session.projectionStore.pendingTransactionIds()).toHaveLength(pendingBeforeInvalid);
    await session.commitAsync();
    expect(text.getRangeHyperlink(1, 3)).toBeNull();
    expect(shape.text.hyperlink).toEqual(url);
  });

  it("reads and writes Figma text decorations across Text and ShapeWithText ranges", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", fontAvailability: { "font-1": "ready" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text-decoration", type: "TEXT", name: "Decorated", parentId: "page", characters: "ABCD",
          textProperties: {
            runs: [
              { start: 0, end: 2, font: { assetId: "font-1", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "underline", textDecorationStyle: "wavy", textDecorationOffset: { value: 3, unit: "pixels" }, textDecorationThickness: { value: 2, unit: "pixels" }, textDecorationColor: { color: { space: "srgb", components: [1, .25, .5], alpha: 1 }, visible: true, opacity: .75, blendMode: "multiply" }, textDecorationSkipInk: true, leadingTrim: "capHeight" },
              { start: 2, end: 4, font: { assetId: "font-1", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "strikethrough", textDecorationStyle: "dotted", textDecorationOffset: { value: -20, unit: "percent" }, textDecorationThickness: { value: 20, unit: "percent" }, textDecorationColor: { color: { space: "srgb", components: [0, 1, 0], alpha: 1 }, visible: true, opacity: 1, blendMode: "normal" } },
            ],
            paragraph: { alignment: "left", paragraphSpacing: 0 }, autoSize: "fixed",
          },
        },
        {
          id: "shape-decoration", type: "SHAPE_WITH_TEXT", name: "Empty decoration", parentId: "page", characters: "",
          textProperties: {
            runs: [], paragraph: { alignment: "center", paragraphSpacing: 0 }, autoSize: "fixed",
            baseStyle: { fontSize: 18, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "underline", textDecorationStyle: "dotted", textDecorationOffset: { value: 12.5, unit: "percent" }, textDecorationThickness: { value: 12.5, unit: "percent" }, textDecorationColor: { color: { space: "srgb", components: [0, .5, 1], alpha: 1 }, visible: true, opacity: .5, blendMode: "screen" }, textDecorationSkipInk: true, leadingTrim: "capHeight" },
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "text-decoration", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text-decoration"))!;
    const shape = (await session.getNodeByIdAsync("shape-decoration"))!;

    expect(text.textDecoration).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextDecoration(0, 2)).toBe("UNDERLINE");
    expect(text.getRangeTextDecoration(2, 4)).toBe("STRIKETHROUGH");
    expect(shape.text.textDecoration).toBe("UNDERLINE");
    expect(text.textDecorationStyle).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextDecorationStyle(0, 2)).toBe("WAVY");
    expect(text.getRangeTextDecorationStyle(2, 4)).toBeNull();
    expect(shape.text.textDecorationStyle).toBe("DOTTED");
    expect(text.textDecorationOffset).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextDecorationOffset(0, 2)).toEqual({ value: 3, unit: "PIXELS" });
    expect(text.getRangeTextDecorationOffset(2, 4)).toBeNull();
    expect(shape.text.textDecorationOffset).toEqual({ value: 12.5, unit: "PERCENT" });
    expect(text.textDecorationThickness).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextDecorationThickness(0, 2)).toEqual({ value: 2, unit: "PIXELS" });
    expect(text.getRangeTextDecorationThickness(2, 4)).toBeNull();
    expect(shape.text.textDecorationThickness).toEqual({ value: 12.5, unit: "PERCENT" });
    expect(text.textDecorationColor).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextDecorationColor(0, 2)).toEqual({ value: { type: "SOLID", color: { r: 1, g: .25, b: .5 }, visible: true, opacity: .75, blendMode: "MULTIPLY" } });
    expect(text.getRangeTextDecorationColor(2, 4)).toBeNull();
    expect(shape.text.textDecorationColor).toEqual({ value: { type: "SOLID", color: { r: 0, g: .5, b: 1 }, visible: true, opacity: .5, blendMode: "SCREEN" } });
    expect(text.textDecorationSkipInk).toBe(RUNTIME_MIXED);
    expect(text.getRangeTextDecorationSkipInk(0, 2)).toBe(true);
    expect(text.getRangeTextDecorationSkipInk(2, 4)).toBeNull();
    expect(shape.text.textDecorationSkipInk).toBe(true);
    expect(text.leadingTrim).toBe(RUNTIME_MIXED);
    expect(shape.text.leadingTrim).toBe("CAP_HEIGHT");
    text.leadingTrim = "NONE";
    expect(text.leadingTrim).toBe("NONE");
    shape.text.leadingTrim = "NONE";
    expect(shape.text.leadingTrim).toBe("NONE");
    shape.text.leadingTrim = "CAP_HEIGHT";
    expect(shape.text.leadingTrim).toBe("CAP_HEIGHT");
    expect(isRuntimeError(captureError(() => { text.leadingTrim = "AUTO" as never; }), "INVALID_ARGUMENT")).toBe(true);
    text.setRangeTextDecorationStyle(0, 2, "SOLID");
    expect(text.getRangeTextDecorationStyle(0, 2)).toBe("SOLID");
    text.setRangeTextDecoration(0, 2, "STRIKETHROUGH");
    expect(text.textDecoration).toBe("STRIKETHROUGH");
    expect(text.textDecorationStyle).toBeNull();
    text.textDecoration = "NONE";
    expect(text.textDecoration).toBe("NONE");
    expect(text.textDecorationStyle).toBeNull();
    shape.text.textDecorationStyle = "WAVY";
    expect(shape.text.textDecorationStyle).toBe("WAVY");
    shape.text.textDecorationOffset = { unit: "AUTO" };
    expect(shape.text.textDecorationOffset).toEqual({ unit: "AUTO" });
    shape.text.setRangeTextDecorationOffset(0, 0, { value: -2, unit: "PIXELS" });
    expect(shape.text.textDecorationOffset).toEqual({ value: -2, unit: "PIXELS" });
    shape.text.textDecorationThickness = { unit: "AUTO" };
    expect(shape.text.textDecorationThickness).toEqual({ unit: "AUTO" });
    shape.text.setRangeTextDecorationThickness(0, 0, { value: 10, unit: "PERCENT" });
    expect(shape.text.textDecorationThickness).toEqual({ value: 10, unit: "PERCENT" });
    shape.text.textDecorationColor = { value: "AUTO" };
    expect(shape.text.textDecorationColor).toEqual({ value: "AUTO" });
    shape.text.setRangeTextDecorationColor(0, 0, { value: { type: "SOLID", color: { r: .1, g: .2, b: .3 }, visible: false, opacity: .25, blendMode: "OVERLAY" } });
    expect(shape.text.textDecorationColor).toEqual({ value: { type: "SOLID", color: { r: .1, g: .2, b: .3 }, visible: false, opacity: .25, blendMode: "OVERLAY" } });
    shape.text.textDecorationSkipInk = false;
    expect(shape.text.textDecorationSkipInk).toBe(false);
    shape.text.setRangeTextDecorationSkipInk(0, 0, true);
    expect(shape.text.textDecorationSkipInk).toBe(true);
    shape.text.textDecoration = "STRIKETHROUGH";
    expect(shape.text.textDecoration).toBe("STRIKETHROUGH");
    expect(shape.text.textDecorationStyle).toBeNull();
    expect(shape.text.textDecorationOffset).toBeNull();
    expect(shape.text.textDecorationThickness).toBeNull();
    expect(shape.text.textDecorationColor).toBeNull();
    expect(shape.text.textDecorationSkipInk).toBeNull();
    expect(isRuntimeError(captureError(() => text.setRangeTextDecoration(0, 1, "BLINK" as never)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationStyle(0, 1, "DASHED" as never)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationOffset(0, 1, { value: Number.NaN, unit: "PIXELS" })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationThickness(0, 1, { value: -1, unit: "PIXELS" })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationColor(0, 1, { value: { type: "SOLID", color: { r: Number.NaN, g: 0, b: 0 } } })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationColor(0, 1, { value: { type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 2 } })), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationColor(0, 1, { value: { type: "SOLID", color: { r: 1, g: 0, b: 0 }, boundVariables: {} } as never })), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationSkipInk(0, 1, "AUTO" as never)), "INVALID_ARGUMENT")).toBe(true);

    await session.commitAsync();
    expect(text.textDecoration).toBe("NONE");
    expect(text.textDecorationStyle).toBeNull();
    expect(shape.text.textDecoration).toBe("STRIKETHROUGH");
    expect(shape.text.textDecorationStyle).toBeNull();
    expect(shape.text.textDecorationOffset).toBeNull();
    expect(shape.text.textDecorationThickness).toBeNull();
    expect(shape.text.textDecorationColor).toBeNull();
    expect(shape.text.textDecorationSkipInk).toBeNull();
  });

  it("requires affected fonts to be loaded before changing TextCase", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", fontAvailability: { "font-idle": "idle" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "font-gated-case",
          type: "TEXT",
          name: "Font gated case",
          parentId: "page",
          characters: "Ab",
          textProperties: {
            runs: [{ start: 0, end: 2, font: { assetId: "font-idle", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "text-case-font-gate", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("font-gated-case"))!;
    expect(isRuntimeError(captureError(() => text.setRangeTextCase(0, 2, "UPPER")), "FONT_NOT_LOADED")).toBe(true);
    expect(isRuntimeError(captureError(() => text.setRangeTextDecorationSkipInk(0, 2, true)), "FONT_NOT_LOADED")).toBe(true);
    expect(isRuntimeError(captureError(() => { text.leadingTrim = "CAP_HEIGHT"; }), "FONT_NOT_LOADED")).toBe(true);
    expect(text.textCase).toBe("ORIGINAL");
  });

  it("loads the asset behind a Figma FontName and waits for the projection fence", async () => {
    const asset = { assetId: "font-load", contentHash: "f".repeat(64), mediaType: "font/ttf", byteLength: 10 };
    const fontName = { family: fontFamilyForAsset(asset.assetId), style: "Regular" };
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", assets: [asset], fontAvailability: { [asset.assetId]: "idle" } },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
      ],
    };
    const transport = new InMemoryTransport(projection) as InMemoryTransport & { loadFontAsync: (assetId: string) => Promise<void> };
    const session = new RuntimeSession({ sessionId: "load-font-name", projection, transport, scheduleMicrotask: () => {} });
    const loadFontAsync = vi.fn(async () => {
      session.applyConfirmedProjection({
        revision: 1,
        nodes: projection.nodes.map((node) => node.id === "document"
          ? { ...node, fontAvailability: { [asset.assetId]: "ready" } }
          : node),
      });
    });
    transport.loadFontAsync = loadFontAsync;

    await session.loadFontAsync({ family: "Inter", style: "Regular" });
    expect(loadFontAsync).not.toHaveBeenCalled();
    await session.loadFontAsync(fontName);
    expect(loadFontAsync).toHaveBeenCalledWith(asset.assetId, undefined);
    await expect(session.loadFontAsync({ family: "Unknown", style: "Regular" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_UNAVAILABLE"));
  });

  it("preserves the requested style run when inserting into repeated text", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "repeated-text",
          type: "TEXT",
          name: "Repeated text",
          parentId: "page",
          characters: "aaaa",
          textProperties: {
            runs: [
              { start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 },
              { start: 1, end: 3, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 },
              { start: 3, end: 4, fontSize: 30, fontWeight: 400, italic: false, letterSpacing: 0 },
            ],
            paragraph: { alignment: "left", paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "repeated-text", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("repeated-text"))!;
    text.insertCharacters(2, "a");
    expect(text.characters).toBe("aaaaa");
    const node = session.projectionStore.getNode("repeated-text");
    expect((node?.textProperties as { runs: Array<{ start: number; end: number; fontSize: number }> }).runs).toEqual([
      expect.objectContaining({ start: 0, end: 1, fontSize: 12 }),
      expect.objectContaining({ start: 1, end: 4, fontSize: 20 }),
      expect.objectContaining({ start: 4, end: 5, fontSize: 30 }),
    ]);
  });

  it("maps the supported Figma textAutoResize values to Canonical text properties", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        {
          id: "text",
          type: "TEXT",
          name: "Auto-sized text",
          parentId: "page",
          characters: "Alpha\nBeta",
          textProperties: {
            runs: [{ start: 0, end: 10, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
            paragraph: { alignment: "left", lineHeight: 20, paragraphSpacing: 0 },
            autoSize: "fixed",
          },
        },
        { id: "rectangle", type: "RECTANGLE", name: "Rectangle", parentId: "page" },
      ],
    };
    const session = new RuntimeSession({ sessionId: "text-auto-resize", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text"))!;
    const rectangle = (await session.getNodeByIdAsync("rectangle"))!;

    expect(text.textAutoResize).toBe("NONE");
    text.textAutoResize = "HEIGHT";
    expect(text.textAutoResize).toBe("HEIGHT");
    const transactionId = session.projectionStore.pendingTransactionIds()[0]!;
    expect(session.projectionStore.transaction(transactionId)?.operations.at(-1)).toMatchObject({
      type: "update",
      nodeId: "text",
      patch: { textProperties: { autoSize: "height" } },
    });
    expect(text.textTruncation).toBe("DISABLED");
    expect(text.maxLines).toBeNull();
    text.textTruncation = "ENDING";
    text.maxLines = 2;
    expect(text.textTruncation).toBe("ENDING");
    expect(text.maxLines).toBe(2);
    expect(session.projectionStore.transaction(transactionId)?.operations.at(-1)).toMatchObject({
      type: "update",
      nodeId: "text",
      patch: { textProperties: { textTruncation: "ending", maxLines: 2 } },
    });
    expect(isRuntimeError(captureError(() => { text.maxLines = 0; }), "INVALID_ARGUMENT")).toBe(true);
    text.textTruncation = "DISABLED";
    expect(text.maxLines).toBeNull();
    expect(isRuntimeError(captureError(() => { (text as unknown as { textAutoResize: string }).textAutoResize = "TRUNCATE"; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(captureError(() => rectangle.textAutoResize), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => rectangle.textTruncation), "UNSUPPORTED_PROPERTY")).toBe(true);
  });

  it("requires explicit page loads before dynamic-document traversal", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page-1", type: "PAGE", parentId: "document", name: "Page 1" },
        { id: "page-2", type: "PAGE", parentId: "document", name: "Page 2" },
        { id: "one", type: "RECTANGLE", parentId: "page-1", pageId: "page-1", name: "One", x: 0, y: 0 },
        { id: "two", type: "RECTANGLE", parentId: "page-2", pageId: "page-2", name: "Two", x: 0, y: 0 },
      ],
    };
    const session = new RuntimeSession({
      sessionId: "dynamic-pages",
      projection,
      currentPageId: "page-1",
      documentAccess: "dynamic-page",
      transport: new InMemoryTransport(projection),
      scheduleMicrotask: () => {},
    });
    expect((await session.getNodeByIdAsync("two"))).toBeNull();
    expect(isRuntimeError(captureError(() => session.root.findAll(() => true)), "PAGE_NOT_LOADED")).toBe(true);

    const secondPage = session.root.children.find((node) => node.id === "page-2");
    if (!(secondPage instanceof RuntimeContainerNodeProxy)) throw new Error("Second page is unavailable");
    await secondPage.loadAsync();
    expect((await session.getNodeByIdAsync("two"))?.id).toBe("two");
    expect(session.root.findAll(() => true).map((node) => node.id)).toEqual(["page-1", "one", "page-2", "two"]);

    await session.loadAllPagesAsync();
    expect(session.root.findAll(() => true).map((node) => node.id)).toEqual(["page-1", "one", "page-2", "two"]);
    await session.setCurrentPageAsync(secondPage);
    expect(session.currentPage.id).toBe("page-2");
  });

  it("admits an image before registering it and binds its immutable hash to a node", async () => {
    const registered: Array<{ assetId: string; bytes: Uint8Array }> = [];
    const transport = new InMemoryTransport(initial) as InMemoryTransport & { registerAssetAsync: (asset: { assetId: string }, bytes: Uint8Array) => Promise<void> };
    transport.registerAssetAsync = async (asset, bytes) => { registered.push({ assetId: asset.assetId, bytes }); };
    const session = new RuntimeSession({
      sessionId: "image-resource",
      projection: initial,
      transport,
      scheduleMicrotask: () => {},
      admitImage: async (bytes) => ({ assetId: "image-1", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: bytes.byteLength, pixelWidth: 24, pixelHeight: 16 }),
    });
    const image = await session.createImageAsync(Uint8Array.of(1, 2, 3), "image/png");
    expect(image).toEqual({ hash: "image-1", width: 24, height: 16 });
    expect(registered).toEqual([{ assetId: "image-1", bytes: Uint8Array.of(1, 2, 3) }]);
    const imageNode = session.createImageNode(image);
    imageNode.setImageAsset(image);
    expect(session.projectionStore.getNode(imageNode.id)).toMatchObject({ assetId: "image-1", type: "IMAGE" });
  });

  it("creates a FigJam Media node from an admitted GIF hash", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        {
          id: "document",
          type: "DOCUMENT",
          name: "Document",
          assets: [
            { assetId: "gif-1", contentHash: "a".repeat(64), mediaType: "image/gif", byteLength: 12, pixelWidth: 320, pixelHeight: 180 },
            { assetId: "png-1", contentHash: "b".repeat(64), mediaType: "image/png", byteLength: 8, pixelWidth: 20, pixelHeight: 10 },
          ],
        },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
      ],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({
      sessionId: "create-gif",
      projection,
      transport,
      scheduleMicrotask: () => {},
      createId: () => "media-1",
    });

    const media = session.createGif("gif-1");
    expect(media.type).toBe("MEDIA");
    expect(media.mediaData).toEqual({ hash: "gif-1" });
    expect(session.projectionStore.getNode(media.id)).toMatchObject({
      type: "MEDIA",
      assetId: "gif-1",
      width: 320,
      height: 180,
      mediaMetadata: { hash: "gif-1" },
    });
    expect(isRuntimeError(captureError(() => session.createGif("missing")), "RESOURCE_UNAVAILABLE")).toBe(true);
    expect(isRuntimeError(captureError(() => session.createGif("png-1")), "RESOURCE_UNAVAILABLE")).toBe(true);

    await session.commitAsync();
    expect(session.projectionStore.getNode(media.id)?.removed).not.toBe(true);
  });

  it("projects readonly Embed and LinkUnfurl metadata on live node proxies", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
        {
          id: "embed",
          type: "EMBED",
          name: "Video",
          parentId: "page",
          siblingIndex: 0,
          embedMetadata: { srcUrl: "https://player.example/embed/1", canonicalUrl: "https://example.com/watch/1", title: "Demo", provider: "Example" },
        },
        {
          id: "link",
          type: "LINK_UNFURL",
          name: "Story",
          parentId: "page",
          siblingIndex: 1,
          linkUnfurlMetadata: { url: "https://example.com/story", title: "Story", description: "Summary", provider: "Example" },
        },
      ],
    };
    const session = new RuntimeSession({ sessionId: "preview-metadata", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const embed = (await session.getNodeByIdAsync("embed"))!;
    const link = (await session.getNodeByIdAsync("link"))!;

    expect(embed.embedData).toEqual({ srcUrl: "https://player.example/embed/1", canonicalUrl: "https://example.com/watch/1", title: "Demo", provider: "Example" });
    expect(link.linkUnfurlData).toEqual({ url: "https://example.com/story", title: "Story", description: "Summary", provider: "Example" });
    expect(isRuntimeError(captureError(() => embed.linkUnfurlData), "UNSUPPORTED_PROPERTY")).toBe(true);
    expect(isRuntimeError(captureError(() => link.mediaData), "UNSUPPORTED_PROPERTY")).toBe(true);
  });

  it("creates provider-resolved Embed and LinkUnfurl nodes through the host boundary", async () => {
    const transport = new InMemoryTransport(initial) as InMemoryTransport & {
      resolveLinkPreviewAsync: (url: string) => Promise<
        | { type: "EMBED"; data: { srcUrl: string; canonicalUrl: string | null; title: string | null; provider: string | null } }
        | { type: "LINK_UNFURL"; data: { url: string; title: string | null; description: string | null; provider: string | null } }
      >;
    };
    transport.resolveLinkPreviewAsync = vi.fn(async (url: string) => url.includes("video")
      ? { type: "EMBED" as const, data: { srcUrl: "https://player.example/embed/1", canonicalUrl: url, title: "Video", provider: "Example" } }
      : { type: "LINK_UNFURL" as const, data: { url, title: "Story", description: "Summary", provider: "Example" } });
    let nextId = 0;
    const session = new RuntimeSession({
      sessionId: "create-preview",
      projection: initial,
      transport,
      scheduleMicrotask: () => {},
      createId: () => `preview-${++nextId}`,
    });

    const embed = await session.createLinkPreviewAsync("https://example.com/video");
    const link = await session.createLinkPreviewAsync("https://example.com/story");
    expect(embed).toMatchObject({ type: "EMBED", name: "Video", width: 360, height: 240 });
    expect(embed.embedData.srcUrl).toBe("https://player.example/embed/1");
    expect(link).toMatchObject({ type: "LINK_UNFURL", name: "Story", width: 360, height: 180 });
    expect(link.linkUnfurlData.description).toBe("Summary");
    await expect(session.createLinkPreviewAsync("javascript:alert(1)")).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_UNAVAILABLE"));
    expect(transport.resolveLinkPreviewAsync).toHaveBeenCalledTimes(2);

    await session.commitAsync();
    expect(session.projectionStore.getNode(embed.id)?.removed).not.toBe(true);
    expect(session.projectionStore.getNode(link.id)?.removed).not.toBe(true);
  });

  it("rejects missing or invalid link-preview resolvers before staging a node", async () => {
    const withoutResolver = new RuntimeSession({ sessionId: "missing-preview-resolver", projection: initial, transport: new InMemoryTransport(initial), scheduleMicrotask: () => {} });
    await expect(withoutResolver.createLinkPreviewAsync("https://example.com")).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_UNAVAILABLE"));
    expect(withoutResolver.projectionStore.pendingTransactionIds()).toEqual([]);

    const transport = new InMemoryTransport(initial) as InMemoryTransport & { resolveLinkPreviewAsync: () => Promise<unknown> };
    transport.resolveLinkPreviewAsync = async () => ({ type: "EMBED", data: { srcUrl: "file:///private", canonicalUrl: null, title: null, provider: null } });
    const invalidResolver = new RuntimeSession({ sessionId: "invalid-preview-resolver", projection: initial, transport: transport as never, scheduleMicrotask: () => {} });
    await expect(invalidResolver.createLinkPreviewAsync("https://example.com")).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_UNAVAILABLE"));
    expect(invalidResolver.projectionStore.pendingTransactionIds()).toEqual([]);
  });

  it("does not register an image when cancellation wins during admission", async () => {
    const registerAssetAsync = vi.fn(async () => undefined);
    const transport = new InMemoryTransport(initial) as InMemoryTransport & { registerAssetAsync: typeof registerAssetAsync };
    transport.registerAssetAsync = registerAssetAsync;
    const session = new RuntimeSession({
      sessionId: "cancel-image",
      projection: initial,
      transport,
      scheduleMicrotask: () => {},
      admitImage: async (_bytes, _mime, signal) => await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const task = session.createImageTask(Uint8Array.of(1), "image/png");
    task.cancel();
    await expect(task.promise).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "TASK_CANCELLED"));
    expect(registerAssetAsync).not.toHaveBeenCalled();
  });

  it("shares ordered page selection state between sessions on one transport", async () => {
    const listeners = new Set<(state: { activePageId: string; selectedIds: readonly string[]; viewport: { x: number; y: number; zoom: number } }) => void>();
    const transport = new InMemoryTransport(initial) as InMemoryTransport & {
      subscribeViewState: (listener: (state: { activePageId: string; selectedIds: readonly string[]; viewport: { x: number; y: number; zoom: number } }) => void) => () => void;
      setSelectionAsync: (ids: readonly string[]) => Promise<void>;
    };
    transport.subscribeViewState = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
    transport.setSelectionAsync = async (ids) => listeners.forEach((listener) => listener({ activePageId: "page", selectedIds: ids, viewport: { x: 0, y: 0, zoom: 1 } }));
    const first = new RuntimeSession({ sessionId: "first", projection: initial, transport, scheduleMicrotask: () => {} });
    const second = new RuntimeSession({ sessionId: "second", projection: initial, transport, scheduleMicrotask: () => {} });
    const node = (await first.getNodeByIdAsync("frame"))!;
    const events: number[] = [];
    second.onViewStateChange((state) => events.push(state.sequence));

    await first.currentPage.setSelectionAsync([node]);
    expect(first.currentPage.selection.map((candidate) => candidate.id)).toEqual(["frame"]);
    expect(second.currentPage.selection.map((candidate) => candidate.id)).toEqual(["frame"]);
    expect(events).toEqual([...events].sort((left, right) => left - right));
  });

  it("lists admitted fonts and paginates a complete dynamic-document query", async () => {
    const projection: RuntimeProjection = {
      revision: 0,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", assets: [{ assetId: "font-1", contentHash: "f".repeat(64), mediaType: "font/ttf", byteLength: 10, fontFaces: [{ faceIndex: 0, family: "Acme Sans", style: "Regular", aliases: [{ family: "思源黑体", style: "常规" }] }, { faceIndex: 1, family: "Acme Sans", style: "Bold" }] }] },
        { id: "page-1", type: "PAGE", parentId: "document", name: "Page 1" },
        { id: "page-2", type: "PAGE", parentId: "document", name: "Page 2" },
        { id: "one", type: "RECTANGLE", parentId: "page-1", pageId: "page-1", name: "One" },
        { id: "two", type: "TEXT", parentId: "page-2", pageId: "page-2", name: "Two" },
      ],
    };
    const session = new RuntimeSession({ sessionId: "paged", projection, currentPageId: "page-1", documentAccess: "dynamic-page", transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    await expect(session.listAvailableFontsAsync()).resolves.toEqual([
      { fontName: { family: "Acme Sans", style: "Regular" }, assetId: "font-1", faceIndex: 0 },
      { fontName: { family: "思源黑体", style: "常规" }, assetId: "font-1", faceIndex: 0 },
      { fontName: { family: "Acme Sans", style: "Bold" }, assetId: "font-1", faceIndex: 1 },
    ]);
    expect(session.hasFontReference({ assetId: "font-1", faceIndex: 1 })).toBe(true);
    expect(session.hasFontReference({ assetId: "font-1", faceIndex: 2 })).toBe(false);
    const pages: string[][] = [];
    for await (const page of session.findAllNodesPagedAsync(2)) pages.push(page.map((node) => node.id));
    expect(pages).toEqual([["page-1", "one"], ["page-2", "two"]]);
  });

  it("cancels outstanding resource tasks when the session closes", async () => {
    const session = new RuntimeSession({
      sessionId: "close-tasks",
      projection: initial,
      transport: new InMemoryTransport(initial),
      scheduleMicrotask: () => {},
      admitImage: async (_bytes, _mime, signal) => await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const task = session.createImageTask(Uint8Array.of(1), "image/png");
    const outcome = task.promise.catch((error: unknown) => error);
    await session.closeAsync();
    expect(isRuntimeError(await outcome, "TASK_CANCELLED")).toBe(true);
  });

  it("exports SVG from a RevisionLease-frozen Canvas projection, never a pending overlay", async () => {
    const canvasRectangle = {
      ...createNode("rectangle", 10, 20),
      id: "exported-rectangle",
      pageId: "page",
      width: 40,
      height: 30,
      fill: "#0048ff",
      strokeWidth: 0,
    };
    const projection: RuntimeProjection = {
      revision: 7,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", parentId: "document", name: "Page" },
        { ...canvasRectangle, type: "RECTANGLE", parentId: "page" },
      ],
    };
    const session = new RuntimeSession({ sessionId: "export", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {} });
    const rectangle = (await session.getNodeByIdAsync(canvasRectangle.id))!;
    rectangle.x = 90;

    await expect(rectangle.exportAsync({ format: "SVG_STRING" })).resolves.toContain('matrix(1 0 0 1 10 20)');
    await expect(rectangle.exportAsync({ format: "SVG_STRING" })).resolves.not.toContain('matrix(1 0 0 1 90 20)');
    await expect(session.exportNodeSvgString("missing")).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "NODE_NOT_FOUND"));
  });

  it("requests live Boolean geometry for the frozen target subtree revision", async () => {
    const boolean = { ...createNode("booleanOperation", 30, 40), id: "exported-boolean", pageId: "page", width: 100, height: 80, fill: "#0048ff", stroke: "transparent" };
    const first = { ...createNode("vector", 0, 0), id: "boolean-first", pageId: "page", parentId: boolean.id, width: 100, height: 80 };
    const second = { ...createNode("vector", 20, 20), id: "boolean-second", pageId: "page", parentId: boolean.id, width: 40, height: 30 };
    const projection: RuntimeProjection = {
      revision: 7,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", parentId: "document", name: "Page" },
        { ...boolean, type: "BOOLEAN_OPERATION", parentId: "page" },
        { ...first, type: "VECTOR" },
        { ...second, type: "VECTOR" },
      ],
    };
    const path = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [
      { id: "p0", x: 0, y: 0, pointType: "corner" as const },
      { id: "p1", x: 100, y: 0, pointType: "corner" as const },
      { id: "p2", x: 100, y: 80, pointType: "corner" as const },
    ] }] };
    const resolveBooleanPathsAsync = vi.fn(async () => new Map([[boolean.id, path]]));
    const transport = Object.assign(new InMemoryTransport(projection), { resolveBooleanPathsAsync });
    const session = new RuntimeSession({ sessionId: "boolean-export", projection, transport, scheduleMicrotask: () => {} });

    await expect(session.exportNodeSvgString(boolean.id)).resolves.toContain("<path");
    expect(resolveBooleanPathsAsync).toHaveBeenCalledWith(7, [boolean.id]);
  });

  it("rasterizes PNG from the same frozen SVG scene with an admitted scale", async () => {
    const canvasRectangle = { ...createNode("rectangle", 10, 20), id: "png-rectangle", pageId: "page", width: 40, height: 30, fill: "#0048ff", strokeWidth: 0 };
    const projection: RuntimeProjection = {
      revision: 7,
      nodes: [{ id: "document", type: "DOCUMENT", name: "Document" }, { id: "page", type: "PAGE", parentId: "document", name: "Page" }, { ...canvasRectangle, type: "RECTANGLE", parentId: "page" }],
    };
    const rasterizePng = vi.fn(async () => Uint8Array.of(137, 80, 78, 71));
    const session = new RuntimeSession({ sessionId: "png-export", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {}, rasterizePng });
    const rectangle = (await session.getNodeByIdAsync(canvasRectangle.id))!;
    rectangle.x = 90;

    await expect(rectangle.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } })).resolves.toEqual(Uint8Array.of(137, 80, 78, 71));
    expect(rasterizePng).toHaveBeenCalledWith(expect.objectContaining({ width: 72, height: 62, scale: 2, svg: expect.stringContaining('matrix(1 0 0 1 10 20)') }));
    await expect(rectangle.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 0 } })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "INVALID_ARGUMENT"));
  });

  it("cancels an in-flight PNG export and settles it before session close completes", async () => {
    const canvasRectangle = { ...createNode("rectangle", 10, 20), id: "cancelled-png", pageId: "page", width: 40, height: 30, fill: "#0048ff", strokeWidth: 0 };
    const projection: RuntimeProjection = {
      revision: 7,
      nodes: [{ id: "document", type: "DOCUMENT", name: "Document" }, { id: "page", type: "PAGE", parentId: "document", name: "Page" }, { ...canvasRectangle, type: "RECTANGLE", parentId: "page" }],
    };
    let exportSignal: AbortSignal | undefined;
    const rasterizePng = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      exportSignal = signal;
      return await new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const session = new RuntimeSession({ sessionId: "cancel-png-export", projection, transport: new InMemoryTransport(projection), scheduleMicrotask: () => {}, rasterizePng });
    const rectangle = (await session.getNodeByIdAsync(canvasRectangle.id))!;
    const outcome = rectangle.exportAsync({ format: "PNG" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(rasterizePng).toHaveBeenCalledOnce());

    await session.closeAsync();

    expect(exportSignal?.aborted).toBe(true);
    expect(isRuntimeError(await outcome, "TASK_CANCELLED")).toBe(true);
  });

  it("fences a resolved M5 CHANGE_TO reaction through the normal transaction path", async () => {
    const projection: RuntimeProjection = {
      ...initial,
      nodes: [...initial.nodes, { id: "variant", type: "COMPONENT", parentId: "page", name: "State=Hover" }],
    };
    const transport = new InMemoryTransport(projection);
    const session = new RuntimeSession({ sessionId: "change-to", projection, transport, scheduleMicrotask: () => {} });
    const frame = (await session.getNodeByIdAsync("frame"))!;
    await frame.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CHANGE_TO", destinationId: "variant", transition: { type: "SMART_ANIMATE", duration: 100 } }] }]);
    expect(transport.submitted[0]?.operations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "update", nodeId: "frame" })]));
    expect(frame.reactions[0]?.actions[0]).toMatchObject({ type: "CHANGE_TO", destinationId: "variant" });
  });
});

function sessionFor(transport: RuntimeTransactionTransport): RuntimeSession {
  let nextId = 0;
  return new RuntimeSession({
    sessionId: "session-1",
    projection: initial,
    transport,
    createId: () => `runtime-${nextId++}`,
    scheduleMicrotask: () => {},
  });
}

class InMemoryTransport implements RuntimeTransactionTransport {
  submitted: PendingProjectionTransaction[] = [];
  private projection: RuntimeProjection;

  constructor(initialProjection: RuntimeProjection, private readonly reject = false) {
    this.projection = structuredClone(initialProjection);
  }

  currentProjection(): RuntimeProjection {
    return structuredClone(this.projection);
  }

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    this.submitted.push(transaction);
    if (this.reject) return { type: "rejected", errorCode: "REVISION_CONFLICT" };
    if (transaction.baseRevision !== this.projection.revision) return { type: "rejected", errorCode: "REVISION_CONFLICT" };
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    for (const operation of transaction.operations) {
      if (operation.type === "create") nodes.set(operation.node.id, { ...structuredClone(operation.node), removed: false });
      else if (operation.type === "componentSet") {
        nodes.set(operation.node.id, { ...structuredClone(operation.node), removed: false });
        operation.childIds.forEach((nodeId, index) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, ...structuredClone(operation.childPatches[index]), parentId: operation.node.id, siblingIndex: index });
        });
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, siblingIndex });
        });
      }
      else if (operation.type === "boolean") {
        nodes.set(operation.node.id, { ...structuredClone(operation.node), removed: false });
        operation.operandIds.forEach((nodeId, index) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, ...structuredClone(operation.operandPatches[index]), parentId: operation.node.id, siblingIndex: index });
        });
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, siblingIndex });
        });
      }
      else if (operation.type === "transformGroup") {
        nodes.set(operation.node.id, { ...structuredClone(operation.node), removed: false });
        operation.childIds.forEach((nodeId, index) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, ...structuredClone(operation.childPatches[index]), parentId: operation.node.id, siblingIndex: index });
        });
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, siblingIndex });
        });
      }
      else if (operation.type === "flattenBoolean") {
        nodes.set(operation.replacement.id, { ...structuredClone(operation.replacement), removed: false });
        nodes.delete(operation.booleanId);
        operation.operandIds.forEach((nodeId) => nodes.delete(nodeId));
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, siblingIndex });
        });
      }
      else if (operation.type === "flattenNode") {
        nodes.set(operation.replacement.id, { ...structuredClone(operation.replacement), removed: false });
        nodes.delete(operation.sourceId);
        operation.siblingIndexes.forEach(({ nodeId, siblingIndex }) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, siblingIndex });
        });
      }
      else if (operation.type === "componentFromNode") {
        nodes.set(operation.replacement.id, { ...structuredClone(operation.replacement), positionId: operation.finalPositionId, removed: false });
        operation.childIds.forEach((nodeId, siblingIndex) => {
          const node = nodes.get(nodeId);
          if (node) nodes.set(nodeId, { ...node, parentId: operation.replacement.id, siblingIndex });
        });
        nodes.delete(operation.sourceId);
      }
      else if (operation.type === "detachInstance") {
        operation.replacements.forEach((replacement, index) => nodes.set(replacement.id, {
          ...structuredClone(replacement),
          ...(index === 0 ? { positionId: operation.finalPositionId } : {}),
          removed: false,
        }));
        operation.sourceIds.forEach((nodeId) => nodes.delete(nodeId));
      }
      else if (operation.type === "remove") nodes.delete(operation.nodeId);
      else {
        const node = nodes.get(operation.nodeId);
        if (!node) return { type: "rejected", errorCode: "TRANSACTION_ABORTED" };
        nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
      }
    }
    this.projection = { revision: this.projection.revision + 1, nodes: [...nodes.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function projectedParagraph(
  node: { readonly textProperties?: unknown } | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const textProperties = node?.textProperties;
  if (!textProperties || typeof textProperties !== "object") return undefined;
  const paragraph = (textProperties as { paragraph?: unknown }).paragraph;
  return paragraph && typeof paragraph === "object"
    ? paragraph as Readonly<Record<string, unknown>>
    : undefined;
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}

async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to reject.");
}
