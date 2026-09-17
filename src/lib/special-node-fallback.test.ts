import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { specialNodeFallback } from "./special-node-fallback";

describe("M6 special-node fallbacks", () => {
  it("keeps static Canvas cards while exposing only lossy or remote behavior", () => {
    expect(specialNodeFallback(createNode("sticky", 0, 0), "canvas")).toBeUndefined();
    expect(specialNodeFallback({ ...createNode("connector", 0, 0), connectorMetadata: { ...createNode("connector", 0, 0).connectorMetadata!, lineType: "ELBOWED" } }, "canvas")).toBeUndefined();
    expect(specialNodeFallback(createNode("media", 0, 0), "canvas")).toMatchObject({ code: "M6_MEDIA_RESOURCE_UNAVAILABLE_FALLBACK" });
    expect(specialNodeFallback({ ...createNode("media", 0, 0), assetId: "gif-asset", mediaMetadata: { hash: "gif-content-hash" } }, "canvas")).toMatchObject({ code: "M6_MEDIA_PLAYBACK_FALLBACK" });
    expect(specialNodeFallback({ ...createNode("shapeWithText", 0, 0), shapeWithTextType: "STAR" }, "canvas")).toBeUndefined();
    expect(specialNodeFallback({ ...createNode("transformGroup", 0, 0), transformModifiers: [{ type: "REPEAT", count: 2, unitType: "RELATIVE", offset: 1, repeatType: "LINEAR", axis: "HORIZONTAL" }] }, "canvas")).toMatchObject({ code: "M6_TRANSFORM_GROUP_REPEAT_FALLBACK" });
  });

  it("exports the supported plain-text card subset without hiding it behind a fallback", () => {
    for (const kind of ["shapeWithText", "sticky", "table", "tableCell"] as const) {
      expect(specialNodeFallback(createNode(kind, 0, 0), "svg")).toBeUndefined();
    }
    expect(specialNodeFallback({ ...createNode("shapeWithText", 0, 0), shapeWithTextType: "STAR" }, "svg")).toBeUndefined();
    expect(specialNodeFallback({
      ...createNode("transformGroup", 0, 0),
      transformModifiers: [
        { type: "REPEAT", count: 1, unitType: "PIXELS", offset: 100, repeatType: "LINEAR", axis: "HORIZONTAL" },
        { type: "REPEAT", count: 1, unitType: "PIXELS", offset: 80, repeatType: "LINEAR", axis: "VERTICAL" },
      ],
    }, "svg")).toBeUndefined();
  });
});
