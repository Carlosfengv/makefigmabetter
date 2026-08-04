import { describe, expect, it } from "vitest";
import { resolveCanvasObjectSelection } from "./canvas-selection";

describe("canvas object selection", () => {
  it("keeps an existing multi-selection when pressing a selected object", () => {
    expect(resolveCanvasObjectSelection(["sun", "signal"], "sun", false)).toEqual(["sun", "signal"]);
  });

  it("replaces the selection when pressing an unselected object", () => {
    expect(resolveCanvasObjectSelection(["sun", "signal"], "headline", false)).toEqual(["headline"]);
  });

  it("adds a target once when shift is held", () => {
    expect(resolveCanvasObjectSelection(["sun", "signal"], "sun", true)).toEqual(["sun", "signal"]);
    expect(resolveCanvasObjectSelection(["sun", "signal"], "headline", true)).toEqual(["sun", "signal", "headline"]);
  });
});
