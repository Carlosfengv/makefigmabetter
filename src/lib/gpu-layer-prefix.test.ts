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

  it("keeps gradient text in Canvas because the GPU glyph atlas is solid-only", () => {
    const text = { ...node("text", "text"), fillGradient: { start: [0, 0] as [number, number], end: [1, 0] as [number, number], stops: [] } };
    expect(gpuLayerPrefix([text], new Set(), new Set(["text"]))).toEqual([]);
  });

  it("admits aligned full Ellipse rings once the GPU has the equivalent two-ring pass", () => {
    const ellipse = { ...node("ellipse", "ellipse"), strokeWidth: 8, strokeAlign: "outside" as const };
    expect(gpuLayerPrefix([ellipse], new Set()).map((entry) => entry.id)).toEqual(["ellipse"]);
  });

  it("keeps Arc and Donut Ellipses in Canvas", () => {
    const ellipse = { ...node("ellipse", "ellipse"), arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } };
    expect(gpuLayerPrefix([ellipse], new Set())).toEqual([]);
  });

  it("keeps detailed Frame and Rectangle outlines in Canvas", () => {
    const weighted = { ...node("rectangle", "weighted"), strokeWeights: [1, 2, 3, 4] as [number, number, number, number] };
    const rounded = { ...node("frame", "rounded"), cornerRadii: [3, 4, 5, 6] as [number, number, number, number] };
    expect(gpuLayerPrefix([weighted], new Set())).toEqual([]);
    expect(gpuLayerPrefix([rounded], new Set())).toEqual([]);
  });

  it("keeps the whole suffix in Canvas when an affine-native layer is encountered", () => {
    const nodes = [node("frame", "frame"), node("skewed", "rectangle"), node("later", "rectangle")];
    expect(gpuLayerPrefix(nodes, new Set(), new Set(), (entry) => entry.id !== "skewed").map((entry) => entry.id)).toEqual(["frame"]);
  });
});
