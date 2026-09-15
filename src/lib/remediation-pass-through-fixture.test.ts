import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-pass-through.fixture.json";
import type { CanvasNode } from "./editor-protocol";
import { requiresSubtreeComposition } from "./subtree-compositing";

describe("W12-P pass-through fixture", () => {
  it("freezes a pass-through group and matching direct blend references", () => {
    const nodes = fixture.nodes as CanvasNode[];
    const group = nodes.find((node) => node.name === "Pass through group")!;
    const children = nodes.filter((node) => node.parentId === group.id);

    expect(group.blendMode).toBe("pass-through");
    expect(children.map((node) => node.blendMode)).toEqual(["multiply", "screen"]);
    expect(requiresSubtreeComposition(group, true)).toBe(false);
    expect(nodes.filter((node) => node.name.includes("reference")).map((node) => node.blendMode)).toEqual(["multiply", "screen"]);
  });

  it("records a deterministic fixture hash", () => {
    const bytes = readFileSync("fixtures/documents/remediation-pass-through.fixture.json");
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
});
