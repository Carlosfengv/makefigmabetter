import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { exportPageToSvg } from "./svg-export";

const pageId = "00000000-0000-0000-0000-000000000001";

describe("SVG export", () => {
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
    expect(result.svg).toContain('fill="#123456"');
    expect(result.svg).toContain('fill="#654321"');
  });

  it("excludes hidden Section contents, escapes text and reports image fallback", () => {
    const section = { ...createNode("section", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, contentsHidden: true };
    const hiddenChild = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000002", pageId, parentId: section.id, name: "Hidden" };
    const text = { ...createNode("text", 40, 50), id: "00000000-0000-4000-8000-000000000003", pageId, text: "A < B & C" };
    const image = { ...createNode("image", 120, 50), id: "00000000-0000-4000-8000-000000000004", pageId, assetId: "image-asset" };

    const result = exportPageToSvg([section, hiddenChild, text, image], { pageId, defaultPageId: pageId });

    expect(result.svg).not.toContain('Hidden');
    expect(result.svg).toContain('A &lt; B &amp; C');
    expect(result.warnings).toEqual([expect.stringContaining("does not embed asset bytes")]);
  });

  it("exports Text line breaks and its primary layout style without flattening paragraphs", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 120, text: "First\nSecond",
      textProperties: { runs: [{ start: 0, end: 12, fontSize: 20, fontWeight: 600, italic: true, letterSpacing: 1.5 }], paragraph: { alignment: "center" as const, lineHeight: 24, paragraphSpacing: 6 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('text-anchor="middle"');
    expect(result.svg).toContain('<tspan x="60" y="20"><tspan font-size="20" font-weight="600" font-style="italic" letter-spacing="1.5">First</tspan></tspan><tspan x="60" y="50"><tspan font-size="20" font-weight="600" font-style="italic" letter-spacing="1.5">Second</tspan></tspan>');
  });

  it("exports mixed UTF-8 Style Runs as individual SVG tspans", () => {
    const text = {
      ...createNode("text", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, text: "A中B",
      textProperties: { runs: [
        { start: 0, end: 1, fontSize: 10, fontWeight: 400, italic: false, letterSpacing: 0 },
        { start: 1, end: 4, fontSize: 20, fontWeight: 700, italic: true, letterSpacing: 2 },
        { start: 4, end: 5, fontSize: 12, fontWeight: 500, italic: false, letterSpacing: 1 },
      ], paragraph: { alignment: "left" as const, lineHeight: 24, paragraphSpacing: 0 }, autoSize: "fixed" as const, fallbackFonts: [] },
    };
    const result = exportPageToSvg([text], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('<tspan font-size="10" font-weight="400" font-style="normal" letter-spacing="0">A</tspan><tspan font-size="20" font-weight="700" font-style="italic" letter-spacing="2">中</tspan><tspan font-size="12" font-weight="500" font-style="normal" letter-spacing="1">B</tspan>');
  });

  it("exports a donut Arc as an even-odd path instead of flattening it to an ellipse", () => {
    const ellipse = { ...createNode("ellipse", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 80, arcData: { startingAngle: 0, endingAngle: 360, innerRadius: .5 } };
    const result = exportPageToSvg([ellipse], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('fill-rule="evenodd"');
    expect(result.svg).toContain('<path d="M 100 40 A 50 40');
  });

  it("maps Arrow's Line + StrokeCap representation to SVG markers", () => {
    const arrow = { ...createNode("line", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 120, strokeCapEnd: "arrowLines" as const, strokeCapStart: "diamondFilled" as const };
    const result = exportPageToSvg([arrow], { pageId, defaultPageId: pageId });

    expect(result.svg).toContain('marker-start="url(#makefigma-marker-');
    expect(result.svg).toContain('marker-end="url(#makefigma-marker-');
    expect(result.svg).toContain('<marker id="makefigma-marker-');
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

  it("exports Frame/Rectangle inside and outside Stroke as paint rings", () => {
    const inside = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", pageId, width: 100, height: 60, radius: 12, strokeWidth: 8, strokeAlign: "inside" as const };
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
