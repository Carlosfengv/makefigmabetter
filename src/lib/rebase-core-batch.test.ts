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
});
