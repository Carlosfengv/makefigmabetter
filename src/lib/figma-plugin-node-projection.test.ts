import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { figmaPluginNodeType, figmaPluginRelativeTransform, fromFigmaPluginArcData, fromFigmaPluginTransform, projectFigmaPluginNode, toFigmaPluginArcData, toFigmaPluginTransform } from "./figma-plugin-node-projection";
import { extensionsForNodeBlendMode } from "./node-blend-semantics";

describe("Figma Plugin API node projection", () => {
  it("maps each completed Canonical Figma-compatible node kind and deliberately excludes the local Image node", () => {
    expect([
      "booleanOperation", "codeBlock", "component", "ellipse", "frame", "group", "line", "polygon",
      "rectangle", "section", "slice", "star", "text", "vector",
    ].map((kind) => figmaPluginNodeType(kind as Parameters<typeof figmaPluginNodeType>[0]))).toEqual([
      "BOOLEAN_OPERATION", "CODE_BLOCK", "COMPONENT", "ELLIPSE", "FRAME", "GROUP", "LINE", "POLYGON",
      "RECTANGLE", "SECTION", "SLICE", "STAR", "TEXT", "VECTOR",
    ]);
    expect(figmaPluginNodeType("image")).toBeUndefined();
  });

  it("projects CodeBlock's documented source and language fields", () => {
    const codeBlock = { ...createNode("codeBlock", 0, 0), id: "code", text: "const ready = true", codeLanguage: "TYPESCRIPT" };
    expect(projectFigmaPluginNode([codeBlock], codeBlock)).toMatchObject({ type: "CODE_BLOCK", code: "const ready = true", codeLanguage: "TYPESCRIPT" });
  });

  it("projects omitted legacy constraints as the Figma MIN/MIN default", () => {
    const frame = { ...createNode("frame", 0, 0), id: "frame" };
    const child = { ...createNode("rectangle", 20, 10), id: "child", parentId: frame.id };
    expect(child.constraints).toBeUndefined();
    expect(projectFigmaPluginNode([frame, child], child)).toMatchObject({
      constraints: { horizontal: "MIN", vertical: "MIN" },
    });
  });

  it("projects the node-only pass-through blend mode", () => {
    const group = { ...createNode("group", 0, 0), id: "group", blendMode: "pass-through" as const };
    expect(projectFigmaPluginNode([group], group)).toMatchObject({ type: "GROUP", blendMode: "PASS_THROUGH" });
  });

  it("reports legacy NORMAL containers as pass-through and marked containers as isolated NORMAL", () => {
    const legacy = { ...createNode("group", 0, 0), id: "legacy" };
    const isolated = {
      ...createNode("group", 0, 0),
      id: "isolated",
      extensions: extensionsForNodeBlendMode(undefined, "normal"),
    };

    expect(projectFigmaPluginNode([legacy], legacy)).toMatchObject({ blendMode: "PASS_THROUGH" });
    expect(projectFigmaPluginNode([isolated], isolated)).toMatchObject({ blendMode: "NORMAL" });
  });

  it("projects the node-only linear blend modes", () => {
    const burn = { ...createNode("rectangle", 0, 0), id: "burn", blendMode: "linear-burn" as const };
    const dodge = { ...createNode("rectangle", 0, 0), id: "dodge", blendMode: "linear-dodge" as const };
    expect(projectFigmaPluginNode([burn], burn)).toMatchObject({ blendMode: "LINEAR_BURN" });
    expect(projectFigmaPluginNode([dodge], dodge)).toMatchObject({ blendMode: "LINEAR_DODGE" });
  });

  it("projects Component's reusable-container and publication metadata", () => {
    const component = {
      ...createNode("component", 0, 0), id: "component", clipsContent: false,
      componentMetadata: {
        key: "component-key", remote: false, description: "Reusable card", descriptionMarkdown: "**Reusable card**",
        documentationLinks: [{ uri: "https://design.example/card", name: "Card guide" }],
        componentPropertyDefinitions: { state: { type: "BOOLEAN" as const, defaultValue: true, description: "Selected state" } },
      },
    };
    expect(projectFigmaPluginNode([component], component)).toMatchObject({
      type: "COMPONENT", clipsContent: false, key: "component-key", remote: false,
      description: "Reusable card", descriptionMarkdown: "**Reusable card**",
      documentationLinks: [{ uri: "https://design.example/card", name: "Card guide" }],
      componentPropertyDefinitions: { state: { type: "BOOLEAN", defaultValue: true } },
    });
  });

  it("projects ComponentSet publication data, variant groups, and its top-left default component", () => {
    const set = { ...createNode("componentSet", 0, 0), id: "set", componentSetMetadata: { key: "set-key", remote: false, description: "Buttons", descriptionMarkdown: "", documentationLinks: [], variantGroupProperties: { State: { values: ["Default", "Hover"] } } } };
    const hover = { ...createNode("component", 80, 20), id: "hover", parentId: set.id };
    const base = { ...createNode("component", 20, 10), id: "base", parentId: set.id };
    expect(projectFigmaPluginNode([set, hover, base], set)).toMatchObject({ type: "COMPONENT_SET", key: "set-key", description: "Buttons", variantGroupProperties: { State: { values: ["Default", "Hover"] } }, defaultVariantId: "base" });
  });

  it("projects Instance's component link, properties, overrides, and scale", () => {
    const instance = { ...createNode("instance", 0, 0), id: "instance", instanceMetadata: { mainComponentId: "component", scaleFactor: 1.5, componentProperties: { enabled: true }, overrides: [{ id: "label", overriddenFields: ["characters"] }], isExposedInstance: true } };
    expect(projectFigmaPluginNode([instance], instance)).toMatchObject({ type: "INSTANCE", mainComponentId: "component", scaleFactor: 1.5, componentProperties: { enabled: true }, overrides: [{ id: "label", overriddenFields: ["characters"] }], isExposedInstance: true });
  });

  it("projects Slot's component-property identity", () => {
    const slot = { ...createNode("slot", 0, 0), id: "slot", slotMetadata: { propertyName: "Content" } };
    expect(projectFigmaPluginNode([slot], slot)).toMatchObject({ type: "SLOT", slotPropertyName: "Content", clipsContent: true });
  });

  it("projects Connector endpoints, routing, caps, label, and corner radius", () => {
    const connector = { ...createNode("connector", 0, 0), id: "connector", connectorMetadata: { lineType: "ELBOWED" as const, start: { endpointNodeId: "a", magnet: "RIGHT" as const, x: 0, y: 0 }, end: { endpointNodeId: "b", x: 160, y: 20 }, startStrokeCap: "NONE", endStrokeCap: "ARROW_EQUILATERAL", text: "relates to", cornerRadius: 8 } };
    const projection = projectFigmaPluginNode([connector], connector);
    expect(projection).toMatchObject({ type: "CONNECTOR", connectorLineType: "ELBOWED", connectorStartStrokeCap: "NONE", connectorEndStrokeCap: "ARROW_EQUILATERAL", connectorText: "relates to", cornerRadius: 8 });
    expect(projection.connectorStart).toEqual({ endpointNodeId: "a", magnet: "RIGHT" });
    expect(projection.connectorEnd).toEqual({ endpointNodeId: "b", position: { x: 160, y: 20 } });
    const positioned = { ...connector, connectorMetadata: { ...connector.connectorMetadata, start: { x: 4, y: 5 } } };
    expect(projectFigmaPluginNode([positioned], positioned).connectorStart).toEqual({ position: { x: 4, y: 5 } });
  });

  it("projects Embed's readonly resolved preview metadata", () => {
    const embed = { ...createNode("embed", 0, 0), id: "embed", embedMetadata: { srcUrl: "https://player.example/embed/1", canonicalUrl: "https://example.com/watch/1", title: "Demo", provider: "Example" } };
    expect(projectFigmaPluginNode([embed], embed)).toMatchObject({ type: "EMBED", embedData: embed.embedMetadata });
  });

  it("projects Highlight path data and handle mirroring", () => {
    const highlight = { ...createNode("highlight", 0, 0), id: "highlight", highlightHandleMirroring: "ANGLE" as const };
    expect(projectFigmaPluginNode([highlight], highlight)).toMatchObject({ type: "HIGHLIGHT", vectorPaths: highlight.vectorPath, handleMirroring: "ANGLE" });
  });

  it("projects InteractiveSlideElement's readonly interactive type", () => {
    const element = { ...createNode("interactiveSlideElement", 0, 0), id: "slide-element", interactiveSlideElementType: "YOUTUBE" as const };
    expect(projectFigmaPluginNode([element], element)).toMatchObject({ type: "INTERACTIVE_SLIDE_ELEMENT", interactiveSlideElementType: "YOUTUBE" });
  });

  it("projects LinkUnfurl's readonly rich-preview metadata", () => {
    const link = { ...createNode("linkUnfurl", 0, 0), id: "link", linkUnfurlMetadata: { url: "https://example.com/story", title: "Story", description: "Preview", provider: "Example" } };
    expect(projectFigmaPluginNode([link], link)).toMatchObject({ type: "LINK_UNFURL", linkUnfurlData: link.linkUnfurlMetadata });
  });

  it("projects Media's readonly content hash", () => {
    const media = { ...createNode("media", 0, 0), id: "media", mediaMetadata: { hash: "gif-hash" } };
    expect(projectFigmaPluginNode([media], media)).toMatchObject({ type: "MEDIA", mediaData: { hash: "gif-hash" } });
  });

  it("projects ShapeWithText's shape selector and text sublayer", () => {
    const shape = {
      ...createNode("shapeWithText", 0, 0),
      id: "shape",
      shapeWithTextType: "DIAMOND" as const,
      text: "Decision",
      textProperties: {
        runs: [{ start: 0, end: 8, fontSize: 18, fontWeight: 650, italic: false, letterSpacing: 1.5, textCase: "smallCapsForced" as const, hyperlink: { type: "URL" as const, value: "https://example.com/decision" }, textDecoration: "underline" as const, textDecorationStyle: "wavy" as const, textDecorationOffset: { value: -15, unit: "percent" as const }, textDecorationThickness: { value: 12.5, unit: "percent" as const }, textDecorationColor: { color: { space: "srgb" as const, components: [1, .25, .5] as [number, number, number], alpha: 1 }, visible: true, opacity: .75, blendMode: "multiply" as const }, textDecorationSkipInk: true, leadingTrim: "capHeight" as const, textStyleId: "S:decision" }],
        paragraph: { alignment: "center" as const, lineHeight: 24, paragraphSpacing: 4, paragraphIndent: 12, textWrapStyle: "balance" as const, listType: "unordered" as const, listSpacing: 8, hangingList: true, hangingPunctuation: true },
        autoSize: "fixed" as const,
      },
    };
    expect(projectFigmaPluginNode([shape], shape)).toMatchObject({
      type: "SHAPE_WITH_TEXT",
      shapeType: "DIAMOND",
      textSublayer: {
        characters: "Decision",
        textStyleId: "S:decision",
        fontSize: 18,
        fontWeight: 650,
        letterSpacing: { value: 1.5, unit: "PIXELS" },
        textCase: "SMALL_CAPS_FORCED",
        textAlignHorizontal: "CENTER",
        lineHeight: { value: 24, unit: "PIXELS" },
        paragraphSpacing: 4,
        paragraphIndent: 12,
        listSpacing: 8,
        hangingList: true,
        hangingPunctuation: true,
        textWrapStyle: "BALANCE",
        hyperlink: { type: "URL", value: "https://example.com/decision" },
        textDecoration: "UNDERLINE",
        textDecorationStyle: "WAVY",
        textDecorationOffset: { value: -15, unit: "PERCENT" },
        textDecorationThickness: { value: 12.5, unit: "PERCENT" },
        textDecorationColor: { value: { type: "SOLID", color: { r: 1, g: .25, b: .5 }, visible: true, opacity: .75, blendMode: "MULTIPLY" } },
        textDecorationSkipInk: true,
        leadingTrim: "CAP_HEIGHT",
      },
    });
    const percent = {
      ...shape,
      textProperties: {
        ...shape.textProperties,
        paragraph: { ...shape.textProperties.paragraph, lineHeight: 150, lineHeightUnit: "percent" as const },
      },
    };
    expect(projectFigmaPluginNode([percent], percent)?.textSublayer?.lineHeight).toEqual({ value: 150, unit: "PERCENT" });
    const auto = {
      ...shape,
      textProperties: {
        ...shape.textProperties,
        paragraph: { ...shape.textProperties.paragraph, lineHeight: undefined, lineHeightUnit: "auto" as const },
      },
    };
    expect(projectFigmaPluginNode([auto], auto)?.textSublayer?.lineHeight).toEqual({ unit: "AUTO" });
  });

  it("projects an imported SlideGrid as its distinct read-only Slides root type", () => {
    const grid = { ...createNode("slideGrid", 0, 0), id: "slide-grid" };
    expect(projectFigmaPluginNode([grid], grid)).toMatchObject({ type: "SLIDE_GRID", name: "Slide grid" });
  });

  it("projects a Slide's skipped flag and full transition payload", () => {
    const slide = { ...createNode("slide", 0, 0), id: "slide", slideMetadata: { isSkippedSlide: true, transition: { style: "SMART_ANIMATE" as const, duration: .45, curve: "GENTLE" as const, timing: { type: "AFTER_DELAY" as const, delay: 1.2 } } } };
    expect(projectFigmaPluginNode([slide], slide)).toMatchObject({ type: "SLIDE", width: 1920, height: 1080, isSkippedSlide: true, slideTransition: slide.slideMetadata.transition });
  });

  it("projects an imported SlideRow as its structural Slides type", () => {
    const row = { ...createNode("slideRow", 0, 0), id: "slide-row" };
    expect(projectFigmaPluginNode([row], row)).toMatchObject({ type: "SLIDE_ROW", name: "Slide row" });
  });

  it("projects Stamp through its official type and name-based stamp category", () => {
    const stamp = { ...createNode("stamp", 0, 0), id: "stamp", name: "Thumbs up" };
    expect(projectFigmaPluginNode([stamp], stamp)).toMatchObject({ type: "STAMP", name: "Thumbs up" });
  });

  it("projects Sticky text, author presentation, and width mode", () => {
    const sticky = { ...createNode("sticky", 0, 0), id: "sticky", text: "Vote", stickyMetadata: { authorVisible: false, authorName: "Ada", isWideWidth: true } };
    expect(projectFigmaPluginNode([sticky], sticky)).toMatchObject({ type: "STICKY", stickyTextSublayer: { characters: "Vote" }, authorVisible: false, authorName: "Ada", isWideWidth: true });
  });

  it("projects Table dimensions and TableCell coordinates with text", () => {
    const table = { ...createNode("table", 0, 0), id: "table", tableMetadata: { rowHeights: [24, 30], columnWidths: [100, 120] } };
    const cell = { ...createNode("tableCell", 0, 0), id: "cell", parentId: table.id, text: "A1", tableCellMetadata: { rowIndex: 0, columnIndex: 0 } };
    expect(projectFigmaPluginNode([table, cell], table)).toMatchObject({ type: "TABLE", numRows: 2, numColumns: 2 });
    expect(projectFigmaPluginNode([table, cell], cell)).toMatchObject({ type: "TABLE_CELL", rowIndex: 0, columnIndex: 0, tableCellTextSublayer: { characters: "A1" } });
  });

  it("projects TextPath's beta text, path, and alignment fields", () => {
    const textPath = { ...createNode("textPath", 0, 0), id: "text-path", text: "Along the line", textPathMetadata: { startSegment: 1, startPosition: .25, autoRename: false, textAlignHorizontal: "CENTER" as const, textAlignVertical: "BOTTOM" as const } };
    expect(projectFigmaPluginNode([textPath], textPath)).toMatchObject({ type: "TEXT_PATH", characters: "Along the line", vectorPaths: expect.anything(), textPathStartData: { segment: 1, position: .25 }, hasMissingFont: false, textAlignHorizontal: "CENTER", textAlignVertical: "BOTTOM", autoRename: false });
  });

  it("projects TransformGroup's repeat modifiers", () => {
    const group = { ...createNode("transformGroup", 0, 0), id: "transform-group", isMask: true, transformModifiers: [{ type: "REPEAT" as const, count: 4, unitType: "PIXELS" as const, offset: 24, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const }] };
    expect(projectFigmaPluginNode([group], group)).toMatchObject({ type: "TRANSFORM_GROUP", transformModifiers: group.transformModifiers, isMask: true, maskType: "ALPHA" });
  });

  it("projects Group BlendMixin masks while omitting isMask from Slice and Section", () => {
    const group = { ...createNode("group", 0, 0), id: "group-mask", isMask: true };
    const slice = { ...createNode("slice", 0, 0), id: "slice", isMask: true };
    const section = { ...createNode("section", 0, 0), id: "section", isMask: true };
    expect(projectFigmaPluginNode([group], group)).toMatchObject({ type: "GROUP", isMask: true, maskType: "ALPHA" });
    expect(projectFigmaPluginNode([slice], slice)).not.toHaveProperty("isMask");
    expect(projectFigmaPluginNode([section], section)).not.toHaveProperty("isMask");
  });

  it("projects WashiTape as its dedicated FigJam node type", () => {
    const tape = { ...createNode("washiTape", 0, 0), id: "tape" };
    expect(projectFigmaPluginNode([tape], tape)).toMatchObject({ type: "WASHI_TAPE", name: "Washi tape" });
  });

  it("projects Widget identity and its same-widget synced state", () => {
    const widget = { ...createNode("widget", 0, 0), id: "widget", widgetMetadata: { widgetId: "com.example.widget", syncedState: { votes: 2 }, syncedMap: {} } };
    expect(projectFigmaPluginNode([widget], widget)).toMatchObject({ type: "WIDGET", widgetId: "com.example.widget", widgetSyncedState: { votes: 2 } });
  });

  it("round-trips Figma's two-by-three Transform shape without transposing coefficients", () => {
    const figma = [[0, -1, 40], [1, 0, 20]] as const;
    const canonical = fromFigmaPluginTransform(figma);
    expect(canonical).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 40, f: 20 });
    expect(canonical && toFigmaPluginTransform(canonical)).toEqual(figma);
    expect(fromFigmaPluginTransform([[1, 0, 0], [0, 0, 0]])).toBeUndefined();
  });

  it("uses radians at the Plugin API boundary and preserves both valid arc endpoints", () => {
    expect(fromFigmaPluginArcData({ startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 })).toEqual({ startingAngle: 0, endingAngle: 180, innerRadius: 0 });
    expect(toFigmaPluginArcData({ startingAngle: 0, endingAngle: 360, innerRadius: 1 })).toEqual({ startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 1 });
    expect(fromFigmaPluginArcData({ startingAngle: 0, endingAngle: 1, innerRadius: 1.01 })).toBeUndefined();
  });

  it("projects all twelve node kinds and exposes their documented type-specific fields", () => {
    const nodes = [
      createNode("booleanOperation", 0, 0), createNode("ellipse", 0, 0), createNode("frame", 0, 0), createNode("group", 0, 0),
      createNode("line", 0, 0), createNode("polygon", 0, 0), createNode("rectangle", 0, 0), createNode("section", 0, 0),
      createNode("slice", 0, 0), createNode("star", 0, 0), createNode("text", 0, 0), createNode("vector", 0, 0),
    ];
    const projections = nodes.map((node) => projectFigmaPluginNode(nodes, node));

    expect(projections.map((node) => node?.type)).toEqual([
      "BOOLEAN_OPERATION", "ELLIPSE", "FRAME", "GROUP", "LINE", "POLYGON",
      "RECTANGLE", "SECTION", "SLICE", "STAR", "TEXT", "VECTOR",
    ]);
    expect(projections[2]).toMatchObject({ clipsContent: true });
    expect(projections[6]).toMatchObject({ type: "RECTANGLE", opacity: 1, blendMode: "NORMAL", isMask: false, maskType: "ALPHA" });
    expect(projections[7]).toMatchObject({ sectionContentsHidden: false });
    expect(projections[6]).toMatchObject({ cornerRadius: 12, cornerSmoothing: 0, topLeftRadius: 12, topRightRadius: 12, bottomRightRadius: 12, bottomLeftRadius: 12 });
    expect(projections[5]).toMatchObject({ pointCount: 5 });
    expect(projections[9]).toMatchObject({ pointCount: 5, innerRadius: .5 });
    expect(projections[10]).toMatchObject({ characters: "Type something" });
    expect(projections[8]).not.toHaveProperty("opacity");
  });

  it("reports a child of a Group relative to its containing Frame rather than its structural Group", () => {
    const frame = { ...createNode("frame", 100, 50), id: "frame", relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 } };
    const group = { ...createNode("group", 0, 0), id: "group", parentId: frame.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 10 } };
    const rectangle = { ...createNode("rectangle", 0, 0), id: "rectangle", parentId: group.id, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 } };
    const nodes = [frame, group, rectangle];

    expect(figmaPluginRelativeTransform(nodes, rectangle)).toEqual([[1, 0, 25], [0, 1, 17]]);
    expect(projectFigmaPluginNode(nodes, rectangle)).toMatchObject({ x: 25, y: 17, absoluteTransform: [[1, 0, 125], [0, 1, 67]] });
  });
});
