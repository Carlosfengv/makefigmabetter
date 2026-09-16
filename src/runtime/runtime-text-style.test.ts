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
      remote: false,
      style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: .25, textCase: "smallCaps" },
      paragraph: { alignment: "left", lineHeight: 150, lineHeightUnit: "percent", paragraphSpacing: 8, paragraphIndent: 4, textWrapStyle: "pretty", listSpacing: 6, hangingList: true, hangingPunctuation: true },
    },
    {
      id: "S:remote",
      key: "library-key",
      name: "Library",
      description: "",
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
  it("queries complete canonical styles and reports linked consumers", async () => {
    const session = new RuntimeSession({ sessionId: "styles", projection, transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    const figma = new FigmaCompatibleRuntime(session);
    const style = await figma.getStyleByIdAsync("S:body");

    expect(style).toMatchObject({ id: "S:body", type: "TEXT", name: "Body", remote: false, fontSize: 16, paragraphIndent: 4, paragraphSpacing: 8, listSpacing: 6, hangingList: true, hangingPunctuation: true, textCase: "SMALL_CAPS", textWrapStyle: "PRETTY" });
    expect(style?.letterSpacing).toEqual({ value: .25, unit: "PIXELS" });
    expect(style?.lineHeight).toEqual({ value: 150, unit: "PERCENT" });
    expect(style?.getPluginData("missing")).toBe("");
    expect(style?.getPluginDataKeys()).toEqual([]);
    expect((await style?.getStyleConsumersAsync())?.map((entry) => ({ id: entry.node.id, fields: entry.fields }))).toEqual([{ id: "text", fields: ["textStyleId"] }]);
    expect((await figma.getLocalTextStylesAsync()).map((entry) => entry.id)).toEqual(["S:body"]);
    expect(await figma.getStyleByIdAsync("missing")).toBeNull();
    expect(isRuntimeError(capture(() => { if (style) style.name = "Changed"; }), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it("keeps deprecated synchronous style reads behind full-document access", () => {
    const dynamic = new RuntimeSession({ sessionId: "styles-dynamic", projection, transport: new ReadOnlyTransport(), documentAccess: "dynamic-page", scheduleMicrotask: () => {} });
    expect(isRuntimeError(capture(() => dynamic.getStyleById("S:body")), "PAGE_NOT_LOADED")).toBe(true);
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

  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    this.submitted.push(transaction);
    const nodes = new Map(this.projection.nodes.map((node) => [node.id, structuredClone(node)]));
    for (const operation of transaction.operations) {
      if (operation.type !== "update") continue;
      const node = nodes.get(operation.nodeId);
      if (node) nodes.set(operation.nodeId, { ...node, ...structuredClone(operation.patch) });
    }
    this.projection = { ...this.projection, revision: this.projection.revision + 1, nodes: [...nodes.values()] };
    return { type: "accepted", acceptedRevision: this.projection.revision, projection: this.projection };
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
