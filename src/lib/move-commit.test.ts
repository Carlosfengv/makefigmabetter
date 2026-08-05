import { describe, expect, it } from "vitest";
import { hasCommittedMove } from "./move-commit";

describe("hasCommittedMove", () => {
  const initial = new Map([
    ["first", { x: 10, y: 20 }],
    ["second", { x: 30, y: 40 }],
  ]);

  it("does not commit a selection click or snapped zero-distance drag", () => {
    expect(hasCommittedMove(initial, [
      { id: "first", x: 10, y: 20 },
      { id: "second", x: 30, y: 40 },
    ])).toBe(false);
  });

  it("commits when either world coordinate changes", () => {
    expect(hasCommittedMove(initial, [{ id: "first", x: 11, y: 20 }])).toBe(true);
    expect(hasCommittedMove(initial, [{ id: "second", x: 30, y: 39 }])).toBe(true);
  });

  it("ignores updates that are not in the active move selection", () => {
    expect(hasCommittedMove(initial, [{ id: "outside", x: 1, y: 1 }])).toBe(false);
  });
});
