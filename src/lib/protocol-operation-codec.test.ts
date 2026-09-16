import { BlendMode, ColorSpace, ConstraintType, GridTrackType, HyperlinkType, ImageScaleMode, LayoutAlignment, LayoutMode, LayoutSizing, LeadingTrim, LineHeightUnit, NodeKind, ResolvedOperationBatch, StrokeAlign, StrokeCap, TextAlignment, TextCase, TextDecoration, TextDecorationOffsetUnit, TextDecorationStyle, TextDecorationThicknessUnit, TextListType, TextStyleLetterSpacingUnit, TextWrapStyle, VariableResolvedType, WrapTrackAlignment } from "@makefigma/protocol-types";
import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { encodeCoreBatchPayload, encodeCreatePagePayload, encodeRegisterResourcePayload, idBytes } from "./protocol-operation-codec";
import { resolveCoreBatch } from "./transaction-batch";

const id = "00000000-0000-4000-8000-000000000001";

describe("protocol operation codec", () => {
  it("serializes worker-resolved creates as generated protobuf operations", () => {
    const node = { ...createNode("rectangle", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations).toHaveLength(1);
    expect(batch.operations[0].createNode?.node).toMatchObject({ name: node.name, kind: NodeKind.NODE_KIND_RECTANGLE, nodeId: idBytes(id), pageId: idBytes(node.pageId!) });
  });

  it("serializes an imported Page before its scene nodes in one remote operation batch", () => {
    const page = { id: "00000000-0000-4000-8000-0000000000a0", name: "Imported", positionId: "40000000000000000000000000000000:00000000000000000000000000000000" };
    const node = { ...createNode("rectangle", 10, 20), id, pageId: page.id, positionId: "80000000000000000000000000000000:00000000000000000000000000000000" };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([{ type: "createPage", page }, ...resolved!.batch]));

    expect(batch.operations[0].createPage?.page).toMatchObject({ pageId: idBytes(page.id), name: "Imported" });
    expect(batch.operations[1].createNode?.node).toMatchObject({ pageId: idBytes(page.id), nodeId: idBytes(id) });
  });

  it("serializes canonical TextStyle registration with identity and values", () => {
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([{
      type: "registerTextStyle",
      style: {
        id: "S:body",
        key: "library-key",
        name: "Body",
        description: "Body copy",
        descriptionMarkdown: "**Body** copy",
        documentationLinks: [{ uri: "https://example.com/styles/body" }],
        remote: true,
        style: { fontSize: 16, fontWeight: 450, italic: false, letterSpacing: .25, textCase: "smallCaps" },
        letterSpacingUnit: "percent",
        variableBindings: { paragraphSpacing: "V:space", fontSize: "V:size" },
        paragraph: { alignment: "left", lineHeight: 150, lineHeightUnit: "percent", paragraphSpacing: 6 },
      },
    }]));

    expect(batch.operations).toHaveLength(1);
    expect(batch.operations[0]?.registerTextStyle?.style).toMatchObject({
      id: "S:body",
      key: "library-key",
      name: "Body",
      description: "Body copy",
      descriptionMarkdown: "**Body** copy",
      documentationLinks: [{ uri: "https://example.com/styles/body" }],
      remote: true,
      style: { fontSize: 16, fontWeight: 450, letterSpacing: .25, textCase: TextCase.TEXT_CASE_SMALL_CAPS },
      letterSpacingUnit: TextStyleLetterSpacingUnit.TEXT_STYLE_LETTER_SPACING_UNIT_PERCENT,
      variableBindings: [
        { field: "fontSize", variableId: "V:size" },
        { field: "paragraphSpacing", variableId: "V:space" },
      ],
      paragraph: { alignment: TextAlignment.TEXT_ALIGNMENT_LEFT, lineHeight: 150, lineHeightUnit: LineHeightUnit.LINE_HEIGHT_UNIT_PERCENT, paragraphSpacing: 6 },
    });
  });

  it("serializes canonical PaintStyle registration with an ordered paint stack", () => {
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([{
      type: "registerPaintStyle",
      style: {
        id: "S:brand-fill",
        key: "library-paint-key",
        name: "Brand fill",
        description: "Primary surface",
        descriptionMarkdown: "**Primary** surface",
        documentationLinks: [{ uri: "https://example.com/styles/brand" }],
        remote: true,
        paints: { layers: [{ visible: true, opacity: .75, blendMode: "multiply", paint: { css: "#ff0000ff", color: { space: "srgb", components: [1, 0, 0], alpha: 1 } } }] },
        variableBindings: [{ paintIndex: 0, variableId: "V:brand" }],
      },
    }]));

    expect(batch.operations).toHaveLength(1);
    expect(batch.operations[0]?.registerPaintStyle?.style).toMatchObject({
      id: "S:brand-fill",
      key: "library-paint-key",
      name: "Brand fill",
      description: "Primary surface",
      descriptionMarkdown: "**Primary** surface",
      documentationLinks: [{ uri: "https://example.com/styles/brand" }],
      remote: true,
      paints: { layers: [{ visible: true, opacity: .75, blendMode: BlendMode.BLEND_MODE_MULTIPLY, solid: { space: ColorSpace.COLOR_SPACE_SRGB, red: 1, green: 0, blue: 0, alpha: 1 } }] },
      variableBindings: [{ paintIndex: 0, stopIndex: undefined, variableId: "V:brand" }],
    });
  });

  it("serializes style updates and deletions as distinct operations", () => {
    const textStyle = {
      id: "S:body",
      key: "",
      name: "Body",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: false,
      style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 },
    };
    const paintStyle = {
      id: "S:brand",
      key: "",
      name: "Brand",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: false,
      paints: { layers: [] },
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([
      { type: "setTextStyle", style: textStyle },
      { type: "deleteTextStyle", id: textStyle.id },
      { type: "setPaintStyle", style: paintStyle },
      { type: "deletePaintStyle", id: paintStyle.id },
    ]));

    expect(batch.operations[0]?.setTextStyle?.style).toMatchObject({ id: textStyle.id, name: "Body" });
    expect(batch.operations[1]?.deleteTextStyle).toEqual({ styleId: textStyle.id });
    expect(batch.operations[2]?.setPaintStyle?.style).toMatchObject({ id: paintStyle.id, name: "Brand" });
    expect(batch.operations[3]?.deletePaintStyle).toEqual({ styleId: paintStyle.id });
  });

  it("serializes variable collection and variable registrations", () => {
    const collection = { id: "VC:tokens", key: "", name: "Tokens", remote: false, hiddenFromPublishing: false, modes: [{ modeId: "default", name: "Mode 1" }], defaultModeId: "default" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([
      { type: "registerVariableCollection", collection },
      { type: "registerVariable", variable: { id: "V:spacing", key: "", name: "Spacing", description: "", remote: false, hiddenFromPublishing: false, collectionId: collection.id, resolvedType: "FLOAT", valuesByMode: { default: 0 }, scopes: ["ALL_SCOPES"], codeSyntax: { WEB: "--spacing" } } },
      { type: "setVariable", variable: { id: "V:spacing", key: "", name: "Space", description: "", remote: false, hiddenFromPublishing: false, collectionId: collection.id, resolvedType: "FLOAT", valuesByMode: { default: 8 }, scopes: ["GAP"] } },
      { type: "deleteVariable", id: "V:spacing" },
      { type: "setVariableCollection", collection: { ...collection, name: "Design tokens" }, variables: [] },
      { type: "deleteVariableCollection", id: collection.id },
    ]));

    expect(batch.operations[0]?.registerVariableCollection?.collection).toMatchObject({ id: "VC:tokens", defaultModeId: "default" });
    expect(batch.operations[1]?.registerVariable?.variable).toMatchObject({
      id: "V:spacing",
      collectionId: "VC:tokens",
      resolvedType: VariableResolvedType.VARIABLE_RESOLVED_TYPE_FLOAT,
      valuesByMode: [{ modeId: "default", value: { floatValue: 0 } }],
      codeSyntax: { WEB: "--spacing" },
    });
    expect(batch.operations[2]?.setVariable?.variable).toMatchObject({ name: "Space", valuesByMode: [{ modeId: "default", value: { floatValue: 8 } }] });
    expect(batch.operations[3]?.deleteVariable).toEqual({ variableId: "V:spacing" });
    expect(batch.operations[4]?.setVariableCollection).toMatchObject({ collection: { name: "Design tokens" }, variables: [] });
    expect(batch.operations[5]?.deleteVariableCollection).toEqual({ collectionId: "VC:tokens" });
  });

  it("serializes PaintStyle identities on create and clears them explicitly on update", () => {
    const node = {
      ...createNode("frame", 10, 20),
      id,
      fillStyleId: "S:surface",
      strokeStyleId: "S:border",
      backgroundStyleId: "S:surface",
    };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(created.operations[0].createNode?.node).toMatchObject({
      fillStyleId: "S:surface",
      strokeStyleId: "S:border",
      backgroundStyleId: "S:surface",
    });

    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([node], [{
      type: "update",
      id,
      patch: { fillStyleId: undefined, strokeStyleId: undefined, backgroundStyleId: undefined },
    }])!.batch));
    expect(updated.operations[2].setPaintStyleLinks).toEqual({
      nodeId: idBytes(id),
      fillStyleId: undefined,
      strokeStyleId: undefined,
      backgroundStyleId: undefined,
    });
  });

  it("serializes a zero-height line with the generated Line node kind", () => {
    const node = { ...createNode("line", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_LINE, height: 0 });
  });

  it("serializes a non-painting Slice with its dedicated generated node kind", () => {
    const node = { ...createNode("slice", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SLICE, width: 320, height: 220, strokeWidth: 0 });
  });

  it("serializes beta TextPath with its dedicated node kind and metadata", () => {
    const node = { ...createNode("textPath", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", textPathMetadata: { startSegment: 1, startPosition: .5, autoRename: false, textAlignHorizontal: "RIGHT" as const, textAlignVertical: "CENTER" as const } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_TEXT_PATH, vectorPath: expect.anything() });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.text-path.metadata.v1"])).toContain('"startSegment":1');
  });

  it("serializes identity-preserving TextPath conversion without create/delete churn", () => {
    const source = {
      ...createNode("rectangle", 10, 20),
      id,
      pageId: "00000000-0000-0000-0000-000000000001",
      parentId: "00000000-0000-4000-8000-000000000010",
      positionId: "00000000000000000000000000000001:00000000000000000000000000000000",
    };
    const vectorPath = { fillRule: "nonZero" as const, subpaths: [{ closed: false, points: [
      { id: "00000000-0000-4000-8000-000000000011", x: 0, y: 40, pointType: "corner" as const },
      { id: "00000000-0000-4000-8000-000000000012", x: 320, y: 40, pointType: "corner" as const },
    ] }] };
    const resolved = resolveCoreBatch([source], [{
      type: "convertToTextPath",
      id,
      vectorPath,
      metadata: { startSegment: 0, startPosition: .25, autoRename: true, textAlignHorizontal: "LEFT", textAlignVertical: "CENTER" },
    }]);
    expect(resolved?.nextNodes).toContainEqual(expect.objectContaining({
      id,
      kind: "textPath",
      parentId: source.parentId,
      positionId: source.positionId,
      x: source.x,
      y: source.y,
    }));

    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    const operationNames = batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined));
    expect(operationNames).toEqual(["convertToTextPath", "renameNode", "setText", "setTextProperties", "setNodeExtensions"]);
    expect(batch.operations[0]?.convertToTextPath).toMatchObject({ nodeId: idBytes(id), vectorPath: expect.anything() });
    expect(operationNames).not.toContain("createNode");
    expect(operationNames).not.toContain("deleteNode");
  });

  it.each(["shapeWithText", "textPath"] as const)("serializes confirmed %s plain-text edits without TextProperties", (kind) => {
    const node = { ...createNode(kind, 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", text: "Before" };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { text: "After" } }]);
    expect(resolved?.batch[0]).toMatchObject({ type: "update", plainTextOnly: true });
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    const operationNames = batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined));
    expect(operationNames).toContain("setText");
    expect(operationNames).not.toContain("setTextProperties");
    expect(operationNames).toEqual(["setText"]);
    expect(batch.operations.find((operation) => operation.setText)?.setText?.text).toBe("After");
  });

  it("serializes ShapeWithText TextSublayer styles without replaying geometry", () => {
    const textProperties = {
      runs: [{ start: 0, end: 6, fontSize: 18, fontWeight: 650, italic: false, letterSpacing: 1.5 }],
      paragraph: { alignment: "center" as const, lineHeight: 24, paragraphSpacing: 4 },
      autoSize: "fixed" as const,
    };
    const node = { ...createNode("shapeWithText", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", text: "Review" };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    expect(resolved?.batch[0]).toMatchObject({ type: "update", plainTextOnly: true });
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["setText", "setTextProperties"]);
    expect(batch.operations[1]?.setTextProperties?.properties?.runs[0]).toMatchObject({ fontSize: 18, fontWeight: 650, letterSpacing: 1.5 });
  });

  it("serializes PERCENT and AUTO line heights on the append-only paragraph unit tag", () => {
    const node = { ...createNode("shapeWithText", 10, 20), id, text: "Review" };
    const encoded = (paragraph: { lineHeight?: number; lineHeightUnit: "percent" | "auto" }) => {
      const textProperties = {
        runs: [{ start: 0, end: 6, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "center" as const, paragraphSpacing: 0, ...paragraph },
        autoSize: "fixed" as const,
      };
      const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
      return ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
        .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraph;
    };
    expect(encoded({ lineHeight: 150, lineHeightUnit: "percent" })).toMatchObject({
      lineHeight: 150,
      lineHeightUnit: LineHeightUnit.LINE_HEIGHT_UNIT_PERCENT,
    });
    expect(encoded({ lineHeightUnit: "auto" })).toMatchObject({
      lineHeight: undefined,
      lineHeightUnit: LineHeightUnit.LINE_HEIGHT_UNIT_AUTO,
    });
  });

  it("serializes presence-bearing paragraph indentation on the append-only paragraph tag", () => {
    const node = { ...createNode("shapeWithText", 10, 20), id, text: "Review" };
    const textProperties = {
      runs: [{ start: 0, end: 6, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, paragraphIndent: 18 },
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const paragraph = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraph;
    expect(paragraph?.paragraphIndent).toBe(18);
  });

  it("serializes non-default paragraph wrapping on the append-only paragraph tag", () => {
    const node = { ...createNode("shapeWithText", 10, 20), id, text: "Review this now" };
    const textProperties = {
      runs: [{ start: 0, end: 15, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, textWrapStyle: "balance" as const },
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const paragraph = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraph;
    expect(paragraph?.textWrapStyle).toBe(TextWrapStyle.TEXT_WRAP_STYLE_BALANCE);
  });

  it("serializes explicit per-paragraph AUTO wrapping on ParagraphStyleRun tag 9", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo" };
    const textProperties = {
      runs: [{ start: 0, end: 7, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, textWrapStyle: "balance" as const },
      paragraphStyleRuns: [{ start: 4, textWrapStyle: "auto" as const }],
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const run = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)
      ?.setTextProperties?.properties?.paragraphStyleRuns[0];
    expect(run?.start).toBe(4);
    expect(run?.textWrapStyle).toBe(TextWrapStyle.TEXT_WRAP_STYLE_AUTO);
  });

  it("serializes ordered and unordered list options on the append-only paragraph tag", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo" };
    const encoded = (listType: "ordered" | "unordered") => {
      const textProperties = {
        runs: [{ start: 0, end: 7, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType },
        autoSize: "fixed" as const,
      };
      const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
      return ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
        .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraph?.listType;
    };
    expect(encoded("ordered")).toBe(TextListType.TEXT_LIST_TYPE_ORDERED);
    expect(encoded("unordered")).toBe(TextListType.TEXT_LIST_TYPE_UNORDERED);
  });

  it("serializes list spacing on append-only ParagraphStyle tag 8", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo" };
    const textProperties = {
      runs: [{ start: 0, end: 7, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const, listSpacing: 8 },
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const paragraph = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraph;
    expect(paragraph?.listSpacing).toBe(8);
  });

  it("serializes hangingList only when enabled on ParagraphStyle tag 9", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo" };
    const encoded = (hangingList?: boolean) => {
      const textProperties = {
        runs: [{ start: 0, end: 7, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const, hangingList },
        autoSize: "fixed" as const,
      };
      const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
      return ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
        .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraph?.hangingList;
    };
    expect(encoded(true)).toBe(true);
    expect(encoded(false)).toBeUndefined();
  });

  it("serializes hangingPunctuation only when enabled on ParagraphStyle tag 10", () => {
    const node = { ...createNode("text", 10, 20), id, text: "“Text.”" };
    const encoded = (hangingPunctuation?: boolean) => {
      const textProperties = {
        runs: [{ start: 0, end: 11, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, paragraphSpacing: 0, hangingPunctuation },
        autoSize: "fixed" as const,
      };
      const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
      return ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
        .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraph?.hangingPunctuation;
    };
    expect(encoded(true)).toBe(true);
    expect(encoded(false)).toBeUndefined();
  });

  it("serializes sparse paragraph indentation on TextProperties tag 8", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo" };
    const textProperties = {
      runs: [{ start: 0, end: 7, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const },
      paragraphStyleRuns: [{ start: 4, indentation: 2 }],
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const properties = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties;
    expect(properties?.paragraphStyleRuns).toEqual([{ start: 4, indentation: 2 }]);
  });

  it("serializes per-paragraph list overrides on ParagraphStyleRun tag 3", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo\nThree" };
    const textProperties = {
      runs: [{ start: 0, end: 13, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const },
      paragraphStyleRuns: [
        { start: 4, listType: "none" as const },
        { start: 8, listType: "unordered" as const },
      ],
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const runs = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraphStyleRuns;
    expect(runs).toEqual([
      { start: 4, listType: TextListType.TEXT_LIST_TYPE_NONE },
      { start: 8, listType: TextListType.TEXT_LIST_TYPE_UNORDERED },
    ]);
  });

  it("serializes explicit per-paragraph list spacing, including zero, on ParagraphStyleRun tag 4", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo\nThree" };
    const textProperties = {
      runs: [{ start: 0, end: 13, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, listType: "ordered" as const, listSpacing: 8 },
      paragraphStyleRuns: [{ start: 4, listSpacing: 0 }, { start: 8, listSpacing: 12 }],
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const runs = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraphStyleRuns;
    expect(runs).toEqual([{ start: 4, listSpacing: 0 }, { start: 8, listSpacing: 12 }]);
  });

  it("serializes explicit per-paragraph paragraph spacing, including zero, on ParagraphStyleRun tag 5", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo\nThree" };
    const textProperties = {
      runs: [{ start: 0, end: 13, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 8 },
      paragraphStyleRuns: [{ start: 4, paragraphSpacing: 0 }, { start: 8, paragraphSpacing: 12 }],
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const runs = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraphStyleRuns;
    expect(runs).toEqual([{ start: 4, paragraphSpacing: 0 }, { start: 8, paragraphSpacing: 12 }]);
  });

  it("serializes explicit per-paragraph indentation, including zero, on ParagraphStyleRun tag 6", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo\nThree" };
    const textProperties = {
      runs: [{ start: 0, end: 13, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, paragraphSpacing: 0, paragraphIndent: 8 },
      paragraphStyleRuns: [{ start: 4, paragraphIndent: 0 }, { start: 8, paragraphIndent: 12 }],
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const runs = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraphStyleRuns;
    expect(runs).toEqual([{ start: 4, paragraphIndent: 0 }, { start: 8, paragraphIndent: 12 }]);
  });

  it("serializes per-paragraph PIXELS, PERCENT and AUTO line heights on tags 7 and 8", () => {
    const node = { ...createNode("text", 10, 20), id, text: "One\nTwo\nThree" };
    const textProperties = {
      runs: [{ start: 0, end: 13, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }],
      paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 },
      paragraphStyleRuns: [
        { start: 0, lineHeight: 24 },
        { start: 4, lineHeight: 150, lineHeightUnit: "percent" as const },
        { start: 8, lineHeightUnit: "auto" as const },
      ],
      autoSize: "fixed" as const,
    };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { textProperties } }]);
    const runs = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch))
      .operations.find((operation) => operation.setTextProperties)?.setTextProperties?.properties?.paragraphStyleRuns;
    expect(runs).toEqual([
      { start: 0, lineHeight: 24 },
      { start: 4, lineHeight: 150, lineHeightUnit: LineHeightUnit.LINE_HEIGHT_UNIT_PERCENT },
      { start: 8, lineHeightUnit: LineHeightUnit.LINE_HEIGHT_UNIT_AUTO },
    ]);
  });

  it("serializes legacy run colors and presence-bearing Text PaintStacks on their distinct protobuf tags", () => {
    const textProperties = {
      runs: [
        { start: 0, end: 1, fontSize: 18, fontWeight: 650, italic: false, letterSpacing: 0, color: { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: .5 } },
        { start: 1, end: 2, fontSize: 18, fontWeight: 650, italic: false, letterSpacing: 0, fillStack: { layers: [] } },
      ],
      paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 },
      autoSize: "fixed" as const,
    };
    const node = { ...createNode("text", 10, 20), id, text: "AB", textProperties };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const runs = batch.operations[1]?.setTextProperties?.properties?.runs;
    expect(runs?.[0]?.color).toMatchObject({ red: 1, green: 0, blue: 0, alpha: .5 });
    expect(runs?.[0]?.fillStack).toBeUndefined();
    expect(runs?.[1]?.color).toBeUndefined();
    expect(runs?.[1]?.fillStack).toEqual({ layers: [] });
  });

  it("serializes an empty-text base style on the append-only TextProperties field", () => {
    const textProperties = {
      runs: [],
      baseStyle: {
        fontSize: 22,
        fontWeight: 600,
        italic: true,
        letterSpacing: 1.25,
        fillStack: { layers: [] },
      },
      paragraph: { alignment: "left" as const, lineHeight: 26, paragraphSpacing: 0 },
      autoSize: "fixed" as const,
    };
    const node = { ...createNode("shapeWithText", 10, 20), id, text: "", textProperties };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[1]?.setTextProperties?.properties?.baseStyle).toMatchObject({
      start: 0,
      end: 0,
      fontSize: 22,
      fontWeight: 600,
      italic: true,
      letterSpacing: 1.25,
      fillStack: { layers: [] },
    });
  });

  it("serializes TextStyle link identities on character runs and empty-text base styles", () => {
    const linked = {
      ...createNode("text", 10, 20),
      id,
      text: "AB",
      textProperties: {
        runs: [{ start: 0, end: 2, fontSize: 18, fontWeight: 600, italic: false, letterSpacing: 0, textStyleId: "S:heading" }],
        paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    const linkedBatch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: linked }])!.batch));
    expect(linkedBatch.operations[1]?.setTextProperties?.properties?.runs[0]?.textStyleId).toBe("S:heading");

    const empty = {
      ...createNode("text", 10, 20),
      id,
      text: "",
      textProperties: {
        runs: [],
        baseStyle: { fontSize: 18, fontWeight: 600, italic: false, letterSpacing: 0, textStyleId: "S:body" },
        paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 },
        autoSize: "fixed" as const,
      },
    };
    const emptyBatch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: empty }])!.batch));
    expect(emptyBatch.operations[1]?.setTextProperties?.properties?.baseStyle?.textStyleId).toBe("S:body");
  });

  it("serializes beta TransformGroup with repeat metadata", () => {
    const node = { ...createNode("transformGroup", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", transformModifiers: [{ type: "REPEAT" as const, count: 2, unitType: "PIXELS" as const, offset: 10, repeatType: "LINEAR" as const, axis: "VERTICAL" as const }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_TRANSFORM_GROUP });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.transform-group.modifiers.v1"])).toContain('"repeatType":"LINEAR"');
  });

  it("serializes WashiTape with its dedicated generated node kind", () => {
    const node = { ...createNode("washiTape", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_WASHI_TAPE });
  });

  it("serializes Widget identity and synced state metadata", () => {
    const node = { ...createNode("widget", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", widgetMetadata: { widgetId: "com.example.widget", syncedState: { votes: 1 }, syncedMap: {} } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_WIDGET });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.widget.metadata.v1"])).toContain("com.example.widget");
  });

  it("serializes CodeBlock with its dedicated generated node kind and language extension", () => {
    const node = { ...createNode("codeBlock", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", text: "const x = 1", codeLanguage: "TYPESCRIPT" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_CODE_BLOCK, text: "const x = 1" });
    expect(batch.operations[0].createNode?.node?.extensions["figma.code-block.language.v1"]).toEqual(Uint8Array.from(new TextEncoder().encode("TYPESCRIPT")));
  });

  it("serializes Component with its dedicated node kind and durable library metadata", () => {
    const node = {
      ...createNode("component", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000",
      componentMetadata: { key: "component-key", remote: false, description: "Card", descriptionMarkdown: "**Card**", documentationLinks: [{ uri: "https://design.example/card" }], componentPropertyDefinitions: {} },
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_COMPONENT, clipsContent: true });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.component.metadata.v1"])).toContain('"key":"component-key"');
  });

  it("serializes ComponentSet with its dedicated node kind and variant metadata", () => {
    const node = { ...createNode("componentSet", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", componentSetMetadata: { key: "set", remote: false, description: "Variants", descriptionMarkdown: "", documentationLinks: [], componentPropertyDefinitions: { State: { type: "VARIANT" as const, defaultValue: "Default", variantOptions: ["Default"] } }, variantGroupProperties: { State: { values: ["Default"] } } } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_COMPONENT_SET, clipsContent: true });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.component-set.metadata.v1"])).toContain("State");
  });

  it("serializes Connector with its dedicated node kind and relationship metadata", () => {
    const node = { ...createNode("connector", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", connectorMetadata: { lineType: "ELBOWED" as const, start: { endpointNodeId: "a", x: 0, y: 0 }, end: { endpointNodeId: "b", x: 160, y: 0 }, startStrokeCap: "NONE", endStrokeCap: "ARROW_EQUILATERAL", text: "links" } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_CONNECTOR, height: 0 });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.connector.metadata.v1"])).toContain("ELBOWED");
  });

  it("serializes Embed with its dedicated node kind and readonly preview metadata", () => {
    const node = { ...createNode("embed", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", embedMetadata: { srcUrl: "https://player.example/embed/1", canonicalUrl: null, title: "Demo", provider: "Example" } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_EMBED, width: 360, height: 240 });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.embed.metadata.v1"])).toContain("player.example");
  });

  it("serializes Highlight with its dedicated node kind, path, and handle metadata", () => {
    const node = { ...createNode("highlight", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", highlightHandleMirroring: "ANGLE" as const };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_HIGHLIGHT, vectorPath: expect.anything() });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.highlight.handle-mirroring.v1"])).toBe("ANGLE");
  });

  it("serializes InteractiveSlideElement with its readonly interactive type", () => {
    const node = { ...createNode("interactiveSlideElement", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", interactiveSlideElementType: "POLL" as const };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_INTERACTIVE_SLIDE_ELEMENT });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.interactive-slide-element.type.v1"])).toBe("POLL");
  });

  it("serializes LinkUnfurl with its dedicated node kind and rich-preview metadata", () => {
    const node = { ...createNode("linkUnfurl", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", linkUnfurlMetadata: { url: "https://example.com/story", title: "Story", description: "Preview", provider: "Example" } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_LINK_UNFURL });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.link-unfurl.metadata.v1"])).toContain("example.com/story");
  });

  it("serializes Media with its dedicated node kind, GIF resource, and content hash", () => {
    const node = { ...createNode("media", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", assetId: "00000000-0000-4000-8000-000000000002", mediaMetadata: { hash: "gif-hash" } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_MEDIA, assetId: expect.anything() });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.media.metadata.v1"])).toContain("gif-hash");
  });

  it("serializes ShapeWithText with its dedicated node kind and selector metadata", () => {
    const node = { ...createNode("shapeWithText", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", shapeWithTextType: "DIAMOND" as const, text: "Decision" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SHAPE_WITH_TEXT, text: "Decision" });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.shape-with-text.type.v1"])).toBe("DIAMOND");
  });

  it("serializes an imported SlideGrid with its dedicated read-only node kind", () => {
    const node = { ...createNode("slideGrid", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SLIDE_GRID });
  });

  it("serializes Slide with fixed geometry and its transition extension", () => {
    const node = { ...createNode("slide", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SLIDE, width: 1920, height: 1080 });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.slide.metadata.v1"])).toContain("ON_CLICK");
  });

  it("serializes SlideRow with its dedicated structural node kind", () => {
    const node = { ...createNode("slideRow", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SLIDE_ROW });
  });

  it("serializes Stamp with its dedicated node kind and name", () => {
    const node = { ...createNode("stamp", 10, 20), id, name: "Heart", pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_STAMP, name: "Heart" });
  });

  it("serializes Sticky's dedicated type and metadata extension", () => {
    const node = { ...createNode("sticky", 10, 20), id, text: "Vote", pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_STICKY, text: "Vote" });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.sticky.metadata.v1"])).toContain("authorVisible");
  });

  it("serializes Instance with its dedicated node kind and component link metadata", () => {
    const node = { ...createNode("instance", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", instanceMetadata: { mainComponentId: "00000000-0000-4000-8000-000000000002", scaleFactor: 1, componentProperties: { enabled: true }, overrides: [], isExposedInstance: false } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_INSTANCE, clipsContent: true });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.instance.metadata.v1"])).toContain('"mainComponentId"');
  });

  it("serializes Slot with its dedicated node kind and property metadata", () => {
    const node = { ...createNode("slot", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", slotMetadata: { propertyName: "Content" } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SLOT, clipsContent: true });
    expect(new TextDecoder().decode(batch.operations[0].createNode?.node?.extensions["figma.slot.metadata.v1"])).toContain("Content");
  });

  it("serializes Blend Mode for both a created node and an appearance update", () => {
    const node = { ...createNode("rectangle", 10, 20), id, blendMode: "color-dodge" as const };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([node], [{ type: "update", id, patch: { blendMode: "linear-dodge" } }])!.batch));

    expect(created.operations[0].createNode?.node?.blendMode).toBe(BlendMode.BLEND_MODE_COLOR_DODGE);
    expect(updated.operations[3].setAppearance?.blendMode).toBe(BlendMode.BLEND_MODE_LINEAR_DODGE);
  });

  it("serializes a live BooleanOperation selector on the created structural node", () => {
    const node = { ...createNode("booleanOperation", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000", booleanOperation: "subtract" as const };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({
      nodeId: idBytes(id), kind: NodeKind.NODE_KIND_BOOLEAN_OPERATION, booleanOperation: 3,
    });
  });

  it("serializes a Boolean selector change as a dedicated replayable operation", () => {
    const node = { ...createNode("booleanOperation", 10, 20), id, booleanOperation: "exclude" as const };
    const firstOperand = { ...createNode("rectangle", 10, 20), id: "00000000-0000-4000-8000-000000000002", parentId: id };
    const secondOperand = { ...createNode("rectangle", 30, 20), id: "00000000-0000-4000-8000-000000000003", parentId: id };
    const batch = ResolvedOperationBatch.decode(
      encodeCoreBatchPayload(resolveCoreBatch([node, firstOperand, secondOperand], [{ type: "update", id, patch: { booleanOperation: "exclude" } }])!.batch),
    );

    expect(batch.operations.find((operation) => operation.setBooleanOperation)?.setBooleanOperation).toEqual({
      nodeId: idBytes(id),
      operation: 4,
    });
  });

  it("serializes the G4 alpha-mask flag as a dedicated replayable operation", () => {
    const mask = { ...createNode("rectangle", 10, 20), id };
    const target = { ...createNode("rectangle", 30, 20), id: "00000000-0000-4000-8000-000000000002" };
    const batch = ResolvedOperationBatch.decode(
      encodeCoreBatchPayload(resolveCoreBatch([mask, target], [{ type: "setMask", id, enabled: true }])!.batch),
    );

    expect(batch.operations[0].setMask).toEqual({ nodeId: idBytes(id), enabled: true });
  });

  it("preserves an alpha mask when the node enters Core through creation", () => {
    const mask = { ...createNode("rectangle", 10, 20), id, isMask: true };
    const target = { ...createNode("rectangle", 30, 20), id: "00000000-0000-4000-8000-000000000002" };
    const batch = ResolvedOperationBatch.decode(
      encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: mask }, { type: "create", node: target }])!.batch),
    );

    expect(batch.operations).toHaveLength(3);
    expect(batch.operations[0].createNode?.node?.nodeId).toEqual(idBytes(id));
    expect(batch.operations[1].createNode?.node?.nodeId).toEqual(idBytes(target.id));
    expect(batch.operations[2].setMask).toEqual({ nodeId: idBytes(id), enabled: true });
  });

  it("serializes a canonical Drop Shadow on create and inspector update", () => {
    const dropShadow = { offsetX: 4, offsetY: 8, blurRadius: 12, spread: 2, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true };
    const node = { ...createNode("rectangle", 10, 20), id, dropShadow };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([node], [{ type: "update", id, patch: { dropShadow } }])!.batch));
    expect(created.operations[0].createNode?.node?.dropShadow).toMatchObject({ offsetX: 4, offsetY: 8, blurRadius: 12, spread: 2, visible: true, color: { alpha: .25 } });
    expect(created.operations[0].createNode?.node?.effectStack).toEqual([expect.objectContaining({ dropShadow: expect.objectContaining({ offsetX: 4, offsetY: 8 }) })]);
    expect(updated.operations[3].setAppearance?.dropShadow).toMatchObject({ offsetX: 4, offsetY: 8, blurRadius: 12, spread: 2, visible: true, color: { alpha: .25 } });
    expect(updated.operations[3].setAppearance?.effectStack).toEqual([expect.objectContaining({ dropShadow: expect.objectContaining({ blurRadius: 12 }) })]);
  });

  it("serializes Layer Blur in the ordered Effect Stack", () => {
    const node = { ...createNode("rectangle", 10, 20), id, effectStack: [{ layerBlur: { radius: 24, visible: true } }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node?.effectStack).toEqual([{ layerBlur: { radius: 24, visible: true } }]);
  });

  it("serializes Inner Shadow in the ordered Effect Stack", () => {
    const innerShadow = { offsetX: -3, offsetY: 5, blurRadius: 10, spread: 1, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .32 }, visible: true };
    const node = { ...createNode("rectangle", 10, 20), id, effectStack: [{ innerShadow }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node?.effectStack).toEqual([{ innerShadow: expect.objectContaining({ offsetX: -3, blurRadius: 10, visible: true }) }]);
  });

  it("serializes Background Blur in the ordered Effect Stack", () => {
    const node = { ...createNode("rectangle", 10, 20), id, effectStack: [{ backgroundBlur: { radius: 18, visible: true } }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node?.effectStack).toEqual([{ backgroundBlur: { radius: 18, visible: true } }]);
  });

  it("serializes a Section and its content visibility state", () => {
    const node = { ...createNode("section", 10, 20), id, contentsHidden: true };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_SECTION, contentsHidden: true });
  });

  it("serializes four independent radii only for supported closed nodes", () => {
    const rectangle = { ...createNode("rectangle", 10, 20), id, cornerRadii: [4, 8, 12, 16] as [number, number, number, number], cornerSmoothing: .6 };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: rectangle }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ cornerRadii: [4, 8, 12, 16], cornerSmoothing: .6 });

    const line = { ...createNode("line", 10, 20), id, cornerRadii: [4, 8, 12, 16] as [number, number, number, number], cornerSmoothing: .6 };
    expect(() => encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: line }])!.batch)).toThrow("Per-corner radii");
  });

  it("serializes ordered fill and stroke paint stacks while retaining legacy paint fields", () => {
    const node = {
      ...createNode("rectangle", 10, 20), id,
      fills: [{ css: "#e6edff" }, { css: "#0048ff" }],
      strokes: [{ css: "#000000" }, { css: "#2563eb" }],
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({
      fill: { solid: expect.anything() }, stroke: { solid: expect.anything() },
      fills: [{ solid: expect.anything() }, { solid: expect.anything() }],
      strokes: [{ solid: expect.anything() }, { solid: expect.anything() }],
    });
  });

  it("serializes presence-bearing empty and image paint stacks", () => {
    const assetId = "00000000-0000-4000-8000-000000000077";
    const node = {
      ...createNode("rectangle", 10, 20),
      id,
      fillStack: { layers: [] },
      strokeStack: {
        layers: [{
          image: { assetId, scaleMode: "fill" as const, transform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 8 }, rotationDegrees: 90 as const, filters: { exposure: .25, shadows: -.5 } },
          visible: false,
          opacity: 0.25,
          blendMode: "color-burn" as const,
        }],
      },
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    expect(batch.operations[0].createNode?.node?.fillStack).toEqual({ layers: [] });
    expect(batch.operations[0].createNode?.node?.strokeStack?.layers[0]).toMatchObject({
      image: { assetId: idBytes(assetId), scaleMode: ImageScaleMode.IMAGE_SCALE_MODE_FILL, transform: { a: 1, d: 1, e: 4, f: 8 }, rotationDegrees: 90, filters: { exposure: .25, shadows: -.5 } },
      visible: false,
      opacity: 0.25,
      blendMode: BlendMode.BLEND_MODE_COLOR_BURN,
    });
  });

  it("serializes a non-linear gradient kind, transform, and ordered stops", () => {
    const node = {
      ...createNode("rectangle", 10, 20),
      id,
      fillStack: {
        layers: [{
          paint: {
            css: "#ff0000",
            gradientPaint: {
              kind: "diamond" as const,
              transform: { a: .8, b: -.2, c: .15, d: 1.1, e: .1, f: .05 },
              stops: [
                { position: 0, color: { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: 1 } },
                { position: 1, color: { space: "srgb" as const, components: [0, 0, 1] as [number, number, number], alpha: .5 } },
              ],
            },
          },
          visible: true,
          opacity: .75,
          blendMode: "overlay" as const,
        }],
      },
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const layer = batch.operations[0].createNode?.node?.fillStack?.layers[0];

    expect(layer).toMatchObject({
      gradient: {
        kind: 3,
        transform: { a: .8, b: -.2, c: .15, d: 1.1, e: .1, f: .05 },
      },
      visible: true,
      opacity: .75,
      blendMode: BlendMode.BLEND_MODE_OVERLAY,
    });
    expect(layer?.gradient?.stops.map((stop) => stop.position)).toEqual([0, 1]);
  });

  it("preserves a linear-gradient paint layer with its ordered stops", () => {
    const gradient = {
      start: [0, 0] as [number, number], end: [1, 1] as [number, number], stops: [
        { position: 0, color: { space: "srgb" as const, components: [0.1, 0.2, 0.3] as [number, number, number], alpha: 1 } },
        { position: .6, color: { space: "display-p3" as const, components: [0.4, 0.7, 0.2] as [number, number, number], alpha: .75 } },
        { position: 1, color: { space: "srgb" as const, components: [0.9, 0.8, 0.1] as [number, number, number], alpha: .5 } },
      ],
    };
    const node = { ...createNode("rectangle", 10, 20), id, fills: [{ css: "#1a334d", gradient }] };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));

    const encoded = batch.operations[0].createNode?.node?.fills[0]?.linearGradient;
    expect(encoded).toMatchObject({ startX: 0, startY: 0, endX: 1, endY: 1 });
    expect(encoded?.stops).toHaveLength(3);
    expect(encoded?.stops.map((stop) => stop.color?.space)).toEqual([1, 2, 1]);
    expect(encoded?.stops.map((stop) => stop.position)).toEqual([0, expect.closeTo(.6, 6), 1]);
    expect(encoded?.stops[1]?.color).toMatchObject({ red: expect.closeTo(.4, 6), green: expect.closeTo(.7, 6), blue: expect.closeTo(.2, 6), alpha: .75 });
  });

  it("serializes a Frame clip-content choice while defaulting new Frames to clipping", () => {
    const clipped = { ...createNode("frame", 10, 20), id };
    const unclipped = { ...clipped, clipsContent: false };
    const clippedBatch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: clipped }])!.batch));
    const unclippedBatch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: unclipped }])!.batch));

    expect(clippedBatch.operations[0].createNode?.node?.clipsContent).toBe(true);
    expect(unclippedBatch.operations[0].createNode?.node?.clipsContent).toBe(false);
  });

  it("serializes Auto Layout as an explicit replayable Frame operation", () => {
    const autoLayout = {
      mode: "horizontal" as const, padding: [4, 8, 12, 16] as [number, number, number, number], itemSpacing: 10, trackSpacing: 14, trackAlignment: "spaceBetween" as const, wrap: true,
      primaryAlignment: "spaceBetween" as const, counterAlignment: "baseline" as const,
      primarySizing: "fixed" as const, counterSizing: "fixed" as const,
      minWidth: 120, maxHeight: 320, absolute: false, alignSelf: "end" as const,
    };
    const node = { ...createNode("frame", 10, 20), id, autoLayout };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([node], [{ type: "update", id, patch: { autoLayout: { ...autoLayout, wrap: false, mode: "vertical", counterAlignment: "start" } } }])!.batch));

    expect(created.operations[0].createNode?.node?.autoLayout).toMatchObject({ mode: LayoutMode.LAYOUT_MODE_HORIZONTAL, paddingTop: 4, paddingLeft: 16, itemSpacing: 10, trackSpacing: 14, wrapTrackAlignment: WrapTrackAlignment.WRAP_TRACK_ALIGNMENT_SPACE_BETWEEN, wrap: true });
    expect(created.operations[1].setAutoLayout?.autoLayout).toMatchObject({ primaryAlignment: LayoutAlignment.LAYOUT_ALIGNMENT_SPACE_BETWEEN, counterAlignment: LayoutAlignment.LAYOUT_ALIGNMENT_BASELINE, primarySizing: LayoutSizing.LAYOUT_SIZING_FIXED, minWidth: 120, maxHeight: 320, alignSelf: LayoutAlignment.LAYOUT_ALIGNMENT_END });
    expect(updated.operations.find((operation) => operation.setAutoLayout)?.setAutoLayout?.autoLayout).toMatchObject({ mode: LayoutMode.LAYOUT_MODE_VERTICAL, wrap: false });
  });

  it("serializes versioned Grid tracks and independent gaps", () => {
    const autoLayout = {
      mode: "grid" as const, padding: [8, 12, 16, 20] as [number, number, number, number], itemSpacing: 0, wrap: false,
      primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false,
      gridRows: [{ type: "fixed" as const, value: 64 }, { type: "flex" as const, value: 1 }],
      gridColumns: [{ type: "flex" as const, value: 2 }, { type: "fixed" as const, value: 80 }],
      gridRowGap: 12, gridColumnGap: 20,
    };
    const node = { ...createNode("frame", 10, 20), id, autoLayout };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0]?.createNode?.node?.autoLayout).toMatchObject({
      mode: LayoutMode.LAYOUT_MODE_GRID,
      gridRows: [{ type: GridTrackType.GRID_TRACK_TYPE_FIXED, value: 64 }, { type: GridTrackType.GRID_TRACK_TYPE_FLEX, value: 1 }],
      gridColumns: [{ type: GridTrackType.GRID_TRACK_TYPE_FLEX, value: 2 }, { type: GridTrackType.GRID_TRACK_TYPE_FIXED, value: 80 }],
      gridRowGap: 12,
      gridColumnGap: 20,
    });
  });

  it("serializes a flow child's align-self relationship as a durable operation", () => {
    const parent = { ...createNode("frame", 10, 20), id, autoLayout: {
      mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false,
      primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false,
    } };
    const childId = "00000000-0000-4000-8000-000000000002";
    const child = { ...createNode("rectangle", 10, 20), id: childId, parentId: parent.id, autoLayout: {
      mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false,
      primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false, alignSelf: "end" as const,
    } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([parent, child], [{ type: "update", id: child.id, patch: { autoLayout: child.autoLayout } }])!.batch));

    expect(batch.operations.find((operation) => operation.setAutoLayout)?.setAutoLayout).toMatchObject({
      nodeId: idBytes(childId), autoLayout: { mode: LayoutMode.LAYOUT_MODE_NONE, alignSelf: LayoutAlignment.LAYOUT_ALIGNMENT_END },
    });
  });

  it("does not coerce hydrated null Auto Layout bounds to a zero-size constraint", () => {
    const node = {
      ...createNode("frame", 10, 20), id,
      autoLayout: {
        mode: "vertical" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false,
        primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const,
        minWidth: null as unknown as number, maxWidth: null as unknown as number, minHeight: null as unknown as number, maxHeight: null as unknown as number, absolute: false,
      },
    };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations.find((operation) => operation.setAutoLayout)?.setAutoLayout?.autoLayout).toMatchObject({
      minWidth: undefined, maxWidth: undefined, minHeight: undefined, maxHeight: undefined,
    });
  });

  it("serializes Figma-compatible Frame constraints with the node appearance", () => {
    const node = { ...createNode("rectangle", 10, 20), id, constraints: { horizontal: "stretch" as const, vertical: "center" as const } };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node }])!.batch));
    expect(batch.operations[0].createNode?.node?.constraints).toEqual({ horizontal: ConstraintType.CONSTRAINT_TYPE_STRETCH, vertical: ConstraintType.CONSTRAINT_TYPE_CENTER });
  });

  it("serializes an optional parent-relative transform and rejects singular matrices", () => {
    const node = {
      ...createNode("rectangle", 10, 20), id,
      relativeTransform: { a: 0, b: 1, c: -1, d: 0, e: 20, f: 30 },
    };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations[0].createNode?.node?.relativeTransform).toEqual(node.relativeTransform);

    const singular = resolveCoreBatch([], [{ type: "create", node: { ...node, relativeTransform: { ...node.relativeTransform, a: 0, b: 0, c: 0, d: 0 } } }]);
    expect(() => encodeCoreBatchPayload(singular!.batch)).toThrow("Relative transform");
  });

  it("persists Arrow as a Line with an ArrowLines end cap", () => {
    const node = { ...createNode("line", 10, 20), id, strokeCapEnd: "arrowLines" as const };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_LINE, strokeCapStart: StrokeCap.STROKE_CAP_NONE, strokeCapEnd: StrokeCap.STROKE_CAP_ARROW_LINES });
  });

  it("serializes Frame/Rectangle per-side stroke weights and rejects them for Line", () => {
    const rectangle = { ...createNode("rectangle", 10, 20), id, strokeWeights: [1, 2, 3, 4] as [number, number, number, number], strokeAlign: "outside" as const };
    const resolved = resolveCoreBatch([], [{ type: "create", node: rectangle }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations[0].createNode?.node).toMatchObject({ strokeWeights: [1, 2, 3, 4], strokeAlign: StrokeAlign.STROKE_ALIGN_OUTSIDE });

    const line = { ...createNode("line", 10, 20), id, strokeWeights: [1, 2, 3, 4] as [number, number, number, number] };
    const lineBatch = resolveCoreBatch([], [{ type: "create", node: line }]);
    expect(() => encodeCoreBatchPayload(lineBatch!.batch)).toThrow("Per-side stroke weights");
  });

  it("keeps a full inspector update atomic through canonical leaf operations", () => {
    const node = { ...createNode("text", 10, 20), id, text: "before" };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { name: "Headline", x: 44, text: "after" } }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["updateGeometry", "renameNode", "setPaintStyleLinks", "setAppearance", "setText", "setTextProperties"]);
    expect(batch.operations[4].setText).toMatchObject({ nodeId: idBytes(id), text: "after" });
    expect(batch.operations[5].setTextProperties?.properties).toMatchObject({ autoSize: 1, paragraph: { alignment: 1 } });
    expect(batch.operations[5].setTextProperties?.properties?.paragraph?.lineHeight).toBe(20);
  });

  it("serializes the resizeWithoutConstraints intent on GeometryUpdate", () => {
    const node = { ...createNode("frame", 10, 20), id };
    const resolved = resolveCoreBatch([node], [{ type: "resizeWithoutConstraints", id, patch: { width: 480, height: 320 } }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations[0].updateGeometry).toMatchObject({ width: 480, height: 320, ignoreConstraints: true });
  });

  it("serializes an image fill with the rest of a shape update", () => {
    const assetId = "00000000-0000-0000-0000-00000000000b";
    const node = { ...createNode("rectangle", 10, 20), id, assetId };
    const resolved = resolveCoreBatch([node], [{ type: "update", id, patch: { assetId } }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["updateGeometry", "renameNode", "setPaintStyleLinks", "setAppearance", "setImageFill"]);
    expect(batch.operations[4].setImageFill).toEqual({ nodeId: idBytes(id), assetId: idBytes(assetId) });
  });

  it("serializes Polygon and Star parameters as canonical protobuf fields", () => {
    const polygon = { ...createNode("polygon", 10, 20), id };
    const star = { ...createNode("star", 10, 20), id: "00000000-0000-0000-0000-000000000003" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([
      { type: "create", node: { ...polygon, cornerRadius: polygon.radius, text: "" } },
      { type: "create", node: { ...star, cornerRadius: star.radius, text: "" } },
    ]));
    expect(batch.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_POLYGON, polygonParameters: { pointCount: 5 } });
    expect(batch.operations[1].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_STAR, starParameters: { pointCount: 5, innerRatio: .5 } });
  });

  it("serializes a VectorPath on create and as an atomic update operation", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const created = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([], [{ type: "create", node: vector }])!.batch));
    const updated = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolveCoreBatch([vector], [{ type: "update", id, patch: { vectorPath: { ...vector.vectorPath!, fillRule: "evenOdd" } } }])!.batch));

    expect(created.operations[0].createNode?.node).toMatchObject({ kind: NodeKind.NODE_KIND_VECTOR, vectorPath: { fillRule: 1 } });
    expect(created.operations[0].createNode?.node?.vectorPath?.subpaths[0]).toMatchObject({ closed: true, points: expect.arrayContaining([expect.objectContaining({ pointType: 1 })]) });
    expect(updated.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["updateGeometry", "renameNode", "setPaintStyleLinks", "setAppearance", "setVectorPath"]);
    expect(updated.operations[4].setVectorPath).toMatchObject({ nodeId: idBytes(id), vectorPath: { fillRule: 2 } });
  });

  it("serializes named Vector point edits without replacing the path", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const pointId = vector.vectorPath!.subpaths[0].points[1].id;
    const resolved = resolveCoreBatch([vector], [
      { type: "moveVectorPoint", id, pointId, x: 170, y: 12 },
      { type: "setVectorSubpathClosed", id, subpathIndex: 0, closed: false },
    ]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([
      { moveVectorPoint: { nodeId: idBytes(id), pointId: idBytes(pointId), x: 170, y: 12 } },
      { setVectorSubpathClosed: { nodeId: idBytes(id), subpathIndex: 0, closed: false } },
    ]);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0]).toMatchObject({ closed: false, points: expect.arrayContaining([expect.objectContaining({ id: pointId, x: 170, y: 12 })]) });
  });

  it("serializes point insertion and deletion as stable-id operations", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const afterPointId = vector.vectorPath!.subpaths[0].points[0].id;
    const insertedId = "00000000-0000-4000-8000-000000000099";
    const resolved = resolveCoreBatch([vector], [
      { type: "insertVectorPoint", id, subpathIndex: 0, afterPointId, point: { id: insertedId, x: 120, y: 30, pointType: "corner" } },
      { type: "deleteVectorPoint", id, pointId: insertedId },
    ]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([
      { insertVectorPoint: { nodeId: idBytes(id), subpathIndex: 0, afterPointId: idBytes(afterPointId), point: { pointId: idBytes(insertedId), x: 120, y: 30, handleInX: undefined, handleInY: undefined, handleOutX: undefined, handleOutY: undefined, pointType: 1 } } },
      { deleteVectorPoint: { nodeId: idBytes(id), pointId: idBytes(insertedId) } },
    ]);
  });

  it("serializes a segment split as a named canonical operation", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const afterPointId = vector.vectorPath!.subpaths[0].points[0].id;
    const pointId = "00000000-0000-4000-8000-00000000009a";
    const resolved = resolveCoreBatch([vector], [{ type: "splitVectorSegment", id, subpathIndex: 0, afterPointId, t: .5, pointId }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([{ splitVectorSegment: { nodeId: idBytes(id), subpathIndex: 0, afterPointId: idBytes(afterPointId), t: .5, pointId: idBytes(pointId) } }]);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0].points).toHaveLength(4);
  });

  it("serializes endpoint connections as named canonical operations", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const second = structuredClone(vector.vectorPath!.subpaths[0]);
    second.closed = false;
    second.points = second.points.map((point, index) => ({ ...point, id: `00000000-0000-4000-8000-00000000010${index + 1}` }));
    vector.vectorPath = { ...vector.vectorPath!, subpaths: [{ ...vector.vectorPath!.subpaths[0], closed: false }, second] };
    const firstPointId = vector.vectorPath.subpaths[0].points.at(-1)!.id;
    const secondPointId = vector.vectorPath.subpaths[1].points[0].id;
    const resolved = resolveCoreBatch([vector], [{ type: "connectVectorEndpoints", id, firstSubpathIndex: 0, firstPointId, secondSubpathIndex: 1, secondPointId }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([{ connectVectorEndpoints: { nodeId: idBytes(id), firstSubpathIndex: 0, firstPointId: idBytes(firstPointId), secondSubpathIndex: 1, secondPointId: idBytes(secondPointId) } }]);
  });

  it("serializes tangent-handle edits without replacing the vector path", () => {
    const vector = { ...createNode("vector", 10, 20), id };
    const pointId = vector.vectorPath!.subpaths[0].points[1].id;
    const resolved = resolveCoreBatch([vector], [{
      type: "setVectorPointHandles",
      id,
      pointId,
      handleIn: { x: -18, y: 6 },
      handleOut: { x: 24, y: -8 },
      pointType: "asymmetric",
    }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations).toEqual([{
      setVectorPointHandles: {
        nodeId: idBytes(id), pointId: idBytes(pointId),
        handleInX: -18, handleInY: 6, handleOutX: 24, handleOutY: -8,
        pointType: 3,
      },
    }]);
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0].points[1]).toMatchObject({
      id: pointId, handleIn: { x: -18, y: 6 }, handleOut: { x: 24, y: -8 }, pointType: "asymmetric",
    });
  });

  it("keeps a continued open-path Pen stroke ordered as one insertion batch", () => {
    const defaultVector = createNode("vector", 10, 20);
    const vector = { ...defaultVector, id, vectorPath: { ...defaultVector.vectorPath!, subpaths: [{ ...defaultVector.vectorPath!.subpaths[0], closed: false }] } };
    const endPointId = vector.vectorPath!.subpaths[0].points.at(-1)!.id;
    const firstId = "00000000-0000-4000-8000-0000000000a1";
    const secondId = "00000000-0000-4000-8000-0000000000a2";
    const resolved = resolveCoreBatch([vector], [
      { type: "insertVectorPoint", id, subpathIndex: 0, afterPointId: endPointId, point: { id: firstId, x: 220, y: 150, pointType: "corner" } },
      { type: "insertVectorPoint", id, subpathIndex: 0, afterPointId: firstId, point: { id: secondId, x: 260, y: 140, handleIn: { x: -16, y: 4 }, handleOut: { x: 16, y: -4 }, pointType: "mirrored" } },
      { type: "setVectorSubpathClosed", id, subpathIndex: 0, closed: true },
    ]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    expect(batch.operations.slice(0, 2).map((operation) => operation.insertVectorPoint?.afterPointId)).toEqual([idBytes(endPointId), idBytes(firstId)]);
    expect(batch.operations[2].setVectorSubpathClosed).toEqual({ nodeId: idBytes(id), subpathIndex: 0, closed: true });
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0]).toMatchObject({ closed: true });
    expect(resolved?.nextNodes[0].vectorPath?.subpaths[0].points.slice(-2)).toMatchObject([
      { id: firstId, x: 220, y: 150 },
      { id: secondId, handleIn: { x: -16, y: 4 }, handleOut: { x: 16, y: -4 }, pointType: "mirrored" },
    ]);
  });

  it("serializes a layer reorder as a dedicated canonical operation", () => {
    const node = { ...createNode("rectangle", 10, 20), id, positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const positionId = "ffffffffffffffffffffffffffffffff:00000000000000000000000000000007";
    const resolved = resolveCoreBatch([node], [{ type: "reposition", positionIds: [{ id, positionId }] }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations).toEqual([{ setNodePosition: { nodeId: idBytes(id), positionId: { key: idBytes("ffffffffffffffffffffffffffffffff"), actorId: idBytes("00000000000000000000000000000007") } } }]);
  });

  it("serializes a resolved parent move without changing geometry", () => {
    const groupId = "00000000-0000-0000-0000-00000000000a";
    const positionId = "0000000000000000000000000000000b:00000000000000000000000000000000";
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([{ type: "reparent", parentIds: [{ id, parentId: groupId, positionId }] }]));
    expect(batch.operations).toEqual([{ setNodeParent: { nodeId: idBytes(id), parentId: idBytes(groupId), positionId: { key: idBytes("0000000000000000000000000000000b"), actorId: idBytes("00000000000000000000000000000000") } } }]);
  });

  it("creates rich text followed by a separately hashable style operation", () => {
    const node = {
      ...createNode("text", 10, 20), id, text: "A😀B",
      textProperties: {
        runs: [{ start: 0, end: 6, fontSize: 18, fontWeight: 700, italic: false, letterSpacing: 0, textCase: "smallCapsForced" as const, hyperlink: { type: "URL" as const, value: "https://example.com" }, textDecoration: "underline" as const, textDecorationStyle: "wavy" as const, textDecorationOffset: { value: 3, unit: "pixels" as const }, textDecorationThickness: { value: 10, unit: "percent" as const }, textDecorationColor: { color: { space: "srgb" as const, components: [1, .25, .5] as [number, number, number], alpha: 1 }, visible: true, opacity: .75, blendMode: "multiply" as const }, textDecorationSkipInk: true, leadingTrim: "capHeight" as const }],
        paragraph: { alignment: "center" as const, paragraphSpacing: 4 },
        autoSize: "height" as const,
        textTruncation: "ending" as const,
        maxLines: 2,
      },
    };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));
    expect(batch.operations.map((operation) => Object.keys(operation).find((key) => operation[key as keyof typeof operation] !== undefined))).toEqual(["createNode", "setTextProperties"]);
    expect(batch.operations[0].createNode?.node?.textProperties).toBeUndefined();
    expect(batch.operations[1].setTextProperties?.properties).toMatchObject({ autoSize: 2, textTruncation: 2, maxLines: 2, paragraph: { alignment: 2 }, runs: [{ start: 0, end: 6, fontSize: 18, fontWeight: 700, textCase: TextCase.TEXT_CASE_SMALL_CAPS_FORCED, hyperlink: { type: HyperlinkType.HYPERLINK_TYPE_URL, value: "https://example.com" }, textDecoration: TextDecoration.TEXT_DECORATION_UNDERLINE, textDecorationStyle: TextDecorationStyle.TEXT_DECORATION_STYLE_WAVY, textDecorationOffset: { value: 3, unit: TextDecorationOffsetUnit.TEXT_DECORATION_OFFSET_UNIT_PIXELS }, textDecorationThickness: { value: 10, unit: TextDecorationThicknessUnit.TEXT_DECORATION_THICKNESS_UNIT_PERCENT }, textDecorationColor: { color: { space: ColorSpace.COLOR_SPACE_SRGB, red: 1, green: .25, blue: .5, alpha: 1 }, visible: true, opacity: .75, blendMode: BlendMode.BLEND_MODE_MULTIPLY }, textDecorationSkipInk: true, leadingTrim: LeadingTrim.LEADING_TRIM_CAP_HEIGHT }] });
  });

  it("passes an unknown-extension payload through the generated node encode byte-for-byte (P0-2)", () => {
    const extensions = { "com.figma.phase3.motion": [0, 1, 2, 250, 255], "vendor.blob": [42] };
    const node = { ...createNode("rectangle", 10, 20), id, extensions };
    const resolved = resolveCoreBatch([], [{ type: "create", node }]);
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload(resolved!.batch));

    const decoded = batch.operations[0].createNode?.node?.extensions;
    expect(decoded && Object.keys(decoded).sort()).toEqual(["com.figma.phase3.motion", "vendor.blob"]);
    expect(decoded && [...decoded["com.figma.phase3.motion"]]).toEqual([0, 1, 2, 250, 255]);
    expect(decoded && [...decoded["vendor.blob"]]).toEqual([42]);
  });

  it("serializes a tombstone restore as a distinct history operation", () => {
    const node = { ...createNode("rectangle", 10, 20), id, pageId: "00000000-0000-0000-0000-000000000001", positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([{ type: "restore", node: { ...node, cornerRadius: node.radius, text: "" } }]));
    expect(batch.operations).toEqual([{ restoreNode: { node: expect.objectContaining({ nodeId: idBytes(id), name: node.name }) } }]);
  });

  it("serializes page creation through the same generated operation batch", () => {
    const page = { id: "00000000-0000-0000-0000-00000000000a", name: "Ideas", positionId: "0000000000000000000000000000000a:00000000000000000000000000000000" };
    const batch = ResolvedOperationBatch.decode(encodeCreatePagePayload(page));
    expect(batch.operations).toEqual([{ createPage: { page: { pageId: idBytes(page.id), name: "Ideas", positionId: { key: idBytes("0000000000000000000000000000000a"), actorId: idBytes("00000000000000000000000000000000") } } } }]);
  });

  it("serializes admitted asset metadata as a distinct, byte-free resource operation", () => {
    const assetId = "00000000-0000-0000-0000-00000000000b";
    const hash = "ab".repeat(32);
    const batch = ResolvedOperationBatch.decode(encodeRegisterResourcePayload({ assetId, contentHash: hash, mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 }));
    expect(batch.operations).toEqual([{ registerResource: { resource: { assetId: idBytes(assetId), contentHash: Uint8Array.from(Array(32).fill(0xab)), mediaType: "image/png", byteLength: "128", pixelWidth: 16, pixelHeight: 8, fontFaces: [] } } }]);
  });

  it("serializes admitted OpenType face identities without font bytes", () => {
    const assetId = "00000000-0000-0000-0000-00000000000d";
    const batch = ResolvedOperationBatch.decode(encodeRegisterResourcePayload({
      assetId,
      contentHash: "ef".repeat(32),
      mediaType: "font/ttf",
      byteLength: 512,
      fontFaces: [{
        faceIndex: 0,
        family: "Acme Sans",
        style: "Regular",
        aliases: [{ family: "思源黑体", style: "常规" }],
      }],
    }));
    expect(batch.operations[0].registerResource?.resource?.fontFaces).toEqual([
      {
        faceIndex: 0,
        family: "Acme Sans",
        style: "Regular",
        aliases: [{ family: "思源黑体", style: "常规" }],
      },
    ]);
  });

  it("keeps a resource registration ahead of its pasted image in one operation batch", () => {
    const assetId = "00000000-0000-0000-0000-00000000000c";
    const image = { ...createNode("image", 10, 20), id, assetId };
    const batch = ResolvedOperationBatch.decode(encodeCoreBatchPayload([
      { type: "registerAsset", asset: { assetId, contentHash: "cd".repeat(32), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 } },
      { type: "create", node: { ...image, cornerRadius: image.radius, text: "" } },
    ]));

    expect(batch.operations[0].registerResource?.resource).toMatchObject({ assetId: idBytes(assetId), contentHash: Uint8Array.from(Array(32).fill(0xcd)) });
    expect(batch.operations[1].createNode?.node).toMatchObject({ nodeId: idBytes(id), assetId: idBytes(assetId), kind: NodeKind.NODE_KIND_IMAGE });
  });
});
