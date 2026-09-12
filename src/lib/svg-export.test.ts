import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { withPdfRasterizationFallback } from "./export-compatibility";
import { exportPageToSvg } from "./svg-export";
import { compileScene } from "../runtime/scene-compiler";

const pageId = "00000000-0000-0000-0000-000000000001";

describe("SVG export", () => {
  it("uses a matching shared Scene IR order instead of re-sorting the export input", () => {
    const back = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000971", pageId, width: 20, height: 20, fills: [{ css: "#ff0000" }], strokeWidth: 0, positionId: "00000000000000000000000000000001:00000000000000000000000000000000" };
    const front = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000972", pageId, width: 20, height: 20, fills: [{ css: "#0000ff" }], strokeWidth: 0, positionId: "00000000000000000000000000000002:00000000000000000000000000000000" };
    const scene = compileScene({ revision: 17, pageId, nodes: [back, front] }).scene;
    const result = exportPageToSvg([front, back], { pageId, defaultPageId: pageId, sourceRevision: 17, scene, padding: 0 });

    expect(result.warnings).toEqual([]);
    expect(result.svg.indexOf('fill="#ff0000"')).toBeLessThan(result.svg.indexOf('fill="#0000ff"'));
  });

  it("rejects a Scene IR from a different frozen revision without changing export order", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000973", pageId, width: 20, height: 20, strokeWidth: 0 };
    const scene = compileScene({ revision: 18, pageId, nodes: [rectangle] }).scene;
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId, sourceRevision: 19, scene, padding: 0 });

    expect(result.compatibilityFallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "scene-order", outcome: "fallback" })]));
  });

  it("preserves a supported Blend Mode as SVG mix-blend-mode", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000099", pageId, blendMode: "multiply" as const };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('style="mix-blend-mode:multiply"');
  });

  it("reports Display P3 conversion instead of silently presenting the SVG as wide-gamut", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000098", pageId,
      fillColor: { space: "display-p3" as const, components: [1, .2, .3] as [number, number, number], alpha: 1 },
      strokeWidth: 0,
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.compatibilityFallbacks).toEqual([
      expect.objectContaining({ nodeId: rectangle.id, capability: "display-p3", outcome: "fallback" }),
    ]);
    expect(result.warnings).toEqual([expect.stringContaining("converted to clipped sRGB")]);
  });

  it("exports a selected Slice as a rotated world-space crop without painting the Slice", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000091", pageId, width: 220, height: 160, stroke: "transparent", strokeWidth: 0 };
    const slice = { ...createNode("slice", 40, 30), id: "00000000-0000-4000-8000-000000000092", pageId, width: 100, height: 60, rotation: 90 };

    const result = exportPageToSvg([rectangle, slice], { pageId, defaultPageId: pageId, padding: 999, sliceId: slice.id });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('viewBox="60 10 60 100"');
    expect(result.svg).toContain('<clipPath id="makefigma-slice-');
    expect(result.svg).toContain('clip-path="url(#makefigma-slice-');
    expect(result.svg).not.toContain('stroke-width="0" fill="transparent"');
  });

  it("exports selected layer roots and descendants instead of unrelated Page paint", () => {
    const frame = { ...createNode("frame", 10, 20), id: "00000000-0000-4000-8000-000000000081", pageId, width: 120, height: 80, fill: "#112233", strokeWidth: 0 };
    const child = { ...createNode("rectangle", 20, 10), id: "00000000-0000-4000-8000-000000000082", pageId, parentId: frame.id, width: 40, height: 30, fill: "#ff0066", strokeWidth: 0 };
    const unrelated = { ...createNode("rectangle", 300, 40), id: "00000000-0000-4000-8000-000000000083", pageId, width: 60, height: 40, fill: "#00cc88", strokeWidth: 0 };

    const result = exportPageToSvg([frame, child, unrelated], { pageId, defaultPageId: pageId, padding: 0, nodeIds: [frame.id] });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('matrix(1 0 0 1 10 20)');
    expect(result.svg).toContain('matrix(1 0 0 1 20 10)');
    expect(result.svg).not.toContain('matrix(1 0 0 1 300 40)');
    expect(result.svg).toContain('viewBox="10 10 120 90"');
  });

  it("reports an unavailable node selection instead of silently changing the export target", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000084", pageId, width: 60, height: 40, strokeWidth: 0 };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId, padding: 0, nodeIds: ["00000000-0000-4000-8000-000000000085"] });

    expect(result.compatibilityFallbacks).toEqual([expect.objectContaining({ capability: "node-selection", outcome: "fallback" })]);
    expect(result.svg).toContain('viewBox="0 0 60 40"');
  });

  it("exports an alpha mask as a source-alpha definition without painting the mask layer", () => {
    const mask = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 80, height: 80, fill: "#000000", isMask: true };
    const target = { ...createNode("rectangle", 40, 0), id: "00000000-0000-4000-8000-000000000002", pageId, width: 80, height: 80, fill: "#0048ff", stroke: "transparent", strokeWidth: 0 };

    const result = exportPageToSvg([mask, target], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('<mask id="makefigma-alpha-mask-');
    expect(result.svg).toContain('mask-type="alpha"');
    expect(result.svg).toContain('<g mask="url(#makefigma-alpha-mask-');
    // The mask's black fill appears only inside its definition, never as a
    // painted page sibling; the target remains the only rendered layer.
    expect(result.svg.match(/fill="#0048FF"/g)).toHaveLength(1);
  });

  it("keeps an embedded image alpha source inside its SVG mask and PDF raster input", () => {
    const assetId = "00000000-0000-4000-8000-000000000075";
    const mask = { ...createNode("image", 0, 0), id: "00000000-0000-4000-8000-000000000076", pageId, width: 80, height: 80, assetId, isMask: true, strokeWidth: 0 };
    const target = { ...createNode("rectangle", 20, 0), id: "00000000-0000-4000-8000-000000000077", pageId, width: 100, height: 80, fill: "#0048ff", strokeWidth: 0 };
    const result = exportPageToSvg([mask, target], {
      pageId, defaultPageId: pageId, padding: 0,
      imageDataUris: new Map([[assetId, "data:image/png;base64,AAAA"]]),
    });
    const pdf = withPdfRasterizationFallback(result, target.id);

    expect(result.svg).toContain('mask-type="alpha"');
    expect(result.svg).toContain('<mask id="makefigma-alpha-mask-');
    expect(result.svg.match(/<image href="data:image\/png;base64,AAAA"/g)).toHaveLength(1);
    expect(result.svg).toContain('mask="url(#makefigma-alpha-mask-');
    expect(pdf.compatibilityFallbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: target.id, capability: "pdf-rasterization", outcome: "fallback" }),
    ]));
  });

  it("retains active ancestor and sibling alpha masks when exporting a selected layer", () => {
    const outerMask = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000093", pageId, width: 140, height: 100, isMask: true, strokeWidth: 0 };
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000094", pageId, width: 140, height: 100, clipsContent: false };
    const innerMask = { ...createNode("ellipse", 10, 10), id: "00000000-0000-4000-8000-000000000095", pageId, parentId: frame.id, width: 110, height: 80, isMask: true, strokeWidth: 0 };
    const target = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000096", pageId, parentId: frame.id, width: 140, height: 100, fills: [{ css: "#0048ff" }], stroke: "transparent", strokeWidth: 0 };
    const unrelated = { ...createNode("rectangle", 180, 0), id: "00000000-0000-4000-8000-000000000097", pageId, width: 40, height: 40, fills: [{ css: "#f43f5e" }], strokeWidth: 0 };
    const result = exportPageToSvg([outerMask, frame, innerMask, target, unrelated], { pageId, defaultPageId: pageId, padding: 0, nodeIds: [target.id] });

    expect(result.svg.match(/<mask id="makefigma-alpha-mask-/g)).toHaveLength(2);
    expect(result.svg).toContain('fill="#0048ff"');
    expect(result.svg).not.toContain('fill="#f43f5e"');
  });

  it("reports an unsupported Background Blur applied to a mask instead of silently dropping it", () => {
    const mask = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000091", pageId, width: 80, height: 80, fill: "#000000", isMask: true,
      effectStack: [{ backgroundBlur: { radius: 12, visible: true } }],
    };
    const target = { ...createNode("rectangle", 40, 0), id: "00000000-0000-4000-8000-000000000092", pageId, width: 80, height: 80, fill: "#0048ff", stroke: "transparent", strokeWidth: 0 };
    const result = exportPageToSvg([mask, target], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg).toContain('mask-type="alpha"');
    expect(result.compatibilityFallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: mask.id, capability: "background-blur", outcome: "fallback" })]));
  });

  it("nests alpha masks through structural children without flattening either mask run", () => {
    const outerMask = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000011", pageId, width: 160, height: 120, isMask: true };
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000012", pageId, width: 160, height: 120, clipsContent: false };
    const innerMask = { ...createNode("ellipse", 20, 20), id: "00000000-0000-4000-8000-000000000013", pageId, parentId: frame.id, width: 100, height: 80, isMask: true };
    const target = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000014", pageId, parentId: frame.id, width: 160, height: 120, stroke: "transparent", strokeWidth: 0 };

    const result = exportPageToSvg([outerMask, frame, innerMask, target], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg.match(/<mask id="makefigma-alpha-mask-/g)).toHaveLength(2);
    expect(result.svg.match(/mask-type="alpha"/g)).toHaveLength(2);
  });

  it("omits an unflattened Boolean subtree instead of exporting the wrapper or raw operands", () => {
    const boolean = {
      ...createNode("booleanOperation", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, name: "Subtract", width: 100, height: 60,
    };
    const first = {
      ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000002", pageId, parentId: boolean.id, name: "Boolean source A", width: 100, height: 60,
    };
    const second = {
      ...createNode("vector", 40, 0), id: "00000000-0000-4000-8000-000000000003", pageId, parentId: boolean.id, name: "Boolean source B", width: 60, height: 60,
    };

    const result = exportPageToSvg([boolean, first, second], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.warnings).toEqual([expect.stringContaining("Live BooleanOperation")]);
    expect(result.compatibilityFallbacks).toEqual([expect.objectContaining({ nodeId: boolean.id, capability: "live-boolean", outcome: "fallback" })]);
    expect(result.svg).not.toContain('viewBox="0 0 100 60"');
    expect(result.svg).not.toContain('<path');
  });

  it("exports a live Boolean from its supplied Rust-derived path without emitting its operands", () => {
    const boolean = { ...createNode("booleanOperation", 0, 0), id: "00000000-0000-4000-8000-000000000011", pageId, width: 100, height: 60 };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000012", pageId, parentId: boolean.id, fill: "#cc3366", strokeWidth: 0 };
    const second = { ...createNode("vector", 40, 0), id: "00000000-0000-4000-8000-000000000013", pageId, parentId: boolean.id, strokeWidth: 0 };
    const result = exportPageToSvg([boolean, first, second], {
      pageId,
      defaultPageId: pageId,
      padding: 0,
      booleanPaths: new Map([[boolean.id, { fillRule: "nonZero", subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000014", x: 0, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000015", x: 100, y: 0, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000016", x: 100, y: 60, pointType: "corner" },
        { id: "00000000-0000-4000-8000-000000000017", x: 0, y: 60, pointType: "corner" },
      ] }] }]]),
    });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('d="M 0 0 L 100 0 L 100 60 L 0 60 L 0 0 Z"');
    expect(result.svg.match(/<path /g)).toHaveLength(1);
  });

  it("preserves a supported Boolean wrapper effect in the frozen SVG/PNG/PDF source", () => {
    const boolean = {
      ...createNode("booleanOperation", 0, 0), id: "00000000-0000-4000-8000-000000000061", pageId, width: 100, height: 60,
      effectStack: [{ layerBlur: { radius: 12, visible: true } }],
    };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000062", pageId, parentId: boolean.id, fill: "#cc3366", strokeWidth: 0 };
    const second = { ...createNode("vector", 40, 0), id: "00000000-0000-4000-8000-000000000063", pageId, parentId: boolean.id, strokeWidth: 0 };
    const path = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [
      { id: "00000000-0000-4000-8000-000000000064", x: 0, y: 0, pointType: "corner" as const },
      { id: "00000000-0000-4000-8000-000000000065", x: 100, y: 0, pointType: "corner" as const },
      { id: "00000000-0000-4000-8000-000000000066", x: 100, y: 60, pointType: "corner" as const },
      { id: "00000000-0000-4000-8000-000000000067", x: 0, y: 60, pointType: "corner" as const },
    ] }] };

    const result = exportPageToSvg([boolean, first, second], {
      pageId, defaultPageId: pageId, padding: 0, booleanPaths: new Map([[boolean.id, path]]),
    });

    expect(result.svg).toContain('id="makefigma-layer-blur-0"');
    expect(result.svg).toContain('filter="url(#makefigma-layer-blur-0)"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: boolean.id, capability: "layer-blur" })]));
  });

  it("preserves ordered Layer Blur and Drop Shadow composition instead of dropping Layer Blur from the SVG raster source", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000060", pageId, width: 100, height: 60,
      effectStack: [
        { layerBlur: { radius: 12, visible: true } },
        { dropShadow: { offsetX: 4, offsetY: 6, blurRadius: 8, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true } },
      ],
    };

    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg).toContain('id="makefigma-composed-effect-0"');
    expect(result.svg).toContain('stdDeviation="6" result="effect-0"');
    expect(result.svg).toContain('in="effect-0" type="matrix"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: rectangle.id, capability: "layer-blur" }),
    ]));
  });

  it("preserves an ordered Layer Blur and Inner Shadow stack through the same frozen SVG/PNG/PDF source", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000068", pageId, width: 100, height: 60,
      effectStack: [
        { layerBlur: { radius: 6, visible: true } },
        { innerShadow: { offsetX: 3, offsetY: -4, blurRadius: 8, spread: 2, color: { space: "srgb" as const, components: [.1, .2, .3] as [number, number, number], alpha: .4 }, visible: true } },
      ],
    };

    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('id="makefigma-composed-effect-0"');
    expect(result.svg).toContain('in="effect-0" type="matrix"');
    expect(result.svg).toContain('operator="dilate" radius="2" result="spread-1"');
    expect(result.svg).toContain('dx="-3" dy="4" result="offset-1"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: rectangle.id, capability: "layer-blur" }),
      expect.objectContaining({ nodeId: rectangle.id, capability: "inner-shadow" }),
    ]));
  });

  it("uses the supplied Core-flattened Vector path for SVG and its downstream PNG/PDF source", () => {
    const vector = {
      ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000071", pageId, width: 100, height: 80, strokeWidth: 0,
      vectorPath: { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000072", x: 0, y: 0, pointType: "corner" as const, handleOut: { x: 30, y: 0 } },
        { id: "00000000-0000-4000-8000-000000000073", x: 100, y: 0, pointType: "corner" as const, handleIn: { x: -30, y: 0 } },
        { id: "00000000-0000-4000-8000-000000000074", x: 50, y: 80, pointType: "corner" as const },
      ] }] },
    };
    const flattened = {
      fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [
        { id: "00000000-0000-4000-8000-000000000075", x: 0, y: 0, pointType: "corner" as const },
        { id: "00000000-0000-4000-8000-000000000076", x: 50, y: 0, pointType: "corner" as const },
        { id: "00000000-0000-4000-8000-000000000077", x: 100, y: 0, pointType: "corner" as const },
        { id: "00000000-0000-4000-8000-000000000078", x: 50, y: 80, pointType: "corner" as const },
      ] }],
    };

    const result = exportPageToSvg([vector], { pageId, defaultPageId: pageId, padding: 0, vectorPaths: new Map([[vector.id, flattened]]) });

    expect(result.svg).toContain('d="M 0 0 L 50 0 L 100 0 L 50 80 L 0 0 Z"');
    expect(result.svg).not.toContain(' C ');
  });

  it("preserves a Rust-derived Boolean through an alpha-mask Slice source and records the PDF fallback", () => {
    const mask = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000081", pageId, width: 80, height: 80, isMask: true, strokeWidth: 0 };
    const boolean = { ...createNode("booleanOperation", 0, 0), id: "00000000-0000-4000-8000-000000000082", pageId, width: 120, height: 80 };
    const first = { ...createNode("vector", 0, 0), id: "00000000-0000-4000-8000-000000000083", pageId, parentId: boolean.id, width: 120, height: 80, fill: "#0048ff", strokeWidth: 0 };
    const second = { ...createNode("vector", 40, 0), id: "00000000-0000-4000-8000-000000000084", pageId, parentId: boolean.id, width: 80, height: 80, strokeWidth: 0 };
    const slice = { ...createNode("slice", 0, 0), id: "00000000-0000-4000-8000-000000000085", pageId, width: 100, height: 80 };
    const path = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [
      { id: "00000000-0000-4000-8000-000000000086", x: 0, y: 0, pointType: "corner" as const },
      { id: "00000000-0000-4000-8000-000000000087", x: 100, y: 0, pointType: "corner" as const },
      { id: "00000000-0000-4000-8000-000000000088", x: 100, y: 80, pointType: "corner" as const },
      { id: "00000000-0000-4000-8000-000000000089", x: 0, y: 80, pointType: "corner" as const },
    ] }] };

    const result = exportPageToSvg([mask, boolean, first, second, slice], { pageId, defaultPageId: pageId, padding: 0, sliceId: slice.id, booleanPaths: new Map([[boolean.id, path]]) });

    const pdf = withPdfRasterizationFallback(result, slice.id, "#ffffff");

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('<mask id="makefigma-alpha-mask-');
    expect(result.svg).toContain('mask-type="alpha"');
    expect(result.svg).toContain('clip-path="url(#makefigma-slice-');
    expect(result.svg).toContain('d="M 0 0 L 100 0 L 100 80 L 0 80 L 0 0 Z"');
    expect(pdf.compatibilityFallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: slice.id, capability: "pdf-rasterization", outcome: "fallback" })]));
  });

  it("keeps ordered paint-stack gradients, world matrices and Frame clips", () => {
    const frame = {
      ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 200, height: 100,
      relativeTransform: { a: 0, b: 1, c: -1, d: 0, e: 40, f: 20 },
    };
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000002", pageId, parentId: frame.id, width: 80, height: 40,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 10 },
      fills: [{ css: "#102030", gradient: {
        start: [0, 0] as [number, number], end: [1, 1] as [number, number], stops: [
          { position: 0, color: { space: "srgb" as const, components: [.1, .2, .3] as [number, number, number], alpha: 1 } },
          { position: 1, color: { space: "srgb" as const, components: [.8, .7, .6] as [number, number, number], alpha: .5 } },
        ],
      } }, { css: "#fedcba" }],
      strokes: [{ css: "#123456" }, { css: "#654321" }], strokeWidth: 3,
    };

    const result = exportPageToSvg([frame, rectangle], { pageId, defaultPageId: pageId });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('<linearGradient id="makefigma-gradient-');
    expect(result.svg).toContain('offset="0"');
    expect(result.svg).toContain('offset="1"');
    expect(result.svg).toContain('matrix(0 1 -1 0 40 20)');
    expect(result.svg).toContain('matrix(0 1 -1 0 30 40)');
    expect(result.svg).toContain('<clipPath id="makefigma-clip-');
    // Keep Frame clip geometry in world coordinates. Chromium's SVG Image
    // rasterization can otherwise discard all clipped descendants when the
    // clipPath contains its own transformed group.
    expect(result.svg).toContain('clipPathUnits="userSpaceOnUse"');
    expect(result.svg).not.toMatch(/<clipPath[^>]*><g transform=/);
    expect(result.svg).toContain('fill="#123456"');
    expect(result.svg).toContain('fill="#654321"');
  });

  it("exports Core-resolved Wrap and absolute-child geometry without running Auto Layout again", () => {
    const frame = {
      ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000091", pageId, width: 300, height: 180, clipsContent: true,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 20 },
      autoLayout: { mode: "horizontal" as const, padding: [10, 12, 14, 16] as [number, number, number, number], itemSpacing: 999, trackSpacing: 777, trackAlignment: "spaceBetween" as const, wrap: true, primaryAlignment: "end" as const, counterAlignment: "center" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false },
    };
    // These are intentionally not positions a browser would derive from the
    // parent configuration. They represent the only source the exporter is
    // allowed to use: Core's already-resolved, frozen Relative-v1 geometry.
    const flowChild = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000092", pageId, parentId: frame.id, width: 42, height: 24,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 187, f: 91 },
      autoLayout: { mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false, alignSelf: "end" as const },
    };
    const absoluteChild = {
      ...createNode("ellipse", 0, 0), id: "00000000-0000-4000-8000-000000000093", pageId, parentId: frame.id, width: 26, height: 26,
      relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 251, f: 133 },
      autoLayout: { mode: "none" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: true },
    };

    const result = exportPageToSvg([frame, flowChild, absoluteChild], { pageId, defaultPageId: pageId });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('matrix(1 0 0 1 227 111)');
    expect(result.svg).toContain('matrix(1 0 0 1 291 153)');
    expect(result.svg).not.toContain('999');
    expect(result.svg).not.toContain('777');
  });

  it("excludes hidden Section contents, escapes text and reports image fallback", () => {
    const section = { ...createNode("section", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, contentsHidden: true };
    const hiddenChild = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000002", pageId, parentId: section.id, name: "Hidden" };
    const text = { ...createNode("text", 40, 50), id: "00000000-0000-4000-8000-000000000003", pageId, text: "A < B & C" };
    const image = { ...createNode("image", 120, 50), id: "00000000-0000-4000-8000-000000000004", pageId, assetId: "image-asset" };

    const result = exportPageToSvg([section, hiddenChild, text, image], { pageId, defaultPageId: pageId });

    expect(result.svg).not.toContain('Hidden');
    expect(result.svg).toContain('A &lt; B &amp; C');
    expect(result.warnings).toEqual([expect.stringContaining("bytes were unavailable")]);
    expect(result.compatibilityFallbacks).toEqual([expect.objectContaining({ nodeId: image.id, capability: "image-asset", outcome: "fallback" })]);
  });

  it("embeds an authorized raster image as a clipped self-contained SVG asset", () => {
    const image = { ...createNode("image", 12, 24), id: "00000000-0000-4000-8000-000000000005", pageId, width: 80, height: 48, radius: 12, assetId: "image-asset" };
    const result = exportPageToSvg([image], {
      pageId,
      defaultPageId: pageId,
      imageDataUris: new Map([["image-asset", "data:image/png;base64,AAAA"]]),
    });

    expect(result.warnings).toEqual([]);
    expect(result.compatibilityFallbacks).toEqual([]);
    expect(result.svg).toContain('<image href="data:image/png;base64,AAAA"');
    expect(result.svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(result.svg).toContain('<clipPath id="makefigma-image-clip-');
  });

  it("refuses a supplied SVG data URI and reports the image fallback", () => {
    const image = { ...createNode("image", 12, 24), id: "00000000-0000-4000-8000-000000000006", pageId, assetId: "untrusted-image" };
    const result = exportPageToSvg([image], {
      pageId,
      defaultPageId: pageId,
      imageDataUris: new Map([["untrusted-image", "data:image/svg+xml;base64,PHN2Zy8+"]]),
    });

    expect(result.svg).not.toContain("data:image/svg+xml");
    expect(result.compatibilityFallbacks).toEqual([expect.objectContaining({ nodeId: image.id, capability: "image-asset", outcome: "fallback" })]);
  });

  it("exports Text line breaks and its primary layout style without flattening paragraphs", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 120, text: "First\nSecond",
      textProperties: { runs: [{ start: 0, end: 12, fontSize: 20, fontWeight: 600, italic: true, letterSpacing: 1.5 }], paragraph: { alignment: "center" as const, lineHeight: 24, paragraphSpacing: 6 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('text-anchor="middle"');
    expect(result.svg).toContain('<tspan x="60" y="20" text-anchor="middle" direction="ltr" unicode-bidi="plaintext"><tspan font-size="20" font-weight="600" font-style="italic" letter-spacing="1.5">First</tspan></tspan><tspan x="60" y="50" text-anchor="middle" direction="ltr" unicode-bidi="plaintext"><tspan font-size="20" font-weight="600" font-style="italic" letter-spacing="1.5">Second</tspan></tspan>');
  });

  it("uses frozen Rust text line ranges for soft wrapping without applying paragraph spacing", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000090", pageId, width: 80, text: "abcdef",
      textProperties: { runs: [{ start: 0, end: 6, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }], paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 9 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], {
      pageId, defaultPageId: pageId,
      textLayouts: new Map([[text.id, { lines: [{ start: 0, end: 3, direction: "ltr" as const }, { start: 3, end: 6, direction: "ltr" as const }] }]]),
    });

    expect(result.svg).toContain('<tspan x="0" y="20" text-anchor="start" direction="ltr" unicode-bidi="plaintext"><tspan font-size="20" font-weight="400" font-style="normal" letter-spacing="0">abc</tspan></tspan><tspan x="0" y="44" text-anchor="start" direction="ltr" unicode-bidi="plaintext"><tspan font-size="20" font-weight="400" font-style="normal" letter-spacing="0">def</tspan></tspan>');
  });

  it("uses the frozen Rust direction for an exported text line", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000071", pageId, width: 180, text: "مرحبا",
      textProperties: { runs: [{ start: 0, end: 10, fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0 }], paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], {
      pageId, defaultPageId: pageId,
      textLayouts: new Map([[text.id, { lines: [{ start: 0, end: 10, direction: "ltr" as const }] }]]),
    });

    expect(result.svg).toContain('<tspan x="0" y="20" text-anchor="start" direction="ltr" unicode-bidi="plaintext">');
  });

  it("preserves RTL paragraph direction and its visual start edge in SVG", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000036", pageId, width: 180, text: "مرحبا بالعالم",
      textProperties: { runs: [{ start: 0, end: 25, fontSize: 18, fontWeight: 400, italic: false, letterSpacing: 0 }], paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('<tspan x="180" y="18" text-anchor="end" direction="rtl" unicode-bidi="plaintext">');
  });

  it("declares a generic SVG font fallback and reports unembedded document font assets", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000031", pageId, text: "Custom font",
      textProperties: {
        runs: [{ start: 0, end: 11, font: { assetId: "00000000-0000-4000-8000-000000000032", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 }, autoSize: "fixed" as const,
        fallbackFonts: [{ assetId: "00000000-0000-4000-8000-000000000033", faceIndex: 0 }],
      },
    };

    const result = exportPageToSvg([text], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('font-family="sans-serif"');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("does not embed document font assets"), expect.stringContaining("did not receive frozen Rust text line ranges")]));
    expect(result.compatibilityFallbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: text.id, capability: "font-asset", outcome: "fallback" }),
      expect.objectContaining({ nodeId: text.id, capability: "text-layout", outcome: "fallback" }),
    ]));
  });

  it("keeps a document-font text-layout fallback out of the sidecar once frozen lines are supplied", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000073", pageId, width: 100, text: "Layout",
      textProperties: {
        runs: [{ start: 0, end: 6, font: { assetId: "00000000-0000-4000-8000-000000000074", faceIndex: 0 }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [],
      },
    };
    const result = exportPageToSvg([text], {
      pageId, defaultPageId: pageId,
      fontDataUris: new Map([["00000000-0000-4000-8000-000000000074", "data:font/ttf;base64,AAAA"]]),
      textLayouts: new Map([[text.id, { lines: [{ start: 0, end: 6, direction: "ltr" as const }] }]]),
    });

    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: text.id, capability: "text-layout" })]));
  });

  it("embeds authorized font bytes and traces the SVG to its frozen source revision", () => {
    const assetId = "00000000-0000-4000-8000-000000000034";
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000035", pageId, text: "Custom font",
      textProperties: { runs: [{ start: 0, end: 11, font: { assetId, faceIndex: 0, variationAxes: [{ tag: "wght", value: 650 }, { tag: "wdth", value: 92 }] }, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }], paragraph: { alignment: "left" as const, lineHeight: 20, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], { pageId, defaultPageId: pageId, sourceRevision: 42, fontDataUris: new Map([[assetId, "data:font/woff2;base64,AA=="]]) });

    expect(result.sourceRevision).toBe(42);
    expect(result.svg).toContain('data-makefigma-source-revision="42"');
    expect(result.svg).toContain("@font-face{font-family:'makefigma-font-00000000-0000-4000-8000-000000000034'");
    expect(result.svg).toContain('font-family="makefigma-font-00000000-0000-4000-8000-000000000034,sans-serif"');
    expect(result.svg).toContain('font-variation-settings="&quot;wdth&quot; 92, &quot;wght&quot; 650"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([expect.objectContaining({ capability: "font-asset" })]));
  });

  it("exports mixed UTF-8 Style Runs as individual SVG tspans", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, text: "A中B",
      textProperties: { runs: [
        { start: 0, end: 1, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 4, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 2, color: { space: "srgb" as const, components: [1, 0, 0] as [number, number, number], alpha: 1 } },
        { start: 4, end: 5, fontSize: 12, fontWeight: 500, italic: false, letterSpacing: 1 },
      ], paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('<tspan font-size="10" font-weight="400" font-style="normal" letter-spacing="0">A</tspan><tspan font-size="20" font-weight="700" font-style="italic" letter-spacing="2" fill="#ff0000">中</tspan><tspan font-size="12" font-weight="500" font-style="normal" letter-spacing="1">B</tspan>');
  });

  it("exports a donut Arc as an even-odd path instead of flattening it to an ellipse", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 80, arcData: { startingAngle: 0, endingAngle: 360, innerRadius: .5 } };
    const result = exportPageToSvg([ellipse], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('fill-rule="evenodd"');
    expect(result.svg).toContain('<path d="M 100 40 A 50 40');
  });

  it("preserves the valid ArcData innerRadius one boundary without thinning it", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), id: "00000000-0000-4000-8000-000000000002", pageId, width: 100, height: 80, arcData: { startingAngle: 0, endingAngle: 360, innerRadius: 1 } };
    const result = exportPageToSvg([ellipse], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('Z M 100 40 A 50 40 0 1 0 0 40');
    expect(result.svg).not.toContain("49.99995");
  });

  it("fills decorative Line endpoints from the shared cap mesh instead of independently sized markers", () => {
    const arrow = { ...createNode("line", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 120, strokeCapEnd: "arrowLines" as const, strokeCapStart: "diamondFilled" as const };
    const result = exportPageToSvg([arrow], { pageId, defaultPageId: pageId });

    // The decorative caps are now filled triangle meshes in the Line's local
    // space — the same geometry Canvas draws and hit testing selects — so no
    // <marker> element or independent size model can drift from the render.
    expect(result.svg).not.toContain("<marker");
    expect(result.svg).not.toContain("marker-start=");
    expect(result.svg).not.toContain("marker-end=");
    // Diamond start cap: size = max(8, 1·4) = 8, direction −1, so it reaches
    // back to x = −8 with the near vertex at x = −4 (half) and ±4 vertically.
    expect(result.svg).toContain('<path d="M 0 0 L -4 4 L -8 0 Z M 0 0 L -8 0 L -4 -4 Z" fill="#0048FF" stroke="none" fill-rule="nonzero"/>');
    // End arrowLines barbs point back from x = 120 as thin filled quads.
    expect(result.svg).toContain('L 113.32179676972449');
  });

  it("uses Line's start-endpoint transform and visible stroke envelope for the export viewport", () => {
    const line = {
      ...createNode("line", 10, 20), id: "00000000-0000-4000-8000-000000000001", pageId,
      width: 100, rotation: 90, strokeWidth: 10, strokeCapStart: "round" as const, strokeCapEnd: "round" as const,
    };
    const result = exportPageToSvg([line], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg).toContain('viewBox="5 15 10 110"');
    expect(result.svg).toContain('transform="matrix(0 1 -1 0 10 20)"');
  });

  it("exports independent solid Line caps as one non-overlapping outline", () => {
    const line = {
      ...createNode("line", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      width: 100, strokeWidth: 10, strokeCapStart: "square" as const, strokeCapEnd: "round" as const,
    };
    const result = exportPageToSvg([line], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg).toContain('d="M 0 -5 H 100 V 5 H 0 Z M -5 -5 H 0 V 5 H -5 Z M 95 0 A 5 5 0 1 0 105 0 A 5 5 0 1 0 95 0 Z"');
    expect(result.svg).toContain('fill="#0048FF" stroke="none" fill-rule="nonzero"');
    expect(result.svg).not.toContain('fill="none" stroke="#0048FF" fill-rule="nonzero" stroke-linecap="square"');
  });

  it("uses the same Butt fallback as Canvas for dashed Lines with asymmetric caps", () => {
    const line = {
      ...createNode("line", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      width: 100, strokeWidth: 10, strokeDashPattern: [8, 4], strokeCapStart: "square" as const, strokeCapEnd: "round" as const,
    };
    const result = exportPageToSvg([line], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg).toContain('stroke-linecap="butt"');
    expect(result.svg).toContain('stroke-dasharray="8 4"');
    expect(result.svg).not.toContain('stroke-linecap="square"');
  });

  it("does not give an SVG viewport a square-cap extension after a terminal dash gap", () => {
    const line = {
      ...createNode("line", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      width: 94, strokeWidth: 10, strokeDashPattern: [8, 4], strokeCapStart: "square" as const, strokeCapEnd: "square" as const,
    };
    const result = exportPageToSvg([line], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg).toContain('viewBox="-5 -5 99 10"');
    expect(result.svg).toContain('stroke-linecap="square"');
    expect(result.svg).toContain('stroke-dasharray="8 4"');
  });

  it("retains explicit solid-color alpha independently from node opacity", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      fillColor: { space: "srgb" as const, components: [.2, .4, .6] as [number, number, number], alpha: .25 },
      strokeColor: { space: "srgb" as const, components: [.9, .8, .7] as [number, number, number], alpha: .5 },
      strokeWidth: 2, strokeAlign: "center" as const, opacity: .8,
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('fill-opacity="0.25"');
    expect(result.svg).toContain('stroke-opacity="0.5"');
    expect(result.svg).toContain('opacity="0.8"');
  });

  it("exports the persisted Drop Shadow with a bounded SVG filter", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      dropShadow: { offsetX: 4, offsetY: 8, blurRadius: 12, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true },
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });
    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('<filter id="makefigma-drop-shadow-0" filterUnits="userSpaceOnUse"');
    expect(result.svg).toContain('<feGaussianBlur in="SourceAlpha" stdDeviation="6" result="blur"/>');
    expect(result.svg).toContain('<feOffset in="blur" dx="4" dy="8" result="offsetBlur"/>');
    expect(result.svg).toContain('flood-opacity="0.25"');
    expect(result.svg).toContain('filter="url(#makefigma-drop-shadow-0)"');
  });

  it("preserves positive and negative Drop Shadow spread with SVG morphology", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      dropShadow: { offsetX: 0, offsetY: 4, blurRadius: 10, spread: 3, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true },
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('<feMorphology in="SourceAlpha" operator="dilate" radius="3" result="spread"/>');
    expect(result.svg).toContain('<feGaussianBlur in="spread" stdDeviation="5" result="blur"/>');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: rectangle.id, capability: "shadow-spread" })]));

    const negative = exportPageToSvg([{ ...rectangle, dropShadow: { ...rectangle.dropShadow, spread: -2 } }], { pageId, defaultPageId: pageId });
    expect(negative.svg).toContain('<feMorphology in="SourceAlpha" operator="erode" radius="2" result="spread"/>');
  });

  it("threads ordered Drop Shadow entries through one SVG filter instead of reusing SourceGraphic", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      dropShadow: { offsetX: 4, offsetY: 6, blurRadius: 8, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true },
      effectStack: [
        { dropShadow: { offsetX: 4, offsetY: 6, blurRadius: 8, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true } },
        { dropShadow: { offsetX: -3, offsetY: 2, blurRadius: 4, spread: 1, color: { space: "srgb" as const, components: [1, 1, 1] as [number, number, number], alpha: .5 }, visible: true } },
      ],
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('result="shadow-0"');
    expect(result.svg).toContain('result="shadow-1"');
    expect(result.svg).toContain('<feMerge result="effect-0"><feMergeNode in="shadow-0"/><feMergeNode in="SourceGraphic"/></feMerge>');
    expect(result.svg).toContain('<feMerge result="effect-1"><feMergeNode in="shadow-1"/><feMergeNode in="effect-0"/></feMerge>');
  });

  it("reports unsupported ordered Blur and Inner Shadow effects instead of silently dropping them", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      effectStack: [
        { layerBlur: { radius: 12, visible: true } },
        { innerShadow: { offsetX: 2, offsetY: 3, blurRadius: 8, spread: 0, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true } },
        { backgroundBlur: { radius: 16, visible: true } },
      ],
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Layer Blur"), expect.stringContaining("Inner Shadow"), expect.stringContaining("Background Blur"),
    ]));
    expect(result.compatibilityFallbacks).toEqual([
      expect.objectContaining({ nodeId: rectangle.id, capability: "layer-blur", outcome: "fallback" }),
      expect.objectContaining({ nodeId: rectangle.id, capability: "inner-shadow", outcome: "fallback" }),
      expect.objectContaining({ nodeId: rectangle.id, capability: "background-blur", outcome: "fallback" }),
    ]);
  });

  it("exports a standalone Layer Blur as a vector SVG Gaussian filter", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      width: 80, height: 40,
      effectStack: [{ layerBlur: { radius: 12, visible: true } }],
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('id="makefigma-layer-blur-0"');
    expect(result.svg).toContain('<feGaussianBlur in="SourceGraphic" stdDeviation="6"/>');
    expect(result.svg).toContain('filter="url(#makefigma-layer-blur-0)"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([expect.objectContaining({ capability: "layer-blur" })]));
  });

  it("exports a standalone Inner Shadow with spread and a SourceAlpha-clipped SVG filter", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      width: 80, height: 40,
      effectStack: [
        { layerBlur: { radius: 12, visible: false } },
        { innerShadow: { offsetX: 2, offsetY: -3, blurRadius: 8, spread: -2, color: { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .25 }, visible: true } },
      ],
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('id="makefigma-inner-shadow-0"');
    expect(result.svg).toContain('<feMorphology in="SourceAlpha" operator="erode" radius="2" result="spread"/>');
    expect(result.svg).toContain('<feGaussianBlur in="spread" stdDeviation="4" result="blur"/>');
    expect(result.svg).toContain('<feComposite in="offsetBlur" in2="SourceAlpha" operator="in" result="innerMask"/>');
    expect(result.svg).toContain('<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="innerShadow"/></feMerge>');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([expect.objectContaining({ capability: "inner-shadow" })]));
  });

  it("expands explicit per-corner radii through the shared aligned-stroke source for Outside export", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 60, cornerRadii: [10, 10, 10, 10] as [number, number, number, number], strokeWidth: 8, strokeAlign: "outside" as const };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    // The outer ring's corners are 10 + 8 = 18, derived from the shared
    // `outsetRoundedRectRadii` — the same source Canvas and hit testing use — so
    // an explicit per-corner radius grows identically across all three consumers
    // instead of each re-deriving the aligned expansion.
    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('d="M 18 0 H 98 A 18 18 0 0 1 116 18 V 58 A 18 18 0 0 1 98 76 H 18 A 18 18 0 0 1 0 58 V 18 A 18 18 0 0 1 18 0 Z"');
    expect(result.svg).toContain('transform="translate(-8 -8)"');
  });

  it("exports Frame/Rectangle inside and outside Stroke as paint rings", () => {    const inside = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 60, radius: 12, strokeWidth: 8, strokeAlign: "inside" as const };
    const outside = { ...createNode("rectangle", 120, 0), id: "00000000-0000-4000-8000-000000000002", pageId, width: 100, height: 60, radius: 12, strokeWidth: 8, strokeAlign: "outside" as const };

    const result = exportPageToSvg([inside, outside], { pageId, defaultPageId: pageId });

    expect(result.svg).not.toContain('stroke-width="8"');
    expect(result.svg).toContain('transform="translate(8 8)"');
    expect(result.svg).toContain('transform="translate(-8 -8)"');
    expect(result.svg).toContain('M 20 0 H 96');
  });

  it("keeps Dash when exporting aligned Frame/Rectangle Stroke", () => {
    const inside = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 60, radius: 12, strokeWidth: 8, strokeAlign: "inside" as const, strokeDashPattern: [12, 6] };
    const outside = { ...createNode("rectangle", 120, 0), id: "00000000-0000-4000-8000-000000000002", pageId, width: 100, height: 60, radius: 12, strokeWidth: 8, strokeAlign: "outside" as const, strokeDashPattern: [12, 6] };
    const result = exportPageToSvg([inside, outside], { pageId, defaultPageId: pageId });

    expect(result.svg.match(/stroke-dasharray="12 6"/g)).toHaveLength(2);
    expect(result.svg).toContain('transform="translate(4 4)"');
    expect(result.svg).toContain('transform="translate(-4 -4)"');
    expect(result.svg).not.toContain('stroke-width="8" fill-rule="nonzero"');
  });

  it("exports full Ellipse inside and outside Stroke as paint rings", () => {
    const inside = { ...createNode("ellipse", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 60, strokeWidth: 8, strokeAlign: "inside" as const };
    const outside = { ...createNode("ellipse", 120, 0), id: "00000000-0000-4000-8000-000000000002", pageId, width: 100, height: 60, strokeWidth: 8, strokeAlign: "outside" as const };
    const result = exportPageToSvg([inside, outside], { pageId, defaultPageId: pageId });

    expect(result.svg).not.toContain('stroke-width="8"');
    expect(result.svg).toContain('rx="42" ry="22"');
    expect(result.svg).toContain('rx="58" ry="38"');
  });

  it("includes Outside Ellipse paint in a zero-padding export viewport", () => {
    const ellipse = { ...createNode("ellipse", 10, 20), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 60, strokeWidth: 8, strokeAlign: "outside" as const };
    const result = exportPageToSvg([ellipse], { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg).toContain('viewBox="2 12 116 76"');
  });

  it("uses Canvas' continuous-corner approximation for smoothed shapes and Frame clips", () => {
    const frame = { ...createNode("frame", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 60, radius: 20, cornerSmoothing: .5 };
    const child = { ...createNode("rectangle", 10, 10), id: "00000000-0000-4000-8000-000000000002", pageId, parentId: frame.id, width: 120, height: 40 };
    const result = exportPageToSvg([frame, child], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('<clipPath id="makefigma-clip-');
    expect(result.svg).toContain('d="M 20 0 H 80 L ');
    expect(result.svg).not.toContain('A 20 20');
  });

  it("exports per-side Stroke weights without collapsing them to a uniform outline", () => {
    const rectangle = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, strokeWidth: 3, strokeWeights: [1, 2, 3, 4] as [number, number, number, number], strokeAlign: "outside" as const };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.warnings).toEqual([]);
    expect(result.svg).toContain('stroke-width="1"');
    expect(result.svg).toContain('stroke-width="2"');
    expect(result.svg).toContain('stroke-width="3"');
    expect(result.svg).toContain('stroke-width="4"');
    expect(result.svg).toContain('M 0 -0.5 H 180');
    expect(result.svg).toContain('M 181 0 V 120');
  });

  it("keeps each Inside per-side Stroke weight fully inside the exported shape", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      strokeWeights: [4, 12, 16, 8] as [number, number, number, number], strokeAlign: "inside" as const,
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('M 0 2 H 180');
    expect(result.svg).toContain('M 174 0 V 120');
    expect(result.svg).toContain('M 180 112 H 0');
    expect(result.svg).toContain('M 4 120 V 0');
  });

  it("preserves the independent-edge Dash contract for per-side Stroke export", () => {
    const rectangle = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId,
      strokeWeights: [4, 12, 16, 8] as [number, number, number, number], strokeAlign: "inside" as const, strokeDashPattern: [18, 8],
    };
    const result = exportPageToSvg([rectangle], { pageId, defaultPageId: pageId });

    expect(result.svg.match(/stroke-dasharray="18 8"/g)).toHaveLength(4);
    expect(result.svg).toContain('M 0 2 H 180');
    expect(result.svg).toContain('M 174 0 V 120');
    expect(result.svg).toContain('<g clip-path="url(#makefigma-stroke-clip-');
  });
});
