import { describe, expect, it } from "vitest";
import type { NodeKind } from "./editor-protocol";
import {
  canContainChildren,
  canContainNodeKind,
  clipsChildren,
  EXTERNAL_NODE_TYPES,
  externalNodeTypeForKind,
  NODE_KIND_CAPABILITIES,
  nodeCapabilities,
  nodeKindFromExternalType,
  supportsInspectorProperty,
} from "./node-capabilities";

const ALL_NODE_KINDS: readonly NodeKind[] = [
  "frame", "group", "section", "rectangle", "ellipse", "polygon", "star", "vector", "booleanOperation", "slice", "line", "text", "image", "codeBlock", "component", "instance", "slot", "componentSet", "connector", "embed", "highlight", "interactiveSlideElement", "linkUnfurl", "media", "shapeWithText", "slideGrid", "slide", "slideRow", "stamp", "sticky", "table", "tableCell", "textPath", "transformGroup", "washiTape", "widget",
];

describe("node capability catalog", () => {
  it("round-trips every Canonical kind through the Runtime node type name", () => {
    expect(EXTERNAL_NODE_TYPES).toEqual(ALL_NODE_KINDS.map(externalNodeTypeForKind));
    expect(new Set(EXTERNAL_NODE_TYPES).size).toBe(ALL_NODE_KINDS.length);
    ALL_NODE_KINDS.forEach((kind) => expect(nodeKindFromExternalType(externalNodeTypeForKind(kind))).toBe(kind));
    expect(nodeKindFromExternalType("DOCUMENT")).toBeUndefined();
  });

  it("classifies every Canonical NodeKind with every entry surface", () => {
    expect(Object.keys(NODE_KIND_CAPABILITIES)).toEqual(ALL_NODE_KINDS);
    for (const kind of ALL_NODE_KINDS) {
      expect(Object.keys(nodeCapabilities(kind).entrySupport).sort()).toEqual(["export", "hit", "import", "read", "render", "runtime", "write"]);
      expect(Object.keys(nodeCapabilities(kind).inspector).sort()).toEqual(["corners", "dropShadow", "fill", "frameClip", "lineStroke", "paintStack", "perSideStroke", "sectionContents", "strokeAlign", "strokeDetails", "strokeWidth"]);
      expect(Object.values(nodeCapabilities(kind).entrySupport).every((support) => support.limitation.length > 0)).toBe(true);
    }
  });

  it("matches the Core hierarchy and keeps child clipping separate from containment", () => {
    expect(ALL_NODE_KINDS.filter(canContainChildren)).toEqual([
      "frame", "group", "section", "booleanOperation", "component", "instance", "slot", "componentSet", "slideGrid", "slide", "slideRow", "table", "transformGroup",
    ]);
    expect(ALL_NODE_KINDS.filter(clipsChildren)).toEqual(["frame", "component", "instance", "slot", "componentSet"]);
    expect(canContainNodeKind("componentSet", "component")).toBe(true);
    expect(canContainNodeKind("componentSet", "rectangle")).toBe(false);
    expect(canContainNodeKind("slideGrid", "slideRow")).toBe(true);
    expect(canContainNodeKind("slideRow", "slide")).toBe(true);
    expect(canContainNodeKind("table", "tableCell")).toBe(true);
    expect(canContainNodeKind("frame", "slide")).toBe(false);
  });

  it("distinguishes structural nodes, export regions and current API gaps", () => {
    expect(nodeCapabilities("group")).toMatchObject({ ownPaint: { fill: false, stroke: false }, childPolicy: "scene", childClip: false, maskEligible: true });
    expect(nodeCapabilities("transformGroup")).toMatchObject({ ownPaint: { fill: false, stroke: false }, childPolicy: "scene", maskEligible: true });
    expect(nodeCapabilities("slice")).toMatchObject({ ownPaint: { fill: false, stroke: false }, exportRegion: true, selectable: true, maskEligible: false });
    expect(nodeCapabilities("section").maskEligible).toBe(false);
    expect(nodeCapabilities("component").entrySupport).toMatchObject({ import: { status: "partial" }, runtime: { status: "partial" } });
    expect(nodeCapabilities("rectangle").entrySupport).toMatchObject({ import: { status: "supported" }, runtime: { status: "partial" } });
    expect(supportsInspectorProperty("frame", "frameClip")).toBe(true);
    expect(supportsInspectorProperty("component", "frameClip")).toBe(false);
    expect(supportsInspectorProperty("text", "paintStack")).toBe(false);
    expect(supportsInspectorProperty("line", "lineStroke")).toBe(true);
  });
});
