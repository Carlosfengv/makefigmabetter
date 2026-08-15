import { describe, expect, it } from "vitest";
import { createNode, type CanvasNode } from "./editor-protocol";
import {
  inspectorCapabilityAnnouncement,
  inspectorCapabilityMatrix,
  type InspectorCapabilityField,
  type InspectorCapabilityMatrix,
  type InspectorCapabilityState,
} from "./inspector-capability-matrix";

/**
 * Table-driven acceptance for the Mixed Inspector's Same / Mixed / NotApplicable
 * tri-state (Phase 2 remediation P1-2). Rows are the NodeKind combination
 * equivalence classes the plan enumerates — every homogeneous single kind, the
 * hostile "contains Group / Section / Line / Arc / Text / Image" mixes, and
 * value-agreement variants that isolate each column — and columns are the nine
 * Inspector capability fields. Every cell is pinned so a capability boundary or
 * value-agreement rule cannot silently drift.
 */

const ALL_FIELDS: readonly InspectorCapabilityField[] = [
  "fill",
  "strokeWidth",
  "strokeAlign",
  "perSideStroke",
  "corners",
  "strokeDetails",
  "lineStroke",
  "frameClip",
  "sectionContents",
  "dropShadow",
];

/** Every column defaults to NotApplicable; a case only lists the cells that
 * differ, so a missing entry is an explicit "no selected node accepts this". */
function expectMatrix(overrides: Partial<Record<InspectorCapabilityField, InspectorCapabilityState>>): InspectorCapabilityMatrix {
  const base = Object.fromEntries(ALL_FIELDS.map((field) => [field, field === "dropShadow" ? "same" : "notApplicable"])) as Record<InspectorCapabilityField, InspectorCapabilityState>;
  return { ...base, ...overrides };
}

function node(kind: CanvasNode["kind"], overrides: Partial<CanvasNode> = {}): CanvasNode {
  return { ...createNode(kind, 0, 0), ...overrides };
}

const cases: ReadonlyArray<{ name: string; nodes: readonly CanvasNode[]; expected: InspectorCapabilityMatrix }> = [
  {
    name: "empty selection is NotApplicable across every control",
    nodes: [],
    expected: expectMatrix({ dropShadow: "notApplicable" }),
  },
  {
    name: "single Frame exposes fill, aligned/per-side stroke, corners, details and clip",
    nodes: [node("frame")],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", strokeAlign: "same", perSideStroke: "same", corners: "same", strokeDetails: "same", frameClip: "same" }),
  },
  {
    name: "single Rectangle matches Frame minus the Frame-only clip",
    nodes: [node("rectangle")],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", strokeAlign: "same", perSideStroke: "same", corners: "same", strokeDetails: "same" }),
  },
  {
    name: "single full Ellipse exposes stroke align but never per-side or corners",
    nodes: [node("ellipse")],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", strokeAlign: "same", strokeDetails: "same" }),
  },
  {
    name: "single Arc Ellipse drops Stroke Align (Inside-only) but keeps details",
    nodes: [node("ellipse", { arcData: { startingAngle: 0, endingAngle: 270, innerRadius: 0.5 } })],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", strokeDetails: "same" }),
  },
  {
    name: "single Line exposes stroke width, details and the Line-only endpoint controls",
    nodes: [node("line")],
    expected: expectMatrix({ strokeWidth: "same", strokeDetails: "same", lineStroke: "same" }),
  },
  {
    name: "single Text exposes fill only (no stroke of its own)",
    nodes: [node("text")],
    expected: expectMatrix({ fill: "same" }),
  },
  {
    name: "single Image exposes fill, stroke width and stroke details",
    nodes: [node("image")],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", strokeDetails: "same" }),
  },
  {
    name: "single Section exposes fill, width, corners, details and contents toggle",
    nodes: [node("section")],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", corners: "same", strokeDetails: "same", sectionContents: "same" }),
  },
  {
    name: "single Group has no directly writable appearance at all",
    nodes: [node("group")],
    expected: expectMatrix({ dropShadow: "notApplicable" }),
  },
  {
    name: "two identical Frames agree on every applicable control",
    nodes: [node("frame"), node("frame")],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", strokeAlign: "same", perSideStroke: "same", corners: "same", strokeDetails: "same", frameClip: "same" }),
  },
  {
    name: "two divergent Frames stay applicable but report Mixed per differing field",
    nodes: [
      node("frame", { fill: "#111111", strokeWidth: 1, strokeAlign: "inside", radius: 4, strokeJoin: "miter", strokeDashPattern: [], clipsContent: true }),
      node("frame", { fill: "#222222", strokeWidth: 6, strokeAlign: "outside", radius: 12, strokeJoin: "round", strokeDashPattern: [4, 2], clipsContent: false }),
    ],
    expected: expectMatrix({ fill: "mixed", strokeWidth: "mixed", strokeAlign: "mixed", perSideStroke: "mixed", corners: "mixed", strokeDetails: "mixed", frameClip: "mixed" }),
  },
  {
    name: "Frame + Rectangle keep shape controls but drop the Frame-only clip",
    nodes: [node("frame"), node("rectangle")],
    expected: expectMatrix({ fill: "mixed", strokeWidth: "same", strokeAlign: "same", perSideStroke: "same", corners: "mixed", strokeDetails: "same" }),
  },
  {
    name: "any Group in the selection makes every control NotApplicable",
    nodes: [node("frame"), node("group")],
    expected: expectMatrix({ dropShadow: "notApplicable" }),
  },
  {
    name: "a Section removes per-side stroke, align and the Frame clip; keeps shared corners",
    nodes: [node("frame"), node("section")],
    expected: expectMatrix({ fill: "mixed", strokeWidth: "same", corners: "mixed", strokeDetails: "same" }),
  },
  {
    name: "a Line removes fill, align, corners and per-side; leaves shared width/details",
    nodes: [node("frame"), node("line")],
    expected: expectMatrix({ strokeWidth: "same", strokeDetails: "same" }),
  },
  {
    name: "an Arc Ellipse removes Stroke Align from an otherwise-aligned mix",
    nodes: [node("frame"), node("ellipse", { arcData: { startingAngle: 0, endingAngle: 180, innerRadius: 0 } })],
    expected: expectMatrix({ fill: "mixed", strokeWidth: "same", strokeDetails: "same" }),
  },
  {
    name: "Text keeps only fill applicable (its stroke controls vanish)",
    nodes: [node("frame"), node("text")],
    expected: expectMatrix({ fill: "mixed" }),
  },
  {
    name: "Image keeps fill/width/details applicable alongside a Frame",
    nodes: [node("frame"), node("image")],
    expected: expectMatrix({ fill: "mixed", strokeWidth: "same", strokeDetails: "same" }),
  },
  {
    name: "Line + Text is a hostile mix with no shared writable control",
    nodes: [node("line"), node("text")],
    expected: expectMatrix({}),
  },
  {
    name: "two Lines isolate the endpoint column: identical caps agree",
    nodes: [node("line"), node("line")],
    expected: expectMatrix({ strokeWidth: "same", strokeDetails: "same", lineStroke: "same" }),
  },
  {
    name: "two Lines with differing caps report Mixed endpoints but same details",
    nodes: [node("line", { strokeCapEnd: "arrowLines" }), node("line", { strokeCapEnd: "diamondFilled" })],
    expected: expectMatrix({ strokeWidth: "same", strokeDetails: "same", lineStroke: "mixed" }),
  },
  {
    name: "two Sections with differing contents visibility report Mixed contents toggle",
    nodes: [node("section", { contentsHidden: false }), node("section", { contentsHidden: true })],
    expected: expectMatrix({ fill: "same", strokeWidth: "same", corners: "same", strokeDetails: "same", sectionContents: "mixed" }),
  },
];

describe("inspectorCapabilityMatrix", () => {
  it.each(cases)("$name", ({ nodes, expected }) => {
    expect(inspectorCapabilityMatrix(nodes)).toEqual(expected);
  });

  it("never returns a state outside the pinned tri-state", () => {
    for (const { nodes } of cases) {
      const matrix = inspectorCapabilityMatrix(nodes);
      for (const field of ALL_FIELDS) {
        expect(["same", "mixed", "notApplicable"]).toContain(matrix[field]);
      }
    }
  });

  it("reports Drop Shadow as Mixed when compatible layers disagree", () => {
    const matrix = inspectorCapabilityMatrix([node("rectangle"), node("rectangle", { dropShadow: { offsetX: 0, offsetY: 4, blurRadius: 12, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .25 }, visible: true } })]);
    expect(matrix.dropShadow).toBe("mixed");
  });
});

describe("inspectorCapabilityAnnouncement", () => {
  it("reports no selection for an empty set", () => {
    expect(inspectorCapabilityAnnouncement([])).toBe("No layers selected.");
  });

  it("announces editable, mixed and not-applicable controls in one polite utterance", () => {
    const nodes = [
      node("frame", { fill: "#111111", strokeAlign: "inside", radius: 4 }),
      node("frame", { fill: "#222222", strokeAlign: "outside", radius: 12 }),
    ];
    expect(inspectorCapabilityAnnouncement(nodes)).toBe(
      "2 layers selected. Editable: Stroke width, Per-side stroke, Stroke details, Clip content, Drop shadow. Mixed values: Fill, Stroke align, Corner radius. Not applicable: Line endpoints, Section contents.",
    );
  });

  it("names the whole selection as not applicable when a Group is present", () => {
    const announcement = inspectorCapabilityAnnouncement([node("frame"), node("group")]);
    expect(announcement).toContain("No shared editable controls.");
    expect(announcement).toContain("Not applicable: Fill, Stroke width, Stroke align, Per-side stroke, Corner radius, Stroke details, Line endpoints, Clip content, Section contents, Drop shadow.");
  });

  it("omits the Mixed clause when every applicable control agrees", () => {
    const announcement = inspectorCapabilityAnnouncement([node("frame"), node("frame")]);
    expect(announcement).toContain("Editable: Fill, Stroke width, Stroke align, Per-side stroke, Corner radius, Stroke details, Clip content, Drop shadow.");
    expect(announcement).not.toContain("Mixed values:");
  });
});
