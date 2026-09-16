import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeSession } from "./runtime-session";
import type { RuntimeProjection } from "./runtime-projection-store";
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
});

class ReadOnlyTransport implements RuntimeTransactionTransport {
  submit(): Promise<RuntimeTransactionResult> {
    throw new Error("No writes expected");
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
