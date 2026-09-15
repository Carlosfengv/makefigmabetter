import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import {
  effectiveNodeBlendMode,
  extensionsForNodeBlendMode,
  isolatesNormalBlend,
  NORMAL_BLEND_ISOLATION_EXTENSION,
} from "./node-blend-semantics";

describe("node blend semantics", () => {
  it("keeps legacy NORMAL containers pass-through while primitives stay NORMAL", () => {
    expect(effectiveNodeBlendMode(createNode("group", 0, 0))).toBe("pass-through");
    expect(effectiveNodeBlendMode(createNode("rectangle", 0, 0))).toBe("normal");
  });

  it("uses a presence-bearing marker for isolated NORMAL and removes it for other modes", () => {
    const unrelated = { "future.value": [4, 2] };
    const isolated = extensionsForNodeBlendMode(unrelated, "normal");
    expect(isolated).toEqual({
      "future.value": [4, 2],
      [NORMAL_BLEND_ISOLATION_EXTENSION]: [1],
    });
    expect(isolatesNormalBlend({ blendMode: "normal", extensions: isolated })).toBe(true);
    expect(effectiveNodeBlendMode({ ...createNode("frame", 0, 0), extensions: isolated })).toBe("normal");
    expect(extensionsForNodeBlendMode(isolated, "pass-through")).toEqual(unrelated);
    expect(unrelated).toEqual({ "future.value": [4, 2] });
  });

  it("does not admit malformed or stale markers", () => {
    expect(isolatesNormalBlend({ blendMode: "normal", extensions: { [NORMAL_BLEND_ISOLATION_EXTENSION]: [] } })).toBe(false);
    expect(isolatesNormalBlend({ blendMode: "normal", extensions: { [NORMAL_BLEND_ISOLATION_EXTENSION]: [2] } })).toBe(false);
    expect(isolatesNormalBlend({ blendMode: "multiply", extensions: { [NORMAL_BLEND_ISOLATION_EXTENSION]: [1] } })).toBe(false);
  });
});
