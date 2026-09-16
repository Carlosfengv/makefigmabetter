import {
  documentColorFromCssHex,
  type BlendMode,
  type DocumentColor,
  type DocumentGradientPaint,
  type DocumentImageFilters,
  type DocumentImagePaint,
  type DocumentLinearGradient,
  type DocumentPaint,
  type DocumentPaintLayer,
  type DocumentPaintStack,
  type DocumentTextDecorationColor,
  type DocumentVariableAlias,
  type RelativeTransform,
} from "../lib/editor-protocol";
import { colorToSrgbComponents } from "../lib/color-rendering";
import { runtimeError } from "./runtime-errors";

export type RuntimeBlendMode = "NORMAL" | "MULTIPLY" | "SCREEN" | "OVERLAY" | "DARKEN" | "LIGHTEN" | "COLOR_DODGE" | "COLOR_BURN" | "HARD_LIGHT" | "SOFT_LIGHT" | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY" | "LINEAR_BURN" | "LINEAR_DODGE";
export type RuntimeRGB = Readonly<{ r: number; g: number; b: number }>;
export type RuntimeRGBA = RuntimeRGB & Readonly<{ a: number }>;
export type RuntimeTransform = readonly [readonly [number, number, number], readonly [number, number, number]];
export type RuntimeImageFilters = Readonly<{
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}>;
export type RuntimePaintBoundVariables = Readonly<{ color?: DocumentVariableAlias }>;
type RuntimePaintBase = Readonly<{ visible?: boolean; opacity?: number; blendMode?: RuntimeBlendMode; boundVariables?: RuntimePaintBoundVariables }>;
export type RuntimeSolidPaint = RuntimePaintBase & Readonly<{ type: "SOLID"; color: RuntimeRGB }>;
export type RuntimeGradientStop = Readonly<{ position: number; color: RuntimeRGBA; boundVariables?: RuntimePaintBoundVariables }>;
export type RuntimeGradientPaint = RuntimePaintBase & Readonly<{
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradientTransform: RuntimeTransform;
  gradientStops: readonly RuntimeGradientStop[];
}>;
export type RuntimeImagePaint = RuntimePaintBase & Readonly<{
  type: "IMAGE";
  imageHash: string | null;
  scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
  imageTransform?: RuntimeTransform;
  scalingFactor?: number;
  rotation?: 0 | 90 | 180 | 270;
  filters?: RuntimeImageFilters;
}>;
export type RuntimePaint = RuntimeSolidPaint | RuntimeGradientPaint | RuntimeImagePaint;
export type RuntimeTextDecorationColor =
  | Readonly<{ value: "AUTO" }>
  | Readonly<{ value: RuntimeSolidPaint }>;

const BLEND_TO_CANONICAL: Readonly<Record<RuntimeBlendMode, BlendMode>> = {
  NORMAL: "normal",
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
  COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light",
  SOFT_LIGHT: "soft-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
  LINEAR_BURN: "linear-burn",
  LINEAR_DODGE: "linear-dodge",
};

export function runtimePaintsFromNode(node: Readonly<Record<string, unknown>>, usage: "fill" | "stroke"): readonly RuntimePaint[] {
  const stack = node[`${usage}Stack`] as DocumentPaintStack | undefined;
  const layers = stack?.layers ?? legacyLayers(node, usage);
  return layers.map(runtimePaintFromLayer);
}

/** Projects an explicitly present Canonical stack, including an empty stack.
 * Text style runs use presence to distinguish "no glyph paint" from inheriting
 * the node's legacy fill. */
export function runtimePaintsFromDocumentStack(stack: DocumentPaintStack): readonly RuntimePaint[] {
  return stack.layers.map(runtimePaintFromLayer);
}

export function documentPaintStackFromRuntime(
  paints: readonly RuntimePaint[],
  hasImageHash: (hash: string) => boolean,
): DocumentPaintStack {
  if (!Array.isArray(paints) || paints.length > 16) throw runtimeError("INVALID_ARGUMENT");
  return { layers: paints.map((paint) => documentLayerFromRuntime(paint, hasImageHash)) };
}

/** Canonical text runs currently store one color rather than a full Paint
 * stack. Keep the public Text range boundary lossless by accepting exactly one
 * visible Normal solid and folding its Paint opacity into the run color. */
export function documentTextColorFromRuntimeFills(paints: readonly RuntimePaint[]): DocumentColor {
  if (!Array.isArray(paints) || paints.length !== 1) throw runtimeError("UNSUPPORTED_FEATURE");
  const paint = paints[0];
  if (!paint || typeof paint !== "object") throw runtimeError("INVALID_ARGUMENT");
  if (paint.type !== "SOLID") throw runtimeError("UNSUPPORTED_FEATURE");
  const stack = documentPaintStackFromRuntime(paints, () => false);
  const layer = stack.layers[0];
  if (
    stack.layers.length !== 1
    || !layer?.visible
    || layer.blendMode !== "normal"
    || !layer.paint?.color
    || layer.paint.gradient
    || layer.paint.gradientPaint
    || layer.image
  ) {
    throw runtimeError("UNSUPPORTED_FEATURE");
  }
  return { ...layer.paint.color, components: [...layer.paint.color.components], alpha: layer.paint.color.alpha * layer.opacity };
}

/** Projects one Canonical per-run color to Figma's normalized Solid Paint
 * shape. Alpha is represented as Paint opacity because SolidPaint.color is
 * RGB-only in the Plugin API. */
export function runtimeFillsFromDocumentTextColor(color: DocumentColor): readonly RuntimePaint[] {
  const srgb = colorToSrgb(color);
  return [{
    type: "SOLID",
    color: { r: srgb.components[0], g: srgb.components[1], b: srgb.components[2] },
    visible: true,
    opacity: srgb.alpha,
    blendMode: "NORMAL",
  }];
}

export function runtimeTextDecorationColorFromDocument(
  value: DocumentTextDecorationColor | undefined,
): RuntimeTextDecorationColor {
  if (!value) return { value: "AUTO" };
  const srgb = colorToSrgb(value.color);
  return {
    value: {
      type: "SOLID",
      color: { r: srgb.components[0], g: srgb.components[1], b: srgb.components[2] },
      visible: value.visible,
      opacity: value.opacity,
      blendMode: runtimeBlendMode(value.blendMode),
    },
  };
}

export function documentTextDecorationColorFromRuntime(
  value: RuntimeTextDecorationColor,
): DocumentTextDecorationColor | undefined {
  if (!value || typeof value !== "object") throw runtimeError("INVALID_ARGUMENT");
  if (value.value === "AUTO") return undefined;
  const paint = value.value;
  if (!paint || typeof paint !== "object") throw runtimeError("INVALID_ARGUMENT");
  if ("boundVariables" in paint) throw runtimeError("UNSUPPORTED_FEATURE");
  if (paint.type !== "SOLID") throw runtimeError("UNSUPPORTED_FEATURE");
  const layer = documentPaintStackFromRuntime([paint], () => false).layers[0];
  if (!layer?.paint?.color || layer.paint.gradient || layer.paint.gradientPaint || layer.image || layer.blendMode === "pass-through") {
    throw runtimeError("UNSUPPORTED_FEATURE");
  }
  return {
    color: layer.paint.color,
    visible: layer.visible,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
  };
}

function runtimePaintFromLayer(layer: DocumentPaintLayer): RuntimePaint {
  const base = {
    visible: layer.visible,
    opacity: layer.opacity,
    blendMode: runtimeBlendMode(layer.blendMode),
  } as const;
  if (layer.image) {
    const scaleMode = layer.image.scaleMode.toUpperCase() as RuntimeImagePaint["scaleMode"];
    return {
      ...base,
      type: "IMAGE",
      imageHash: layer.image.assetId,
      scaleMode,
      ...runtimeImagePlacement(scaleMode, layer.image.transform),
      ...(layer.image.rotationDegrees ? { rotation: layer.image.rotationDegrees } : {}),
      ...(layer.image.filters ? { filters: { ...layer.image.filters } } : {}),
    };
  }
  const paint = layer.paint;
  if (!paint) throw runtimeError("INTERNAL_ERROR");
  if (paint.gradient) {
    return {
      ...base,
      type: "GRADIENT_LINEAR",
      gradientTransform: gradientTransform(paint.gradient),
      gradientStops: paint.gradient.stops.map((stop) => ({
        position: stop.position,
        color: runtimeRgba(stop.color),
      })),
    };
  }
  if (paint.gradientPaint) {
    return {
      ...base,
      type: `GRADIENT_${paint.gradientPaint.kind.toUpperCase()}` as RuntimeGradientPaint["type"],
      gradientTransform: runtimeTransform(paint.gradientPaint.transform),
      gradientStops: paint.gradientPaint.stops.map((stop) => ({
        position: stop.position,
        color: runtimeRgba(stop.color),
      })),
    };
  }
  const color = paint.color ?? documentColorFromCssHex(paint.css) ?? (paint.css === "transparent"
    ? { space: "srgb", components: [0, 0, 0], alpha: 0 } satisfies DocumentColor
    : undefined);
  if (!color) throw runtimeError("INTERNAL_ERROR");
  const srgb = colorToSrgb(color);
  return {
    ...base,
    type: "SOLID",
    color: { r: srgb.components[0], g: srgb.components[1], b: srgb.components[2] },
    opacity: layer.opacity * srgb.alpha,
  };
}

function documentLayerFromRuntime(paint: RuntimePaint, hasImageHash: (hash: string) => boolean): DocumentPaintLayer {
  if (!paint || typeof paint !== "object") throw runtimeError("INVALID_ARGUMENT");
  if (paint.boundVariables !== undefined) throw runtimeError("UNSUPPORTED_FEATURE");
  const visible = paint.visible ?? true;
  const opacity = paint.opacity ?? 1;
  const blendMode = paint.blendMode === undefined ? "normal" : BLEND_TO_CANONICAL[paint.blendMode];
  if (typeof visible !== "boolean" || !finiteUnit(opacity) || !blendMode) throw runtimeError("INVALID_ARGUMENT");
  const base = { visible, opacity, blendMode };
  if (paint.type === "SOLID") {
    return { ...base, paint: { css: cssForRuntimeRgb(paint.color), color: documentRgb(paint.color) } };
  }
  if (paint.type === "GRADIENT_LINEAR") {
    const gradient = documentGradient(paint);
    return { ...base, paint: { css: cssForRuntimeRgba(paint.gradientStops[0]!.color), gradient } };
  }
  if (paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
    const gradientPaint = documentNonLinearGradient(paint);
    return { ...base, paint: { css: cssForRuntimeRgba(paint.gradientStops[0]!.color), gradientPaint } };
  }
  if (paint.type === "IMAGE") {
    if (!paint.imageHash || !hasImageHash(paint.imageHash)) throw runtimeError("RESOURCE_UNAVAILABLE");
    const scaleMode = paint.scaleMode?.toLowerCase() as "fill" | "fit" | "crop" | "tile" | undefined;
    if (!scaleMode || !["fill", "fit", "crop", "tile"].includes(scaleMode)) throw runtimeError("INVALID_ARGUMENT");
    if (paint.imageTransform !== undefined && scaleMode !== "crop") throw runtimeError("INVALID_ARGUMENT");
    if (paint.scalingFactor !== undefined && (scaleMode !== "tile" || !Number.isFinite(paint.scalingFactor) || paint.scalingFactor <= 0)) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    const rotationDegrees = canonicalImageRotation(paint.rotation, scaleMode);
    if (rotationDegrees === undefined) throw runtimeError("INVALID_ARGUMENT");
    const filters = documentImageFilters(paint.filters);
    let transform = paint.imageTransform ? documentTransform(paint.imageTransform) : identityTransform();
    if (paint.scalingFactor !== undefined) transform = multiplyScale(transform, paint.scalingFactor);
    return {
      ...base,
      image: {
        assetId: paint.imageHash,
        scaleMode,
        transform,
        ...(rotationDegrees ? { rotationDegrees } : {}),
        ...(filters ? { filters } : {}),
      },
    };
  }
  throw runtimeError("UNSUPPORTED_FEATURE");
}

function legacyLayers(node: Readonly<Record<string, unknown>>, usage: "fill" | "stroke"): DocumentPaintLayer[] {
  const paints = node[`${usage}s`] as DocumentPaint[] | undefined;
  const fallback: DocumentPaint = {
    css: typeof node[usage] === "string" ? node[usage] as string : "transparent",
    color: node[`${usage}Color`] as DocumentColor | undefined,
    gradient: node[`${usage}Gradient`] as DocumentLinearGradient | undefined,
  };
  if (!paints?.length && fallback.css === "transparent" && !fallback.color && !fallback.gradient) return [];
  return (paints?.length ? paints : [fallback]).map((paint) => ({ paint, visible: true, opacity: 1, blendMode: "normal" }));
}

function documentGradient(paint: RuntimeGradientPaint): DocumentLinearGradient {
  const inverse = invert(documentTransform(paint.gradientTransform));
  const start = transformPoint(inverse, 0, .5);
  const end = transformPoint(inverse, 1, .5);
  if (distanceSquared(start, end) <= 1e-18 || paint.gradientStops.length < 2 || paint.gradientStops.length > 16) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  const stops = paint.gradientStops.map((stop) => {
    if (stop.boundVariables !== undefined) throw runtimeError("UNSUPPORTED_FEATURE");
    if (!finiteUnit(stop.position)) throw runtimeError("INVALID_ARGUMENT");
    return { position: stop.position, color: documentRgba(stop.color) };
  });
  if (stops.some((stop, index) => index > 0 && stops[index - 1]!.position > stop.position)) throw runtimeError("INVALID_ARGUMENT");
  return { start, end, stops };
}

function documentNonLinearGradient(paint: RuntimeGradientPaint): DocumentGradientPaint {
  const transform = documentTransform(paint.gradientTransform);
  invert(transform);
  if (paint.gradientStops.length < 2 || paint.gradientStops.length > 16) throw runtimeError("INVALID_ARGUMENT");
  const stops = paint.gradientStops.map((stop) => {
    if (stop.boundVariables !== undefined) throw runtimeError("UNSUPPORTED_FEATURE");
    if (!finiteUnit(stop.position)) throw runtimeError("INVALID_ARGUMENT");
    return { position: stop.position, color: documentRgba(stop.color) };
  });
  if (stops.some((stop, index) => index > 0 && stops[index - 1]!.position > stop.position)) throw runtimeError("INVALID_ARGUMENT");
  return {
    kind: paint.type === "GRADIENT_RADIAL" ? "radial" : paint.type === "GRADIENT_ANGULAR" ? "angular" : "diamond",
    transform,
    stops,
  };
}

function gradientTransform(gradient: DocumentLinearGradient): RuntimeTransform {
  const vx = gradient.end[0] - gradient.start[0];
  const vy = gradient.end[1] - gradient.start[1];
  const fromGradient = {
    a: vx,
    b: vy,
    c: -vy,
    d: vx,
    e: gradient.start[0] + vy / 2,
    f: gradient.start[1] - vx / 2,
  };
  return runtimeTransform(invert(fromGradient));
}

function runtimeTransform(transform: RelativeTransform): RuntimeTransform {
  const stable = (value: number) => Object.is(value, -0) || Math.abs(value) < 1e-15 ? 0 : value;
  return [[stable(transform.a), stable(transform.c), stable(transform.e)], [stable(transform.b), stable(transform.d), stable(transform.f)]];
}

function documentTransform(value: RuntimeTransform): RelativeTransform {
  if (!Array.isArray(value) || value.length !== 2 || value.some((row) => !Array.isArray(row) || row.length !== 3 || row.some((entry) => !Number.isFinite(entry)))) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  return { a: value[0][0], c: value[0][1], e: value[0][2], b: value[1][0], d: value[1][1], f: value[1][2] };
}

function invert(value: RelativeTransform): RelativeTransform {
  const determinant = value.a * value.d - value.b * value.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) throw runtimeError("INVALID_ARGUMENT");
  return {
    a: value.d / determinant,
    b: -value.b / determinant,
    c: -value.c / determinant,
    d: value.a / determinant,
    e: (value.c * value.f - value.d * value.e) / determinant,
    f: (value.b * value.e - value.a * value.f) / determinant,
  };
}

function transformPoint(value: RelativeTransform, x: number, y: number): [number, number] {
  return [value.a * x + value.c * y + value.e, value.b * x + value.d * y + value.f];
}

function identityTransform(): RelativeTransform { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
function runtimeImagePlacement(
  scaleMode: RuntimeImagePaint["scaleMode"],
  transform: RelativeTransform,
): Pick<RuntimeImagePaint, "imageTransform" | "scalingFactor"> {
  if (scaleMode === "CROP") return { imageTransform: runtimeTransform(transform) };
  if (
    scaleMode === "TILE" && transform.a > 0 && transform.a === transform.d
    && transform.b === 0 && transform.c === 0 && transform.e === 0 && transform.f === 0
  ) {
    return { scalingFactor: transform.a };
  }
  if (isIdentityTransform(transform)) return {};
  throw runtimeError("UNSUPPORTED_FEATURE");
}
function isIdentityTransform(value: RelativeTransform): boolean {
  return value.a === 1 && value.b === 0 && value.c === 0 && value.d === 1 && value.e === 0 && value.f === 0;
}
function canonicalImageRotation(
  value: RuntimeImagePaint["rotation"],
  scaleMode: DocumentImagePaint["scaleMode"],
): 0 | 90 | 180 | 270 | undefined {
  const rotation = value ?? 0;
  if (![0, 90, 180, 270].includes(rotation) || (scaleMode === "crop" && rotation !== 0)) return undefined;
  return rotation as 0 | 90 | 180 | 270;
}
const IMAGE_FILTER_FIELDS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"] as const;
function documentImageFilters(value: RuntimeImageFilters | undefined): DocumentImageFilters | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError("INVALID_ARGUMENT");
  if (Object.keys(value).some((key) => !IMAGE_FILTER_FIELDS.includes(key as typeof IMAGE_FILTER_FIELDS[number]))) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  const filters: DocumentImageFilters = {};
  for (const field of IMAGE_FILTER_FIELDS) {
    const adjustment = value[field];
    if (adjustment === undefined) continue;
    if (typeof adjustment !== "number" || !Number.isFinite(adjustment) || adjustment < -1 || adjustment > 1) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    filters[field] = adjustment;
  }
  return filters;
}
function multiplyScale(value: RelativeTransform, scale: number): RelativeTransform {
  return { ...value, a: value.a * scale, b: value.b * scale, c: value.c * scale, d: value.d * scale };
}
function distanceSquared(left: readonly number[], right: readonly number[]): number {
  return (left[0]! - right[0]!) ** 2 + (left[1]! - right[1]!) ** 2;
}
function runtimeBlendMode(value: BlendMode): RuntimeBlendMode { return value.toUpperCase().replaceAll("-", "_") as RuntimeBlendMode; }
function finiteUnit(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function documentRgb(color: RuntimeRGB): DocumentColor {
  if (!color || !finiteUnit(color.r) || !finiteUnit(color.g) || !finiteUnit(color.b)) throw runtimeError("INVALID_ARGUMENT");
  return { space: "srgb", components: [color.r, color.g, color.b], alpha: 1 };
}
function documentRgba(color: RuntimeRGBA): DocumentColor {
  return { ...documentRgb(color), alpha: finiteUnit(color.a) ? color.a : invalidArgument() };
}
function invalidArgument(): never { throw runtimeError("INVALID_ARGUMENT"); }
function runtimeRgba(color: DocumentColor): RuntimeRGBA {
  const srgb = colorToSrgb(color);
  return { r: srgb.components[0], g: srgb.components[1], b: srgb.components[2], a: srgb.alpha };
}
function colorToSrgb(color: DocumentColor): DocumentColor {
  if (color.space === "srgb") return color;
  return { space: "srgb", components: colorToSrgbComponents(color), alpha: color.alpha };
}
function cssForRuntimeRgb(color: RuntimeRGB): string { return cssForRuntimeRgba({ ...color, a: 1 }); }
function cssForRuntimeRgba(color: RuntimeRGBA): string {
  const canonical = documentRgba(color);
  const byte = (value: number) => Math.round(value * 255).toString(16).padStart(2, "0");
  return `#${canonical.components.map(byte).join("")}${byte(canonical.alpha)}`;
}
