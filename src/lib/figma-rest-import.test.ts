import { describe, expect, it } from "vitest";
import { figmaRestImportReport, planFigmaRestImport, resolveFigmaRestAssetBindings, resolveFigmaRestImportBatch } from "./figma-rest-import";
import { nodeContainsWorldPoint } from "./hit-test";
import { exportPageToSvg } from "./svg-export";
import { resolveCoreBatch } from "./transaction-batch";

function ids() {
  let next = 1;
  return {
    allocateNodeId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
    allocatePageId: () => `00000000-0000-4000-8000-${(next++).toString().padStart(12, "0")}`,
  };
}

function decode(value: number[] | undefined) {
  return value ? new TextDecoder().decode(Uint8Array.from(value)) : undefined;
}

describe("Figma REST import planning", () => {
  it("maps supported page hierarchy, geometry, layout and constraints into Canonical candidates", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", name: "Mobile", children: [{
        id: "1:1", type: "FRAME", name: "Card", relativeTransform: [[1, 0, 10], [0, 1, 20]], absoluteBoundingBox: { x: 10, y: 20, width: 320, height: 180 },
        layoutMode: "HORIZONTAL", layoutWrap: "WRAP", paddingTop: 8, paddingRight: 12, paddingBottom: 16, paddingLeft: 20, itemSpacing: 6,
        counterAxisSpacing: 14, counterAxisAlignContent: "SPACE_BETWEEN", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "BASELINE",
        layoutSizingHorizontal: "FIXED", layoutSizingVertical: "HUG", children: [{
          id: "1:2", type: "RECTANGLE", name: "Avatar mask", relativeTransform: [[1, 0, 24], [0, 1, 30]], absoluteBoundingBox: { x: 34, y: 50, width: 40, height: 40 },
          fills: [{ type: "SOLID", color: { r: 1, g: 0, b: .5, a: .5 } }], constraints: { horizontal: "MAX", vertical: "STRETCH" }, isMask: true, maskType: "ALPHA",
        }, {
          id: "1:3", type: "RECTANGLE", name: "Masked target", relativeTransform: [[1, 0, 80], [0, 1, 30]], absoluteBoundingBox: { x: 90, y: 50, width: 40, height: 40 },
        }],
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.pages).toHaveLength(1);
    expect(plan.nodes).toHaveLength(3);
    expect(plan.pageCommands).toEqual([{ type: "create-page", id: plan.pages[0]?.id, name: "Mobile", positionId: plan.pages[0]?.positionId }]);
    expect(plan.nodeCommands).toEqual(plan.nodes.map((node) => ({ type: "create", node })));
    expect(resolveFigmaRestImportBatch(plan)?.batch.map((command) => command.type)).toEqual(["createPage", "create", "create", "create", "setMask"]);
    const [frame, child, target] = plan.nodes;
    expect(frame).toMatchObject({ kind: "frame", pageId: plan.pages[0]?.id, x: 10, y: 20, width: 320, height: 180, autoLayout: { mode: "horizontal", padding: [8, 12, 16, 20], itemSpacing: 6, trackSpacing: 14, trackAlignment: "spaceBetween", wrap: true, primaryAlignment: "spaceBetween", counterAlignment: "baseline", primarySizing: "fixed", counterSizing: "hug" } });
    expect(child).toMatchObject({ kind: "rectangle", parentId: frame?.id, x: 24, y: 30, fill: "#ff008080", isMask: true, constraints: { horizontal: "max", vertical: "stretch" } });
    expect(decode(child?.extensions?.["figma.rest.source-id.v1"])).toBe("1:2");
    expect(decode(child?.extensions?.["figma.mask.type"])).toBe("ALPHA");
    expect(target).toMatchObject({ parentId: frame?.id, x: 80, y: 30 });
  });

  it("produces a stable byte-free compatibility report from planner outcomes", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 }, blendMode: "COLOR",
      }, {
        id: "1:2", type: "WIDGET", absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
      }] }] },
    }, ids());

    expect(figmaRestImportReport(plan)).toEqual({
      format: "makefigma-figma-rest-import-report-v1",
      summary: { pageCount: 1, nodeCount: 1, assetRequestCount: 0, rejectedCount: 0, omittedCount: 1, preservedExtensionCount: 1 },
      issues: expect.arrayContaining([
        expect.objectContaining({ capability: "blend-mode", outcome: "preserved-extension" }),
        expect.objectContaining({ capability: "node-kind", outcome: "omitted" }),
      ]),
    });
  });

  it("preserves the full Figma relativeTransform and uses geometry=paths size before rotated bounds", () => {
    const plan = planFigmaRestImport({ version: "figma-affine-fixture",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE",
        relativeTransform: [[0, -1, 100], [1, 0, 40]],
        size: { x: 20, y: 30 },
        absoluteBoundingBox: { x: 70, y: 40, width: 30, height: 20 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]).toMatchObject({
      x: 100, y: 40, width: 20, height: 30, rotation: 90,
      relativeTransform: { a: 0, b: 1, c: -1, d: 0, e: 100, f: 40 },
    });
    expect(resolveCoreBatch([], plan.nodeCommands)?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ relativeTransform: { a: 0, b: 1, c: -1, d: 0, e: 100, f: 40 } }) }),
    ]);
  });

  it("preserves unsupported source semantics rather than coercing them to a supported mode", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", name: "Page", children: [{
        id: "1:1", type: "RECTANGLE", name: "Source", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        fills: [{ type: "GRADIENT_LINEAR", gradientStops: [] }, { type: "IMAGE", imageRef: "figma-image-ref" }], blendMode: "PASS_THROUGH", isMask: true, maskType: "LUMINANCE",
        effects: [{ type: "NOISE", visible: true }], layoutMode: "GRID",
        exportSettings: [{ format: "SVG", suffix: "-source", svgOutlineText: true }],
      }, { id: "1:2", type: "BOOLEAN_OPERATION", name: "Boolean", booleanOperation: "SUBTRACT", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } }, { id: "1:3", type: "STAR", name: "Star", pointCount: 7, innerRadius: .4, relativeTransform: [[1, 0, 2], [0, 1, 3]], absoluteBoundingBox: { x: 2, y: 3, width: 40, height: 40 } }, { id: "1:4", type: "COMPONENT", name: "Unsupported", absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 } }] }] },
    }, ids());

    expect(plan.nodes).toHaveLength(3);
    const source = plan.nodes[0];
    expect(source?.isMask).toBe(false);
    expect(source?.blendMode).toBe("normal");
    expect(decode(source?.extensions?.["figma.mask.type"])).toBe("LUMINANCE");
    expect(decode(source?.extensions?.["figma.rest.blend-mode.v1"])).toBe("PASS_THROUGH");
    expect(decode(source?.extensions?.["figma.rest.layout-mode.v1"])).toBe("GRID");
    expect(decode(source?.extensions?.["figma.rest.export-settings.v1"])).toContain("svgOutlineText");
    expect(plan.assetRequests).toEqual([{ sourceId: "1:1", nodeId: source?.id, imageRef: "figma-image-ref", usage: "fill" }]);
    expect(plan.nodes[1]).toMatchObject({ kind: "booleanOperation", booleanOperation: "subtract" });
    expect(plan.nodes[2]).toMatchObject({ kind: "star", parametricShape: { kind: "star", pointCount: 7, innerRatio: .4 } });
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "paint", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "blend-mode", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "mask", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "grid-auto-layout", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "export-settings", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "node-kind", outcome: "omitted" }),
    ]));
  });

  it("maps only geometrically equivalent Figma linear gradients into the Canonical Paint Stack", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
        fills: [{ type: "GRADIENT_LINEAR", opacity: .8, gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: .5, color: { r: 0, g: 1, b: 0, a: .5 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ] }],
        strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }, { type: "GRADIENT_LINEAR", gradientHandlePositions: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }], gradientStops: [
          { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
        ] }],
      }] }] },
    }, ids());

    const node = plan.nodes[0];
    expect(node).toMatchObject({
      fill: "#ff0000cc",
      fillGradient: { start: [0, 0], end: [1, 0], stops: [
        { position: 0, color: { space: "srgb", components: [1, 0, 0], alpha: .8 } },
        { position: .5, color: { space: "srgb", components: [0, 1, 0], alpha: .4 } },
        { position: 1, color: { space: "srgb", components: [0, 0, 1], alpha: .8 } },
      ] },
      strokes: [
        { css: "#000000", color: { space: "srgb", components: [0, 0, 0], alpha: 1 } },
        { css: "#ffffff", gradient: { start: [0, 0], end: [0, 1] } },
      ],
    });
    expect(node?.strokeGradient).toBeUndefined();
    expect(plan.issues).toEqual([]);
    expect(resolveCoreBatch([], plan.nodeCommands)?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ fillGradient: expect.objectContaining({ stops: expect.any(Array) }), strokes: expect.any(Array) }) }),
    ]);
  });

  it("maps Figma basic stroke, corner and ellipse-arc fields into their existing Canonical semantics", () => {
    const plan = planFigmaRestImport({ version: "figma-stroke-fixture",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "FRAME", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 120 },
        strokeWeight: 4, individualStrokeWeights: { top: 1, right: 2, bottom: 3, left: 4 }, strokeCap: "TRIANGLE_ARROW", strokeJoin: "ROUND", strokeDashes: [8, 4, 2], strokeAlign: "OUTSIDE",
        cornerRadius: 12, rectangleCornerRadii: [3, 6, 9, 12], cornerSmoothing: .6,
      }, {
        id: "1:2", type: "ELLIPSE", relativeTransform: [[1, 0, 240], [0, 1, 0]], absoluteBoundingBox: { x: 240, y: 0, width: 100, height: 100 },
        strokeWeight: 3, strokeAlign: "INSIDE", arcData: { startingAngle: 0, endingAngle: Math.PI / 2, innerRadius: .4 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]).toMatchObject({ strokeWidth: 4, strokeCapStart: "arrowEquilateral", strokeCapEnd: "arrowEquilateral", strokeJoin: "round", strokeDashPattern: [8, 4, 2], strokeAlign: "outside", strokeWeights: [1, 2, 3, 4], radius: 12, cornerRadii: [3, 6, 9, 12], cornerSmoothing: .6 });
    expect(plan.nodes[1]).toMatchObject({ strokeWidth: 3, strokeAlign: "inside", arcData: { startingAngle: 0, endingAngle: 90, innerRadius: .4 } });
    expect(plan.issues).toEqual([]);
    expect(resolveCoreBatch([], plan.nodeCommands)?.batch).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ strokeWeights: [1, 2, 3, 4], cornerRadii: [3, 6, 9, 12] }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ arcData: expect.objectContaining({ endingAngle: 90 }) }) }),
    ]));
  });

  it("keeps a valid non-donut Figma Arc with innerRadius zero instead of dropping arcData", () => {
    const plan = planFigmaRestImport({
      version: "figma-arc-zero",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "ELLIPSE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.arcData).toEqual({ startingAngle: 0, endingAngle: 180, innerRadius: 0 });
    expect(plan.issues).toEqual([]);
  });

  it("preserves unsupported Figma stroke details rather than changing their appearance", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
        strokeCap: "WASHI_TAPE_1", strokeMiterAngle: 20, complexStrokeProperties: { type: "DYNAMIC", frequency: 2 }, variableWidthPoints: [{ segment: 0, position: .5, width: 2 }],
      }] }] },
    }, ids());

    expect(plan.nodes[0]).toMatchObject({ strokeCapStart: "none", strokeCapEnd: "none", strokeMiterLimit: 10 });
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.unsupported-stroke.v1"])).toContain("WASHI_TAPE_1");
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "stroke-appearance", outcome: "preserved-extension" })]));
  });

  it("keeps effect order without aliasing a later drop shadow as the leading legacy shadow", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "FRAME", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
        effects: [
          { type: "INNER_SHADOW", offset: { x: -1, y: -1 }, radius: 2, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.2 }, visible: true },
          { type: "DROP_SHADOW", offset: { x: 2, y: 2 }, radius: 4, spread: 1, color: { r: 0, g: 0, b: 0, a: 0.1 }, visible: true },
        ],
        children: [],
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.effectStack?.map((effect) => "dropShadow" in effect ? "drop" : "innerShadow" in effect ? "inner" : "blur"))
      .toEqual(["inner", "drop"]);
    expect(plan.nodes[0]?.dropShadow).toBeUndefined();
  });

  it("preserves skewed or otherwise non-equivalent linear gradients instead of approximating them", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [{ type: "GRADIENT_LINEAR", gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ] }],
      }] }] },
    }, ids());

    expect(plan.nodes[0]).toMatchObject({ fillGradient: undefined, fill: "#e6edff" });
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.unsupported-paint.v1"])).toContain("GRADIENT_LINEAR");
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "paint", outcome: "preserved-extension" })]));
  });

  it("maps authorized-independent Text metrics and ASCII style overrides into UTF-8 Canonical runs", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "ABCD", relativeTransform: [[1, 0, 4], [0, 1, 8]], absoluteBoundingBox: { x: 4, y: 8, width: 200, height: 40 }, textAutoResize: "HEIGHT",
        style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400, italic: true, letterSpacing: .2, textAlignHorizontal: "CENTER", lineHeightPx: 24, paragraphSpacing: 6 },
        characterStyleOverrides: [0, 0, 1, 1], styleOverrideTable: { 1: { fontFamily: "Inter", fontSize: 20, fontWeight: 700, italic: false, letterSpacing: .4 } },
      }] }] },
    }, ids());

    const text = plan.nodes[0];
    expect(text?.textProperties).toEqual({
      runs: [
        { start: 0, end: 2, fontSize: 16, fontWeight: 400, italic: true, letterSpacing: .2 },
        { start: 2, end: 4, fontSize: 20, fontWeight: 700, italic: false, letterSpacing: .4 },
      ],
      paragraph: { alignment: "center", lineHeight: 24, paragraphSpacing: 6 },
      autoSize: "height",
    });
    expect(decode(text?.extensions?.["figma.rest.text-font.v1"])).toContain("Inter");
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "font-asset", outcome: "preserved-extension" })]));
  });

  it("does not guess Unicode REST override indexing while retaining a valid base UTF-8 run", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "A😀", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }, characterStyleOverrides: [0, 1], styleOverrideTable: { 1: { fontSize: 20, fontWeight: 700, italic: false, letterSpacing: 0 } },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.textProperties?.runs).toEqual([{ start: 0, end: 5, fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 }]);
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "text-style-overrides", outcome: "preserved-extension" })]));
  });

  it("derives Page and sibling PositionIds from Figma order, including an imported alpha-mask run", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", name: "First", children: [{
        id: "1:1", type: "RECTANGLE", name: "Mask", isMask: true, maskType: "ALPHA", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
      }, {
        id: "1:2", type: "RECTANGLE", name: "Target", relativeTransform: [[1, 0, 30], [0, 1, 0]], absoluteBoundingBox: { x: 30, y: 0, width: 20, height: 20 },
      }, {
        id: "1:3", type: "RECTANGLE", name: "Front", relativeTransform: [[1, 0, 60], [0, 1, 0]], absoluteBoundingBox: { x: 60, y: 0, width: 20, height: 20 },
      }] }, { id: "0:2", type: "CANVAS", name: "Second", children: [] }] },
    }, ids());

    expect(plan.pages.map((page) => page.positionId)).toEqual([
      "55555555555555555555555555555555:00000000000000000000000000000000",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:00000000000000000000000000000000",
    ]);
    expect(plan.pageCommands.map((command) => command.positionId)).toEqual(plan.pages.map((page) => page.positionId));
    expect(plan.nodes.map((node) => node.positionId)).toEqual([
      "40000000000000000000000000000000:00000000000000000000000000000000",
      "80000000000000000000000000000000:00000000000000000000000000000000",
      "c0000000000000000000000000000000:00000000000000000000000000000000",
    ]);
    expect(resolveCoreBatch([], plan.nodeCommands)?.batch.map((entry) => entry.type)).toEqual(["create", "create", "create", "setMask"]);
  });

  it("keeps REST Image nodes valid before authorization, then registers and binds an admitted asset atomically", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "IMAGE", name: "Protected photograph", locked: true, imageRef: "figma-image-ref", relativeTransform: [[1, 0, 4], [0, 1, 8]], absoluteBoundingBox: { x: 4, y: 8, width: 120, height: 80 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]).toMatchObject({ kind: "rectangle", locked: false });
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.image-node.v1"])).toContain("figma-image-ref");
    expect(resolveFigmaRestImportBatch(plan)?.batch.map((command) => command.type)).toEqual(["createPage", "create"]);
    const asset = { assetId: "00000000-0000-4000-8000-00000000a001", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 };
    const binding = resolveFigmaRestAssetBindings(plan.nodes, [], [{ request: plan.assetRequests[0]!, asset }]);

    expect(binding.issues).toEqual([]);
    expect(binding.batch.map((command) => command.type)).toEqual(["registerAsset", "update"]);
    expect(binding.nextNodes[0]).toMatchObject({ assetId: asset.assetId, locked: true });
  });

  it("does not choose between multiple Figma image paints for one Canonical image slot", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [{ type: "IMAGE", imageRef: "first" }, { type: "IMAGE", imageRef: "second" }],
      }] }] },
    }, ids());
    const asset = (suffix: string) => ({ assetId: `00000000-0000-4000-8000-00000000${suffix}`, contentHash: suffix.repeat(64).slice(0, 64), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 });
    const binding = resolveFigmaRestAssetBindings(plan.nodes, [], [
      { request: plan.assetRequests[0]!, asset: asset("a001") },
      { request: plan.assetRequests[1]!, asset: asset("b002") },
    ]);

    expect(binding.boundNodeIds).toEqual([]);
    expect(binding.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "image-fill", outcome: "preserved-extension" })]));
  });

  it("imports supported relative Figma Vector paths with Canonical PointIds and rejects unsafe path input", () => {
    expect(planFigmaRestImport({ document: {} }, ids()).issues).toEqual([
      expect.objectContaining({ capability: "figma-rest-file", outcome: "rejected" }),
    ]);
    const imported = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "VECTOR", relativeTransform: [[1, 0, 14], [0, 1, 18]], absoluteBoundingBox: { x: 14, y: 18, width: 40, height: 20 },
        fillGeometry: [{ path: "M0 0 L40 0 L20 20 Z", windingRule: "EVENODD" }],
      }] }] },
    }, ids());
    expect(imported.nodes[0]).toMatchObject({ kind: "vector", x: 14, y: 18, vectorPath: { fillRule: "evenOdd", subpaths: [{ closed: true, points: [expect.objectContaining({ x: 0, y: 0 }), expect.objectContaining({ x: 40, y: 0 }), expect.objectContaining({ x: 20, y: 20 })] }] } });
    expect(imported.issues).toEqual([]);
    expect(resolveCoreBatch([], imported.nodeCommands)?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ kind: "vector", vectorPath: expect.objectContaining({ fillRule: "evenOdd" }) }) }),
    ]);

    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "VECTOR", fillGeometry: [{ path: "M".repeat(64) }], absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
      }] }] },
    }, { ...ids(), maxPathBytes: 16 });

    expect(plan.nodes).toEqual([]);
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "1:1", capability: "vector-path", outcome: "rejected" }),
    ]));
  });

  it("imports Figma SVG arcs as bounded editable cubics while retaining source arc parameters", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "VECTOR", relativeTransform: [[1, 0, 14], [0, 1, 18]], absoluteBoundingBox: { x: 14, y: 18, width: 10, height: 10 },
        fillGeometry: [{ path: "M0 0 A10 10 0 0 1 10 10 L0 10 Z", windingRule: "NONZERO" }],
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.vectorPath?.subpaths[0]?.points).toHaveLength(6);
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.vector-arc-source.v1"])).toContain("A10 10");
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "vector-arc", outcome: "preserved-extension" })]));
    // Canvas hit testing and SVG's PNG/PDF source both consume the editable
    // cubic projection, rather than interpreting a second arc implementation.
    expect(nodeContainsWorldPoint(plan.nodes[0]!, { x: 19, y: 26 })).toBe(true);
    const exported = exportPageToSvg(plan.nodes, {
      pageId: plan.pages[0]!.id,
      defaultPageId: plan.pages[0]!.id,
      sourceRevision: 1,
    });
    expect(exported.svg).toContain("<path");
    expect(exported.svg).toContain(" C ");
  });

  it("counts rejected source entries against the traversal budget", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [
        { id: "1:1", type: "WIDGET" },
        { id: "1:2", type: "WIDGET" },
        { id: "1:3", type: "WIDGET" },
        { id: "1:4", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } },
      ] }] },
    }, { ...ids(), maxNodes: 2 });

    expect(plan.nodes).toEqual([]);
    expect(plan.issues.filter((issue) => issue.capability === "node-count")).toEqual([
      expect.objectContaining({ outcome: "rejected" }),
    ]);
  });
});
