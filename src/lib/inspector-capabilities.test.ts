import { describe, expect, it } from "vitest";
import { mixedInspectorCapabilities, supportsCornerRadiusInspector, supportsGenericAppearanceInspector, supportsMixedStrokeAlignInspector, supportsPaintStackInspector, supportsPerSideStrokeInspector, supportsStrokeAlignInspector, supportsStrokeDetailsInspector } from "./inspector-capabilities";

describe("Inspector capability boundaries", () => {
  it("keeps structural and endpoint-only nodes out of generic appearance editing", () => {
    expect(supportsGenericAppearanceInspector("group")).toBe(false);
    expect(supportsPaintStackInspector("group")).toBe(false);
    expect(supportsGenericAppearanceInspector("text")).toBe(true);
    expect(supportsPaintStackInspector("text")).toBe(false);
    expect(supportsGenericAppearanceInspector("line")).toBe(false);
    expect(supportsPaintStackInspector("line")).toBe(true);
    expect(["frame", "rectangle", "ellipse", "line", "section", "image"].every(supportsStrokeDetailsInspector)).toBe(true);
    expect(["group", "text"].some(supportsStrokeDetailsInspector)).toBe(false);
  });

  it("limits uniform corner radius to closed Phase 2 node kinds", () => {
    expect(["frame", "rectangle", "section"].every(supportsCornerRadiusInspector)).toBe(true);
    expect(["group", "ellipse", "line", "text", "image"].some(supportsCornerRadiusInspector)).toBe(false);
  });

  it("keeps Stroke Align and independent Weight capability boundaries explicit", () => {
    expect(supportsStrokeAlignInspector({ kind: "frame" })).toBe(true);
    expect(supportsStrokeAlignInspector({ kind: "rectangle" })).toBe(true);
    expect(supportsStrokeAlignInspector({ kind: "ellipse" })).toBe(true);
    expect(supportsStrokeAlignInspector({ kind: "ellipse", arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } })).toBe(false);
    expect(supportsStrokeAlignInspector({ kind: "section" })).toBe(false);
    expect(["frame", "rectangle"].every(supportsPerSideStrokeInspector)).toBe(true);
    expect(["group", "section", "ellipse", "line", "text", "image"].some(supportsPerSideStrokeInspector)).toBe(false);
    expect(supportsMixedStrokeAlignInspector([{ kind: "frame" }, { kind: "ellipse" }])).toBe(true);
    expect(supportsMixedStrokeAlignInspector([{ kind: "rectangle" }, { kind: "ellipse", arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } }])).toBe(false);
  });

  it("only exposes mixed controls that every selected node can accept", () => {
    expect(mixedInspectorCapabilities([])).toEqual({
      fill: false, strokeWidth: false, strokeAlign: false, perSideStroke: false,
      corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false,
    });
    expect(mixedInspectorCapabilities([{ kind: "frame" }, { kind: "rectangle" }])).toEqual({
      fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: true,
      corners: true, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false,
    });
    expect(mixedInspectorCapabilities([{ kind: "line" }, { kind: "line" }])).toEqual({
      fill: false, strokeWidth: true, strokeAlign: false, perSideStroke: false,
      corners: false, strokeDetails: true, lineStroke: true, frameClip: false, sectionContents: false,
    });
    expect(mixedInspectorCapabilities([{ kind: "section" }, { kind: "group" }])).toEqual({
      fill: false, strokeWidth: false, strokeAlign: false, perSideStroke: false,
      corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false,
    });
    expect(mixedInspectorCapabilities([{ kind: "ellipse" }, { kind: "ellipse", arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } }]).strokeAlign).toBe(false);
  });

  it("covers every common-node single selection and hostile mixed boundaries", () => {
    const expected = {
      frame: { fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: true, corners: true, strokeDetails: true, lineStroke: false, frameClip: true, sectionContents: false },
      rectangle: { fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: true, corners: true, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false },
      ellipse: { fill: true, strokeWidth: true, strokeAlign: true, perSideStroke: false, corners: false, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false },
      line: { fill: false, strokeWidth: true, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: true, lineStroke: true, frameClip: false, sectionContents: false },
      section: { fill: true, strokeWidth: true, strokeAlign: false, perSideStroke: false, corners: true, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: true },
      image: { fill: true, strokeWidth: true, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: true, lineStroke: false, frameClip: false, sectionContents: false },
      text: { fill: true, strokeWidth: false, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false },
      group: { fill: false, strokeWidth: false, strokeAlign: false, perSideStroke: false, corners: false, strokeDetails: false, lineStroke: false, frameClip: false, sectionContents: false },
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
