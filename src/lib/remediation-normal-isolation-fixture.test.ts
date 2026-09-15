import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-normal-isolation.fixture.json";
import type { CanvasNode } from "./editor-protocol";
import { effectiveNodeBlendMode, isolatesNormalBlend } from "./node-blend-semantics";
import { requiresSubtreeComposition } from "./subtree-compositing";

describe("W12-P isolated NORMAL fixture", () => {
  it("freezes isolated and pass-through subtrees beside their direct references", () => {
    const nodes = fixture.nodes as CanvasNode[];
    const isolated = nodes.find((node) => node.name === "Isolated normal group")!;
    const passThrough = nodes.find((node) => node.name === "Pass through group")!;

    expect(isolatesNormalBlend(isolated)).toBe(true);
    expect(effectiveNodeBlendMode(isolated)).toBe("normal");
    expect(effectiveNodeBlendMode(passThrough)).toBe("pass-through");
    expect(requiresSubtreeComposition(isolated, true)).toBe(true);
    expect(requiresSubtreeComposition(passThrough, true)).toBe(false);
    expect(nodes.filter((node) => node.name.includes("multiply child")).map((node) => node.blendMode)).toEqual(["multiply", "multiply"]);
  });

  it("records a deterministic fixture hash", () => {
    const bytes = readFileSync("fixtures/documents/remediation-normal-isolation.fixture.json");
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
});
