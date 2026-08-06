import { describe, expect, it } from "vitest";
import { hasCommittedSelectionResize, scaleLegacySelectionGeometry } from "./selection-resize";

describe("multi-selection resize", () => {
  const nodes = [
    { id: "first", x: 10, y: 20, width: 20, height: 10 },
    { id: "second", x: 70, y: 40, width: 30, height: 20 },
  ];
  const before = { x: 10, y: 20, width: 90, height: 40 };

  it("maps every Legacy node through the selection-scale transform", () => {
    const scaled = scaleLegacySelectionGeometry(nodes, before, { x: 0, y: 10, width: 180, height: 80 });
    expect(scaled?.get("first")).toEqual({ x: 0, y: 10, width: 40, height: 20 });
    expect(scaled?.get("second")).toEqual({ x: 120, y: 50, width: 60, height: 40 });
  });

  it("keeps no-op drags out of the Core transaction stream", () => {
    const beforeById = new Map(nodes.map(({ id, ...geometry }) => [id, geometry]));
    const equal = scaleLegacySelectionGeometry(nodes, before, before)!;
    expect(hasCommittedSelectionResize(beforeById, equal)).toBe(false);
    const resized = scaleLegacySelectionGeometry(nodes, before, { ...before, width: 120 })!;
    expect(hasCommittedSelectionResize(beforeById, resized)).toBe(true);
  });

  it("reflects a crossed Legacy selection while keeping child dimensions positive", () => {
    const reflected = scaleLegacySelectionGeometry([
      { id: "left", x: 0, y: 0, width: 20, height: 10 },
      { id: "right", x: 60, y: 0, width: 20, height: 10 },
    ], { x: 0, y: 0, width: 100, height: 20 }, { x: 0, y: 0, width: 100, height: 20, flipX: true })!;
    expect(reflected.get("left")).toEqual({ x: 80, y: 0, width: 20, height: 10 });
    expect(reflected.get("right")).toEqual({ x: 20, y: 0, width: 20, height: 10 });
  });
});
