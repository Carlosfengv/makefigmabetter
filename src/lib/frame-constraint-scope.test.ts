import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { hasActiveAutoLayoutConstraintOverride, hasFrameConstraintScope } from "./frame-constraint-scope";

const node = (id: string, kind: ReturnType<typeof createNode>["kind"], parentId?: string) => ({ ...createNode(kind, 0, 0), id, parentId });

describe("Frame constraint scope", () => {
  it("accepts a direct child and a Group descendant of a Frame", () => {
    const frame = node("frame", "frame");
    const direct = node("direct", "rectangle", frame.id);
    const group = node("group", "group", frame.id);
    const nested = node("nested", "line", group.id);
    const nodes = [frame, direct, group, nested];

    expect(hasFrameConstraintScope(nodes, direct)).toBe(true);
    expect(hasFrameConstraintScope(nodes, nested)).toBe(true);
  });

  it("rejects root layers, Sections and malformed/cyclic ancestors", () => {
    const root = node("root", "ellipse");
    const section = node("section", "section");
    const sectionChild = node("section-child", "text", section.id);
    const first = node("first", "group", "second");
    const second = node("second", "group", first.id);
    const cyclicChild = node("cyclic-child", "rectangle", first.id);
    const nodes = [root, section, sectionChild, first, second, cyclicChild];

    expect(hasFrameConstraintScope(nodes, root)).toBe(false);
    expect(hasFrameConstraintScope(nodes, sectionChild)).toBe(false);
    expect(hasFrameConstraintScope(nodes, cyclicChild)).toBe(false);
  });

  it("lets the nearest active Auto Layout Frame override preserved constraints", () => {
    const autoFrame = { ...node("auto", "frame"), autoLayout: { mode: "horizontal" as const, padding: [0, 0, 0, 0] as [number, number, number, number], itemSpacing: 0, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false } };
    const group = node("group", "group", autoFrame.id);
    const nested = node("nested", "rectangle", group.id);
    const plainFrame = node("plain", "frame", autoFrame.id);
    const plainChild = node("plain-child", "rectangle", plainFrame.id);
    const nodes = [autoFrame, group, nested, plainFrame, plainChild];

    expect(hasActiveAutoLayoutConstraintOverride(nodes, nested)).toBe(true);
    expect(hasActiveAutoLayoutConstraintOverride(nodes, plainChild)).toBe(false);
  });
});
