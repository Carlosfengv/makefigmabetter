import { describe, expect, it } from "vitest";
import { gpuLayerPrefix } from "./gpu-layer-prefix";
import type { CanvasNode } from "./editor-protocol";

const node = (id: string, kind: CanvasNode["kind"], assetId?: string): CanvasNode => ({ id, kind, assetId, name: id, x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#ffffff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 });

describe("GPU layer prefix", () => {
  it("leaves a newer shape in Canvas when it follows an image", () => {
    const nodes = [node("frame", "frame"), node("image", "image", "asset"), node("newer-rectangle", "rectangle")];
    expect(gpuLayerPrefix(nodes, new Set(["asset"])).map((entry) => entry.id)).toEqual(["frame", "image"]);
  });

  it("stops before an undecoded image placeholder", () => {
    const nodes = [node("frame", "frame"), node("image", "image", "asset")];
    expect(gpuLayerPrefix(nodes, new Set()).map((entry) => entry.id)).toEqual(["frame"]);
  });

  it("keeps shape image fills in Canvas until the image pass can preserve their mask", () => {
    const nodes = [node("frame", "frame"), node("filled-rectangle", "rectangle", "asset")];
    expect(gpuLayerPrefix(nodes, new Set(["asset"])).map((entry) => entry.id)).toEqual(["frame"]);
  });

  it("allows a GPU-eligible text node after images", () => {
    const nodes = [node("frame", "frame"), node("image", "image", "asset"), node("text", "text")];
    expect(gpuLayerPrefix(nodes, new Set(["asset"]), new Set(["text"])).map((entry) => entry.id)).toEqual(["frame", "image", "text"]);
  });
});
