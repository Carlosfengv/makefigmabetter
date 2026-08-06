import { describe, expect, it } from "vitest";
import { isCreationTool, toolAfterLayerCreated } from "./creation-tool";

describe("one-shot creation tools", () => {
  it("recognizes only layer tools as creation tools", () => {
    expect(isCreationTool("frame")).toBe(true);
    expect(isCreationTool("section")).toBe(true);
    expect(isCreationTool("line")).toBe(true);
    expect(isCreationTool("arrow")).toBe(true);
    expect(isCreationTool("text")).toBe(true);
    expect(isCreationTool("select")).toBe(false);
    expect(isCreationTool("hand")).toBe(false);
  });

  it("returns to Move immediately after a layer is created", () => {
    expect(toolAfterLayerCreated("rectangle")).toBe("select");
    expect(toolAfterLayerCreated("section")).toBe("select");
    expect(toolAfterLayerCreated("line")).toBe("select");
    expect(toolAfterLayerCreated("arrow")).toBe("select");
    expect(toolAfterLayerCreated("select")).toBe("select");
    expect(toolAfterLayerCreated("hand")).toBe("hand");
  });
});
