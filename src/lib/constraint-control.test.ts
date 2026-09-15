import { describe, expect, it } from "vitest";
import {
  constraintAxisLabel,
  constraintEdgeSelected,
  constraintFromDiagramEdge,
  constraintSummary,
} from "./constraint-control";

describe("constraint control", () => {
  it("uses axis-specific Figma labels", () => {
    expect(constraintAxisLabel("horizontal", "min")).toBe("Left");
    expect(constraintAxisLabel("vertical", "min")).toBe("Top");
    expect(constraintSummary("stretch", "scale")).toBe("Left & right · Scale");
  });

  it("uses ordinary clicks as a single-edge choice", () => {
    expect(constraintFromDiagramEdge("stretch", "min", false)).toBe("min");
    expect(constraintFromDiagramEdge("min", "max", false)).toBe("max");
    expect(constraintFromDiagramEdge("scale", "center", false)).toBe("center");
  });

  it("uses Shift-click to add or remove an opposing edge", () => {
    expect(constraintFromDiagramEdge("max", "min", true)).toBe("stretch");
    expect(constraintFromDiagramEdge("min", "max", true)).toBe("stretch");
    expect(constraintFromDiagramEdge("stretch", "min", true)).toBe("max");
    expect(constraintFromDiagramEdge("stretch", "max", true)).toBe("min");
  });

  it("reports both edge buttons selected for Stretch", () => {
    expect(constraintEdgeSelected("stretch", "min")).toBe(true);
    expect(constraintEdgeSelected("stretch", "max")).toBe(true);
    expect(constraintEdgeSelected("stretch", "center")).toBe(false);
  });
});
