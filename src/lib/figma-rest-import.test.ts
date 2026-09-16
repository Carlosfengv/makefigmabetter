import { describe, expect, it } from "vitest";
import { cancelFigmaRestAssetBindings, figmaRestImportReport, pendingFigmaRestAssetRequests, planFigmaRestImport, resolveFigmaRestAssetBindings, resolveFigmaRestImportBatch } from "./figma-rest-import";
import { nodeContainsWorldPoint } from "./hit-test";
import { NORMAL_BLEND_ISOLATION_EXTENSION } from "./node-blend-semantics";
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
  it("preserves explicit NORMAL container isolation separately from PASS_THROUGH", () => {
    const plan = planFigmaRestImport({
      version: "normal-isolation",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [
        { id: "1:1", type: "FRAME", blendMode: "NORMAL", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: [] },
        { id: "1:2", type: "GROUP", blendMode: "PASS_THROUGH", absoluteBoundingBox: { x: 120, y: 0, width: 100, height: 100 }, children: [] },
        { id: "1:3", type: "RECTANGLE", blendMode: "NORMAL", absoluteBoundingBox: { x: 240, y: 0, width: 100, height: 100 } },
      ] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.nodes[0]).toMatchObject({ kind: "frame", blendMode: "normal" });
    expect(plan.nodes[0]?.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION]).toEqual([1]);
    expect(plan.nodes[1]).toMatchObject({ kind: "group", blendMode: "pass-through" });
    expect(plan.nodes[1]?.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION]).toBeUndefined();
    expect(plan.nodes[2]).toMatchObject({ kind: "rectangle", blendMode: "normal" });
    expect(plan.nodes[2]?.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION]).toBeUndefined();
  });

  it.each([
    ["LINEAR_BURN", "linear-burn"],
    ["LINEAR_DODGE", "linear-dodge"],
  ] as const)("preserves a solid paint layer using %s", (sourceBlend, canonicalBlend) => {
    const plan = planFigmaRestImport({
      version: "linear-paint",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [{ type: "SOLID", color: { r: .8, g: .2, b: .3 }, opacity: .75, blendMode: sourceBlend }],
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.nodes[0]?.fillStack).toMatchObject({
      layers: [{ visible: true, opacity: .75, blendMode: canonicalBlend, paint: { css: "#cc334d" } }],
    });
  });

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

  it("imports the bounded row-major Grid subset without coercing its tracks", () => {
    const plan = planFigmaRestImport({
      version: "grid-v1",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "FRAME", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 240 },
        layoutMode: "GRID", gridRowCount: 2, gridColumnCount: 2, gridRowGap: 12, gridColumnGap: 20,
        gridItemsPositioning: "ROW_AUTO_FLOW", gridAutoTracks: "NONE",
        gridRowSizes: [{ type: "FIXED", value: 64 }, { type: "FLEX", value: 1 }],
        gridColumnSizes: [{ type: "FLEX", value: 2 }, { type: "FIXED", value: 80 }],
        children: [],
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.nodes[0]?.autoLayout).toMatchObject({
      mode: "grid",
      primarySizing: "fixed",
      counterSizing: "fixed",
      gridRows: [{ type: "fixed", value: 64 }, { type: "flex", value: 1 }],
      gridColumns: [{ type: "flex", value: 2 }, { type: "fixed", value: 80 }],
      gridRowGap: 12,
      gridColumnGap: 20,
    });
  });

  it("imports HUG Grid tracks and defaults an omitted FLEX weight to one", () => {
    const plan = planFigmaRestImport({
      version: "grid-hug-track",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "FRAME", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 240 },
        layoutMode: "GRID", gridRowCount: 2, gridColumnCount: 1,
        gridItemsPositioning: "ROW_AUTO_FLOW", gridAutoTracks: "NONE",
        gridRowSizes: [{ type: "HUG" }, { type: "FLEX" }],
        gridColumnSizes: [{ type: "FIXED", value: 80 }],
        children: [],
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.nodes[0]?.autoLayout).toMatchObject({
      mode: "grid",
      gridRows: [{ type: "hug" }, { type: "flex", value: 1 }],
      gridColumns: [{ type: "fixed", value: 80 }],
    });
  });

  it("preserves a Grid whose FILL child would cyclically size a HUG track", () => {
    const plan = planFigmaRestImport({
      version: "grid-hug-fill-cycle",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "FRAME", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 240 },
        layoutMode: "GRID", gridRowCount: 1, gridColumnCount: 1,
        gridItemsPositioning: "ROW_AUTO_FLOW", gridAutoTracks: "NONE",
        gridRowSizes: [{ type: "FIXED", value: 80 }],
        gridColumnSizes: [{ type: "HUG" }],
        children: [{
          id: "1:2", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
          layoutSizingHorizontal: "FILL",
        }],
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.autoLayout).toBeUndefined();
    expect(plan.nodes[0]?.extensions?.["figma.rest.grid-auto-layout.v1"]).toBeDefined();
    expect(plan.issues).toContainEqual(expect.objectContaining({ capability: "grid-auto-layout", outcome: "preserved-extension" }));
  });

  it("preserves malformed Grid tracks instead of coercing them to defaults", () => {
    const plan = planFigmaRestImport({
      version: "grid-invalid-track",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "FRAME", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 240 },
        layoutMode: "GRID", gridRowCount: 1, gridColumnCount: 1,
        gridItemsPositioning: "ROW_AUTO_FLOW", gridAutoTracks: "NONE",
        gridRowSizes: [{ type: "HUG", value: 64 }],
        gridColumnSizes: [{ type: "FLEX", value: 1 }],
        children: [],
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.autoLayout).toBeUndefined();
    expect(plan.nodes[0]?.extensions?.["figma.rest.grid-auto-layout.v1"]).toBeDefined();
    expect(plan.issues).toContainEqual(expect.objectContaining({ capability: "grid-auto-layout", outcome: "preserved-extension" }));
  });

  it("produces a stable byte-free compatibility report from planner outcomes", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 }, blendMode: "LINEAR_BURN",
      }, {
        id: "1:2", type: "WIDGET", absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
      }] }] },
    }, ids());

    expect(figmaRestImportReport(plan)).toEqual({
      format: "makefigma-figma-rest-import-report-v1",
      summary: { pageCount: 1, nodeCount: 1, assetRequestCount: 0, rejectedCount: 0, omittedCount: 1, preservedExtensionCount: 0 },
      issues: expect.arrayContaining([
        expect.objectContaining({ capability: "node-kind", outcome: "omitted" }),
      ]),
    });
    expect(plan.nodes[0]?.blendMode).toBe("linear-burn");
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

    expect(plan.nodes).toHaveLength(4);
    const source = plan.nodes[0];
    expect(source?.isMask).toBe(false);
    expect(source?.blendMode).toBe("pass-through");
    expect(decode(source?.extensions?.["figma.mask.type"])).toBe("LUMINANCE");
    expect(source?.extensions?.["figma.rest.blend-mode.v1"]).toBeUndefined();
    expect(decode(source?.extensions?.["figma.rest.layout-mode.v1"])).toBe("GRID");
    expect(decode(source?.extensions?.["figma.rest.export-settings.v1"])).toContain("svgOutlineText");
    expect(plan.assetRequests).toEqual([{ sourceId: "1:1", nodeId: source?.id, imageRef: "figma-image-ref", usage: "fill", paintIndex: 1 }]);
    expect(plan.nodes[1]).toMatchObject({ kind: "booleanOperation", booleanOperation: "subtract" });
    expect(plan.nodes[2]).toMatchObject({ kind: "star", parametricShape: { kind: "star", pointCount: 7, innerRatio: .4 } });
    expect(plan.nodes[3]).toMatchObject({ kind: "component", name: "Unsupported" });
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "paint", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "mask", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "grid-auto-layout", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "export-settings", outcome: "preserved-extension" }),
    ]));
  });

  it("retains Component, Instance and ComponentSet subtrees and resolves local main-component identity", () => {
    const plan = planFigmaRestImport({
      version: "component-fixture",
      components: { "1:1": { key: "card-key", name: "Card", description: "Reusable card" } },
      componentSets: { "1:5": { key: "set-key", name: "Cards", variantGroupProperties: { State: { values: ["Default", "Hover"] } }, componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } } } },
      document: { children: [{ id: "0:1", type: "CANVAS", children: [
        {
          id: "1:1", type: "COMPONENT", name: "Card", clipsContent: true,
          relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
          componentPropertyDefinitions: {
            Enabled: { type: "BOOLEAN", defaultValue: true, boundVariables: { defaultValue: { type: "VARIABLE_ALIAS", id: "VariableID:1" } } },
            Content: { type: "SLOT", preferredValues: [{ type: "COMPONENT", key: "icon-key" }], slotSettings: { minChildren: 1, maxChildren: 2, allowPreferredValuesOnly: true } },
          },
          children: [{ id: "1:2", type: "RECTANGLE", componentPropertyReferences: { visible: "Enabled" }, relativeTransform: [[1, 0, 5], [0, 1, 5]], absoluteBoundingBox: { x: 5, y: 5, width: 90, height: 50 } }],
        },
        {
          id: "1:3", type: "INSTANCE", name: "Card instance", componentId: "1:1",
          scaleFactor: 1.25, isExposedInstance: true,
          componentProperties: { Enabled: { type: "BOOLEAN", value: false }, Label: { type: "TEXT", value: "Imported" } },
          overrides: [{ id: "1:4", overriddenFields: ["fills", "characters"] }],
          relativeTransform: [[1, 0, 120], [0, 1, 0]], absoluteBoundingBox: { x: 120, y: 0, width: 100, height: 60 },
          children: [
            { id: "1:4", type: "RECTANGLE", componentPropertyReferences: { visible: "Enabled" }, relativeTransform: [[1, 0, 5], [0, 1, 5]], absoluteBoundingBox: { x: 125, y: 5, width: 90, height: 50 } },
            { id: "1:8", type: "INSTANCE", componentId: "1:6", relativeTransform: [[1, 0, 10], [0, 1, 10]], absoluteBoundingBox: { x: 130, y: 10, width: 20, height: 20 }, children: [] },
          ],
        },
        {
          id: "1:5", type: "COMPONENT_SET", name: "Cards",
          relativeTransform: [[1, 0, 0], [0, 1, 100]], absoluteBoundingBox: { x: 0, y: 100, width: 120, height: 80 },
          children: [
            { id: "1:6", type: "COMPONENT", relativeTransform: [[1, 0, 10], [0, 1, 10]], absoluteBoundingBox: { x: 10, y: 110, width: 45, height: 60 }, children: [] },
            { id: "1:7", type: "COMPONENT", relativeTransform: [[1, 0, 65], [0, 1, 10]], absoluteBoundingBox: { x: 65, y: 110, width: 45, height: 60 }, children: [] },
          ],
        },
      ] }] },
    }, ids());

    const component = plan.nodes.find((node) => node.kind === "component" && node.parentId === undefined)!;
    const instance = plan.nodes.find((node) => node.kind === "instance")!;
    const instanceChild = plan.nodes.find((node) => node.parentId === instance.id && node.kind === "rectangle")!;
    const nestedInstance = plan.nodes.find((node) => node.parentId === instance.id && node.kind === "instance")!;
    const set = plan.nodes.find((node) => node.kind === "componentSet")!;
    const setComponent = plan.nodes.find((node) => node.parentId === set.id && node.kind === "component")!;
    expect(plan.nodes).toHaveLength(8);
    expect(plan.nodes.filter((node) => node.parentId === component.id)).toHaveLength(1);
    expect(plan.nodes.filter((node) => node.parentId === instance.id)).toHaveLength(2);
    expect(plan.nodes.filter((node) => node.parentId === set.id)).toHaveLength(2);
    expect(component.componentMetadata).toMatchObject({
      key: "card-key",
      description: "Reusable card",
      componentPropertyDefinitions: {
        Enabled: { type: "BOOLEAN", defaultValue: true, boundVariables: { defaultValue: { type: "VARIABLE_ALIAS", id: "VariableID:1" } } },
        Content: { type: "SLOT", preferredValues: [{ type: "COMPONENT", key: "icon-key" }], slotSettings: { minChildren: 1, maxChildren: 2, allowPreferredValuesOnly: true } },
      },
    });
    expect(plan.nodes.find((node) => node.parentId === component.id)?.componentPropertyReferences).toEqual({ visible: "Enabled" });
    expect(instanceChild.componentPropertyReferences).toEqual({ visible: "Enabled" });
    expect(instance.instanceMetadata).toEqual({
      mainComponentId: component.id,
      scaleFactor: 1.25,
      componentProperties: { Enabled: false, Label: "Imported" },
      overrides: [{ id: instanceChild.id, overriddenFields: ["fill", "fillColor", "fillGradient", "fillStack", "fills", "text", "textProperties"] }],
      isExposedInstance: true,
    });
    expect(nestedInstance.instanceMetadata?.mainComponentId).toBe(setComponent.id);
    expect(set.componentSetMetadata).toMatchObject({
      key: "set-key",
      componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] } },
      variantGroupProperties: { State: { values: ["Default", "Hover"] } },
    });
    expect(plan.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ capability: "component-set-properties" })]));
    expect(resolveFigmaRestImportBatch(plan)).toBeDefined();
  });

  it("preserves unresolved component property references without making them editable", () => {
    const plan = planFigmaRestImport({
      version: "invalid-property-reference",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1",
        type: "RECTANGLE",
        componentPropertyReferences: { visible: "Missing" },
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.componentPropertyReferences).toBeUndefined();
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.component-property-references.v1"])).toContain("Missing");
    expect(plan.issues).toContainEqual(expect.objectContaining({ capability: "component-property-references", outcome: "preserved-extension" }));
  });

  it("retains an Instance subtree and reports an unresolved external main Component", () => {
    const plan = planFigmaRestImport({
      version: "external-instance-fixture",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "INSTANCE", componentId: "external:component",
        relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
        children: [{ id: "1:2", type: "RECTANGLE", relativeTransform: [[1, 0, 5], [0, 1, 5]], absoluteBoundingBox: { x: 5, y: 5, width: 90, height: 50 } }],
      }] }] },
    }, { ...ids(), unresolvedComponentPolicy: "preserve" });

    expect(plan.nodes.map((node) => node.kind)).toEqual(["instance", "rectangle"]);
    expect(plan.nodes[0]?.instanceMetadata).toBeUndefined();
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.instance-main-source-id.v1"])).toBe("external:component");
    expect(plan.issues).toContainEqual(expect.objectContaining({ capability: "instance-main-component", outcome: "preserved-extension" }));
    expect(resolveFigmaRestImportBatch(plan)).toBeDefined();
  });

  it("rejects an unresolved Instance by default and never resolves a partial Core batch", () => {
    const plan = planFigmaRestImport({
      version: "strict-external-instance",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "INSTANCE", componentId: "external:component",
        relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 },
        children: [{ id: "1:2", type: "RECTANGLE", relativeTransform: [[1, 0, 5], [0, 1, 5]], absoluteBoundingBox: { x: 5, y: 5, width: 90, height: 50 } }],
      }] }] },
    }, ids());

    expect(plan.nodes.map((node) => node.kind)).toEqual(["instance", "rectangle"]);
    expect(plan.issues).toContainEqual(expect.objectContaining({ capability: "instance-main-component", outcome: "rejected" }));
    expect(resolveFigmaRestImportBatch(plan)).toBeUndefined();
  });

  it("resolves a forward cross-page main Component and local Slot source IDs before one atomic batch", () => {
    const plan = planFigmaRestImport({
      version: "cross-page-component",
      document: { children: [
        { id: "0:1", type: "CANVAS", name: "Instances", children: [{
          id: "1:1", type: "INSTANCE", componentId: "2:1",
          relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 }, children: [],
        }] },
        { id: "0:2", type: "CANVAS", name: "Components", children: [{
          id: "2:1", type: "COMPONENT", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 60 }, children: [
            { id: "2:2", type: "SLOT", slotPropertyName: "Content", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 }, children: [] },
            { id: "2:3", type: "SLOT", slotPropertyName: "Content override", sourceSlotId: "2:2", relativeTransform: [[1, 0, 50], [0, 1, 0]], absoluteBoundingBox: { x: 50, y: 0, width: 40, height: 20 }, children: [] },
          ],
        }] },
      ] },
    }, ids());

    const instance = plan.nodes.find((node) => node.kind === "instance")!;
    const component = plan.nodes.find((node) => node.kind === "component")!;
    const slots = plan.nodes.filter((node) => node.kind === "slot");
    expect(instance.pageId).not.toBe(component.pageId);
    expect(instance.instanceMetadata?.mainComponentId).toBe(component.id);
    expect(slots).toHaveLength(2);
    expect(slots[1]?.slotMetadata).toEqual({ propertyName: "Content override", sourceSlotId: slots[0]?.id });
    expect(plan.issues).toEqual([]);
    expect(resolveFigmaRestImportBatch(plan)?.batch[0]).toMatchObject({ type: "createPage" });
  });

  it("rejects duplicate Figma source IDs before they can alias a component reference", () => {
    const plan = planFigmaRestImport({
      version: "duplicate-source-id",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [
        { id: "1:1", type: "COMPONENT", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 }, children: [] },
        { id: "1:1", type: "COMPONENT", relativeTransform: [[1, 0, 50], [0, 1, 0]], absoluteBoundingBox: { x: 50, y: 0, width: 40, height: 40 }, children: [] },
      ] }] },
    }, ids());

    expect(plan.nodes).toHaveLength(1);
    expect(plan.issues).toContainEqual(expect.objectContaining({ sourceId: "1:1", capability: "source-id", outcome: "rejected" }));
    expect(resolveFigmaRestImportBatch(plan)).toBeUndefined();
  });

  it("rejects a broken Instance override target unless the caller explicitly preserves the loss", () => {
    const input = {
      version: "broken-instance-override",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [
        { id: "1:1", type: "COMPONENT", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 }, children: [] },
        { id: "1:2", type: "INSTANCE", componentId: "1:1", overrides: [{ id: "missing:1", overriddenFields: ["fills"] }], relativeTransform: [[1, 0, 50], [0, 1, 0]], absoluteBoundingBox: { x: 50, y: 0, width: 40, height: 40 }, children: [] },
      ] }] },
    };

    const strict = planFigmaRestImport(input, ids());
    expect(strict.issues).toContainEqual(expect.objectContaining({ sourceId: "missing:1", capability: "instance-override-reference", outcome: "rejected" }));
    expect(resolveFigmaRestImportBatch(strict)).toBeUndefined();

    const preserved = planFigmaRestImport(input, { ...ids(), unresolvedComponentPolicy: "preserve" });
    expect(preserved.issues).toContainEqual(expect.objectContaining({ sourceId: "missing:1", capability: "instance-override-reference", outcome: "preserved-extension" }));
    expect(resolveFigmaRestImportBatch(preserved)).toBeDefined();
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

  it("maps Figma radial, angular and diamond gradients with their complete transforms", () => {
    const gradient = (type: "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND", offset: number) => ({
      type,
      opacity: .75,
      gradientHandlePositions: [{ x: .2 + offset, y: .4 }, { x: .7 + offset, y: .5 }, { x: .1 + offset, y: .1 }],
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: .4, color: { r: 0, g: 1, b: 0, a: .5 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    });
    const plan = planFigmaRestImport({
      version: "non-linear-gradient-fixture",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 80 },
        fills: [gradient("GRADIENT_RADIAL", 0), gradient("GRADIENT_ANGULAR", .05)],
        strokes: [gradient("GRADIENT_DIAMOND", -.05)],
      }] }] },
    }, ids());

    const node = plan.nodes[0];
    expect(node?.fills?.map((paint) => paint.gradientPaint?.kind)).toEqual(["radial", "angular"]);
    expect(node?.strokeStack?.layers.map((layer) => layer.paint?.gradientPaint?.kind)).toEqual(["diamond"]);
    expect(node?.fills?.[0]?.gradientPaint).toMatchObject({
      transform: {
        a: 2.1428571428571432,
        b: -0.3571428571428571,
        c: -0.7142857142857144,
        d: 1.7857142857142858,
        e: -0.1428571428571429,
        f: -0.14285714285714285,
      },
      stops: [
        { position: 0, color: { space: "srgb", components: [1, 0, 0], alpha: .75 } },
        { position: .4, color: { space: "srgb", components: [0, 1, 0], alpha: .375 } },
        { position: 1, color: { space: "srgb", components: [0, 0, 1], alpha: .75 } },
      ],
    });
    expect(plan.issues).toEqual([]);
    expect(decode(node?.extensions?.["figma.rest.unsupported-paint.v1"])).toContain("GRADIENT_DIAMOND");
    expect(resolveCoreBatch([], plan.nodeCommands)?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({
        fills: expect.arrayContaining([expect.objectContaining({ gradientPaint: expect.objectContaining({ kind: "angular" }) })]),
        strokeStack: { layers: [expect.objectContaining({ paint: expect.objectContaining({ gradientPaint: expect.objectContaining({ kind: "diamond" }) }) })] },
      }) }),
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

    expect(plan.nodes[0]).toMatchObject({
      fillGradient: undefined,
      fill: "#00000000",
      fillColor: { space: "srgb", components: [0, 0, 0], alpha: 0 },
    });
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.unsupported-paint.v1"])).toContain("GRADIENT_LINEAR");
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "paint", outcome: "preserved-extension" })]));
  });

  it("keeps explicit empty and hidden Figma paints visually empty", () => {
    const plan = planFigmaRestImport({
      version: "empty-paint-fixture",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [], strokes: [],
      }, {
        id: "1:2", type: "RECTANGLE", relativeTransform: [[1, 0, 30], [0, 1, 0]], absoluteBoundingBox: { x: 30, y: 0, width: 20, height: 20 },
        fills: [{ type: "SOLID", visible: false, color: { r: 1, g: 0, b: 0, a: 1 } }],
        strokes: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 1, a: 1 } }],
      }] }] },
    }, ids());

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        fill: "#00000000",
        fillColor: { space: "srgb", components: [0, 0, 0], alpha: 0 },
        stroke: "#00000000",
        strokeColor: { space: "srgb", components: [0, 0, 0], alpha: 0 },
      }),
      expect.objectContaining({
        fill: "#00000000",
        fillColor: { space: "srgb", components: [0, 0, 0], alpha: 0 },
        stroke: "#00000000",
        strokeColor: { space: "srgb", components: [0, 0, 0], alpha: 0 },
      }),
    ]);
    expect(plan.nodes[0]?.fillColor).not.toBe(plan.nodes[1]?.fillColor);
    expect(plan.nodes[0]?.fillColor?.components).not.toBe(plan.nodes[1]?.fillColor?.components);
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.unsupported-paint.v1"])).toBeUndefined();
    expect(decode(plan.nodes[1]?.extensions?.["figma.rest.unsupported-paint.v1"])).toContain('"visible":false');
    expect(resolveCoreBatch([], plan.nodeCommands)?.batch).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ fill: "#00000000", stroke: "#00000000" }) }),
      expect.objectContaining({ type: "create", node: expect.objectContaining({ fill: "#00000000", stroke: "#00000000" }) }),
    ]);
    const exported = exportPageToSvg(plan.nodes, {
      pageId: plan.pages[0]!.id,
      defaultPageId: plan.pages[0]!.id,
      sourceRevision: 1,
    });
    expect(exported.svg).not.toContain("#ff0000");
    expect(exported.svg).not.toContain("#0000ff");
    expect(plan.issues).toEqual([
      expect.objectContaining({ sourceId: "1:2", capability: "paint", outcome: "preserved-extension" }),
    ]);
  });

  it("maps authorized-independent Text metrics and ASCII style overrides into UTF-8 Canonical runs", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "ABCD", relativeTransform: [[1, 0, 4], [0, 1, 8]], absoluteBoundingBox: { x: 4, y: 8, width: 200, height: 40 }, textAutoResize: "HEIGHT", textTruncation: "ENDING", maxLines: 2,
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
      textTruncation: "ending",
      maxLines: 2,
    });
    expect(decode(text?.extensions?.["figma.rest.text-font.v1"])).toContain("Inter");
    expect(plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "font-asset", outcome: "preserved-extension" })]));
  });

  it("preserves Figma REST pixel, font-size-percent, and automatic line-height units", () => {
    const imported = (id: string, style: Record<string, unknown>) => planFigmaRestImport({
      version: `line-height-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`,
        type: "TEXT",
        characters: "AB",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, ...style },
      }] }] },
    }, ids());

    expect(imported("1", { lineHeightUnit: "PIXELS", lineHeightPx: 28 }).nodes[0]?.textProperties?.paragraph).toMatchObject({ lineHeight: 28 });
    expect(imported("2", { lineHeightUnit: "FONT_SIZE_%", lineHeightPx: 30, lineHeightPercentFontSize: 150 }).nodes[0]?.textProperties?.paragraph).toMatchObject({ lineHeight: 150, lineHeightUnit: "percent" });
    expect(imported("3", { lineHeightUnit: "INTRINSIC_%", lineHeightPx: 24, lineHeightPercent: 100 }).nodes[0]?.textProperties?.paragraph).toMatchObject({ lineHeightUnit: "auto" });
  });

  it("imports valid paragraph indentation and preserves invalid paragraph metrics", () => {
    const imported = (id: string, style: Record<string, unknown>) => planFigmaRestImport({
      version: `paragraph-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "AB",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, ...style },
      }] }] },
    }, ids());

    expect(imported("1", { paragraphIndent: 16 }).nodes[0]?.textProperties?.paragraph.paragraphIndent).toBe(16);
    const invalid = imported("2", { paragraphIndent: -1, paragraphSpacing: -4 });
    expect(invalid.nodes[0]?.textProperties?.paragraph).toMatchObject({ paragraphSpacing: 0 });
    expect(invalid.nodes[0]?.textProperties?.paragraph.paragraphIndent).toBeUndefined();
    expect(decode(invalid.nodes[0]?.extensions?.["figma.rest.paragraph-indent.v1"])).toContain('"paragraphIndent":-1');
    expect(decode(invalid.nodes[0]?.extensions?.["figma.rest.paragraph-spacing.v1"])).toContain('"paragraphSpacing":-4');
  });

  it("imports BALANCE/PRETTY text wrapping and preserves unknown future values", () => {
    const imported = (id: string, textWrapStyle: unknown) => planFigmaRestImport({
      version: `text-wrap-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "aa bb cc dd",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 90, height: 40 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, textWrapStyle },
      }] }] },
    }, ids());

    expect(imported("1", "AUTO").nodes[0]?.textProperties?.paragraph.textWrapStyle).toBeUndefined();
    expect(imported("2", "BALANCE").nodes[0]?.textProperties?.paragraph.textWrapStyle).toBe("balance");
    expect(imported("3", "PRETTY").nodes[0]?.textProperties?.paragraph.textWrapStyle).toBe("pretty");
    const future = imported("4", "STABLE");
    expect(future.nodes[0]?.textProperties?.paragraph.textWrapStyle).toBeUndefined();
    expect(decode(future.nodes[0]?.extensions?.["figma.rest.text-wrap-style.v1"])).toContain('"textWrapStyle":"STABLE"');
  });

  it("imports Figma list options and preserves invalid future values", () => {
    const imported = (id: string, listOptions: unknown) => planFigmaRestImport({
      version: `text-list-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "One\nTwo",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, listOptions },
      }] }] },
    }, ids());

    expect(imported("1", { type: "NONE" }).nodes[0]?.textProperties?.paragraph.listType).toBeUndefined();
    expect(imported("2", { type: "ORDERED" }).nodes[0]?.textProperties?.paragraph.listType).toBe("ordered");
    expect(imported("3", { type: "UNORDERED" }).nodes[0]?.textProperties?.paragraph.listType).toBe("unordered");
    const future = imported("4", { type: "CHECKBOX", checked: true });
    expect(future.nodes[0]?.textProperties?.paragraph.listType).toBeUndefined();
    expect(decode(future.nodes[0]?.extensions?.["figma.rest.text-list-options.v1"])).toContain('"type":"CHECKBOX"');
    expect(future.issues).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "text-list-options", outcome: "preserved-extension" })]));
  });

  it("imports non-negative Figma list spacing and preserves invalid values", () => {
    const imported = (id: string, listSpacing: unknown) => planFigmaRestImport({
      version: `text-list-spacing-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "One\nTwo",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 48 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, listOptions: { type: "ORDERED" }, listSpacing },
      }] }] },
    }, ids());

    expect(imported("1", 8).nodes[0]?.textProperties?.paragraph.listSpacing).toBe(8);
    expect(imported("2", 0).nodes[0]?.textProperties?.paragraph.listSpacing).toBeUndefined();
    const invalid = imported("3", -1);
    expect(invalid.nodes[0]?.textProperties?.paragraph.listSpacing).toBeUndefined();
    expect(decode(invalid.nodes[0]?.extensions?.["figma.rest.text-list-spacing.v1"])).toContain('"listSpacing":-1');
    expect(invalid.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-list-spacing", outcome: "preserved-extension" }),
    ]));
  });

  it("imports Figma hanging lists and preserves invalid values", () => {
    const imported = (id: string, hangingList: unknown) => planFigmaRestImport({
      version: `text-hanging-list-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "One\nTwo",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 48 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, listOptions: { type: "ORDERED" }, hangingList },
      }] }] },
    }, ids());

    expect(imported("1", true).nodes[0]?.textProperties?.paragraph.hangingList).toBe(true);
    expect(imported("2", false).nodes[0]?.textProperties?.paragraph.hangingList).toBeUndefined();
    const invalid = imported("3", "yes");
    expect(invalid.nodes[0]?.textProperties?.paragraph.hangingList).toBeUndefined();
    expect(decode(invalid.nodes[0]?.extensions?.["figma.rest.text-hanging-list.v1"])).toContain('"hangingList":"yes"');
    expect(invalid.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-hanging-list", outcome: "preserved-extension" }),
    ]));
  });

  it("imports Figma hanging punctuation and preserves invalid values", () => {
    const imported = (id: string, hangingPunctuation: unknown) => planFigmaRestImport({
      version: `text-hanging-punctuation-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "“Text.”",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 48 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, hangingPunctuation },
      }] }] },
    }, ids());

    expect(imported("1", true).nodes[0]?.textProperties?.paragraph.hangingPunctuation).toBe(true);
    expect(imported("2", false).nodes[0]?.textProperties?.paragraph.hangingPunctuation).toBeUndefined();
    const invalid = imported("3", "yes");
    expect(invalid.nodes[0]?.textProperties?.paragraph.hangingPunctuation).toBeUndefined();
    expect(decode(invalid.nodes[0]?.extensions?.["figma.rest.text-hanging-punctuation.v1"])).toContain('"hangingPunctuation":"yes"');
    expect(invalid.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-hanging-punctuation", outcome: "preserved-extension" }),
    ]));
  });

  it("imports Figma list indentation as sparse paragraph style runs", () => {
    const imported = (id: string, indentation: unknown) => planFigmaRestImport({
      version: `text-indentation-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "One\nTwo",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 48 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, listOptions: { type: "ORDERED" }, indentation },
      }] }] },
    }, ids());

    expect(imported("1", 2).nodes[0]?.textProperties?.paragraphStyleRuns).toEqual([
      { start: 0, indentation: 2 },
      { start: 4, indentation: 2 },
    ]);
    expect(imported("2", 1).nodes[0]?.textProperties?.paragraphStyleRuns).toBeUndefined();
    const invalid = imported("3", 1.5);
    expect(invalid.nodes[0]?.textProperties?.paragraphStyleRuns).toBeUndefined();
    expect(decode(invalid.nodes[0]?.extensions?.["figma.rest.text-indentation.v1"])).toContain('"indentation":1.5');
    expect(invalid.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-indentation", outcome: "preserved-extension" }),
    ]));
  });

  it("imports ShapeWithText geometry, characters, and a supplied valid style object", () => {
    const plan = planFigmaRestImport({
      version: "shape-with-text",
      document: { children: [{ id: "0:1", type: "CANVAS", name: "Diagram", children: [{
        id: "1:1",
        type: "SHAPE_WITH_TEXT",
        name: "Decision",
        shapeType: "HEXAGON",
        characters: "Approve",
        relativeTransform: [[1, 0, 24], [0, 1, 32]],
        absoluteBoundingBox: { x: 24, y: 32, width: 200, height: 120 },
        fills: [{ type: "SOLID", color: { r: .88, g: .91, b: 1 } }],
        strokes: [{ type: "SOLID", color: { r: .31, g: .27, b: .9 } }],
        strokeWeight: 2,
        style: {
          fontSize: 20,
          fontWeight: 600,
          italic: false,
          letterSpacing: 0,
          textAlignHorizontal: "CENTER",
          lineHeightUnit: "FONT_SIZE_%",
          lineHeightPercentFontSize: 150,
          lineHeightPx: 30,
        },
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]).toMatchObject({
      kind: "shapeWithText",
      name: "Decision",
      shapeWithTextType: "HEXAGON",
      text: "Approve",
      x: 24,
      y: 32,
      width: 200,
      height: 120,
      strokeWidth: 2,
      textProperties: {
        runs: [{ start: 0, end: 7, fontSize: 20, fontWeight: 600, italic: false, letterSpacing: 0 }],
        paragraph: { alignment: "center", lineHeight: 150, lineHeightUnit: "percent", paragraphSpacing: 0 },
      },
    });
    expect(resolveFigmaRestImportBatch(plan)?.batch.map((command) => command.type)).toEqual(["createPage", "create"]);
    const exported = exportPageToSvg(plan.nodes, { pageId: plan.pages[0]!.id, defaultPageId: plan.pages[0]!.id, padding: 0 });
    expect(exported.svg).toContain('d="M 36 0 L 164 0 L 200 60 L 164 120 L 36 120 L 0 60 Z"');
    expect(exported.svg).toContain("Approve");
  });

  it("preserves an unknown ShapeWithText shapeType and uses a renderable fallback", () => {
    const plan = planFigmaRestImport({
      version: "shape-with-text-future",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1",
        type: "SHAPE_WITH_TEXT",
        shapeType: "FUTURE_CALLOUT",
        characters: "Future",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 80 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]).toMatchObject({ kind: "shapeWithText", shapeWithTextType: "ROUNDED_RECTANGLE", text: "Future" });
    expect(plan.nodes[0]?.textProperties).toBeUndefined();
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.shape-with-text-type.v1"])).toBe('{"shapeType":"FUTURE_CALLOUT"}');
    expect(plan.issues).toEqual([
      expect.objectContaining({ sourceId: "1:1", capability: "shape-with-text-type", outcome: "preserved-extension" }),
    ]);
    expect(resolveFigmaRestImportBatch(plan)).toBeDefined();

    const missing = planFigmaRestImport({
      version: "shape-with-text-missing",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:2",
        type: "SHAPE_WITH_TEXT",
        characters: "Missing",
        absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 80 },
      }] }] },
    }, ids());
    expect(missing.nodes[0]).toMatchObject({ kind: "shapeWithText", shapeWithTextType: "ROUNDED_RECTANGLE", text: "Missing" });
    expect(decode(missing.nodes[0]?.extensions?.["figma.rest.shape-with-text-type.v1"])).toBe("{}");
    expect(missing.issues).toEqual([expect.objectContaining({ capability: "shape-with-text-type", outcome: "preserved-extension" })]);

    const pluginOnly = planFigmaRestImport({
      version: "shape-with-text-plugin-only",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:3",
        type: "SHAPE_WITH_TEXT",
        shapeType: "TRIANGLE_UP",
        characters: "Plugin only",
        absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 80 },
      }] }] },
    }, ids());
    expect(pluginOnly.nodes[0]).toMatchObject({ kind: "shapeWithText", shapeWithTextType: "ROUNDED_RECTANGLE", text: "Plugin only" });
    expect(decode(pluginOnly.nodes[0]?.extensions?.["figma.rest.shape-with-text-type.v1"])).toBe('{"shapeType":"TRIANGLE_UP"}');
    expect(pluginOnly.issues).toEqual([expect.objectContaining({ capability: "shape-with-text-type", outcome: "preserved-extension" })]);
  });

  it("imports Connector positions through nested affine geometry and resolves forward endpoint references", () => {
    const plan = planFigmaRestImport({
      version: "connector-position-endpoints",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:frame", type: "FRAME",
        relativeTransform: [[2, 0, 100], [0, 2, 50]],
        size: { x: 300, y: 200 }, absoluteBoundingBox: { x: 100, y: 50, width: 600, height: 400 },
        children: [{
          id: "1:connector", type: "CONNECTOR", name: "Review flow",
          relativeTransform: [[0, -1, 20], [1, 0, 30]],
          size: { x: 100, y: 80 }, absoluteBoundingBox: { x: -20, y: 110, width: 160, height: 200 },
          connectorLineType: "ELBOWED",
          connectorStart: { endpointNodeId: "1:target", position: { x: 120, y: 120 } },
          connectorEnd: { position: { x: 0, y: 280 } },
          connectorStartStrokeCap: "LINE_ARROW",
          connectorEndStrokeCap: "TRIANGLE_ARROW",
          cornerRadius: 10,
          characters: "Review",
          strokes: [{ type: "SOLID", color: { r: .2, g: .3, b: .4 } }],
          strokeWeight: 3,
        }, {
          id: "1:target", type: "RECTANGLE",
          relativeTransform: [[1, 0, 160], [0, 1, 40]],
          size: { x: 40, y: 40 }, absoluteBoundingBox: { x: 420, y: 130, width: 80, height: 80 },
        }],
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    const connector = plan.nodes.find((node) => node.kind === "connector");
    const target = plan.nodes.find((node) => node.kind === "rectangle");
    expect(connector).toMatchObject({
      name: "Review flow", stroke: "#334d66", strokeWidth: 3,
      connectorMetadata: {
        lineType: "ELBOWED",
        start: { x: 5, y: 10, endpointNodeId: target?.id },
        end: { x: 85, y: 70 },
        startStrokeCap: "ARROW_LINES",
        endStrokeCap: "ARROW_EQUILATERAL",
        cornerRadius: 10,
        text: "Review",
      },
    });
    expect(connector?.extensions?.["figma.rest.connector.v1"]).toBeUndefined();
    const exported = exportPageToSvg(plan.nodes, { pageId: plan.pages[0]!.id, defaultPageId: plan.pages[0]!.id, sourceRevision: 1, padding: 0 });
    expect(exported.svg).toContain("Review");
    expect(exported.svg).toContain("Q 45 10 45 20");
  });

  it("preserves magnet-only routing, unresolved endpoint IDs, and unsupported Connector values", () => {
    const plan = planFigmaRestImport({
      version: "connector-preserved-fallback",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:connector", type: "CONNECTOR",
        relativeTransform: [[1, 0, 20], [0, 1, 30]],
        size: { x: 100, y: 40 }, absoluteBoundingBox: { x: 20, y: 30, width: 100, height: 40 },
        connectorLineType: "FUTURE_ROUTE",
        connectorStart: { endpointNodeId: "missing:node", position: { x: 20, y: 30 } },
        connectorEnd: { endpointNodeId: "1:target", magnet: "CENTER" },
        connectorStartStrokeCap: "ERD_ONE",
        connectorEndStrokeCap: "NONE",
        cornerRadius: -4,
        characters: "Fallback",
      }, {
        id: "1:target", type: "RECTANGLE",
        relativeTransform: [[1, 0, 180], [0, 1, 20]],
        size: { x: 40, y: 40 }, absoluteBoundingBox: { x: 180, y: 20, width: 40, height: 40 },
      }] }] },
    }, ids());

    const connector = plan.nodes[0]!;
    const target = plan.nodes[1]!;
    expect(connector.connectorMetadata).toEqual({
      lineType: "STRAIGHT",
      start: { x: 0, y: 0 },
      end: { x: 100, y: 40, endpointNodeId: target.id, magnet: "CENTER" },
      startStrokeCap: "NONE",
      endStrokeCap: "NONE",
      text: "Fallback",
    });
    expect(JSON.stringify(connector.connectorMetadata)).not.toContain("missing:node");
    expect(decode(connector.extensions?.["figma.rest.connector.v1"])).toContain("missing:node");
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "connector-line-type", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "connector-endpoint", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "connector-stroke-cap", outcome: "preserved-extension" }),
      expect.objectContaining({ capability: "connector-corner-radius", outcome: "preserved-extension" }),
    ]));
    expect(resolveFigmaRestImportBatch(plan)).toBeDefined();
  });

  it("preserves non-default intrinsic and malformed REST line-height metadata with a pixel fallback", () => {
    const plan = planFigmaRestImport({
      version: "line-height-fallback",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1",
        type: "TEXT",
        characters: "AB",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        style: {
          fontSize: 20,
          fontWeight: 400,
          italic: false,
          letterSpacing: 0,
          lineHeightUnit: "INTRINSIC_%",
          lineHeightPercent: 120,
          lineHeightPercentFontSize: 144,
          lineHeightPx: 28.8,
        },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.textProperties?.paragraph).toMatchObject({ lineHeight: 28.8 });
    expect(plan.nodes[0]?.textProperties?.paragraph.lineHeightUnit).toBeUndefined();
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-line-height.v1"])).toContain('"lineHeightUnit":"INTRINSIC_%"');
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-line-height", outcome: "preserved-extension" }),
    ]));

    const future = planFigmaRestImport({
      version: "line-height-future",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:2",
        type: "TEXT",
        characters: "AB",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
        style: { fontSize: 20, fontWeight: 400, italic: false, letterSpacing: 0, lineHeightUnit: "FUTURE", lineHeightPx: 32 },
      }] }] },
    }, ids());
    expect(future.nodes[0]?.textProperties?.paragraph).toMatchObject({ lineHeight: 32 });
    expect(decode(future.nodes[0]?.extensions?.["figma.rest.text-line-height.v1"])).toContain('"lineHeightUnit":"FUTURE"');
  });

  it("maps all Figma REST TextCase values and preserves invalid overrides", () => {
    const plan = planFigmaRestImport({
      version: "text-case",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "ABCDEF", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 180, height: 30 },
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, textCase: "UPPER" },
        characterStyleOverrides: [0, 1, 2, 3, 4, 5],
        styleOverrideTable: {
          1: { textCase: "LOWER" }, 2: { textCase: "TITLE" }, 3: { textCase: "SMALL_CAPS" },
          4: { textCase: "SMALL_CAPS_FORCED" }, 5: { textCase: "FUTURE_CASE" },
        },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textCase)).toEqual([
      "upper", "lower", "title", "smallCaps", "smallCapsForced", "upper",
    ]);
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-overrides.v1"])).toContain("FUTURE_CASE");
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-style-overrides", outcome: "preserved-extension" }),
    ]));
  });

  it("maps Figma REST URL and NODE hyperlinks and preserves malformed targets", () => {
    const plan = planFigmaRestImport({
      version: "text-hyperlink",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "ABC", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 90, height: 30 },
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, hyperlink: { type: "URL", value: "https://example.com" } },
        characterStyleOverrides: [0, 1, 2],
        styleOverrideTable: {
          1: { hyperlink: { type: "NODE", value: "12:34" } },
          2: { hyperlink: { type: "EMAIL", value: "a@example.com" } },
        },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.hyperlink)).toEqual([
      { type: "URL", value: "https://example.com" },
      { type: "NODE", value: "12:34" },
      { type: "URL", value: "https://example.com" },
    ]);
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-overrides.v1"])).toContain("EMAIL");
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-style-overrides", outcome: "preserved-extension" }),
    ]));
  });

  it("maps Figma REST text decorations and preserves unknown override values", () => {
    const plan = planFigmaRestImport({
      version: "text-decoration",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "ABCD", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 90, height: 30 }, styles: { text: "S:heading" },
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0, textDecoration: "UNDERLINE", textDecorationStyle: "WAVY", textDecorationOffset: { value: 2, unit: "PIXELS" }, textDecorationThickness: { value: 2.5, unit: "PIXELS" }, textDecorationColor: { value: { type: "SOLID", color: { r: 1, g: .25, b: .5 }, visible: true, opacity: .75, blendMode: "MULTIPLY" } }, textDecorationSkipInk: true, leadingTrim: "CAP_HEIGHT", openTypeFlags: { liga: 1, kern: 0 } },
        characterStyleOverrides: [0, 1, 2, 3],
        styleOverrideTable: {
          1: { textDecoration: "STRIKETHROUGH", textDecorationStyle: "DOTTED", textDecorationOffset: { value: -20, unit: "PERCENT" }, textDecorationThickness: { value: 15, unit: "PERCENT" }, leadingTrim: "NONE", openTypeFlags: { liga: 0 } },
          2: {
            textDecoration: "BLINK", textDecorationStyle: "ZIGZAG",
            textDecorationOffset: { value: 1, unit: "EM" }, textDecorationThickness: { value: 1, unit: "EM" },
            textDecorationColor: { value: { type: "SOLID", color: { r: 2, g: 0, b: 0 }, boundVariables: { color: "VariableID:1" } } },
            leadingTrim: "AUTO",
            openTypeFlags: { liga: 2 },
          },
          3: { textDecoration: "NONE" },
        },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textDecoration)).toEqual([
      "underline", "strikethrough", "underline", undefined,
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textDecorationStyle)).toEqual([
      "wavy", "dotted", "wavy", undefined,
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textDecorationOffset)).toEqual([
      { value: 2, unit: "pixels" }, { value: -20, unit: "percent" }, { value: 2, unit: "pixels" }, undefined,
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textDecorationThickness)).toEqual([
      { value: 2.5, unit: "pixels" }, { value: 15, unit: "percent" }, { value: 2.5, unit: "pixels" }, undefined,
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textDecorationColor)).toEqual([
      { color: { space: "srgb", components: [1, .25, .5], alpha: 1 }, visible: true, opacity: .75, blendMode: "multiply" },
      undefined,
      { color: { space: "srgb", components: [1, .25, .5], alpha: 1 }, visible: true, opacity: .75, blendMode: "multiply" },
      undefined,
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textDecorationSkipInk)).toEqual([
      true, undefined, true, undefined,
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.leadingTrim)).toEqual([
      "capHeight", undefined, "capHeight", "capHeight",
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.openTypeFeatures)).toEqual([
      { KERN: false, LIGA: true }, { LIGA: false }, { KERN: false, LIGA: true }, { KERN: false, LIGA: true },
    ]);
    expect(plan.nodes[0]?.textProperties?.runs.map((run) => run.textStyleId)).toEqual([
      "S:heading", "S:heading", "S:heading", "S:heading",
    ]);
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-overrides.v1"])).toContain("BLINK");
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-overrides.v1"])).toContain("ZIGZAG");
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-overrides.v1"])).toContain("EM");
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-overrides.v1"])).toContain("AUTO");
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-overrides.v1"])).toContain('"liga":2');
  });

  it("builds a canonical TextStyle catalog from REST metadata and linked text values", () => {
    const plan = planFigmaRestImport({
      version: "text-style-catalog",
      styles: {
        "S:body": {
          key: "published-body-key",
          name: "Typography/Body",
          description: "Primary body copy",
          styleType: "TEXT",
          remote: true,
        },
      },
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1",
        type: "TEXT",
        characters: "Body",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 24 },
        styles: { text: "S:body" },
        style: {
          fontSize: 16,
          fontWeight: 450,
          italic: false,
          letterSpacing: .2,
          textAlignHorizontal: "LEFT",
          lineHeightPx: 24,
          paragraphSpacing: 6,
        },
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.textStyles).toEqual([{
      id: "S:body",
      key: "published-body-key",
      name: "Typography/Body",
      description: "Primary body copy",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: true,
      style: { fontSize: 16, fontWeight: 450, italic: false, letterSpacing: .2 },
      paragraph: { alignment: "left", lineHeight: 24, paragraphSpacing: 6 },
    }]);
    expect(plan.nodes[0]?.textProperties?.baseStyle?.textStyleId).toBe("S:body");
    expect(resolveFigmaRestImportBatch(plan)?.batch.map((command) => command.type)).toEqual([
      "createPage",
      "registerTextStyle",
      "create",
    ]);
  });

  it("builds a canonical PaintStyle catalog from REST metadata and linked layer paints", () => {
    const plan = planFigmaRestImport({
      version: "paint-style-catalog",
      styles: {
        "S:brand-fill": {
          key: "published-paint-key",
          name: "Brand/Primary",
          description: "Primary surface",
          styleType: "FILL",
          remote: true,
        },
      },
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1",
        type: "RECTANGLE",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 24 },
        styles: { fill: "S:brand-fill" },
        fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .75, blendMode: "NORMAL", visible: true }],
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.paintStyles).toEqual([{
      id: "S:brand-fill",
      key: "published-paint-key",
      name: "Brand/Primary",
      description: "Primary surface",
      descriptionMarkdown: "",
      documentationLinks: [],
      remote: true,
      paints: { layers: [{ visible: true, opacity: .75, blendMode: "normal", paint: { css: "#ff0000", color: { space: "srgb", components: [1, 0, 0], alpha: 1 } } }] },
    }]);
    expect(plan.nodes[0]?.fillStyleId).toBe("S:brand-fill");
    expect(resolveFigmaRestImportBatch(plan)?.batch.map((command) => command.type)).toEqual([
      "createPage",
      "registerPaintStyle",
      "create",
    ]);
  });

  it("links REST text fills to PaintStyle identities on canonical text runs", () => {
    const plan = planFigmaRestImport({
      version: "text-paint-style-link",
      styles: {
        "S:text-fill": { key: "", name: "Text/Accent", styleType: "FILL", remote: false },
      },
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1",
        type: "TEXT",
        characters: "Hi",
        relativeTransform: [[1, 0, 0], [0, 1, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 },
        styles: { fill: "S:text-fill" },
        fills: [{ type: "SOLID", color: { r: 0, g: .5, b: 1 } }],
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      }] }] },
    }, ids());

    expect(plan.issues).toEqual([]);
    expect(plan.nodes[0]?.fillStyleId).toBeUndefined();
    expect(plan.nodes[0]?.textProperties?.runs).toMatchObject([{
      start: 0,
      end: 2,
      paintStyleId: "S:text-fill",
      fillStack: plan.paintStyles[0]?.paints,
    }]);
  });

  it("preserves an empty Figma Text node style as its Canonical insertion style", () => {
    const plan = planFigmaRestImport({
      version: "empty-text-style",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "", relativeTransform: [[1, 0, 4], [0, 1, 8]], absoluteBoundingBox: { x: 4, y: 8, width: 200, height: 40 }, styles: { TEXT: "S:body" },
        style: { fontFamily: "Inter", fontSize: 18, fontWeight: 650, italic: true, letterSpacing: .5, textAlignHorizontal: "RIGHT", lineHeightPx: 26, paragraphSpacing: 3 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.textProperties).toEqual({
      runs: [],
      baseStyle: { fontSize: 18, fontWeight: 650, italic: true, letterSpacing: .5, textStyleId: "S:body" },
      paragraph: { alignment: "right", lineHeight: 26, paragraphSpacing: 3 },
      autoSize: "fixed",
    });
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-font.v1"])).toContain("Inter");
  });

  it("preserves malformed or conflicting REST TextStyle links without inventing an identity", () => {
    const imported = (id: string, styles: unknown) => planFigmaRestImport({
      version: `text-style-link-${id}`,
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: `1:${id}`, type: "TEXT", characters: "A", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 }, styles,
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      }] }] },
    }, ids());

    for (const plan of [
      imported("1", { text: "" }),
      imported("2", { text: "S:body", TEXT: "S:heading" }),
      imported("3", { text: `S:${"x".repeat(2_048)}` }),
      imported("4", { text: "bad\0id" }),
    ]) {
      expect(plan.nodes[0]?.textProperties?.runs[0]?.textStyleId).toBeUndefined();
      expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-style-link.v1"])).toBeTruthy();
      expect(plan.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ capability: "text-style-link", outcome: "preserved-extension" }),
      ]));
    }
  });

  it("preserves invalid REST text truncation metadata instead of weakening it", () => {
    const plan = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "ABCD", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
        textTruncation: "DISABLED", maxLines: 0,
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      }] }] },
    }, ids());

    expect(plan.nodes[0]?.textProperties).not.toMatchObject({ maxLines: expect.anything() });
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.text-truncation.v1"])).toContain('"maxLines":0');
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-truncation", outcome: "preserved-extension" }),
    ]));

    const malformed = planFigmaRestImport({
      version: "123",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:2", type: "TEXT", characters: "ABCD", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
        textTruncation: 42, maxLines: "two",
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
      }] }] },
    }, ids());
    expect(decode(malformed.nodes[0]?.extensions?.["figma.rest.text-truncation.v1"])).toContain('"maxLines":"two"');
    expect(malformed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "text-truncation", outcome: "preserved-extension" }),
    ]));
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
    expect(binding.batch.map((command) => command.type)).toEqual(["registerAsset", "setExtensions", "update"]);
    expect(binding.nextNodes[0]).toMatchObject({ assetId: asset.assetId, locked: true });
  });

  it("cancels pending image authorization by restoring the exact source lock", () => {
    const plan = planFigmaRestImport({
      version: "cancel-image-binding",
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "IMAGE", locked: true, imageRef: "figma-image-ref",
        relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
      }] }] },
    }, ids());
    expect(plan.nodes[0]?.locked).toBe(false);

    const cancelled = cancelFigmaRestAssetBindings(plan.nodes, plan.assetRequests);
    expect(cancelled.issues).toEqual([]);
    expect(cancelled.cancelledNodeIds).toEqual([plan.nodes[0]?.id]);
    expect(cancelled.nextNodes[0]).toMatchObject({ locked: true });
    expect(cancelled.nextNodes[0]?.assetId).toBeUndefined();
    expect(cancelled.nextNodes[0]?.extensions?.["figma.rest.deferred-lock.v1"]).toBeUndefined();
    expect(cancelled.batch).toEqual([
      expect.objectContaining({ type: "setExtensions", id: plan.nodes[0]?.id }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ locked: true }) }),
    ]);
    expect(pendingFigmaRestAssetRequests(cancelled.nextNodes)).toEqual([]);
    expect(pendingFigmaRestAssetRequests(plan.nodes)).toEqual(plan.assetRequests);
  });

  it("durably closes cancellation for an originally unlocked image", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "IMAGE", locked: false, imageRef: "open-image",
        relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
      }] }] },
    }, ids());

    const cancelled = cancelFigmaRestAssetBindings(plan.nodes, plan.assetRequests);
    expect(cancelled.batch).toHaveLength(2);
    expect(cancelled.nextNodes[0]?.locked).toBe(false);
    expect(pendingFigmaRestAssetRequests(cancelled.nextNodes)).toEqual([]);
  });

  it("accumulates authorized image paints and commits their complete ordered Paint Stack", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", locked: true, relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [
          { type: "SOLID", color: { r: 1, g: 0, b: 0, a: .5 }, opacity: .4, blendMode: "COLOR_DODGE" },
          { type: "IMAGE", imageRef: "first", visible: false, opacity: .6, blendMode: "SOFT_LIGHT", scaleMode: "FIT", rotation: 90, imageTransform: [[1, 0, .25], [0, 1, .5]] },
          { type: "IMAGE", imageRef: "second", scaleMode: "CROP" },
        ],
      }] }] },
    }, ids());
    const asset = (suffix: string) => ({ assetId: `00000000-0000-4000-8000-00000000${suffix}`, contentHash: suffix.repeat(64).slice(0, 64), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 });
    expect(plan.assetRequests.map((request) => request.paintIndex)).toEqual([1, 2]);
    expect(plan.nodes[0]?.locked).toBe(false);
    expect(plan.nodes[0]?.fillStack).toBeUndefined();
    const firstAsset = asset("a001");
    const first = resolveFigmaRestAssetBindings(plan.nodes, [], [{ request: plan.assetRequests[0]!, asset: firstAsset }]);
    expect(first.issues).toEqual([]);
    expect(first.nextNodes[0]?.locked).toBe(false);
    expect(first.nextNodes[0]?.fillStack).toBeUndefined();
    const secondAsset = asset("b002");
    const binding = resolveFigmaRestAssetBindings(first.nextNodes, [firstAsset], [{ request: plan.assetRequests[1]!, asset: secondAsset }]);

    expect(binding.boundNodeIds).toEqual([plan.nodes[0]?.id]);
    expect(binding.issues).toEqual([]);
    expect(binding.nextNodes[0]).toMatchObject({
      locked: true,
      fillStack: { layers: [
        { visible: true, opacity: .4, blendMode: "color-dodge", paint: { css: "#ff000080" } },
        { visible: false, opacity: .6, blendMode: "soft-light", image: { assetId: firstAsset.assetId, scaleMode: "fit", transform: { a: 1, b: 0, c: 0, d: 1, e: .25, f: .5 }, rotationDegrees: 90 } },
        { visible: true, opacity: 1, blendMode: "normal", image: { assetId: secondAsset.assetId, scaleMode: "crop", transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } } },
      ] },
    });
    expect(binding.nextNodes[0]?.assetId).toBeUndefined();
  });

  it("binds an authorized Figma image stroke without replacing its layer order", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        strokes: [
          { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } },
          { type: "IMAGE", imageRef: "stroke-image", scaleMode: "TILE", opacity: .5 },
        ],
      }] }] },
    }, ids());
    const raster = { assetId: "00000000-0000-4000-8000-00000000c003", contentHash: "c".repeat(64), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 };
    const binding = resolveFigmaRestAssetBindings(plan.nodes, [], [{ request: plan.assetRequests[0]!, asset: raster }]);

    expect(binding.issues).toEqual([]);
    expect(binding.nextNodes[0]?.strokeStack).toMatchObject({ layers: [
      { paint: { css: "#0000ff" }, visible: true, opacity: 1, blendMode: "normal" },
      { image: { assetId: raster.assetId, scaleMode: "tile" }, visible: true, opacity: .5, blendMode: "normal" },
    ] });
  });

  it("rejects forged paint indexes and conflicting authorization results without a partial bind", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [{ type: "IMAGE", imageRef: "source-image" }],
      }] }] },
    }, ids());
    const first = { assetId: "00000000-0000-4000-8000-00000000d004", contentHash: "d".repeat(64), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 };
    const second = { ...first, assetId: "00000000-0000-4000-8000-00000000e005", contentHash: "e".repeat(64) };
    const request = plan.assetRequests[0]!;
    const forged = resolveFigmaRestAssetBindings(plan.nodes, [], [{ request: { ...request, paintIndex: 7 }, asset: first }]);
    expect(forged.batch).toEqual([]);
    expect(forged.issues).toContainEqual(expect.objectContaining({ capability: "image-fill", outcome: "rejected" }));

    const conflicted = resolveFigmaRestAssetBindings(plan.nodes, [], [
      { request, asset: first },
      { request, asset: second },
    ]);
    expect(conflicted.batch).toEqual([]);
    expect(conflicted.boundNodeIds).toEqual([]);
    expect(conflicted.issues).toContainEqual(expect.objectContaining({ capability: "image-fill", outcome: "rejected" }));
  });

  it("keeps authorized bytes but reports image adjustments that cannot be represented losslessly", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [{ type: "IMAGE", imageRef: "adjusted", rotation: 30 }],
      }] }] },
    }, ids());
    const raster = { assetId: "00000000-0000-4000-8000-00000000f006", contentHash: "f".repeat(64), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 };
    const binding = resolveFigmaRestAssetBindings(plan.nodes, [], [{ request: plan.assetRequests[0]!, asset: raster }]);

    expect(binding.batch.map((command) => command.type)).toEqual(["registerAsset", "setExtensions", "update"]);
    expect(binding.nextNodes[0]?.fillStack).toBeUndefined();
    expect(binding.issues).toContainEqual(expect.objectContaining({ capability: "image-fill", outcome: "preserved-extension" }));
  });

  it("binds all seven Figma image-filter fields without dropping their presence", () => {
    const filters = { exposure: .1, contrast: -.2, saturation: .3, temperature: -.4, tint: .5, highlights: -.6, shadows: .7 };
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "RECTANGLE", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        fills: [{ type: "IMAGE", imageRef: "adjusted", scaleMode: "FIT", filters }],
      }] }] },
    }, ids());
    const raster = { assetId: "00000000-0000-4000-8000-00000000f007", contentHash: "a".repeat(64), mediaType: "image/png", byteLength: 128, pixelWidth: 16, pixelHeight: 8 };
    const binding = resolveFigmaRestAssetBindings(plan.nodes, [], [{ request: plan.assetRequests[0]!, asset: raster }]);

    expect(binding.issues).toEqual([]);
    expect(binding.nextNodes[0]?.fillStack?.layers[0]?.image).toMatchObject({ assetId: raster.assetId, scaleMode: "fit", filters });
  });

  it("preserves Text image paints without emitting an authorization request the glyph renderer cannot use", () => {
    const plan = planFigmaRestImport({
      document: { children: [{ id: "0:1", type: "CANVAS", children: [{
        id: "1:1", type: "TEXT", characters: "Image text", relativeTransform: [[1, 0, 0], [0, 1, 0]], absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
        fills: [{ type: "IMAGE", imageRef: "glyph-image", scaleMode: "FILL" }],
      }] }] },
    }, ids());

    expect(plan.assetRequests).toEqual([]);
    expect(plan.issues).toContainEqual(expect.objectContaining({ capability: "text-image-paint", outcome: "preserved-extension" }));
    expect(decode(plan.nodes[0]?.extensions?.["figma.rest.unsupported-paint.v1"])).toContain("glyph-image");
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

  it("preflights generated mask commands against the Core atomic transaction limit", () => {
    const children = Array.from({ length: 3_334 }, (_, index) => [
      {
        id: `mask:${index}`, type: "RECTANGLE", isMask: true, maskType: "ALPHA",
        relativeTransform: [[1, 0, index * 2], [0, 1, 0]], absoluteBoundingBox: { x: index * 2, y: 0, width: 1, height: 1 },
      },
      {
        id: `target:${index}`, type: "RECTANGLE",
        relativeTransform: [[1, 0, index * 2], [0, 1, 0]], absoluteBoundingBox: { x: index * 2, y: 0, width: 1, height: 1 },
      },
    ]).flat();
    const plan = planFigmaRestImport({
      version: "transaction-command-limit",
      document: { children: [{ id: "0:1", type: "CANVAS", children }] },
    }, ids());

    expect(plan.nodes).toHaveLength(6_668);
    expect(plan.issues).toContainEqual(expect.objectContaining({ capability: "transaction-commands", outcome: "rejected" }));
    expect(resolveFigmaRestImportBatch(plan)).toBeUndefined();
  });
});
