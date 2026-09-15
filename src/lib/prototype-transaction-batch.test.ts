import { describe, expect, it } from "vitest";
import { resolveCoreBatch } from "./transaction-batch";
import type { CanvasNode } from "./editor-protocol";

const frame: CanvasNode = { id: "frame", pageId: "page", name: "Frame", kind: "frame", x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: "#fff", stroke: "transparent", strokeWidth: 0, radius: 0, opacity: 1 };

describe("M3 prototype transaction batch", () => {
  it("turns prototype patches into a Core extension command in the same transaction", () => {
    const resolved = resolveCoreBatch([frame], [{ type: "update", id: "frame", patch: {
      prototypeMetadata: { startingPoint: true },
      reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }],
    }}]);
    expect(resolved?.batch).toHaveLength(2);
    expect(resolved?.batch.map((command) => command.type)).toEqual(["setExtensions", "update"]);
    expect(resolved?.batch[0]).toMatchObject({ type: "setExtensions", id: "frame" });
  });
});
