import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeSession } from "./runtime-session";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";
import { isRuntimeError } from "./runtime-errors";

const projection: RuntimeProjection = {
  revision: 7,
  paintStyles: [
    {
      id: "S:brand-fill",
      key: "",
      name: "Brand fill",
      description: "Primary surface",
      remote: false,
      paints: { layers: [{ visible: true, opacity: .75, blendMode: "multiply", paint: { css: "#ff0000ff", color: { space: "srgb", components: [1, 0, 0], alpha: 1 } } }] },
    },
    {
      id: "S:remote-fill",
      key: "library-key",
      name: "Library fill",
      description: "",
      remote: true,
      paints: { layers: [] },
    },
  ],
  nodes: [
    { id: "document", type: "DOCUMENT", name: "Document" },
    { id: "page", type: "PAGE", name: "Page", parentId: "document", siblingIndex: 0 },
  ],
};

describe("PaintStyle resource runtime", () => {
  it("queries complete canonical paints and filters remote styles", async () => {
    const session = new RuntimeSession({ sessionId: "paint-styles", projection, transport: new ReadOnlyTransport(), scheduleMicrotask: () => {} });
    const figma = new FigmaCompatibleRuntime(session);
    const style = await figma.getStyleByIdAsync("S:brand-fill");

    expect(style).toMatchObject({ id: "S:brand-fill", type: "PAINT", name: "Brand fill", remote: false });
    expect(style?.type === "PAINT" ? style.paints : undefined).toEqual([{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75, visible: true, blendMode: "MULTIPLY", boundVariables: undefined }]);
    expect(await style?.getStyleConsumersAsync()).toEqual([]);
    expect((await figma.getLocalPaintStylesAsync()).map((entry) => entry.id)).toEqual(["S:brand-fill"]);
    expect(await figma.getStyleByIdAsync("missing")).toBeNull();
    expect(isRuntimeError(capture(() => { if (style) style.name = "Changed"; }), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it("keeps deprecated synchronous reads behind full-document access", () => {
    const session = new RuntimeSession({ sessionId: "paint-styles-dynamic", projection, transport: new ReadOnlyTransport(), documentAccess: "dynamic-page", scheduleMicrotask: () => {} });
    expect(isRuntimeError(capture(() => session.getLocalPaintStyles()), "PAGE_NOT_LOADED")).toBe(true);
  });
});

class ReadOnlyTransport implements RuntimeTransactionTransport {
  submit(_transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    void _transaction;
    throw new Error("No writes expected");
  }
}

function capture(callback: () => unknown): unknown {
  try { return callback(); } catch (error) { return error; }
}
