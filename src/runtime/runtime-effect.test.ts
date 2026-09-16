import { describe, expect, it } from "vitest";
import { documentEffectsFromRuntime, runtimeEffectsFromDocument, type RuntimeEffect } from "./runtime-effect";
import { isRuntimeError } from "./runtime-errors";

const shadow = {
  type: "DROP_SHADOW",
  color: { r: .1, g: .2, b: .3, a: .4 },
  offset: { x: 5, y: -6 },
  radius: 12,
  spread: -2,
  visible: true,
  blendMode: "NORMAL",
} as const;

describe("Runtime effects", () => {
  it("round-trips the bounded ordered Canonical effect set", () => {
    const effects: RuntimeEffect[] = [
      shadow,
      { ...shadow, type: "INNER_SHADOW" },
      { type: "LAYER_BLUR", radius: 8, visible: true, blurType: "NORMAL" },
      { type: "BACKGROUND_BLUR", radius: 16, visible: false, blurType: "NORMAL" },
    ];
    expect(runtimeEffectsFromDocument(documentEffectsFromRuntime(effects))).toEqual(effects);
  });

  it("rejects unsupported or over-budget effect inputs before staging", () => {
    expect(isRuntimeError(capture(() => documentEffectsFromRuntime(Array.from({ length: 9 }, () => shadow))), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentEffectsFromRuntime([{ ...shadow, radius: 1_025 } as RuntimeEffect])), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentEffectsFromRuntime([{ type: "LAYER_BLUR", radius: 4, visible: true, blurType: "PROGRESSIVE" } as never])), "INVALID_ARGUMENT")).toBe(true);
    expect(isRuntimeError(capture(() => documentEffectsFromRuntime([{ ...shadow, boundVariables: { radius: { type: "VARIABLE_ALIAS", id: "V:radius" } } } as RuntimeEffect])), "UNSUPPORTED_FEATURE")).toBe(true);
  });
});

function capture(callback: () => unknown): unknown {
  try { callback(); return undefined; } catch (error) { return error; }
}
