import { describe, expect, it } from "vitest";
import type { CanvasNode, CoreBatchCommand } from "./editor-protocol";
import { rebaseCoreBatchForSnapshot } from "./rebase-core-batch";

const pageId = "00000000-0000-0000-0000-000000000001";
const position = "ffffffffffffffffffffffffffffffff:00000000000000000000000000000007";
function node(id: string, positionId = position): CanvasNode {
  return { id, pageId, positionId, name: "Rectangle", kind: "rectangle", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#fff", stroke: "#000", strokeWidth: 1, radius: 0, opacity: 1 };
}

describe("core batch reconciliation", () => {
  it("reallocates a concurrent create's duplicate position without changing its ID", () => {
    const local = node("00000000-0000-0000-0000-000000000011");
    const batch: CoreBatchCommand[] = [{ type: "create", node: { ...local, cornerRadius: local.radius, text: "" } }];
    const rebased = rebaseCoreBatchForSnapshot([node("00000000-0000-0000-0000-000000000010")], batch);
    expect(rebased[0]).toMatchObject({ type: "create", node: { id: local.id } });
    expect((rebased[0] as Extract<CoreBatchCommand, { type: "create" }>).node.positionId).not.toBe(position);
    expect((batch[0] as Extract<CoreBatchCommand, { type: "create" }>).node.positionId).toBe(position);
  });

  it("preserves a TextStyle registration because it has no layer position to rebase", () => {
    const command: Extract<CoreBatchCommand, { type: "registerTextStyle" }> = {
      type: "registerTextStyle",
      style: {
        id: "S:body",
        key: "",
        name: "Body",
        description: "",
        descriptionMarkdown: "",
        documentationLinks: [],
        remote: false,
        style: { fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0 },
        paragraph: { alignment: "left", lineHeight: 24, paragraphSpacing: 0 },
      },
    };

    const rebased = rebaseCoreBatchForSnapshot([], [command]);
    expect(rebased).toEqual([command]);
    expect((rebased[0] as typeof command).style).not.toBe(command.style);
  });

  it("replays an explicit child-layout transition after a newly created node", () => {
    const created = node("00000000-0000-0000-0000-000000000012");
    const autoLayout = {
      mode: "none" as const,
      padding: [0, 0, 0, 0] as [number, number, number, number],
      itemSpacing: 0,
      wrap: false,
      primaryAlignment: "start" as const,
      counterAlignment: "start" as const,
      primarySizing: "fixed" as const,
      counterSizing: "fixed" as const,
      absolute: false,
    };
    const batch: CoreBatchCommand[] = [
      { type: "create", node: { ...created, cornerRadius: created.radius, text: "", autoLayout: { ...autoLayout, absolute: true } } },
      { type: "setAutoLayout", id: created.id, autoLayout },
    ];

    const rebased = rebaseCoreBatchForSnapshot([], batch);

    expect(rebased).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: created.id, autoLayout: expect.objectContaining({ absolute: true }) }) }),
      { type: "setAutoLayout", id: created.id, autoLayout },
    ]);
    expect((rebased[1] as Extract<CoreBatchCommand, { type: "setAutoLayout" }>).autoLayout).not.toBe(autoLayout);
  });
});
