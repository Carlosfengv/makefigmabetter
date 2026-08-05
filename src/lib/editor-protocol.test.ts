import { describe, expect, it } from "vitest";
import { createNode, DEFAULT_TEXT_LINE_HEIGHT, documentColorFromCssHex } from "./editor-protocol";

describe("editor protocol node presets", () => {
  it("uses a stable 20px line-height when a legacy text record omits it", () => {
    expect(DEFAULT_TEXT_LINE_HEIGHT).toBe(20);
  });

  it("creates a complete, UUID-addressable rectangle intent", () => {
    const node = createNode("rectangle", 12, -8);

    expect(node).toMatchObject({
      kind: "rectangle",
      name: "Rectangle",
      x: 12,
      y: -8,
      width: 180,
      height: 120,
      fill: "#e6edff",
      opacity: 1,
      visible: true,
    });
    expect(node.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(node.fillColor).toEqual({ space: "srgb", components: [230 / 255, 237 / 255, 1], alpha: 1 });
  });

  it("keeps text content in the command payload instead of UI-only state", () => {
    const node = createNode("text", 0, 0);

    expect(node.text).toBe("Type something");
    expect(node.stroke).toBe("transparent");
    expect(node.strokeWidth).toBe(1);
  });

  it("parses only the CSS hex bridge syntax into an explicit Canonical color", () => {
    expect(documentColorFromCssHex("#f80")).toEqual({ space: "srgb", components: [1, 136 / 255, 0], alpha: 1 });
    expect(documentColorFromCssHex("#11223380")).toEqual({ space: "srgb", components: [17 / 255, 34 / 255, 51 / 255], alpha: 128 / 255 });
    expect(documentColorFromCssHex("color(display-p3 1 0 0)")).toBeUndefined();
  });
});
