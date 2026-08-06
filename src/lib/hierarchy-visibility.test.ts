import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { visibleNodesOnPage } from "./hierarchy-visibility";

const pageId = "00000000-0000-0000-0000-000000000001";
const node = (id: string, kind: ReturnType<typeof createNode>["kind"], parentId?: string) => ({ ...createNode(kind, 0, 0), id, pageId, parentId });

describe("hierarchy visibility", () => {
  it("keeps a Section visible while its hidden contents stop rendering and hit testing", () => {
    const section = { ...node("section", "section"), contentsHidden: true };
    const child = node("child", "rectangle", section.id);
    const nested = node("nested", "ellipse", child.id);
    const sibling = node("sibling", "rectangle");

    expect(visibleNodesOnPage([section, child, nested, sibling], pageId, pageId).map((candidate) => candidate.id)).toEqual([section.id, sibling.id]);
  });

  it("propagates ordinary hidden ancestors and ignores another page", () => {
    const frame = { ...node("frame", "frame"), visible: false };
    const child = node("child", "ellipse", frame.id);
    const other = { ...node("other", "rectangle"), pageId: "00000000-0000-0000-0000-000000000002" };

    expect(visibleNodesOnPage([frame, child, other], pageId, pageId)).toEqual([]);
  });
});
