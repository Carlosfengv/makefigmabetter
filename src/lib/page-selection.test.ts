import { describe, expect, it } from "vitest";
import { normalizePageSelection } from "./page-selection";
import type { CanvasNode } from "./editor-protocol";

const defaultPageId = "page-1";
const nodes: CanvasNode[] = [
  { id: "frame", pageId: defaultPageId, name: "Frame", kind: "frame", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "child", pageId: defaultPageId, parentId: "frame", name: "Child", kind: "rectangle", x: 10, y: 10, width: 20, height: 20, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
  { id: "other-page", pageId: "page-2", name: "Other page", kind: "rectangle", x: 0, y: 0, width: 20, height: 20, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 },
];

describe("Page-owned selection", () => {
  it("keeps only direct hierarchy roots on the active Page", () => {
    expect(normalizePageSelection(nodes, defaultPageId, ["child", "frame", "child", "other-page"], defaultPageId)).toEqual(["frame"]);
  });

  it("retains a child when its parent is not selected", () => {
    expect(normalizePageSelection(nodes, defaultPageId, ["child"], defaultPageId)).toEqual(["child"]);
  });
});
