import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/phase2-common-nodes.fixture.json";
import { createNode } from "./editor-protocol";
import { fullStateReplayBatch, historyReplayBatch } from "./history-replay-batch";
import { encodeCoreBatchPayload } from "./protocol-operation-codec";
import type { CanvasNode } from "./editor-protocol";

describe("history replay batch", () => {
  it("replays an undo of a reflected resize as a canonical node update", () => {
    const before = {
      ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001", width: 72, height: 128,
      relativeTransform: { a: -1, b: 0, c: 0, d: 1, e: 72, f: 0 },
    };
    const after = { ...createNode("rectangle", 0, 0), id: before.id, width: 180, height: 128, relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };

    expect(historyReplayBatch([before], [after])).toEqual([
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: after.id, width: 180, relativeTransform: after.relativeTransform }) }),
    ]);
  });

  it("can conservatively replay all extant nodes when a legacy projection cannot be diffed", () => {
    const first = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-000000000001" };
    const second = { ...createNode("ellipse", 10, 20), id: "00000000-0000-4000-8000-000000000002" };
    expect(fullStateReplayBatch([first, second])).toEqual([
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: first.id }) }),
      expect.objectContaining({ type: "update", node: expect.objectContaining({ id: second.id }) }),
    ]);
  });

  it("encodes a full replay of the Phase 2 common-node fixture", () => {
    const nodes = fixture.nodes as CanvasNode[];
    expect(() => encodeCoreBatchPayload(fullStateReplayBatch(nodes))).not.toThrow();
  });

  it("encodes a canonical zero corner smoothing value on Group replay", () => {
    const group = { ...createNode("group", 0, 0), id: "00000000-0000-4000-8000-000000000003", cornerSmoothing: 0 };
    expect(() => encodeCoreBatchPayload(fullStateReplayBatch([group]))).not.toThrow();
  });
});
