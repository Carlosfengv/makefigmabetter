import { describe, expect, it } from "vitest";
import type { DocumentAutoLayout } from "./editor-protocol";
import { normalizeAutoLayout } from "./auto-layout-normalization";

describe("normalizeAutoLayout", () => {
  it("fills parameters omitted by an older imported Auto Layout record", () => {
    expect(normalizeAutoLayout({ mode: "vertical" } as DocumentAutoLayout)).toEqual({
      mode: "vertical",
      padding: [0, 0, 0, 0],
      itemSpacing: 0,
      trackSpacing: undefined,
      trackAlignment: undefined,
      wrap: false,
      primaryAlignment: "start",
      counterAlignment: "start",
      primarySizing: "fixed",
      counterSizing: "fixed",
      alignSelf: undefined,
      minWidth: undefined,
      maxWidth: undefined,
      minHeight: undefined,
      maxHeight: undefined,
      absolute: false,
    });
  });

  it("accepts the old per-side padding shape and rejects invalid numbers", () => {
    const legacy = { mode: "horizontal", paddingTop: 8, paddingRight: 12, paddingBottom: 16, paddingLeft: 20, itemSpacing: Number.NaN } as unknown as DocumentAutoLayout;
    expect(normalizeAutoLayout(legacy)).toMatchObject({ padding: [8, 12, 16, 20], itemSpacing: 0 });
  });

  it("keeps nullable WASM option fields absent instead of converting them to zero limits", () => {
    const wasmProjection = {
      mode: "none",
      trackSpacing: null,
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
    } as unknown as DocumentAutoLayout;

    expect(normalizeAutoLayout(wasmProjection)).toMatchObject({
      trackSpacing: undefined,
      minWidth: undefined,
      maxWidth: undefined,
      minHeight: undefined,
      maxHeight: undefined,
    });
  });
});
