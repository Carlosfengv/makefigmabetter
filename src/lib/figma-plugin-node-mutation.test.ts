import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { addFigmaPluginComponentProperty, createFigmaPluginGif, createFigmaPluginInstance, createFigmaPluginLinkPreview, createFigmaPluginLinkUnfurl, createFigmaPluginShapeWithText, createFigmaPluginSlide, createFigmaPluginSlideRow, createFigmaPluginSticky, createFigmaPluginSlot, createFigmaPluginTable, createFigmaPluginTextPath, createFigmaPluginTransformGroup, deleteFigmaPluginComponentProperty, editFigmaPluginComponentProperty, getFigmaPluginData, reconnectFigmaPluginConnector, removeFigmaPluginInstanceOverrides, removeFigmaPluginNode, resizeFigmaPluginNode, resizeFigmaPluginTableTrack, setFigmaPluginData, setFigmaPluginHighlightVectorNetwork, setFigmaPluginInstanceProperties, setFigmaPluginSlideTransition, setFigmaPluginWidgetSyncedState, swapFigmaPluginComponent, tableCellAt, writeFigmaPluginNode } from "./figma-plugin-node-mutation";
import { resolveCoreBatch } from "./transaction-batch";

describe("Figma Plugin API node mutation adapter", () => {
  it("turns supported common setters into one Canonical update plus a set-mask command", () => {
    const node = { ...createNode("rectangle", 0, 0), id: "rectangle" };
    const result = writeFigmaPluginNode(node, {
      name: "Card", visible: false, locked: true, opacity: .4, blendMode: "MULTIPLY", rotation: 15,
      constraints: { horizontal: "CENTER", vertical: "SCALE" }, isMask: true,
    });
    expect(result).toEqual({ ok: true, commands: [
      { type: "update", id: node.id, patch: { name: "Card", visible: false, locked: true, opacity: .4, blendMode: "multiply", rotation: 15, constraints: { horizontal: "center", vertical: "scale" } } },
      { type: "setMask", id: node.id, enabled: true },
    ] });
    expect(result.ok && resolveCoreBatch([node], result.commands)?.nextNodes[0]).toMatchObject({ name: "Card", visible: false, locked: true, opacity: .4, blendMode: "multiply", isMask: true });
  });

  it("uses Plugin API radians for ellipse arcs and type-gates node-specific setters", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), id: "ellipse" };
    expect(writeFigmaPluginNode(ellipse, { arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 } })).toEqual({ ok: true, commands: [{ type: "update", id: ellipse.id, patch: { arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } } }] });
    expect(writeFigmaPluginNode(ellipse, { pointCount: 5 })).toEqual({ ok: false, reason: "pointCount is writable only on POLYGON and STAR nodes." });
  });

  it("writes CodeBlock source and language only on CODE_BLOCK nodes", () => {
    const codeBlock = { ...createNode("codeBlock", 0, 0), id: "code" };
    expect(writeFigmaPluginNode(codeBlock, { code: "SELECT 1", codeLanguage: "SQL" })).toEqual({ ok: true, commands: [{
      type: "update", id: codeBlock.id, patch: { text: "SELECT 1", codeLanguage: "SQL" },
    }] });
    expect(writeFigmaPluginNode(createNode("text", 0, 0), { code: "SELECT 1" })).toEqual({ ok: false, reason: "code is writable only on CODE_BLOCK nodes and must be a string." });
  });

  it("writes mutable Component publication metadata and protects remote Components", () => {
    const component = { ...createNode("component", 0, 0), id: "component" };
    expect(writeFigmaPluginNode(component, {
      description: "Reusable card", descriptionMarkdown: "**Reusable card**",
      documentationLinks: [{ uri: "https://design.example/card", name: "Card guide" }],
    })).toEqual({ ok: true, commands: [{ type: "update", id: component.id, patch: {
      componentMetadata: {
        key: component.componentMetadata!.key, remote: false, description: "Reusable card", descriptionMarkdown: "**Reusable card**",
        documentationLinks: [{ uri: "https://design.example/card", name: "Card guide" }], componentPropertyDefinitions: {},
      },
    } }] });
    const remote = { ...component, componentMetadata: { key: "remote", remote: true, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} } };
    expect(writeFigmaPluginNode(remote, { description: "Nope" })).toEqual({ ok: false, reason: "remote COMPONENT nodes are read-only." });
  });

  it("writes ComponentSet publication metadata with the same remote protection", () => {
    const set = { ...createNode("componentSet", 0, 0), id: "set" };
    expect(writeFigmaPluginNode(set, { description: "Variants" })).toMatchObject({ ok: true, commands: [{ type: "update", id: set.id, patch: { componentSetMetadata: expect.objectContaining({ description: "Variants" }) } }] });
    const remote = { ...set, componentSetMetadata: { key: "remote", remote: true, description: "", descriptionMarkdown: "", documentationLinks: [], variantGroupProperties: {} } };
    expect(writeFigmaPluginNode(remote, { description: "Nope" })).toEqual({ ok: false, reason: "remote COMPONENT_SET nodes are read-only." });
  });

  it("writes Connector routing, endpoints, and caps through durable connector metadata", () => {
    const connector = { ...createNode("connector", 0, 0), id: "connector" };
    const result = writeFigmaPluginNode(connector, {
      connectorLineType: "ELBOWED",
      connectorStart: { endpointNodeId: "a", magnet: "RIGHT", x: 0, y: 0 },
      connectorEnd: { endpointNodeId: "b", magnet: "LEFT", x: 160, y: 0 },
      connectorStartStrokeCap: "NONE",
      connectorEndStrokeCap: "ARROW_EQUILATERAL",
    });
    expect(result).toMatchObject({ ok: true, commands: [{ type: "update", id: connector.id, patch: { connectorMetadata: {
      lineType: "ELBOWED", start: { endpointNodeId: "a", magnet: "RIGHT" }, end: { endpointNodeId: "b", magnet: "LEFT" }, endStrokeCap: "ARROW_EQUILATERAL",
    } } }] });
    expect(reconnectFigmaPluginConnector(connector, { x: 4, y: 5 }, { x: 100, y: 20 })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { connectorMetadata: { start: { x: 4, y: 5 }, end: { x: 100, y: 20 } } } }] });
    expect(writeFigmaPluginNode(createNode("line", 0, 0), { connectorLineType: "CURVED" })).toEqual({ ok: false, reason: "connector properties are writable only on CONNECTOR nodes." });
  });

  it("creates an Embed only through validated resolved link-preview data", () => {
    const created = createFigmaPluginLinkPreview({ srcUrl: "https://player.example/embed/1", canonicalUrl: "https://example.com/watch/1", title: "Demo", provider: "Example" }, 12, 24, () => "embed");
    expect(created).toMatchObject({ ok: true, embedId: "embed", commands: [{ type: "create", node: { kind: "embed", name: "Demo", embedMetadata: { provider: "Example" } } }] });
    expect(createFigmaPluginLinkPreview({ srcUrl: "not a URL", canonicalUrl: null, title: null, provider: null }, 0, 0, () => "invalid")).toEqual({ ok: false, reason: "createLinkPreviewAsync requires a valid HTTP(S) EmbedData payload and finite coordinates." });
  });

  it("writes Highlight handle mirroring and its canonical vector path", () => {
    const highlight = { ...createNode("highlight", 0, 0), id: "highlight" };
    expect(writeFigmaPluginNode(highlight, { handleMirroring: "ANGLE_AND_LENGTH" })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { highlightHandleMirroring: "ANGLE_AND_LENGTH" } }] });
    expect(setFigmaPluginHighlightVectorNetwork(highlight, highlight.vectorPath!)).toMatchObject({ ok: true, commands: [{ type: "update", patch: { vectorPath: highlight.vectorPath } }] });
    expect(writeFigmaPluginNode(createNode("vector", 0, 0), { handleMirroring: "ANGLE" })).toEqual({ ok: false, reason: "handleMirroring is writable only on HIGHLIGHT nodes and must be NONE, ANGLE, or ANGLE_AND_LENGTH." });
  });

  it("creates a LinkUnfurl only through validated resolved preview data", () => {
    const created = createFigmaPluginLinkUnfurl({ url: "https://example.com/story", title: "Story", description: "Preview", provider: "Example" }, 12, 24, () => "link");
    expect(created).toMatchObject({ ok: true, linkUnfurlId: "link", commands: [{ type: "create", node: { kind: "linkUnfurl", name: "Story", linkUnfurlMetadata: { provider: "Example" } } }] });
  });

  it("creates Media from a registered GIF resource and preserves its hash", () => {
    const created = createFigmaPluginGif("asset-gif", "gif-hash", 320, 180, 12, 24, () => "media");
    expect(created).toMatchObject({ ok: true, mediaId: "media", commands: [{ type: "create", node: { kind: "media", assetId: "asset-gif", width: 320, mediaMetadata: { hash: "gif-hash" } } }] });
    expect(createFigmaPluginGif("", "hash", 1, 1, 0, 0, () => "invalid")).toEqual({ ok: false, reason: "createGif requires non-empty assetId/hash and positive finite dimensions." });
  });

  it("writes ShapeWithText's official shape selector only on that node type", () => {
    const shape = { ...createNode("shapeWithText", 0, 0), id: "shape" };
    expect(writeFigmaPluginNode(shape, { shapeType: "DIAMOND" })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { shapeWithTextType: "DIAMOND" } }] });
    expect(writeFigmaPluginNode(createNode("rectangle", 0, 0), { shapeType: "DIAMOND" })).toEqual({ ok: false, reason: "shapeType is writable only on SHAPE_WITH_TEXT nodes and must be an official ShapeWithText type." });
    expect(createFigmaPluginShapeWithText("DIAMOND", 1, 2, () => "shape")).toMatchObject({ ok: true, shapeWithTextId: "shape", commands: [{ type: "create", node: { kind: "shapeWithText", shapeWithTextType: "DIAMOND" } }] });
  });

  it("rejects all direct SlideGrid writes because Plugin API exposes only its rows", () => {
    const grid = { ...createNode("slideGrid", 0, 0), id: "slide-grid" };
    expect(writeFigmaPluginNode(grid, { name: "Cannot rename" })).toEqual({ ok: false, reason: "SLIDE_GRID is read-only; manipulate its SLIDE_ROW children instead." });
  });

  it("writes Slide state and transition but rejects every geometry transformation", () => {
    const slide = { ...createNode("slide", 0, 0), id: "slide" };
    expect(writeFigmaPluginNode(slide, { isSkippedSlide: true })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { slideMetadata: { isSkippedSlide: true } } }] });
    expect(setFigmaPluginSlideTransition(slide, { style: "DISSOLVE", duration: .2, curve: "EASE_OUT", timing: { type: "ON_CLICK", delay: 4 } })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { slideMetadata: { transition: { timing: { type: "ON_CLICK" } } } } }] });
    expect(writeFigmaPluginNode(slide, { rotation: 1 })).toEqual({ ok: false, reason: "SLIDE is fixed at 1920x1080 and cannot be rotated or transformed." });
    expect(resizeFigmaPluginNode(slide, 100, 100)).toEqual({ ok: false, reason: "SLIDE is fixed at 1920x1080 and cannot be resized." });
  });

  it("creates a SlideRow only under the SlideGrid and keeps it read-only", () => {
    const grid = { ...createNode("slideGrid", 0, 0), id: "grid" };
    expect(createFigmaPluginSlideRow(grid, () => "row")).toMatchObject({ ok: true, slideRowId: "row", commands: [{ type: "create", node: { kind: "slideRow", parentId: "grid" } }] });
    expect(createFigmaPluginSlideRow(createNode("frame", 0, 0), () => "row")).toEqual({ ok: false, reason: "createSlideRow requires the Slide Grid node." });
    expect(writeFigmaPluginNode({ ...createNode("slideRow", 0, 0), id: "row" }, { name: "Nope" })).toEqual({ ok: false, reason: "SLIDE_ROW is read-only; manipulate its SLIDE children instead." });
  });

  it("creates a fixed-size Slide only under a SlideRow", () => {
    const row = { ...createNode("slideRow", 0, 0), id: "row" };
    expect(createFigmaPluginSlide(row, () => "slide")).toMatchObject({ ok: true, slideId: "slide", commands: [{ type: "create", node: { kind: "slide", parentId: "row", width: 1920, height: 1080 } }] });
    expect(createFigmaPluginSlide(createNode("frame", 0, 0), () => "slide")).toEqual({ ok: false, reason: "createSlide requires a Slide Row node." });
  });

  it("creates and writes Sticky's documented text and presentation fields", () => {
    const sticky = { ...createNode("sticky", 0, 0), id: "sticky" };
    expect(createFigmaPluginSticky("Ada", 1, 2, () => "new-sticky")).toMatchObject({ ok: true, stickyId: "new-sticky", commands: [{ type: "create", node: { kind: "sticky", stickyMetadata: { authorName: "Ada" } } }] });
    expect(writeFigmaPluginNode(sticky, { stickyText: "Vote", authorVisible: false, isWideWidth: true })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { text: "Vote", stickyMetadata: { authorVisible: false, isWideWidth: true } } }] });
  });

  it("creates Table cells and exposes cell lookup and track resize", () => {
    let id = 0;
    const created = createFigmaPluginTable(2, 2, 0, 0, () => `id-${id++}`);
    expect(created.ok && created.commands).toHaveLength(5);
    if (!created.ok) throw new Error(created.reason);
    const nodes = created.commands.map((command) => command.type === "create" ? command.node : undefined).filter(Boolean) as ReturnType<typeof createNode>[];
    const table = nodes[0]!;
    expect(tableCellAt(nodes, table, 1, 1)?.tableCellMetadata).toEqual({ rowIndex: 1, columnIndex: 1 });
    expect(resizeFigmaPluginTableTrack(table, "column", 1, 240)).toMatchObject({ ok: true, commands: [{ type: "update", patch: { tableMetadata: { columnWidths: [200, 240] } } }] });
  });

  it("writes TextPath text and documented path-alignment metadata", () => {
    const textPath = { ...createNode("textPath", 0, 0), id: "text-path" };
    expect(writeFigmaPluginNode(textPath, { characters: "Curved title", textPathStartData: { segment: 1, position: .5 }, textAlignHorizontal: "JUSTIFIED", textAlignVertical: "CENTER", autoRename: false })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { text: "Curved title", name: "Curved title", textPathMetadata: { startSegment: 1, startPosition: .5, textAlignHorizontal: "JUSTIFIED", textAlignVertical: "CENTER", autoRename: false } } }] });
    expect(writeFigmaPluginNode(createNode("rectangle", 0, 0), { textAlignHorizontal: "LEFT" })).toEqual({ ok: false, reason: "text-path properties are writable only on TEXT_PATH nodes." });
  });

  it("converts a Vector into a TextPath at its documented segment and position", () => {
    const vector = { ...createNode("vector", 0, 0), id: "vector" };
    expect(createFigmaPluginTextPath(vector, 0, .5, () => "text-path")).toMatchObject({ ok: true, textPathId: "text-path", commands: [{ type: "delete", ids: ["vector"] }, { type: "create", node: { kind: "textPath", textPathMetadata: { startSegment: 0, startPosition: .5 } } }] });
    expect(createFigmaPluginTextPath(createNode("rectangle", 0, 0), 0, .5, () => "text-path")).toEqual({ ok: false, reason: "createTextPath currently requires a VECTOR with a Canonical vector path." });
  });

  it("creates and writes a TransformGroup repeat modifier", () => {
    const modifier = [{ type: "REPEAT" as const, count: 3, unitType: "RELATIVE" as const, offset: 1, repeatType: "RADIAL" as const }];
    const a = { ...createNode("rectangle", 0, 0), id: "a" }, b = { ...createNode("rectangle", 50, 0), id: "b" };
    expect(createFigmaPluginTransformGroup([a, b], modifier, () => "transform-group")).toMatchObject({ ok: true, transformGroupId: "transform-group", commands: [{ type: "transformGroup", ids: ["a", "b"], id: "transform-group", modifiers: modifier }] });
    expect(writeFigmaPluginNode({ ...createNode("transformGroup", 0, 0), id: "transform-group" }, { transformModifiers: modifier })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { transformModifiers: modifier } }] });
  });

  it("sets Widget synced state only for its matching widget identity", () => {
    const widget = { ...createNode("widget", 0, 0), id: "widget", widgetMetadata: { widgetId: "com.example.widget", syncedState: {}, syncedMap: {} } };
    expect(setFigmaPluginWidgetSyncedState(widget, "com.example.widget", { votes: 3 }, { users: { ada: true } })).toMatchObject({ ok: true, commands: [{ type: "update", patch: { widgetMetadata: { syncedState: { votes: 3 }, syncedMap: { users: { ada: true } } } } }] });
    expect(setFigmaPluginWidgetSyncedState(widget, "other.widget", {})).toEqual({ ok: false, reason: "setWidgetSyncedState requires a WIDGET owned by the caller and plain state maps." });
  });

  it("creates a linked INSTANCE subtree and supports property writes and component swapping", () => {
    const component = { ...createNode("component", 0, 0), id: "component", componentMetadata: { key: "component", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: { enabled: { type: "BOOLEAN" as const, defaultValue: true } } } };
    const child = { ...createNode("rectangle", 8, 8), id: "child", parentId: component.id };
    const other = { ...createNode("component", 100, 0), id: "other", componentMetadata: { key: "other", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: { title: { type: "TEXT" as const, defaultValue: "New card" } } } };
    let sequence = 0;
    const created = createFigmaPluginInstance([component, child, other], component.id, () => `instance-${sequence++}`);
    expect(created.ok && created.commands).toHaveLength(2);
    const resolved = created.ok ? resolveCoreBatch([component, child, other], created.commands) : undefined;
    const instance = resolved?.nextNodes.find((node) => node.kind === "instance");
    if (!instance) throw new Error("expected created instance");
    expect(instance?.instanceMetadata).toMatchObject({ mainComponentId: component.id, componentProperties: { enabled: true }, scaleFactor: 1 });
    expect(resolved?.nextNodes.find((node) => node.parentId === instance?.id)?.extensions?.["figma.instance.source-node.v1"]).toBeDefined();
    const synchronized = resolved && resolveCoreBatch(resolved.nextNodes, [{ type: "update", id: component.id, patch: { fill: "#123456" } }]);
    expect(synchronized?.nextNodes.find((node) => node.id === instance?.id)?.fill).toBe("#123456");
    expect(setFigmaPluginInstanceProperties(instance, { enabled: false })).toMatchObject({ ok: true });
    const overridden = { ...instance, instanceMetadata: { ...instance.instanceMetadata!, overrides: [{ id: "child", overriddenFields: ["characters"] }] } };
    expect(removeFigmaPluginInstanceOverrides(overridden)).toEqual({ ok: true, commands: [{ type: "update", id: instance.id, patch: { instanceMetadata: { ...overridden.instanceMetadata, overrides: [] } } }] });
    expect(swapFigmaPluginComponent([component, other, instance], instance.id, other.id)).toMatchObject({ ok: true, commands: [{ type: "update", id: instance.id, patch: { instanceMetadata: expect.objectContaining({ mainComponentId: other.id, componentProperties: { title: "New card" } }) } }] });
  });

  it("adds, edits, and deletes Component property definitions", () => {
    const component = { ...createNode("component", 0, 0), id: "component", componentMetadata: { key: "component", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} } };
    const added = addFigmaPluginComponentProperty(component, "Enabled#1", { type: "BOOLEAN", defaultValue: true, description: "Visibility" });
    expect(added).toMatchObject({ ok: true });
    const addedResult = added.ok ? resolveCoreBatch([component], added.commands) : undefined;
    if (added.ok && !addedResult?.nextNodes[0]) throw new Error("expected added component property");
    const updated = addedResult?.nextNodes[0] ?? component;
    expect(editFigmaPluginComponentProperty(updated, "Enabled#1", { description: "Show card" })).toMatchObject({ ok: true });
    expect(deleteFigmaPluginComponentProperty(updated, "Enabled#1")).toMatchObject({ ok: true });
  });

  it("creates a SLOT and its matching Component property atomically", () => {
    const component = { ...createNode("component", 0, 0), id: "component", componentMetadata: { key: "component", remote: false, description: "", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: {} } };
    const created = createFigmaPluginSlot(component, "Content", () => "slot");
    expect(created).toMatchObject({ ok: true, slotId: "slot" });
    const resolved = created.ok ? resolveCoreBatch([component], created.commands) : undefined;
    expect(resolved?.nextNodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "slot", parentId: component.id, slotMetadata: { propertyName: "Content" } })]));
    expect(resolved?.nextNodes.find((node) => node.id === component.id)?.componentMetadata?.componentPropertyDefinitions.Content).toEqual({ type: "SLOT" });
  });

  it("keeps uniform and individual corner setters in the Canonical corner representation", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "rectangle", radius: 4 };
    expect(writeFigmaPluginNode(rectangle, { cornerRadius: 8, topLeftRadius: 2, bottomRightRadius: 12, cornerSmoothing: .6 })).toEqual({ ok: true, commands: [{
      type: "update", id: rectangle.id, patch: { radius: 8, cornerRadii: [2, 8, 12, 8], cornerSmoothing: .6 },
    }] });
  });

  it("preserves explicit no-loss limits instead of pretending to support unavailable values", () => {
    const star = { ...createNode("star", 0, 0), id: "star" };
    expect(writeFigmaPluginNode(star, { innerRadius: 0 })).toEqual({ ok: false, reason: "STAR innerRadius is currently supported from 0.05 through 0.95." });
    expect(writeFigmaPluginNode(star, { blendMode: "COLOR" as never })).toEqual({ ok: false, reason: "COLOR is not in the Canonical blend-mode subset." });
  });

  it("models resize, remove, and namespaced plugin data as ordinary transactions", () => {
    const node = { ...createNode("text", 0, 0), id: "text" };
    expect(resizeFigmaPluginNode(node, 320, 40)).toEqual({ ok: true, commands: [{ type: "update", id: node.id, patch: { width: 320, height: 40 } }] });
    expect(removeFigmaPluginNode(node)).toEqual({ ok: true, commands: [{ type: "delete", ids: [node.id] }] });
    const write = setFigmaPluginData(node, "com.example.plugin", "state", "ready");
    expect(write.ok).toBe(true);
    const updated = write.ok ? resolveCoreBatch([node], write.commands)?.nextNodes[0] : undefined;
    expect(updated && getFigmaPluginData(updated, "com.example.plugin", "state")).toBe("ready");
    expect(updated && setFigmaPluginData(updated, "com.example.plugin", "state", "").ok).toBe(true);
  });
});
