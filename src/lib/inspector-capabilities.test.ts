import { describe, expect, it } from "vitest";
import type { CanvasNode } from "./editor-protocol";
import { mixedInspectorCapabilities, supportsCornerRadiusInspector, supportsGenericAppearanceInspector, supportsMixedStrokeAlignInspector, supportsPaintStackInspector, supportsPerSideStrokeInspector, supportsStrokeAlignInspector, supportsStrokeDetailsInspector } from "./inspector-capabilities";

describe("Inspector capability boundaries", () => {
  it("keeps structural and endpoint-only nodes out of generic appearance editing", () => {
    expect(supportsGenericAppearanceInspector("group")).toBe(false);
    expect(supportsPaintStackInspector("group")).toBe(false);
    expect(supportsGenericAppearanceInspector("text")).toBe(true);
    expect(supportsPaintStackInspector("text")).toBe(false);
    expect(supportsGenericAppearanceInspector("line")).toBe(false);
    expect(supportsPaintStackInspector("line")).toBe(true);
    expect((["frame", "rectangle", "ellipse", "line", "section", "image"] as CanvasNode["kind"][]).every(supportsStrokeDetailsInspector)).toBe(true);
    expect((["group", "text"] as CanvasNode["kind"][]).some(supportsStrokeDetailsInspector)).toBe(false);
  });

  it("limits uniform corner radius to closed Phase 2 node kinds", () => {
    expect((["frame", "rectangle", "section"] as CanvasNode["kind"][]).every(supportsCornerRadiusInspector)).toBe(true);
    expect((["group", "ellipse", "line", "text", "image"] as CanvasNode["kind"][]).some(supportsCornerRadiusInspector)).toBe(false);
  });

  it("keeps Stroke Align and independent Weight capability boundaries explicit", () => {
    expect(supportsStrokeAlignInspector({ kind: "frame" })).toBe(true);
    expect(supportsStrokeAlignInspector({ kind: "rectangle" })).toBe(true);
    expect(supportsStrokeAlignInspector({ kind: "ellipse" })).toBe(true);
    expect(supportsStrokeAlignInspector({ kind: "ellipse", arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } })).toBe(false);
    expect(supportsStrokeAlignInspector({ kind: "section" })).toBe(false);
    expect((["frame", "rectangle"] as CanvasNode["kind"][]).every(supportsPerSideStrokeInspector)).toBe(true);
    expect((["group", "section", "ellipse", "line", "text", "image"] as CanvasNode["kind"][]).some(supportsPerSideStrokeInspector)).toBe(false);
    expect(supportsMixedStrokeAlignInspector([{ kind: "frame" }, { kind: "ellipse" }])).toBe(true);
    expect(supportsMixedStrokeAlignInspector([{ kind: "rectangle" }, { kind: "ellipse", arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } }])).toBe(false);
  });

  it("only exposes mixed controls that every selected node can accept", () => {
    expect(mixedInspectorCapabilities([])).toEqual({
      fill: false, strokeWidth: false, strokeAlign: false, perSideStroke: false,
      corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: false,
    });
    expect(mixedInspectorCapabilities([{ kind: "frame" }, { kind: "rectangle" }])).toEqual({
      fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: true,
      corners: true, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: true,
    });
    expect(mixedInspectorCapabilities([{ kind: "line" }, { kind: "line" }])).toEqual({
      fill: false, strokeWidth: true, strokeAlign: false, perSideStroke: false,
      corners: false, strokeDetails: true, lineStroke: true, frameClip: false, sectionContents: false, dropShadow: true,
    });
    expect(mixedInspectorCapabilities([{ kind: "section" }, { kind: "group" }])).toEqual({
      fill: false, strokeWidth: false, strokeAlign: false, perSideStroke: false,
      corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: false,
    });
    expect(mixedInspectorCapabilities([{ kind: "ellipse" }, { kind: "ellipse", arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } }]).strokeAlign).toBe(false);
  });

  it("covers every common-node single selection and hostile mixed boundaries", () => {
    const expected = {
      frame: { fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: true, corners: true, strokeDetails: true, lineStroke: false, frameClip: true, sectionContents: false, dropShadow: true },
      rectangle: { fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: true, corners: true, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: true },
      ellipse: { fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: false, corners: false, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: true },
      line: { fill: false, strokeWidth: true, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: true, lineStroke: true, frameClip: false, sectionContents: false, dropShadow: true },
      section: { fill: true, strokeWidth: true, strokeAlign: false, perSideStroke: false, corners: true, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: true, dropShadow: true },
      image: { fill: true, strokeWidth: true, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: true },
      text: { fill: true, strokeWidth: false, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: true },
      group: { fill: false, strokeWidth: false, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false, dropShadow: false },
    } as const;
    Object.entries(expected).forEach(([kind, capabilities]) => {
      expect(mixedInspectorCapabilities([{ kind: kind as keyof typeof expected }])).toEqual(capabilities);
    });

    // One unsupported member must hide a control for the whole transaction.
    expect(mixedInspectorCapabilities([{ kind: "frame" }, { kind: "text" }])).toMatchObject({ strokeWidth: false, strokeAlign: false, strokeDetails: false });
    expect(mixedInspectorCapabilities([{ kind: "rectangle" }, { kind: "line" }])).toMatchObject({ fill: false, strokeAlign: false, perSideStroke: false, corners: false, lineStroke: false });
    expect(mixedInspectorCapabilities([{ kind: "section" }, { kind: "image" }])).toMatchObject({ corners: false, sectionContents: false, strokeDetails: true });
  });
});
