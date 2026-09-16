import type { DocumentEffect, DocumentVariableAlias } from "../lib/editor-protocol";
import { colorToSrgbComponents } from "../lib/color-rendering";
import { runtimeError } from "./runtime-errors";

export type RuntimeEffectBoundVariables = Readonly<Partial<Record<"color" | "radius" | "spread" | "offsetX" | "offsetY", DocumentVariableAlias>>>;
type RuntimeEffectBase = Readonly<{ visible: boolean; boundVariables?: RuntimeEffectBoundVariables }>;
export type RuntimeShadowEffect = RuntimeEffectBase & Readonly<{
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: Readonly<{ r: number; g: number; b: number; a: number }>;
  offset: Readonly<{ x: number; y: number }>;
  radius: number;
  spread?: number;
  blendMode: "NORMAL";
}>;
export type RuntimeBlurEffect = RuntimeEffectBase & Readonly<{
  type: "LAYER_BLUR" | "BACKGROUND_BLUR";
  radius: number;
  blurType: "NORMAL";
}>;
export type RuntimeEffect = RuntimeShadowEffect | RuntimeBlurEffect;

export function runtimeEffectsFromDocument(effects: readonly DocumentEffect[] | undefined): readonly RuntimeEffect[] {
  return (effects ?? []).map((effect): RuntimeEffect => {
    if (effect.dropShadow || effect.innerShadow) {
      const shadow = effect.dropShadow ?? effect.innerShadow!;
      const [r, g, b] = colorToSrgbComponents(shadow.color);
      return {
        type: effect.dropShadow ? "DROP_SHADOW" : "INNER_SHADOW",
        color: { r, g, b, a: shadow.color.alpha },
        offset: { x: shadow.offsetX, y: shadow.offsetY },
        radius: shadow.blurRadius,
        spread: shadow.spread,
        visible: shadow.visible,
        blendMode: "NORMAL",
      };
    }
    const blur = effect.layerBlur ?? effect.backgroundBlur;
    if (!blur) throw runtimeError("INTERNAL_ERROR");
    return {
      type: effect.layerBlur ? "LAYER_BLUR" : "BACKGROUND_BLUR",
      radius: blur.radius,
      visible: blur.visible,
      blurType: "NORMAL",
    };
  });
}

export function documentEffectsFromRuntime(effects: readonly RuntimeEffect[]): DocumentEffect[] {
  if (!Array.isArray(effects) || effects.length > 8) throw runtimeError("INVALID_ARGUMENT");
  return effects.map((effect): DocumentEffect => {
    if (!effect || typeof effect !== "object" || effect.boundVariables !== undefined || typeof effect.visible !== "boolean") {
      throw runtimeError(effect?.boundVariables !== undefined ? "UNSUPPORTED_FEATURE" : "INVALID_ARGUMENT");
    }
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      if (
        effect.blendMode !== "NORMAL"
        || !finiteRange(effect.offset?.x, -10_000, 10_000)
        || !finiteRange(effect.offset?.y, -10_000, 10_000)
        || !finiteRange(effect.radius, 0, 1_024)
        || !finiteRange(effect.spread ?? 0, -10_000, 10_000)
        || !rgba(effect.color)
      ) throw runtimeError("INVALID_ARGUMENT");
      const shadow = {
        offsetX: effect.offset.x,
        offsetY: effect.offset.y,
        blurRadius: effect.radius,
        spread: effect.spread ?? 0,
        color: { space: "srgb" as const, components: [effect.color.r, effect.color.g, effect.color.b] as [number, number, number], alpha: effect.color.a },
        visible: effect.visible,
      };
      return effect.type === "DROP_SHADOW" ? { dropShadow: shadow } : { innerShadow: shadow };
    }
    if ((effect.type !== "LAYER_BLUR" && effect.type !== "BACKGROUND_BLUR") || effect.blurType !== "NORMAL" || !finiteRange(effect.radius, 0, 256)) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    const blur = { radius: effect.radius, visible: effect.visible };
    return effect.type === "LAYER_BLUR" ? { layerBlur: blur } : { backgroundBlur: blur };
  });
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function rgba(value: unknown): value is Readonly<{ r: number; g: number; b: number; a: number }> {
  return Boolean(value && typeof value === "object" && ["r", "g", "b", "a"].every((key) => finiteRange((value as Record<string, unknown>)[key], 0, 1)));
}
