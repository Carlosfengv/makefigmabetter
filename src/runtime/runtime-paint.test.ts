import { describe, expect, it } from "vitest";
import { documentPaintStackFromRuntime, documentTextColorFromRuntimeFills, runtimeFillsFromDocumentTextColor, runtimePaintsFromDocumentStack, runtimePaintsFromNode } from "./runtime-paint";
import { isRuntimeError } from "./runtime-errors";

describe("Runtime Paint adapter", () => {
  it("losslessly maps the representable Text range fill subset", () => {
    const color = documentTextColorFromRuntimeFills([{
      type: "SOLID",
      color: { r: .25, g: .5, b: .75 },
      opacity: .4,
    }]);
    expect(color).toEqual({ space: "srgb", components: [.25, .5, .75], alpha: .4 });
    expect(runtimeFillsFromDocumentTextColor(color)).toEqual([{
      type: "SOLID",
      color: { r: .25, g: .5, b: .75 },
      visible: true,
      opacity: .4,
      blendMode: "NORMAL",
    }]);
    expect(isRuntimeError(capture(() => documentTextColorFromRuntimeFills([])), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(capture(() => documentTextColorFromRuntimeFills([
      { type: "SOLID", color: { r: 1, g: 0, b: 0 } },
      { type: "SOLID", color: { r: 0, g: 0, b: 1 } },
    ])), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(capture(() => documentTextColorFromRuntimeFills([{
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      visible: false,
    }])), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(capture(() => documentTextColorFromRuntimeFills([{
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      blendMode: "MULTIPLY",
    }])), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(capture(() => documentTextColorFromRuntimeFills([{
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    }])), "UNSUPPORTED_FEATURE")).toBe(true);
    expect(isRuntimeError(capture(() => documentTextColorFromRuntimeFills([{
      type: "IMAGE",
      imageHash: "image-1",
      scaleMode: "FILL",
    }])), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it("round-trips Figma's identity linear-gradient transform without losing stops", () => {
    const stack = documentPaintStackFromRuntime([{
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: .4 } },
      ],
      opacity: .75,
      blendMode: "SCREEN",
    }], () => false);

    expect(stack.layers[0]).toMatchObject({
      visible: true,
      opacity: .75,
      blendMode: "screen",
      paint: { gradient: { start: [0, .5], end: [1, .5] } },
    });
    expect(runtimePaintsFromNode({ fillStack: stack }, "fill")).toEqual([{
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: .4 } },
      ],
      visible: true,
      opacity: .75,
      blendMode: "SCREEN",
    }]);
  });

  it("round-trips complete per-run Text paint stacks, including explicit empty stacks", () => {
    const paints = [{
      type: "SOLID",
      color: { r: 1, g: 0, b: 0 },
      opacity: .6,
      blendMode: "MULTIPLY",
    }, {
      type: "GRADIENT_RADIAL",
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: .2 } },
      ],
      visible: false,
    }] as const;
    const stack = documentPaintStackFromRuntime(paints, () => false);
    expect(runtimePaintsFromDocumentStack(stack)).toEqual(paints.map((paint) => ({
      visible: true,
      opacity: 1,
      blendMode: "NORMAL",
      ...paint,
    })));
    expect(runtimePaintsFromDocumentStack({ layers: [] })).toEqual([]);
  });

  it("preserves explicit empty stacks and validates image resources before staging", () => {
    expect(documentPaintStackFromRuntime([], () => false)).toEqual({ layers: [] });
    expect(runtimePaintsFromNode({ fill: "transparent" }, "fill")).toEqual([]);
    const image = { type: "IMAGE", imageHash: "image-1", scaleMode: "TILE", scalingFactor: .5, rotation: 90, filters: { exposure: .25, tint: -.5 } } as const;
    expect(documentPaintStackFromRuntime([image], (hash) => hash === "image-1")).toMatchObject({
      layers: [{ image: { assetId: "image-1", scaleMode: "tile", transform: { a: .5, d: .5 }, rotationDegrees: 90 } }],
    });
    expect(runtimePaintsFromNode({ fillStack: documentPaintStackFromRuntime([image], () => true) }, "fill")).toEqual([{
      ...image,
      visible: true,
      opacity: 1,
      blendMode: "NORMAL",
    }]);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([image], () => false)), "RESOURCE_UNAVAILABLE")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...image, scaleMode: "CROP" }], () => true)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ type: "IMAGE", imageHash: "image-1", scaleMode: "CROP", rotation: 90 }], () => true)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...image, rotation: 45 as never }], () => true)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...image, imageTransform: [[1, 0, 0], [0, 1, 0]] }], () => true)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...image, filters: { exposure: 1.01 } }], () => true)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...image, filters: { exposure: Number.NaN } }], () => true)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...image, filters: { exposure: 0, unknown: 1 } as never }], () => true)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => runtimePaintsFromNode({ fillStack: {
      layers: [{ image: { assetId: "image-1", scaleMode: "tile", transform: { a: 1, b: 0, c: 0, d: 1, e: .1, f: 0 } }, visible: true, opacity: 1, blendMode: "normal" }],
    } }, "fill")), "UNSUPPORTED_FEATURE")).toBe(true);
  });

  it.each([
    ["GRADIENT_RADIAL", "radial"],
    ["GRADIENT_ANGULAR", "angular"],
    ["GRADIENT_DIAMOND", "diamond"],
  ] as const)("round-trips %s with its complete Figma transform", (type, kind) => {
    const paint = {
      type,
      gradientTransform: [[.8, .15, .1], [-.2, 1.1, .05]],
      gradientStops: [
        { position: 0, color: { r: .1, g: .2, b: .3, a: .9 } },
        { position: .4, color: { r: .8, g: .1, b: .2, a: .6 } },
        { position: 1, color: { r: .2, g: .9, b: .5, a: 1 } },
      ],
      visible: false,
      opacity: .7,
      blendMode: "MULTIPLY",
    } as const;
    const stack = documentPaintStackFromRuntime([paint], () => false);

    expect(stack.layers[0]).toMatchObject({
      visible: false,
      opacity: .7,
      blendMode: "multiply",
      paint: {
        gradientPaint: {
          kind,
          transform: { a: .8, b: -.2, c: .15, d: 1.1, e: .1, f: .05 },
        },
      },
    });
    expect(runtimePaintsFromNode({ fillStack: stack }, "fill")).toEqual([paint]);
  });

  it("rejects singular transforms, unordered stops, invalid opacity, and unsupported blends", () => {
    const base = {
      type: "GRADIENT_LINEAR",
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    } as const;
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...base, gradientTransform: [[0, 0, 0], [0, 0, 0]] }], () => false)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ ...base, gradientStops: [...base.gradientStops].reverse() }], () => false)), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentPaintStackFromRuntime([{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 2 }], () => false)), "INVALID_ARGUMENT")).toBe(true);
    expect(documentPaintStackFromRuntime([{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, blendMode: "COLOR" }], () => false).layers[0]?.blendMode).toBe("color");
    expect(runtimePaintsFromNode({ fillStack: { layers: [{ paint: { css: "#000", color: { space: "srgb", components: [0, 0, 0], alpha: 1 } }, visible: true, opacity: 1, blendMode: "color-dodge" }] } }, "fill")[0]?.blendMode).toBe("COLOR_DODGE");
    expect(documentPaintStackFromRuntime([{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, blendMode: "LINEAR_BURN" }], () => false).layers[0]?.blendMode).toBe("linear-burn");
    expect(runtimePaintsFromNode({ fillStack: { layers: [{ paint: { css: "#000" }, visible: true, opacity: 1, blendMode: "linear-dodge" }] } }, "fill")[0]?.blendMode).toBe("LINEAR_DODGE");
  });
});

function capture(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  return undefined;
}
