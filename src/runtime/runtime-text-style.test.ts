import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeSession } from "./runtime-session";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";
import { isRuntimeError } from "./runtime-errors";

const projection: RuntimeProjection = {
  revision: 4,
  textStyles: [
    {
      id: "S:body",
      key: "",
      name: "Body",
      description: "Default body copy",
      descriptionMarkdown: "**Default body copy**",
      documentationLinks: [{ uri: "https://design.example/text/body" }],
      remote: false,
      style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: .25, textCase: "smallCaps" },
      paragraph: { alignment: "left", lineHeight: 150, lineHeightUnit: "percent", paragraphSpacing: 8, paragraphIndent: 4, textWrapStyle: "pretty", listSpacing: 6, hangingList: true, hangingPunctuation: true },
    },
    {
      id: "S:remote",
      key: "library-key",
      name: "Library",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: true,
      style: { fontSize: 12, fontWeight: 500, italic: false, letterSpacing: 0 },
      paragraph: { alignment: "left", lineHeight: 20, paragraphSpacing: 0 },
    },
  ],
  nodes: [
    { id: "document", type: "DOCUMENT", name: "Document" },
    { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
    { id: "text", type: "TEXT", name: "Copy", parentId: "page", siblingIndex: 0, textProperties: { runs: [], baseStyle: { textStyleId: "S:body" } } },
  ],
};

describe("TextStyle resource runtime", () => {
  it("creates a local default TextStyle through the pending canonical catalog", async () => {
    const transport = new StyleTransport(projection);
    const session = new RuntimeSession({
      sessionId: "create-text-style",
      projection,
      transport,
      createId: () => "00000000-0000-4000-8000-000000000101",
      scheduleMicrotask: () => {},
    });
    const figma = new FigmaCompatibleRuntime(session);

    const style = figma.createTextStyle();
    expect(style).toMatchObject({
      id: "S:00000000-0000-4000-8000-000000000101",
      type: "TEXT",
      name: "Text Style",
      remote: false,
      fontSize: 12,
      fontName: { family: "Inter", style: "Regular" },
      letterSpacing: { value: 0, unit: "PIXELS" },
      lineHeight: { value: 20, unit: "PIXELS" },
    });
    expect((await figma.getStyleByIdAsync(style.id))?.id).toBe(style.id);
    expect((await figma.getLocalTextStylesAsync()).map((candidate) => candidate.id)).toEqual(["S:body", style.id]);
    expect(session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)?.operations).toEqual([
      { type: "registerTextStyle", style: expect.objectContaining({ id: style.id, key: "", remote: false }) },
    ]);

    await session.commitAsync();
    const reopened = new RuntimeSession({ sessionId: "created-text-style", projection: transport.currentProjection(), transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    expect((await reopened.getStyleByIdAsync(style.id))?.id).toBe(style.id);
  });

  it("queries complete canonical styles and reports linked consumers", async () => {
    const session = new RuntimeSession({ sessionId: "styles", pluginId: "com.example.styles", projection, transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    const figma = new FigmaCompatibleRuntime(session);
    const style = await figma.getStyleByIdAsync("S:body");

    expect(style).toMatchObject({ id: "S:body", type: "TEXT", name: "Body", remote: false, descriptionMarkdown: "**Default body copy**", documentationLinks: [{ uri: "https://design.example/text/body" }], fontSize: 16, paragraphIndent: 4, paragraphSpacing: 8, listSpacing: 6, hangingList: true, hangingPunctuation: true, textCase: "SMALL_CAPS", textWrapStyle: "PRETTY" });
    expect(style?.letterSpacing).toEqual({ value: .25, unit: "PIXELS" });
    expect(style?.lineHeight).toEqual({ value: 150, unit: "PERCENT" });
    expect(style?.getPluginData("missing")).toBe("");
    expect(style?.getPluginDataKeys()).toEqual([]);
    expect((await style?.getStyleConsumersAsync())?.map((entry) => ({ id: entry.node.id, fields: entry.fields }))).toEqual([{ id: "text", fields: ["textStyleId"] }]);
    expect((await figma.getLocalTextStylesAsync()).map((entry) => entry.id)).toEqual(["S:body"]);
    expect(await figma.getStyleByIdAsync("missing")).toBeNull();
    const remote = await figma.getStyleByIdAsync("S:remote");
    expect(isRuntimeError(capture(() => { if (remote) remote.name = "Changed"; }), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it("updates local style metadata and atomically unlinks consumers before removal", async () => {
    const transport = new StyleTransport(projection);
    const session = new RuntimeSession({ sessionId: "text-style-lifecycle", projection, transport, scheduleMicrotask: () => {} });
    const style = await session.getStyleByIdAsync("S:body");
    if (!style || style.type !== "TEXT") throw new Error("Missing TextStyle fixture");

    style.name = "Typography/Body";
    style.descriptionMarkdown = "Default body copy **updated**";
    style.documentationLinks = [{ uri: "https://design.example/text/body-v2" }];
    style.fontSize = 18;
    style.textDecoration = "UNDERLINE";
    style.letterSpacing = { value: 1.5, unit: "PIXELS" };
    style.lineHeight = { value: 125, unit: "PERCENT" };
    style.leadingTrim = "CAP_HEIGHT";
    style.paragraphIndent = 4;
    style.paragraphSpacing = 8;
    style.textWrapStyle = "BALANCE";
    style.listSpacing = 6;
    style.hangingPunctuation = true;
    style.hangingList = true;
    style.textCase = "UPPER";
    expect(style.name).toBe("Typography/Body");
    expect(style.description).toBe("Default body copy");
    expect(style.descriptionMarkdown).toBe("Default body copy **updated**");
    expect(style.documentationLinks).toEqual([{ uri: "https://design.example/text/body-v2" }]);
    expect(style.fontSize).toBe(18);
    expect(style.textDecoration).toBe("UNDERLINE");
    expect(style.letterSpacing).toEqual({ value: 1.5, unit: "PIXELS" });
    expect(style.lineHeight).toEqual({ value: 125, unit: "PERCENT" });
    expect(style.leadingTrim).toBe("CAP_HEIGHT");
    expect(style.paragraphIndent).toBe(4);
    expect(style.paragraphSpacing).toBe(8);
    expect(style.textWrapStyle).toBe("BALANCE");
    expect(style.listSpacing).toBe(6);
    expect(style.hangingPunctuation).toBe(true);
    expect(style.hangingList).toBe(true);
    expect(style.textCase).toBe("UPPER");
    expect((await session.getStyleByIdAsync(style.id))?.name).toBe("Typography/Body");
    expect(isRuntimeError(capture(() => { style.name = " "; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => { style.name = "界".repeat(400); }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => { style.letterSpacing = { value: 10, unit: "PERCENT" }; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => { style.documentationLinks = [{ uri: "javascript:alert(1)" }]; }), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => { style.documentationLinks = [{ uri: "https://design.example/one" }, { uri: "https://design.example/two" }]; }), "INVALID_ARGUMENT")).toBe(true);

    await session.commitAsync();
    expect(transport.currentProjection().textStyles?.find((candidate) => candidate.id === style.id)).toMatchObject({
      name: "Typography/Body",
      description: "Default body copy",
      descriptionMarkdown: "Default body copy **updated**",
      documentationLinks: [{ uri: "https://design.example/text/body-v2" }],
      style: { fontSize: 18, letterSpacing: 1.5, textDecoration: "underline", leadingTrim: "capHeight", textCase: "upper" },
      paragraph: { lineHeight: 125, lineHeightUnit: "percent", paragraphIndent: 4, paragraphSpacing: 8, textWrapStyle: "balance", listSpacing: 6, hangingPunctuation: true, hangingList: true },
    });

    style.remove();
    expect(await session.getStyleByIdAsync(style.id)).toBeNull();
    expect(session.projectionStore.getNode("text")?.textProperties).toEqual({ runs: [], baseStyle: {} });
    const operations = session.projectionStore.transaction(session.projectionStore.pendingTransactionIds()[0]!)!.operations;
    expect(operations.at(-2)).toMatchObject({ type: "update", nodeId: "text" });
    expect(operations.at(-1)).toEqual({ type: "deleteTextStyle", id: style.id });

    await session.commitAsync();
    const reopenedProjection = transport.currentProjection();
    expect(reopenedProjection.textStyles?.some((candidate) => candidate.id === style.id)).toBe(false);
    expect((reopenedProjection.nodes.find((node) => node.id === "text")?.textProperties as { baseStyle?: { textStyleId?: string } }).baseStyle?.textStyleId).toBeUndefined();
  });

  it("keeps deprecated synchronous style reads behind full-document access", () => {
    const dynamic = new RuntimeSession({ sessionId: "styles-dynamic", projection, transport: new ReadOnlyTransport(), documentAccess: "dynamic-page", scheduleMicrotask: () => {} });
    expect(isRuntimeError(capture(() => dynamic.getStyleById("S:body")), "PAGE_NOT_LOADED")).toBe(true);
  });

  it("persists scoped private and shared plugin data on styles", async () => {
    const alphaTransport = new StyleTransport(projection);
    const alpha = new RuntimeSession({ sessionId: "style-data-a", pluginId: "com.example.alpha", projection, transport: alphaTransport, scheduleMicrotask: () => {} });
    const alphaStyle = await alpha.getStyleByIdAsync("S:body");
    if (!alphaStyle) throw new Error("Missing TextStyle fixture");

    alphaStyle.setPluginData("z-key", "last");
    alphaStyle.setPluginData("a-key", "first 😀");
    alphaStyle.setSharedPluginData("com.example.tokens", "role", "body");
    expect(alphaStyle.getPluginData("a-key")).toBe("first 😀");
    expect(alphaStyle.getPluginDataKeys()).toEqual(["a-key", "z-key"]);
    expect(alphaStyle.getSharedPluginData("com.example.tokens", "role")).toBe("body");
    expect(alphaStyle.getSharedPluginDataKeys("com.example.tokens")).toEqual(["role"]);
    const transactionId = alpha.projectionStore.pendingTransactionIds()[0]!;
    const operationCount = alpha.projectionStore.transaction(transactionId)!.operations.length;
    expect(isRuntimeError(capture(() => alphaStyle.setPluginData("", "invalid")), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => alphaStyle.setSharedPluginData("bad/namespace", "key", "invalid")), "INVALID_ARGUMENT")).toBe(true);
    expect(alpha.projectionStore.transaction(transactionId)?.operations).toHaveLength(operationCount);
    await alpha.commitAsync();

    const betaProjection = alphaTransport.currentProjection();
    const beta = new RuntimeSession({ sessionId: "style-data-b", pluginId: "com.example.beta", projection: betaProjection, transport: new StyleTransport(betaProjection), scheduleMicrotask: () => {} });
    const betaStyle = await beta.getStyleByIdAsync("S:body");
    if (!betaStyle) throw new Error("Missing TextStyle fixture");
    expect(betaStyle.getPluginData("a-key")).toBe("");
    expect(betaStyle.getPluginDataKeys()).toEqual([]);
    expect(betaStyle.getSharedPluginData("com.example.tokens", "role")).toBe("body");

    const unscoped = new RuntimeSession({ sessionId: "style-data-none", projection: betaProjection, transport: new StyleTransport(betaProjection), scheduleMicrotask: () => {} });
    const unscopedStyle = await unscoped.getStyleByIdAsync("S:body");
    if (!unscopedStyle) throw new Error("Missing TextStyle fixture");
    expect(isRuntimeError(capture(() => unscopedStyle.getPluginData("a-key")), "PERMISSION_DENIED")).toBe(true);
    expect(unscopedStyle.getSharedPluginData("com.example.tokens", "role")).toBe("body");
  });

  it("applies and unlinks a complete TextStyle value atomically", async () => {
    const styledProjection: RuntimeProjection = {
      ...projection,
      nodes: [
        ...projection.nodes.map((node) => node.id === "text" ? {
          ...node,
          characters: "Body",
          textProperties: {
            runs: [{ start: 0, end: 4, fontSize: 11, fontWeight: 700, italic: true, letterSpacing: 2, hyperlink: { type: "URL" as const, value: "https://example.com" }, textDecoration: "underline" as const }],
            paragraph: { alignment: "right" as const, lineHeight: 12, paragraphSpacing: 0 },
            autoSize: "fixed" as const,
          },
        } : node),
        { id: "shape", type: "SHAPE_WITH_TEXT", name: "Decision", parentId: "page", siblingIndex: 1, characters: "" },
      ],
    };
    const session = new RuntimeSession({ sessionId: "style-apply", projection: styledProjection, transport: new StyleTransport(styledProjection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text"))!;

    text.textStyleId = "S:body";
    expect(text.textStyleId).toBe("S:body");
    expect(session.projectionStore.getNode("text")?.textProperties).toMatchObject({
      runs: [{
        start: 0,
        end: 4,
        fontSize: 16,
        fontWeight: 400,
        italic: false,
        letterSpacing: .25,
        textCase: "smallCaps",
        textStyleId: "S:body",
        hyperlink: { type: "URL", value: "https://example.com" },
      }],
      paragraph: projection.textStyles?.[0]?.paragraph,
    });
    expect(session.projectionStore.getNode("text")?.textProperties).not.toMatchObject({ runs: [{ textDecoration: "underline" }] });

    text.textStyleId = "";
    expect(text.textStyleId).toBe("");
    expect(text.fontSize).toBe(16);
    expect(isRuntimeError(capture(() => { text.textStyleId = "S:missing"; }), "RESOURCE_UNAVAILABLE")).toBe(true);

    const shape = (await session.getNodeByIdAsync("shape"))!;
    await shape.text.setTextStyleIdAsync("S:body");
    expect(shape.text.textStyleId).toBe("S:body");
    expect(shape.text.fontSize).toBe(16);
  });

  it("supports async range application in dynamic-page mode and rejects unsupported partial paragraph projection", async () => {
    const rangeStyle = {
      id: "S:range",
      key: "",
      name: "Range",
      description: "",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: false,
      style: { fontSize: 20, fontWeight: 600, italic: true, letterSpacing: 1 },
      paragraph: { alignment: "left" as const, lineHeight: 28, paragraphSpacing: 4, paragraphIndent: 2, textWrapStyle: "balance" as const },
    };
    const rangeProjection: RuntimeProjection = {
      ...projection,
      textStyles: [...(projection.textStyles ?? []), rangeStyle],
      nodes: projection.nodes.map((node) => node.id === "text" ? {
        ...node,
        characters: "One\nTwo",
        textProperties: {
          runs: [{ start: 0, end: 7, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }],
          paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 },
          autoSize: "fixed" as const,
        },
      } : node),
    };
    const transport = new StyleTransport(rangeProjection);
    const session = new RuntimeSession({ sessionId: "style-range", projection: rangeProjection, transport, documentAccess: "dynamic-page", loadedPageIds: ["page"], scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text"))!;

    expect(isRuntimeError(capture(() => { text.textStyleId = "S:range"; }), "PAGE_NOT_LOADED")).toBe(true);
    await text.setRangeTextStyleIdAsync(0, 3, "S:range");
    expect(transport.submitted).toHaveLength(1);
    expect(text.getRangeTextStyleId(0, 3)).toBe("S:range");
    expect(text.getRangeTextStyleId(4, 7)).toBe("");
    expect(text.getRangeLineHeight(0, 3)).toEqual({ value: 28, unit: "PIXELS" });
    expect(text.getRangeTextWrapStyle(0, 3)).toBe("BALANCE");

    const incompatible = { ...rangeStyle, id: "S:center", paragraph: { ...rangeStyle.paragraph, alignment: "center" as const } };
    const incompatibleProjection = { ...rangeProjection, textStyles: [...(rangeProjection.textStyles ?? []), incompatible] };
    const incompatibleSession = new RuntimeSession({ sessionId: "style-incompatible", projection: incompatibleProjection, transport: new StyleTransport(incompatibleProjection), scheduleMicrotask: () => {} });
    const incompatibleText = (await incompatibleSession.getNodeByIdAsync("text"))!;
    expect(isRuntimeError(capture(() => incompatibleText.setRangeTextStyleId(0, 3, "S:center")), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(incompatibleText.getRangeTextStyleId(0, 3)).toBe("");
  });

  it("keeps the existing font-load fence when a TextStyle owns a FontRef", async () => {
    const baseStyle = projection.textStyles?.[0];
    if (!baseStyle) throw new Error("Missing fixture TextStyle");
    const fontStyle = {
      ...baseStyle,
      id: "S:font",
      style: { ...baseStyle.style, font: { assetId: "font-1", faceIndex: 0, variationAxes: {} } },
    };
    const fontProjection: RuntimeProjection = {
      ...projection,
      textStyles: [fontStyle],
      nodes: projection.nodes.map((node) => node.id === "document"
        ? { ...node, fontAvailability: { "font-1": "loading" } }
        : node.id === "text"
          ? { ...node, characters: "A", textProperties: { runs: [{ start: 0, end: 1, fontSize: 12, fontWeight: 400, italic: false, letterSpacing: 0 }], paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 }, autoSize: "fixed" as const } }
          : node),
    };
    const session = new RuntimeSession({ sessionId: "style-font-fence", projection: fontProjection, transport: new StyleTransport(fontProjection), scheduleMicrotask: () => {} });
    const text = (await session.getNodeByIdAsync("text"))!;

    expect(isRuntimeError(capture(() => { text.textStyleId = "S:font"; }), "FONT_NOT_LOADED")).toBe(true);
    expect(text.textStyleId).toBe("");
  });
});

class ReadOnlyTransport implements RuntimeTransactionTransport {
  submit(): Promise<RuntimeTransactionResult> {
    throw new Error("No writes expected");
  }
}

class StyleTransport implements RuntimeTransactionTransport {
  submitted: PendingProjectionTransaction[] = [];
  private projection: RuntimeProjection;

  constructor(projection: RuntimeProjection) {
    this.projection = structuredClone(projection);
  }

  currentProjection(): RuntimeProjection { return structuredClone(this.projection); }

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    this.submitted.push(transaction);
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    const textStyles = new Map((this.projection.textStyles ?? []).map((style) => [style.id, structuredClone(style)]));
    for (const operation of transaction.operations) {
      if (operation.type === "registerTextStyle") {
        textStyles.set(operation.style.id, structuredClone(operation.style));
        continue;
      }
      if (operation.type === "setTextStyle") {
        textStyles.set(operation.style.id, structuredClone(operation.style));
        continue;
      }
      if (operation.type === "deleteTextStyle") {
        textStyles.delete(operation.id);
        continue;
      }
      if (operation.type !== "update") continue;
      const node = nodes.get(operation.nodeId);
      if (node) nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
    }
    this.projection = { ...this.projection, revision: this.projection.revision + 1, nodes: [...nodes.values()], textStyles: [...textStyles.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
