import { runtimeError } from "./runtime-errors";
import type { RuntimeProjectionNode } from "./runtime-projection-store";
import type { RuntimeNodeHandle } from "./node-registry";
import type {
  DocumentComponentMetadata,
  DocumentComponentSetMetadata,
  DocumentBooleanOperation,
  BlendMode,
  CanvasNode,
  DocumentConnectorMetadata,
  DocumentColor,
  DocumentConstraints,
  DocumentEffect,
  DocumentFontReference,
  DocumentInstanceMetadata,
  DocumentPaintStyleResource,
  DocumentPaintStack,
  DocumentTextProperties,
  DocumentTextStyleResource,
  DocumentTextPathMetadata,
  DocumentTransformModifier,
  DocumentVectorPath,
  DocumentVariableCollectionResource,
  DocumentVariableResolvedType,
  DocumentVariableResource,
  DocumentVariableValue,
  ShapeWithTextType,
  StrokeCap,
  StrokeJoin,
} from "../lib/editor-protocol";
import {
  EXTERNAL_NODE_TYPES,
  canContainChildren,
  nodeCapabilities,
  nodeKindFromExternalType,
  supportsOwnFill,
  supportsOwnStroke,
  type ExternalNodeType,
} from "../lib/node-capabilities";
import { isolatesNormalBlend, nodeBlendExtensionPatch } from "../lib/node-blend-semantics";
import { parseFigmaSvgPaths } from "../lib/figma-svg-path";
import { vectorPathSvgD } from "../lib/vector-path";
import { isBoundedTransformModifierStack } from "../lib/transform-group-repeat";
import { canonicalConnectorEndpoint, isFigmaConnectorStrokeCap, projectFigmaConnectorEndpoint, type FigmaConnectorEndpoint, type FigmaConnectorStrokeCap } from "../lib/connector-endpoint";
import { fontsForRuntimeTextRange, patchRuntimeParagraphIndent, patchRuntimeParagraphIndentation, patchRuntimeParagraphLineHeight, patchRuntimeParagraphListSpacing, patchRuntimeParagraphListType, patchRuntimeParagraphSpacing, patchRuntimeParagraphTextWrapStyle, patchRuntimeTextRange, replaceRuntimeTextRangeWithStyles, runtimeParagraphIndentationsForRange, runtimeParagraphIndentsForRange, runtimeParagraphLineHeightsForRange, runtimeParagraphListSpacingsForRange, runtimeParagraphListTypesForRange, runtimeParagraphSpacingsForRange, runtimeParagraphTextWrapStylesForRange, runtimeTextRange, runtimeTextStylesForRange, sameRuntimeLineHeight, updateRuntimeText, type RuntimeParagraphLineHeight, type RuntimeTextInsertionStyle, type RuntimeTextStylePatch } from "./runtime-text";
import { DEFAULT_RUNTIME_FONT_NAME, sameRuntimeFontName, type RuntimeFontName } from "./runtime-font-name";
import { documentTextCase, isRuntimeTextCase, runtimeTextCase, type RuntimeTextCase } from "../lib/text-case";
import { colorToSrgbCss } from "../lib/color-rendering";
import type { RuntimeImage } from "./runtime-session";
import type { RuntimeVariable, RuntimeVariableCollection } from "./runtime-variables";
import { extensionsWithVariableMap, VARIABLE_BINDINGS_EXTENSION, VARIABLE_EFFECT_BINDINGS_EXTENSION, VARIABLE_MODES_EXTENSION, VARIABLE_PAINT_BINDINGS_EXTENSION, variableAliases, variableBindingsFromExtensions, variableEffectBindingsFromExtensions, variablePaintBindingsFromExtensions } from "./runtime-variable-bindings";
import {
  documentPaintStackFromRuntime,
  documentTextDecorationColorFromRuntime,
  runtimeFillsFromDocumentTextColor,
  runtimePaintsFromDocumentStack,
  runtimePaintsFromNode,
  runtimeTextDecorationColorFromDocument,
  type RuntimeBlendMode,
  type RuntimePaint,
  type RuntimeSolidPaint,
  type RuntimeTextDecorationColor,
} from "./runtime-paint";
import { documentEffectsFromRuntime, runtimeEffectsFromDocument, type RuntimeEffect } from "./runtime-effect";
import { type PrototypeMetadata, type PrototypeReaction, validatePrototypeMetadata, validatePrototypeReactions } from "./prototype-contract";
import type { RuntimeExportSettings, RuntimePngExportSettings, RuntimeSvgExportSettings } from "./runtime-svg-export";
import {
  canonicalVectorPathFromRuntimeNetwork,
  runtimeVectorNetworkFromCanonical,
  type RuntimeVectorNetwork,
} from "./runtime-vector-network";
import {
  runtimeStyledTextSegments,
  type RuntimeStyledTextSegment,
  type RuntimeStyledTextSegmentField,
} from "./runtime-styled-text-segments";
export type { RuntimeVectorNetwork } from "./runtime-vector-network";
export type { RuntimePaint } from "./runtime-paint";
export type { RuntimeEffect } from "./runtime-effect";
export type { RuntimeTextDecorationColor } from "./runtime-paint";
export type { RuntimeFontName } from "./runtime-font-name";
export type { RuntimeTextCase } from "../lib/text-case";
export type { RuntimeStyledTextSegment, RuntimeStyledTextSegmentField } from "./runtime-styled-text-segments";
export type RuntimeHyperlinkTarget = Readonly<{ type: "URL" | "NODE"; value: string }>;
export type RuntimeTextDecoration = "NONE" | "UNDERLINE" | "STRIKETHROUGH";
export type RuntimeTextDecorationStyle = "SOLID" | "WAVY" | "DOTTED";
export type RuntimeTextDecorationOffset =
  | Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>
  | Readonly<{ unit: "AUTO" }>;
export type RuntimeTextDecorationThickness =
  | Readonly<{ value: number; unit: "PIXELS" | "PERCENT" }>
  | Readonly<{ unit: "AUTO" }>;
export type RuntimeLeadingTrim = "CAP_HEIGHT" | "NONE";
export type RuntimeTextListOptions = Readonly<{ type: "ORDERED" | "UNORDERED" | "NONE" }>;

export type M1SceneNodeType = ExternalNodeType;
export type M1NodeType = "DOCUMENT" | "PAGE" | M1SceneNodeType;
export const M1_NODE_TYPES: readonly M1NodeType[] = Object.freeze(["DOCUMENT", "PAGE", ...EXTERNAL_NODE_TYPES]);
export type RuntimeLayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL";
export type RuntimeLayoutSizing = "FIXED" | "HUG" | "FILL";
export type RuntimeAxisSizingMode = "FIXED" | "AUTO";
export type RuntimePrimaryAxisAlignment = "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
export type RuntimeCounterAxisAlignment = "MIN" | "CENTER" | "MAX" | "BASELINE";
export type RuntimeCounterAxisAlignContent = "AUTO" | "SPACE_BETWEEN";
export type RuntimeLayoutAlign = "MIN" | "CENTER" | "MAX" | "STRETCH" | "INHERIT";
export type RuntimeTextAutoResize = "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT";
export type RuntimeTextTruncation = "DISABLED" | "ENDING";
export type RuntimeConstraintType = "MIN" | "CENTER" | "MAX" | "STRETCH" | "SCALE";
export type RuntimeConstraints = Readonly<{ horizontal: RuntimeConstraintType; vertical: RuntimeConstraintType }>;
export type RuntimeStrokeCap = "NONE" | "ROUND" | "SQUARE" | "ARROW_LINES" | "ARROW_EQUILATERAL" | "DIAMOND_FILLED" | "TRIANGLE_FILLED" | "CIRCLE_FILLED";
/** Stable Figma-compatible sentinel returned by properties whose projected
 * Canonical values differ. Callers compare identity with `runtime.mixed`. */
export const RUNTIME_MIXED = Symbol("figma.mixed");
export type RuntimeStrokeCapValue = RuntimeStrokeCap | typeof RUNTIME_MIXED;
export type RuntimeStrokeJoin = "MITER" | "BEVEL" | "ROUND";
export type RuntimeVectorPath = Readonly<{ windingRule: "NONZERO" | "EVENODD" | "NONE"; data: string }>;
export type RuntimeBooleanOperation = "UNION" | "INTERSECT" | "SUBTRACT" | "EXCLUDE";
export type RuntimeNodeBlendMode = RuntimeBlendMode | "PASS_THROUGH" | "LINEAR_BURN" | "LINEAR_DODGE";

const NODE_BLEND_TO_CANONICAL: Readonly<Record<RuntimeNodeBlendMode, BlendMode>> = {
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
  PASS_THROUGH: "pass-through",
  LINEAR_BURN: "linear-burn",
  LINEAR_DODGE: "linear-dodge",
};

type RuntimeAutoLayout = Readonly<{
  mode: "none" | "horizontal" | "vertical";
  padding: [number, number, number, number];
  itemSpacing: number;
  trackSpacing?: number;
  trackAlignment?: "auto" | "spaceBetween";
  wrap: boolean;
  primaryAlignment: "start" | "center" | "end" | "spaceBetween";
  counterAlignment: "start" | "center" | "end" | "baseline";
  primarySizing: "fixed" | "hug" | "fill";
  counterSizing: "fixed" | "hug" | "fill";
  alignSelf?: "start" | "center" | "end";
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  absolute: boolean;
}>;

export interface RuntimeNodeHost {
  assertOpen(): void;
  isCurrent(handle: RuntimeNodeHandle): boolean;
  readNode(handle: RuntimeNodeHandle): RuntimeProjectionNode | undefined;
  proxyFor(nodeId: string): RuntimeNodeProxy;
  childrenOf(parentId: string): readonly RuntimeNodeProxy[];
  hasLiveNode(nodeId: string): boolean;
  getNodeByIdAsync(nodeId: string): Promise<RuntimeNodeProxy | null>;
  getInstancesOfComponentAsync(componentId: string): Promise<readonly RuntimeNodeProxy[]>;
  enqueueUpdate(nodeId: string, patch: Readonly<Record<string, unknown>>): void;
  enqueueResizeWithoutConstraints(nodeId: string, patch: Readonly<Record<string, unknown>>): void;
  enqueueRemove(nodeId: string): void;
  commitAsync(): Promise<number>;
  cloneNode(nodeId: string): RuntimeNodeProxy;
  exportNodeSvgString(nodeId: string): Promise<string>;
  exportNodePng(nodeId: string, settings: RuntimePngExportSettings): Promise<Uint8Array>;
  assertFontsLoaded(fonts: readonly DocumentFontReference[]): void;
  resolveFontName(fontName: RuntimeFontName): DocumentFontReference | undefined;
  fontNameForReference(font: DocumentFontReference): RuntimeFontName;
  textStyleResource(styleId: string): DocumentTextStyleResource | undefined;
  paintStyleResource(styleId: string): DocumentPaintStyleResource | undefined;
  variableResource(id: string): DocumentVariableResource | undefined;
  variableCollectionResource(id: string): DocumentVariableCollectionResource | undefined;
  explicitVariableModesForNode(nodeId: string): Readonly<Record<string, string>>;
  resolvedVariableModesForNode(nodeId: string, override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<Record<string, string>>;
  resolveVariableValue(variableId: string, nodeId?: string, override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<{ value: DocumentVariableValue; resolvedType: DocumentVariableResolvedType }>;
  assertSynchronousDocumentAccess(): void;
  hasFontReference(font: DocumentFontReference): boolean;
  hasImageHash(hash: string): boolean;
  allocateRuntimeId(): string;
}

export type RuntimeLetterSpacing = Readonly<{ value: number; unit: "PIXELS" }>;
export type RuntimeLineHeight = RuntimeParagraphLineHeight;
const RUNTIME_VARIABLE_BINDABLE_NODE_FIELDS = [
  "width",
  "height",
  "characters",
  "itemSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "counterAxisSpacing",
  "visible",
  "cornerRadius",
  "topLeftRadius",
  "topRightRadius",
  "bottomRightRadius",
  "bottomLeftRadius",
  "strokeWeight",
  "strokeTopWeight",
  "strokeRightWeight",
  "strokeBottomWeight",
  "strokeLeftWeight",
  "opacity",
] as const;
const RUNTIME_VARIABLE_BINDABLE_NODE_FIELD_SET = new Set<string>(RUNTIME_VARIABLE_BINDABLE_NODE_FIELDS);
export type RuntimeVariableBindableNodeField = typeof RUNTIME_VARIABLE_BINDABLE_NODE_FIELDS[number];
type RuntimeEffectVariableField = "color" | "radius" | "spread" | "offsetX" | "offsetY";
const RUNTIME_EFFECT_VARIABLE_FIELDS: readonly RuntimeEffectVariableField[] = ["color", "radius", "spread", "offsetX", "offsetY"];
function isRuntimeEffectVariableField(value: string): value is RuntimeEffectVariableField {
  return RUNTIME_EFFECT_VARIABLE_FIELDS.includes(value as RuntimeEffectVariableField);
}
function isRuntimeVariableBindableNodeField(value: string): value is RuntimeVariableBindableNodeField {
  return RUNTIME_VARIABLE_BINDABLE_NODE_FIELD_SET.has(value);
}
type RuntimeVariableBindableStrokeSideField = "strokeTopWeight" | "strokeRightWeight" | "strokeBottomWeight" | "strokeLeftWeight";
const RUNTIME_STROKE_SIDE_INDEX: Readonly<Record<RuntimeVariableBindableStrokeSideField, number>> = {
  strokeTopWeight: 0,
  strokeRightWeight: 1,
  strokeBottomWeight: 2,
  strokeLeftWeight: 3,
};
function isRuntimeStrokeSideField(value: RuntimeVariableBindableNodeField): value is RuntimeVariableBindableStrokeSideField {
  return Object.hasOwn(RUNTIME_STROKE_SIDE_INDEX, value);
}
type RuntimeVariableBindableCornerField = "topLeftRadius" | "topRightRadius" | "bottomRightRadius" | "bottomLeftRadius";
const RUNTIME_CORNER_INDEX: Readonly<Record<RuntimeVariableBindableCornerField, number>> = {
  topLeftRadius: 0,
  topRightRadius: 1,
  bottomRightRadius: 2,
  bottomLeftRadius: 3,
};
function isRuntimeCornerField(value: RuntimeVariableBindableNodeField): value is RuntimeVariableBindableCornerField {
  return Object.hasOwn(RUNTIME_CORNER_INDEX, value);
}
function isRuntimeLineHeight(value: unknown): value is RuntimeLineHeight {
  if (!value || typeof value !== "object" || !("unit" in value)) return false;
  const candidate = value as { unit?: unknown; value?: unknown };
  if (candidate.unit === "AUTO") return candidate.value === undefined;
  return (candidate.unit === "PIXELS" || candidate.unit === "PERCENT")
    && typeof candidate.value === "number"
    && Number.isFinite(candidate.value)
    && candidate.value > 0;
}
const SHAPE_WITH_TEXT_DEFAULTS = Object.freeze({ fontSize: 14, fontWeight: 400, italic: false, letterSpacing: 0, lineHeight: 20 });
const DEFAULT_RUNTIME_TEXT_STYLE = Object.freeze({ fontSize: 31, fontWeight: 400, italic: false, letterSpacing: 0, lineHeight: 20 });
const SHAPE_WITH_TEXT_DEFAULT_FILLS: readonly RuntimePaint[] = Object.freeze([{
  type: "SOLID",
  color: { r: 31 / 255, g: 41 / 255, b: 55 / 255 },
  visible: true,
  opacity: 1,
  blendMode: "NORMAL",
}]);
const MAX_TEXT_HYPERLINK_BYTES = 2_048;
const MAX_VARIABLE_MODE_SUBTREE_NODES = 10_000;

function runtimeListOptionsForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeTextListOptions | typeof RUNTIME_MIXED {
  const values = runtimeParagraphListTypesForRange(text, properties, start, end);
  const first = values[0];
  if (values.some((value) => value !== first)) return RUNTIME_MIXED;
  return { type: first === "ordered" ? "ORDERED" : first === "unordered" ? "UNORDERED" : "NONE" };
}

function runtimeHyperlinkForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeHyperlinkTarget | null | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end)
    .map((style) => style.hyperlink ?? null);
  if (!values.length) return null;
  const first = values[0]!;
  if (values.some((value) => JSON.stringify(value) !== JSON.stringify(first))) return RUNTIME_MIXED;
  return first ? structuredClone(first) : null;
}

function runtimeOpenTypeFeaturesForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): Readonly<Record<string, boolean>> | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end)
    .map((style) => style.openTypeFeatures ?? {});
  if (!values.length) return { ...(properties?.baseStyle?.openTypeFeatures ?? {}) };
  const first = values[0]!;
  if (values.some((value) => JSON.stringify(value) !== JSON.stringify(first))) return RUNTIME_MIXED;
  return { ...first };
}

function runtimeTextStyleIdForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): string | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end)
    .map((style) => style.textStyleId ?? "");
  if (!values.length) return properties?.baseStyle?.textStyleId ?? "";
  return values.some((value) => value !== values[0]) ? RUNTIME_MIXED : values[0]!;
}

function runtimePaintStyleIdForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): string | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end)
    .map((style) => style.paintStyleId ?? "");
  if (!values.length) return properties?.baseStyle?.paintStyleId ?? "";
  return values.some((value) => value !== values[0]) ? RUNTIME_MIXED : values[0]!;
}

function applyRuntimeTextStyleRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
  styleId: string,
  resource: DocumentTextStyleResource | undefined,
  defaults: Readonly<{ fontSize: number; fontWeight: number; italic: boolean; letterSpacing: number; lineHeight: number }>,
): DocumentTextProperties {
  runtimeTextRange(text, start, end);
  if (!styleId) return patchRuntimeTextRange(text, properties, start, end, { textStyleId: undefined }, defaults);
  if (!resource || resource.id !== styleId) throw runtimeError("RESOURCE_UNAVAILABLE");
  const style = resource.style;
  const patch: RuntimeTextStylePatch = {
    font: structuredClone(style.font),
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    italic: style.italic,
    letterSpacing: style.letterSpacing,
    color: structuredClone(style.color),
    fillStack: structuredClone(style.fillStack),
    textCase: style.textCase,
    textDecoration: style.textDecoration,
    textDecorationStyle: style.textDecorationStyle,
    textDecorationOffset: structuredClone(style.textDecorationOffset),
    textDecorationThickness: structuredClone(style.textDecorationThickness),
    textDecorationColor: structuredClone(style.textDecorationColor),
    textDecorationSkipInk: style.textDecorationSkipInk,
    leadingTrim: style.leadingTrim,
    openTypeFeatures: style.openTypeFeatures ? { ...style.openTypeFeatures } : undefined,
    textStyleId: styleId,
    paintStyleId: undefined,
  };
  let next = patchRuntimeTextRange(text, properties, start, end, patch, defaults);
  if (start === 0 && end === text.length) {
    return {
      ...next,
      paragraph: structuredClone(resource.paragraph),
      paragraphStyleRuns: undefined,
    };
  }
  const currentParagraph = next.paragraph;
  const targetParagraph = resource.paragraph;
  if (currentParagraph.alignment !== targetParagraph.alignment
    || (currentParagraph.hangingList ?? false) !== (targetParagraph.hangingList ?? false)
    || (currentParagraph.hangingPunctuation ?? false) !== (targetParagraph.hangingPunctuation ?? false)) {
    throw runtimeError("UNSUPPORTED_FEATURE");
  }
  const lineHeight: RuntimeParagraphLineHeight = targetParagraph.lineHeightUnit === "auto"
    ? { unit: "AUTO" }
    : {
        value: targetParagraph.lineHeight ?? defaults.lineHeight,
        unit: targetParagraph.lineHeightUnit === "percent" ? "PERCENT" : "PIXELS",
      };
  next = patchRuntimeParagraphLineHeight(text, next, start, end, lineHeight);
  next = patchRuntimeParagraphSpacing(text, next, start, end, targetParagraph.paragraphSpacing);
  next = patchRuntimeParagraphIndent(text, next, start, end, targetParagraph.paragraphIndent ?? 0);
  next = patchRuntimeParagraphTextWrapStyle(text, next, start, end, targetParagraph.textWrapStyle ?? "auto");
  next = patchRuntimeParagraphListType(text, next, start, end, targetParagraph.listType);
  return patchRuntimeParagraphListSpacing(text, next, start, end, targetParagraph.listSpacing ?? 0);
}

function canonicalHyperlink(value: RuntimeHyperlinkTarget | null): DocumentTextProperties["runs"][number]["hyperlink"] {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || (value.type !== "URL" && value.type !== "NODE") || typeof value.value !== "string") {
    throw runtimeError("INVALID_ARGUMENT");
  }
  const byteLength = new TextEncoder().encode(value.value).byteLength;
  if (byteLength === 0 || byteLength > MAX_TEXT_HYPERLINK_BYTES || value.value.includes("\0")) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  return { type: value.type, value: value.value };
}

function runtimeFontNamesForRange(
  host: RuntimeNodeHost,
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): readonly RuntimeFontName[] {
  const styles = runtimeTextStylesForRange(text, properties, start, end);
  const names = styles.length
    ? styles.map((style) => style.font ? host.fontNameForReference(style.font) : DEFAULT_RUNTIME_FONT_NAME)
    : [DEFAULT_RUNTIME_FONT_NAME];
  return names.filter((name, index) => names.findIndex((candidate) => sameRuntimeFontName(candidate, name)) === index);
}

function runtimeFontNameForRange(
  host: RuntimeNodeHost,
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeFontName | typeof RUNTIME_MIXED {
  const names = runtimeFontNamesForRange(host, text, properties, start, end);
  return names.length === 1 ? names[0]! : RUNTIME_MIXED;
}

function runtimeTextHasMissingFont(
  host: RuntimeNodeHost,
  text: string,
  properties: DocumentTextProperties | undefined,
): boolean {
  return runtimeTextStylesForRange(text, properties, 0, text.length)
    .some((style) => Boolean(style.font && !host.hasFontReference(style.font)));
}

function runtimeTextCaseForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeTextCase | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end).map((style) => runtimeTextCase(style.textCase));
  const cases = values.length ? [...new Set(values)] : ["ORIGINAL" as const];
  return cases.length === 1 ? cases[0]! : RUNTIME_MIXED;
}

function runtimeTextDecorationForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeTextDecoration | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end)
    .map((style) => style.textDecoration === "underline" ? "UNDERLINE" as const : style.textDecoration === "strikethrough" ? "STRIKETHROUGH" as const : "NONE" as const);
  const decorations = values.length ? [...new Set(values)] : ["NONE" as const];
  return decorations.length === 1 ? decorations[0]! : RUNTIME_MIXED;
}

function documentTextDecoration(value: RuntimeTextDecoration): DocumentTextProperties["runs"][number]["textDecoration"] {
  if (value === "NONE") return undefined;
  if (value === "UNDERLINE") return "underline";
  if (value === "STRIKETHROUGH") return "strikethrough";
  throw runtimeError("INVALID_ARGUMENT");
}

function runtimeTextDecorationStyleForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeTextDecorationStyle | null | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end).map((style) => {
    if (style.textDecoration !== "underline") return null;
    if (style.textDecorationStyle === "wavy") return "WAVY" as const;
    if (style.textDecorationStyle === "dotted") return "DOTTED" as const;
    return "SOLID" as const;
  });
  const styles = values.length ? [...new Set(values)] : [null];
  return styles.length === 1 ? styles[0]! : RUNTIME_MIXED;
}

function documentTextDecorationStyle(value: RuntimeTextDecorationStyle): DocumentTextProperties["runs"][number]["textDecorationStyle"] {
  if (value === "SOLID") return undefined;
  if (value === "WAVY") return "wavy";
  if (value === "DOTTED") return "dotted";
  throw runtimeError("INVALID_ARGUMENT");
}

function runtimeTextDecorationOffsetForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeTextDecorationOffset | null | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end).map((style): RuntimeTextDecorationOffset | null => {
    if (style.textDecoration !== "underline") return null;
    if (!style.textDecorationOffset) return { unit: "AUTO" };
    return {
      value: style.textDecorationOffset.value,
      unit: style.textDecorationOffset.unit === "pixels" ? "PIXELS" : "PERCENT",
    };
  });
  const offsets = values.length ? values : [null];
  const first = offsets[0]!;
  return offsets.some((value) => JSON.stringify(value) !== JSON.stringify(first))
    ? RUNTIME_MIXED
    : first ? structuredClone(first) : null;
}

function documentTextDecorationOffset(
  value: RuntimeTextDecorationOffset,
): DocumentTextProperties["runs"][number]["textDecorationOffset"] {
  if (!value || typeof value !== "object") throw runtimeError("INVALID_ARGUMENT");
  if (value.unit === "AUTO") return undefined;
  if ((value.unit !== "PIXELS" && value.unit !== "PERCENT")
    || !Number.isFinite(value.value) || value.value < -10_000 || value.value > 10_000) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  return { value: value.value, unit: value.unit === "PIXELS" ? "pixels" : "percent" };
}

function runtimeTextDecorationThicknessForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeTextDecorationThickness | null | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end).map((style): RuntimeTextDecorationThickness | null => {
    if (style.textDecoration !== "underline") return null;
    if (!style.textDecorationThickness) return { unit: "AUTO" };
    return {
      value: style.textDecorationThickness.value,
      unit: style.textDecorationThickness.unit === "pixels" ? "PIXELS" : "PERCENT",
    };
  });
  const thicknesses = values.length ? values : [null];
  const first = thicknesses[0]!;
  return thicknesses.some((value) => JSON.stringify(value) !== JSON.stringify(first))
    ? RUNTIME_MIXED
    : first ? structuredClone(first) : null;
}

function documentTextDecorationThickness(
  value: RuntimeTextDecorationThickness,
): DocumentTextProperties["runs"][number]["textDecorationThickness"] {
  if (!value || typeof value !== "object") throw runtimeError("INVALID_ARGUMENT");
  if (value.unit === "AUTO") return undefined;
  if ((value.unit !== "PIXELS" && value.unit !== "PERCENT")
    || !Number.isFinite(value.value) || value.value < 0 || value.value > 10_000) {
    throw runtimeError("INVALID_ARGUMENT");
  }
  return { value: value.value, unit: value.unit === "PIXELS" ? "pixels" : "percent" };
}

function runtimeTextDecorationColorForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): RuntimeTextDecorationColor | null | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end).map((style): RuntimeTextDecorationColor | null => {
    if (style.textDecoration !== "underline") return null;
    return runtimeTextDecorationColorFromDocument(style.textDecorationColor);
  });
  const colors = values.length ? values : [null];
  const first = colors[0]!;
  return colors.some((value) => JSON.stringify(value) !== JSON.stringify(first))
    ? RUNTIME_MIXED
    : first ? structuredClone(first) : null;
}

function runtimeTextDecorationSkipInkForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
): boolean | null | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, start, end).map((style): boolean | null => {
    if (style.textDecoration !== "underline") return null;
    return style.textDecorationSkipInk === true;
  });
  const resolved = values.length ? values : [null];
  const first = resolved[0]!;
  return resolved.some((value) => value !== first) ? RUNTIME_MIXED : first;
}

function runtimeLeadingTrimForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
): RuntimeLeadingTrim | typeof RUNTIME_MIXED {
  const values = runtimeTextStylesForRange(text, properties, 0, text.length)
    .map((style): RuntimeLeadingTrim => style.leadingTrim === "capHeight" ? "CAP_HEIGHT" : "NONE");
  if (!values.length) {
    return properties?.baseStyle?.leadingTrim === "capHeight" ? "CAP_HEIGHT" : "NONE";
  }
  return values.some((value) => value !== values[0]) ? RUNTIME_MIXED : values[0]!;
}

/** Live, owner-bound subset of Figma's TextSublayerNode. The object has stable
 * identity for one ShapeWithText proxy while every read still resolves through
 * the session projection, so removal and stale-generation errors stay aligned
 * with ordinary Runtime nodes. */
export class RuntimeTextSublayerProxy {
  constructor(
    private readonly handle: RuntimeNodeHandle,
    private readonly host: RuntimeNodeHost,
  ) {}

  get characters(): string {
    const value = this.read().characters;
    return typeof value === "string" ? value : "";
  }

  set characters(value: string) {
    if (typeof value !== "string") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const node = this.read();
    const before = typeof node.characters === "string" ? node.characters : "";
    const properties = node.textProperties as DocumentTextProperties | undefined;
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(before, properties));
    const patch = updateRuntimeText(before, value, properties, SHAPE_WITH_TEXT_DEFAULTS);
    const bindings = { ...variableBindingsFromExtensions(node.extensions) };
    if (Object.hasOwn(bindings, "characters")) {
      delete bindings.characters;
      this.write({ ...patch, extensions: extensionsWithVariableMap(node.extensions, VARIABLE_BINDINGS_EXTENSION, bindings) });
    } else {
      this.write(patch);
    }
  }

  get hasMissingFont(): boolean {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextHasMissingFont(this.host, text, node.textProperties as DocumentTextProperties | undefined);
  }

  get fontName(): RuntimeFontName | typeof RUNTIME_MIXED {
    return this.getRangeFontName(0, this.characters.length);
  }

  set fontName(value: RuntimeFontName | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeFontName(0, this.characters.length, value);
  }

  get openTypeFeatures(): Readonly<Record<string, boolean>> | typeof RUNTIME_MIXED {
    return this.getRangeOpenTypeFeatures(0, this.characters.length);
  }

  get textStyleId(): string | typeof RUNTIME_MIXED {
    return this.getRangeTextStyleId(0, this.characters.length);
  }

  set textStyleId(value: string | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.host.assertSynchronousDocumentAccess();
    this.applyTextStyleRange(0, this.characters.length, value);
  }

  async setTextStyleIdAsync(styleId: string): Promise<void> {
    this.applyTextStyleRange(0, this.characters.length, styleId);
    await this.host.commitAsync();
  }

  get fillStyleId(): string | typeof RUNTIME_MIXED {
    return this.getRangeFillStyleId(0, this.characters.length);
  }

  set fillStyleId(value: string | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.host.assertSynchronousDocumentAccess();
    this.applyPaintStyleRange(0, this.characters.length, value);
  }

  async setFillStyleIdAsync(styleId: string): Promise<void> {
    this.applyPaintStyleRange(0, this.characters.length, styleId);
    await this.host.commitAsync();
  }

  get textCase(): RuntimeTextCase | typeof RUNTIME_MIXED {
    return this.getRangeTextCase(0, this.characters.length);
  }

  set textCase(value: RuntimeTextCase | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED || !isRuntimeTextCase(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextCase(0, this.characters.length, value);
  }

  get textDecoration(): RuntimeTextDecoration | typeof RUNTIME_MIXED {
    return this.getRangeTextDecoration(0, this.characters.length);
  }

  set textDecoration(value: RuntimeTextDecoration | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecoration(0, this.characters.length, value);
  }

  get textDecorationStyle(): RuntimeTextDecorationStyle | null | typeof RUNTIME_MIXED {
    return this.getRangeTextDecorationStyle(0, this.characters.length);
  }

  set textDecorationStyle(value: RuntimeTextDecorationStyle | null | typeof RUNTIME_MIXED) {
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationStyle(0, this.characters.length, value);
  }

  get textDecorationOffset(): RuntimeTextDecorationOffset | null | typeof RUNTIME_MIXED {
    return this.getRangeTextDecorationOffset(0, this.characters.length);
  }

  set textDecorationOffset(value: RuntimeTextDecorationOffset | null | typeof RUNTIME_MIXED) {
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationOffset(0, this.characters.length, value);
  }

  get textDecorationThickness(): RuntimeTextDecorationThickness | null | typeof RUNTIME_MIXED {
    return this.getRangeTextDecorationThickness(0, this.characters.length);
  }

  set textDecorationThickness(value: RuntimeTextDecorationThickness | null | typeof RUNTIME_MIXED) {
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationThickness(0, this.characters.length, value);
  }

  get textDecorationColor(): RuntimeTextDecorationColor | null | typeof RUNTIME_MIXED {
    return this.getRangeTextDecorationColor(0, this.characters.length);
  }

  set textDecorationColor(value: RuntimeTextDecorationColor | null | typeof RUNTIME_MIXED) {
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationColor(0, this.characters.length, value);
  }

  get textDecorationSkipInk(): boolean | null | typeof RUNTIME_MIXED {
    return this.getRangeTextDecorationSkipInk(0, this.characters.length);
  }

  set textDecorationSkipInk(value: boolean | null | typeof RUNTIME_MIXED) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationSkipInk(0, this.characters.length, value);
  }

  get leadingTrim(): RuntimeLeadingTrim | typeof RUNTIME_MIXED {
    const node = this.read();
    return runtimeLeadingTrimForRange(this.characters, node.textProperties as DocumentTextProperties | undefined);
  }

  set leadingTrim(value: RuntimeLeadingTrim | typeof RUNTIME_MIXED) {
    if (value !== "CAP_HEIGHT" && value !== "NONE") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(0, this.characters.length, { leadingTrim: value === "CAP_HEIGHT" ? "capHeight" : undefined });
  }

  get hyperlink(): RuntimeHyperlinkTarget | null | typeof RUNTIME_MIXED {
    return this.getRangeHyperlink(0, this.characters.length);
  }

  set hyperlink(value: RuntimeHyperlinkTarget | null | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeHyperlink(0, this.characters.length, value);
  }

  get fontSize(): number | typeof RUNTIME_MIXED {
    return this.rangeStyleValue(0, this.characters.length, "fontSize", SHAPE_WITH_TEXT_DEFAULTS.fontSize);
  }

  set fontSize(value: number | typeof RUNTIME_MIXED) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeFontSize(0, this.characters.length, value);
  }

  get fontWeight(): number | typeof RUNTIME_MIXED {
    return this.rangeStyleValue(0, this.characters.length, "fontWeight", 400);
  }

  get letterSpacing(): RuntimeLetterSpacing | typeof RUNTIME_MIXED {
    const value = this.rangeStyleValue(0, this.characters.length, "letterSpacing", 0);
    return value === RUNTIME_MIXED ? value : { value, unit: "PIXELS" };
  }

  set letterSpacing(value: RuntimeLetterSpacing | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED || value?.unit !== "PIXELS" || !Number.isFinite(value.value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.setRangeLetterSpacing(0, this.characters.length, value);
  }

  get lineHeight(): RuntimeLineHeight | typeof RUNTIME_MIXED {
    const values = runtimeParagraphLineHeightsForRange(this.characters, this.textProperties(), 0, this.characters.length);
    return values.every((value) => sameRuntimeLineHeight(value, values[0]!))
      ? (values[0] ?? { value: SHAPE_WITH_TEXT_DEFAULTS.lineHeight, unit: "PIXELS" })
      : RUNTIME_MIXED;
  }

  set lineHeight(value: RuntimeLineHeight | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED || !isRuntimeLineHeight(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    const properties = this.textProperties();
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, properties));
    this.write({ textProperties: patchRuntimeParagraphLineHeight(text, properties, 0, text.length, value) });
  }

  get paragraphSpacing(): number | typeof RUNTIME_MIXED {
    const values = runtimeParagraphSpacingsForRange(this.characters, this.textProperties(), 0, this.characters.length);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  set paragraphSpacing(value: number | typeof RUNTIME_MIXED) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphSpacing(text, this.textProperties(), 0, text.length, value) });
  }

  get paragraphIndent(): number | typeof RUNTIME_MIXED {
    const values = runtimeParagraphIndentsForRange(this.characters, this.textProperties(), 0, this.characters.length);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  set paragraphIndent(value: number | typeof RUNTIME_MIXED) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphIndent(text, this.textProperties(), 0, text.length, value) });
  }

  get textWrapStyle(): "AUTO" | "BALANCE" | "PRETTY" | typeof RUNTIME_MIXED {
    const values = runtimeParagraphTextWrapStylesForRange(this.characters, this.textProperties(), 0, this.characters.length);
    return values.every((value) => value === values[0]) ? runtimeTextWrapStyle(values[0] ?? "auto") : RUNTIME_MIXED;
  }

  set textWrapStyle(value: "AUTO" | "BALANCE" | "PRETTY" | typeof RUNTIME_MIXED) {
    if (value !== "AUTO" && value !== "BALANCE" && value !== "PRETTY") {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphTextWrapStyle(text, this.textProperties(), 0, text.length, documentTextWrapStyle(value)) });
  }

  get listSpacing(): number | typeof RUNTIME_MIXED {
    const values = runtimeParagraphListSpacingsForRange(
      this.characters,
      this.textProperties(),
      0,
      this.characters.length,
    );
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  set listSpacing(value: number | typeof RUNTIME_MIXED) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphListSpacing(text, this.textProperties(), 0, text.length, value) });
  }

  get hangingList(): boolean | typeof RUNTIME_MIXED {
    return this.textProperties().paragraph.hangingList ?? false;
  }

  set hangingList(value: boolean | typeof RUNTIME_MIXED) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeParagraph({ hangingList: value ? true : undefined }, false);
  }

  get hangingPunctuation(): boolean {
    return this.textProperties().paragraph.hangingPunctuation ?? false;
  }

  set hangingPunctuation(value: boolean) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeParagraph({ hangingPunctuation: value ? true : undefined }, false);
  }

  getRangeLineHeight(start: number, end: number): RuntimeLineHeight | typeof RUNTIME_MIXED {
    this.assertTextRange(start, end);
    const values = runtimeParagraphLineHeightsForRange(this.characters, this.textProperties(), start, end);
    return values.every((value) => sameRuntimeLineHeight(value, values[0]!)) ? values[0]! : RUNTIME_MIXED;
  }

  setRangeLineHeight(start: number, end: number, value: RuntimeLineHeight): void {
    this.assertTextRange(start, end);
    if (!isRuntimeLineHeight(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    const properties = this.textProperties();
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, properties, start, end));
    this.write({ textProperties: patchRuntimeParagraphLineHeight(text, properties, start, end, value) });
  }

  getRangeParagraphSpacing(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertTextRange(start, end);
    const values = runtimeParagraphSpacingsForRange(this.characters, this.textProperties(), start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeParagraphSpacing(start: number, end: number, value: number): void {
    this.assertTextRange(start, end);
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphSpacing(text, this.textProperties(), start, end, value) });
  }

  getRangeParagraphIndent(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertTextRange(start, end);
    const values = runtimeParagraphIndentsForRange(this.characters, this.textProperties(), start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeParagraphIndent(start: number, end: number, value: number): void {
    this.assertTextRange(start, end);
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphIndent(text, this.textProperties(), start, end, value) });
  }

  getRangeTextWrapStyle(start: number, end: number): "AUTO" | "BALANCE" | "PRETTY" | typeof RUNTIME_MIXED {
    this.assertTextRange(start, end);
    const values = runtimeParagraphTextWrapStylesForRange(this.characters, this.textProperties(), start, end);
    return values.every((value) => value === values[0]) ? runtimeTextWrapStyle(values[0] ?? "auto") : RUNTIME_MIXED;
  }

  setRangeTextWrapStyle(start: number, end: number, value: "AUTO" | "BALANCE" | "PRETTY"): void {
    this.assertTextRange(start, end);
    if (value !== "AUTO" && value !== "BALANCE" && value !== "PRETTY") {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphTextWrapStyle(text, this.textProperties(), start, end, documentTextWrapStyle(value)) });
  }

  getRangeListOptions(start: number, end: number): RuntimeTextListOptions | typeof RUNTIME_MIXED {
    this.assertTextRange(start, end);
    return runtimeListOptionsForRange(this.characters, this.textProperties(), start, end);
  }

  setRangeListOptions(start: number, end: number, value: RuntimeTextListOptions): void {
    this.assertTextRange(start, end);
    if (!value || !["ORDERED", "UNORDERED", "NONE"].includes(value.type)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({
      textProperties: patchRuntimeParagraphListType(
        text,
        this.textProperties(),
        start,
        end,
        value.type === "ORDERED" ? "ordered" : value.type === "UNORDERED" ? "unordered" : undefined,
      ),
    });
  }

  getRangeListSpacing(start: number, end: number): number | typeof RUNTIME_MIXED {
    const values = runtimeParagraphListSpacingsForRange(this.characters, this.textProperties(), start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeListSpacing(start: number, end: number, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphListSpacing(text, this.textProperties(), start, end, value) });
  }

  getRangeIndentation(start: number, end: number): number | typeof RUNTIME_MIXED {
    const values = runtimeParagraphIndentationsForRange(this.characters, this.textProperties(), start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeIndentation(start: number, end: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphIndentation(text, this.textProperties(), start, end, value) });
  }

  get fills(): readonly RuntimePaint[] | typeof RUNTIME_MIXED {
    return this.rangeFills(0, this.characters.length);
  }

  set fills(value: readonly RuntimePaint[] | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeFills(0, this.characters.length, value);
  }

  insertCharacters(start: number, characters: string, useStyle: "BEFORE" | "AFTER" = "BEFORE"): void {
    if (useStyle !== "BEFORE" && useStyle !== "AFTER") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.replaceCharacters(start, start, characters, useStyle);
  }

  deleteCharacters(start: number, end: number): void {
    this.replaceCharacters(start, end, "");
  }

  setRangeCharacters(start: number, end: number, characters: string): void {
    this.replaceCharacters(start, end, characters);
  }

  getStyledTextSegments<Fields extends readonly RuntimeStyledTextSegmentField[]>(
    fields: Fields,
    start?: number,
    end?: number,
  ): Array<RuntimeStyledTextSegment<Fields>> {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeStyledTextSegments(
      text,
      node.textProperties as DocumentTextProperties | undefined,
      fields,
      SHAPE_WITH_TEXT_DEFAULT_FILLS,
      SHAPE_WITH_TEXT_DEFAULTS,
      start,
      end,
      (font) => this.host.fontNameForReference(font),
    );
  }

  getRangeFontSize(start: number, end: number): number | typeof RUNTIME_MIXED {
    return this.rangeStyleValue(start, end, "fontSize", SHAPE_WITH_TEXT_DEFAULTS.fontSize);
  }

  getRangeOpenTypeFeatures(start: number, end: number): Readonly<Record<string, boolean>> | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    this.assertTextRange(start, end);
    return runtimeOpenTypeFeaturesForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  getRangeTextStyleId(start: number, end: number): string | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    this.assertTextRange(start, end);
    return runtimeTextStyleIdForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextStyleId(start: number, end: number, styleId: string): void {
    this.host.assertSynchronousDocumentAccess();
    this.applyTextStyleRange(start, end, styleId);
  }

  async setRangeTextStyleIdAsync(start: number, end: number, styleId: string): Promise<void> {
    this.applyTextStyleRange(start, end, styleId);
    await this.host.commitAsync();
  }

  getRangeFillStyleId(start: number, end: number): string | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    this.assertTextRange(start, end);
    return runtimePaintStyleIdForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeFillStyleId(start: number, end: number, styleId: string): void {
    this.host.assertSynchronousDocumentAccess();
    this.applyPaintStyleRange(start, end, styleId);
  }

  async setRangeFillStyleIdAsync(start: number, end: number, styleId: string): Promise<void> {
    this.applyPaintStyleRange(start, end, styleId);
    await this.host.commitAsync();
  }

  setRangeFontSize(start: number, end: number, value: number): void {
    if (!Number.isFinite(value) || value < 1) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { fontSize: value });
  }

  getRangeFontName(start: number, end: number): RuntimeFontName | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeFontNameForRange(this.host, text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  getRangeAllFontNames(start: number, end: number): readonly RuntimeFontName[] {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeFontNamesForRange(this.host, text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeFontName(start: number, end: number, value: RuntimeFontName): void {
    const font = this.host.resolveFontName(value);
    this.setTextRange(start, end, { font });
  }

  getRangeTextCase(start: number, end: number): RuntimeTextCase | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextCaseForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextCase(start: number, end: number, value: RuntimeTextCase): void {
    if (!isRuntimeTextCase(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { textCase: documentTextCase(value) });
  }

  getRangeTextDecoration(start: number, end: number): RuntimeTextDecoration | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecoration(start: number, end: number, value: RuntimeTextDecoration): void {
    this.setTextRange(start, end, { textDecoration: documentTextDecoration(value) });
  }

  getRangeTextDecorationStyle(start: number, end: number): RuntimeTextDecorationStyle | null | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationStyleForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationStyle(start: number, end: number, value: RuntimeTextDecorationStyle): void {
    this.setTextRange(start, end, { textDecorationStyle: documentTextDecorationStyle(value) });
  }

  getRangeTextDecorationOffset(start: number, end: number): RuntimeTextDecorationOffset | null | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationOffsetForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationOffset(start: number, end: number, value: RuntimeTextDecorationOffset): void {
    this.setTextRange(start, end, { textDecorationOffset: documentTextDecorationOffset(value) });
  }

  getRangeTextDecorationThickness(start: number, end: number): RuntimeTextDecorationThickness | null | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationThicknessForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationThickness(start: number, end: number, value: RuntimeTextDecorationThickness): void {
    this.setTextRange(start, end, { textDecorationThickness: documentTextDecorationThickness(value) });
  }

  getRangeTextDecorationColor(start: number, end: number): RuntimeTextDecorationColor | null | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationColorForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationColor(start: number, end: number, value: RuntimeTextDecorationColor): void {
    this.setTextRange(start, end, { textDecorationColor: documentTextDecorationColorFromRuntime(value) });
  }

  getRangeTextDecorationSkipInk(start: number, end: number): boolean | null | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationSkipInkForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationSkipInk(start: number, end: number, value: boolean): void {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { textDecorationSkipInk: value ? true : undefined });
  }

  getRangeHyperlink(start: number, end: number): RuntimeHyperlinkTarget | null | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeHyperlinkForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeHyperlink(start: number, end: number, value: RuntimeHyperlinkTarget | null): void {
    this.setTextRange(start, end, { hyperlink: canonicalHyperlink(value) });
  }

  getRangeFontWeight(start: number, end: number): number | typeof RUNTIME_MIXED {
    return this.rangeStyleValue(start, end, "fontWeight", 400);
  }

  getRangeLetterSpacing(start: number, end: number): RuntimeLetterSpacing | typeof RUNTIME_MIXED {
    const value = this.rangeStyleValue(start, end, "letterSpacing", 0);
    return value === RUNTIME_MIXED ? value : { value, unit: "PIXELS" };
  }

  setRangeLetterSpacing(start: number, end: number, value: RuntimeLetterSpacing): void {
    if (value?.unit !== "PIXELS" || !Number.isFinite(value.value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { letterSpacing: value.value });
  }

  getRangeFills(start: number, end: number): readonly RuntimePaint[] | typeof RUNTIME_MIXED {
    return this.rangeFills(start, end);
  }

  setRangeFills(start: number, end: number, value: readonly RuntimePaint[]): void {
    const fillStack = documentPaintStackFromRuntime(value, (hash) => this.host.hasImageHash(hash));
    this.setTextRange(start, end, { color: undefined, fillStack, paintStyleId: undefined });
  }

  private setTextRange(start: number, end: number, patch: RuntimeTextStylePatch): void {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const properties = node.textProperties as DocumentTextProperties | undefined;
    const replacesFont = Object.prototype.hasOwnProperty.call(patch, "font");
    if (start === end) {
      const next = patchRuntimeTextRange(text, properties, start, end, patch, SHAPE_WITH_TEXT_DEFAULTS);
      if (text.length === 0) {
        this.host.assertFontsLoaded(replacesFont
          ? patch.font ? [patch.font] : []
          : fontsForRuntimeTextRange(text, next, start, end));
        this.write({ textProperties: next });
      }
      return;
    }
    this.host.assertFontsLoaded(replacesFont
      ? patch.font ? [patch.font] : []
      : fontsForRuntimeTextRange(text, properties, start, end));
    this.write({ textProperties: patchRuntimeTextRange(text, properties, start, end, patch, SHAPE_WITH_TEXT_DEFAULTS) });
  }

  private applyTextStyleRange(start: number, end: number, styleId: string): void {
    if (typeof styleId !== "string" || styleId.includes("\0") || new TextEncoder().encode(styleId).byteLength > 2_048) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    if (text.length > 0 && start === end) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    runtimeTextRange(text, start, end);
    const resource = styleId ? this.host.textStyleResource(styleId) : undefined;
    if (resource?.style.font) this.host.assertFontsLoaded([resource.style.font]);
    this.write({
      textProperties: applyRuntimeTextStyleRange(
        text,
        node.textProperties as DocumentTextProperties | undefined,
        start,
        end,
        styleId,
        resource,
        SHAPE_WITH_TEXT_DEFAULTS,
      ),
    });
  }

  private applyPaintStyleRange(start: number, end: number, styleId: string): void {
    if (typeof styleId !== "string" || styleId.includes("\0") || new TextEncoder().encode(styleId).byteLength > 2_048) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    if (text.length > 0 && start === end) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    runtimeTextRange(text, start, end);
    const resource = styleId ? this.host.paintStyleResource(styleId) : undefined;
    if (styleId && (!resource || resource.id !== styleId)) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, styleId
      ? { color: undefined, fillStack: structuredClone(resource!.paints), paintStyleId: styleId }
      : { paintStyleId: undefined });
  }

  private replaceCharacters(start: number, end: number, replacement: string, insertionStyle: RuntimeTextInsertionStyle = "BEFORE"): void {
    if (typeof replacement !== "string") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const node = this.read();
    const before = typeof node.characters === "string" ? node.characters : "";
    const properties = node.textProperties as DocumentTextProperties | undefined;
    if (start === end && replacement.length === 0) {
      replaceRuntimeTextRangeWithStyles(before, properties, start, end, replacement, { defaults: SHAPE_WITH_TEXT_DEFAULTS, insertionStyle });
      return;
    }
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(before, properties, start, end, insertionStyle));
    this.write(replaceRuntimeTextRangeWithStyles(before, properties, start, end, replacement, { defaults: SHAPE_WITH_TEXT_DEFAULTS, insertionStyle }));
  }

  private rangeStyleValue<K extends "fontSize" | "fontWeight" | "letterSpacing">(
    start: number,
    end: number,
    property: K,
    fallback: DocumentTextProperties["runs"][number][K],
  ): DocumentTextProperties["runs"][number][K] | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const range = runtimeTextRange(text, start, end);
    const properties = node.textProperties as DocumentTextProperties | undefined;
    const runs = properties?.runs ?? [];
    const matching = range.start === range.end
      ? (() => {
        const containing = runs.find((run) => run.start <= range.start && range.start < run.end);
        if (containing) return [containing];
        const preceding = [...runs].reverse().find((run) => run.end === range.start);
        return preceding ? [preceding] : runs.length ? [runs[0]!] : [];
      })()
      : runs.filter((run) => run.start < range.end && run.end > range.start);
    const values = new Set(matching.map((run) => run[property]));
    if (values.size > 1) return RUNTIME_MIXED;
    return values.values().next().value ?? properties?.baseStyle?.[property] ?? fallback;
  }

  private rangeFills(start: number, end: number): readonly RuntimePaint[] | typeof RUNTIME_MIXED {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextFillsForRange(
      text,
      node.textProperties as DocumentTextProperties | undefined,
      start,
      end,
      SHAPE_WITH_TEXT_DEFAULT_FILLS,
    );
  }

  private textProperties(): DocumentTextProperties {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return updateRuntimeText(
      text,
      text,
      node.textProperties as DocumentTextProperties | undefined,
      SHAPE_WITH_TEXT_DEFAULTS,
    ).textProperties;
  }

  private assertTextRange(start: number, end: number): void {
    runtimeTextRange(this.characters, start, end);
  }

  private writeParagraph(patch: Partial<DocumentTextProperties["paragraph"]>, requireFonts = true): void {
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const properties = this.textProperties();
    if (requireFonts) this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, properties));
    this.write({
      textProperties: {
        ...properties,
        paragraph: { ...properties.paragraph, ...patch },
      },
    });
  }

  private read(): RuntimeProjectionNode {
    this.host.assertOpen();
    const node = this.host.readNode(this.handle);
    if (!node || !this.host.isCurrent(this.handle) || node.removed === true || node.type !== "SHAPE_WITH_TEXT") {
      throw runtimeError("NODE_REMOVED", { nodeId: this.handle.nodeId });
    }
    return node;
  }

  private write(patch: Readonly<Record<string, unknown>>): void {
    this.read();
    this.host.enqueueUpdate(this.handle.nodeId, patch);
  }
}

/** Figma-compatible common-property proxy. It deliberately reads the session's
 * composed projection for every getter instead of storing a mutable node copy. */
export class RuntimeNodeProxy {
  private textSublayerProxy?: RuntimeTextSublayerProxy;

  constructor(
    readonly handle: RuntimeNodeHandle,
    protected readonly host: RuntimeNodeHost,
    private readonly nodeType: M1NodeType,
  ) {}

  get id(): string {
    this.host.assertOpen();
    return this.handle.nodeId;
  }

  get type(): M1NodeType {
    this.host.assertOpen();
    return this.nodeType;
  }

  get removed(): boolean {
    this.host.assertOpen();
    return !this.host.isCurrent(this.handle) || this.host.readNode(this.handle)?.removed === true || this.host.readNode(this.handle) === undefined;
  }

  get name(): string { return this.string("name"); }
  set name(value: string) {
    if (!value.trim()) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ name: value });
  }

  get x(): number { return this.number("x"); }
  set x(value: number) { this.writeFinite("x", value); }
  get y(): number { return this.number("y"); }
  set y(value: number) { this.writeFinite("y", value); }
  get width(): number { return this.number("width"); }
  get height(): number { return this.number("height"); }
  get rotation(): number { return this.number("rotation"); }
  set rotation(value: number) { this.writeFinite("rotation", value); }
  get opacity(): number { return this.number("opacity"); }
  set opacity(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeUnboundVariableField("opacity", { opacity: value });
  }
  get visible(): boolean { return this.read().visible !== false; }
  set visible(value: boolean) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeUnboundVariableField("visible", { visible: value });
  }
  get boundVariables(): Readonly<Record<string, Readonly<{ type: "VARIABLE_ALIAS"; id: string }> | readonly Readonly<{ type: "VARIABLE_ALIAS"; id: string }>[]>> | undefined {
    const node = this.read();
    const aliases: Record<string, Readonly<{ type: "VARIABLE_ALIAS"; id: string }> | readonly Readonly<{ type: "VARIABLE_ALIAS"; id: string }>[]> = { ...variableAliases(variableBindingsFromExtensions(node.extensions)) };
    const paintBindings = variablePaintBindingsFromExtensions(node.extensions);
    for (const usage of ["fill", "stroke"] as const) {
      const values = Object.entries(paintBindings)
        .flatMap(([key, id]) => key.startsWith(`${usage}:`) && Number.isInteger(Number(key.slice(usage.length + 1))) ? [{ index: Number(key.slice(usage.length + 1)), id }] : [])
        .sort((a, b) => a.index - b.index)
        .map(({ id }) => Object.freeze({ type: "VARIABLE_ALIAS" as const, id }));
      if (values.length) aliases[`${usage}s`] = Object.freeze(values);
    }
    const effectValues = Object.entries(variableEffectBindingsFromExtensions(node.extensions))
      .flatMap(([key, id]) => {
        const match = /^effect:(\d+):(color|radius|spread|offsetX|offsetY)$/.exec(key);
        return match ? [{ index: Number(match[1]), field: match[2]!, id }] : [];
      })
      .sort((a, b) => a.index - b.index || a.field.localeCompare(b.field))
      .map(({ id }) => Object.freeze({ type: "VARIABLE_ALIAS" as const, id }));
    if (effectValues.length) aliases.effects = Object.freeze(effectValues);
    return Object.keys(aliases).length ? Object.freeze(aliases) : undefined;
  }
  setBoundVariable(field: RuntimeVariableBindableNodeField, variable: RuntimeVariable | string | null): void {
    if (!isRuntimeVariableBindableNodeField(field)) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    if (typeof variable === "string") this.host.assertSynchronousDocumentAccess();
    const node = this.read();
    const bindings = { ...variableBindingsFromExtensions(node.extensions) };
    if (variable === null) {
      if (field === "cornerRadius") {
        this.assertCornerProperties();
        delete bindings.cornerRadius;
        delete bindings.topLeftRadius;
        delete bindings.topRightRadius;
        delete bindings.bottomRightRadius;
        delete bindings.bottomLeftRadius;
      } else {
        if (isRuntimeCornerField(field)) this.assertCornerProperties();
        delete bindings[field];
      }
      this.write({ extensions: extensionsWithVariableMap(node.extensions, VARIABLE_BINDINGS_EXTENSION, bindings) });
      return;
    }
    const variableId = typeof variable === "string" ? variable : variable?.id;
    if (!variableId || !this.host.variableResource(variableId)) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: this.handle.nodeId });
    const resolved = this.host.resolveVariableValue(variableId, this.id);
    const patch = this.variableFieldPatch(field, resolved.value, resolved.resolvedType);
    if (field === "cornerRadius") {
      delete bindings.cornerRadius;
      bindings.topLeftRadius = variableId;
      bindings.topRightRadius = variableId;
      bindings.bottomRightRadius = variableId;
      bindings.bottomLeftRadius = variableId;
    } else if (isRuntimeCornerField(field)) {
      delete bindings.cornerRadius;
      bindings[field] = variableId;
    } else if (field === "strokeWeight") {
      delete bindings.strokeTopWeight;
      delete bindings.strokeRightWeight;
      delete bindings.strokeBottomWeight;
      delete bindings.strokeLeftWeight;
    } else if (isRuntimeStrokeSideField(field)) {
      delete bindings.strokeWeight;
    }
    if (field !== "cornerRadius" && !isRuntimeCornerField(field)) bindings[field] = variableId;
    this.write({ ...patch, extensions: extensionsWithVariableMap(node.extensions, VARIABLE_BINDINGS_EXTENSION, bindings) });
  }
  get explicitVariableModes(): Readonly<Record<string, string>> {
    if (this.type === "DOCUMENT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return this.host.explicitVariableModesForNode(this.id);
  }
  get resolvedVariableModes(): Readonly<Record<string, string>> {
    if (this.type === "DOCUMENT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return this.host.resolvedVariableModesForNode(this.id);
  }
  setExplicitVariableModeForCollection(collection: RuntimeVariableCollection | string, modeId: string): void {
    if (this.type === "DOCUMENT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    if (typeof collection === "string") this.host.assertSynchronousDocumentAccess();
    const collectionId = typeof collection === "string" ? collection : collection?.id;
    const resource = collectionId ? this.host.variableCollectionResource(collectionId) : undefined;
    if (!resource || typeof modeId !== "string" || !resource.modes.some((mode) => mode.modeId === modeId)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.applyExplicitVariableModes({ ...this.explicitVariableModes, [resource.id]: modeId });
  }
  clearExplicitVariableModeForCollection(collection: RuntimeVariableCollection | string): void {
    if (this.type === "DOCUMENT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    if (typeof collection === "string") this.host.assertSynchronousDocumentAccess();
    const collectionId = typeof collection === "string" ? collection : collection?.id;
    if (!collectionId || !this.host.variableCollectionResource(collectionId)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const modes = { ...this.explicitVariableModes };
    delete modes[collectionId];
    this.applyExplicitVariableModes(modes);
  }
  get isMask(): boolean {
    const kind = nodeKindFromExternalType(this.type as ExternalNodeType);
    if (!kind || !nodeCapabilities(kind).maskEligible) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return this.read().isMask === true;
  }
  set isMask(value: boolean) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const kind = nodeKindFromExternalType(this.type as ExternalNodeType);
    if (!kind || !nodeCapabilities(kind).maskEligible) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const booleanOperands = this.type === "BOOLEAN_OPERATION" ? this.host.childrenOf(this.id) : undefined;
    const isEmptyStructuralMask = (this.type === "GROUP" || this.type === "TRANSFORM_GROUP")
      && this.host.childrenOf(this.id).length === 0;
    const isInvalidBooleanMask = booleanOperands !== undefined
      && (booleanOperands.length < 2 || booleanOperands.some((operand) => operand.type !== "VECTOR" || operand.vectorPaths.length === 0));
    if (value && (isEmptyStructuralMask || isInvalidBooleanMask)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.write({ isMask: value });
  }
  get blendMode(): RuntimeNodeBlendMode {
    const node = this.read();
    const canonical = node.blendMode ?? "normal";
    const kind = nodeKindFromExternalType(this.type as ExternalNodeType);
    const value = canonical === "normal"
      && kind !== undefined
      && canContainChildren(kind)
      && !isolatesNormalBlend(node as unknown as Pick<CanvasNode, "blendMode" | "extensions">)
      ? "pass-through"
      : canonical;
    if (typeof value !== "string") throw runtimeError("INTERNAL_ERROR", { nodeId: this.handle.nodeId });
    return value.toUpperCase().replaceAll("-", "_") as RuntimeNodeBlendMode;
  }
  set blendMode(value: RuntimeNodeBlendMode) {
    if (this.type === "SLICE" || !NODE_BLEND_TO_CANONICAL[value]) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const blendMode = NODE_BLEND_TO_CANONICAL[value];
    const node = this.read();
    const kind = nodeKindFromExternalType(this.type as ExternalNodeType);
    const extensions = nodeBlendExtensionPatch(
      node.extensions as CanvasNode["extensions"],
      blendMode,
      kind !== undefined && canContainChildren(kind),
    );
    this.write({
      blendMode,
      ...(extensions ? { extensions } : {}),
    });
  }
  get effects(): readonly RuntimeEffect[] {
    this.assertEffectsSupported();
    return this.runtimeEffectsWithVariableBindings();
  }
  set effects(value: readonly RuntimeEffect[]) {
    this.assertEffectsSupported();
    this.writeNodeEffects(value);
  }
  get fills(): readonly RuntimePaint[] | typeof RUNTIME_MIXED {
    this.assertPaintsSupported("fill");
    if (this.type === "TEXT" || this.type === "TEXT_PATH") {
      return this.getRangeFills(0, this.characters.length);
    }
    return this.runtimePaintsWithVariableBindings("fill");
  }
  set fills(value: readonly RuntimePaint[]) {
    this.assertPaintsSupported("fill");
    if (this.type === "TEXT" || this.type === "TEXT_PATH") {
      this.setRangeFills(0, this.characters.length, value);
      return;
    }
    this.writeNodePaints("fill", value);
  }
  get fillStyleId(): string | typeof RUNTIME_MIXED {
    this.assertPaintsSupported("fill");
    if (this.type === "TEXT" || this.type === "TEXT_PATH") {
      return this.getRangeFillStyleId(0, this.characters.length);
    }
    return typeof this.read().fillStyleId === "string" ? this.read().fillStyleId as string : "";
  }
  set fillStyleId(value: string | typeof RUNTIME_MIXED) {
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.host.assertSynchronousDocumentAccess();
    if (this.type === "TEXT" || this.type === "TEXT_PATH") {
      this.applyTextPaintStyleRange(0, this.characters.length, value);
    } else {
      this.applyPaintStyle("fill", value);
    }
  }
  async setFillStyleIdAsync(styleId: string): Promise<void> {
    if (this.type === "TEXT" || this.type === "TEXT_PATH") {
      this.applyTextPaintStyleRange(0, this.characters.length, styleId);
    } else {
      this.applyPaintStyle("fill", styleId);
    }
    await this.host.commitAsync();
  }
  get strokes(): readonly RuntimePaint[] {
    this.assertPaintsSupported("stroke");
    return this.runtimePaintsWithVariableBindings("stroke");
  }
  set strokes(value: readonly RuntimePaint[]) {
    this.assertPaintsSupported("stroke");
    this.writeNodePaints("stroke", value);
  }
  get strokeStyleId(): string {
    this.assertPaintsSupported("stroke");
    return typeof this.read().strokeStyleId === "string" ? this.read().strokeStyleId as string : "";
  }
  set strokeStyleId(value: string) {
    this.host.assertSynchronousDocumentAccess();
    this.applyPaintStyle("stroke", value);
  }
  async setStrokeStyleIdAsync(styleId: string): Promise<void> {
    this.applyPaintStyle("stroke", styleId);
    await this.host.commitAsync();
  }
  get backgroundStyleId(): string {
    this.assertBackgroundStyleSupported();
    const node = this.read();
    return typeof node.backgroundStyleId === "string"
      ? node.backgroundStyleId
      : typeof node.fillStyleId === "string" ? node.fillStyleId : "";
  }
  set backgroundStyleId(value: string) {
    this.host.assertSynchronousDocumentAccess();
    this.applyPaintStyle("background", value);
  }
  get parent(): RuntimeNodeProxy | null {
    const parentId = this.read().parentId;
    return typeof parentId === "string" ? this.host.proxyFor(parentId) : null;
  }

  get constraints(): RuntimeConstraints {
    this.assertConstraintsSupported();
    const constraints = this.read().constraints as DocumentConstraints | undefined;
    return {
      horizontal: runtimeConstraint(constraints?.horizontal ?? "min"),
      vertical: runtimeConstraint(constraints?.vertical ?? "min"),
    };
  }
  set constraints(value: RuntimeConstraints) {
    this.assertConstraintsSupported();
    const horizontal = canonicalConstraint(value?.horizontal);
    const vertical = canonicalConstraint(value?.vertical);
    if (!horizontal || !vertical) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ constraints: { horizontal, vertical } satisfies DocumentConstraints });
  }

  /** Exact PublishableMixin subset carried by Canonical Component metadata. */
  get key(): string { return this.publishableMetadata().key; }
  get remote(): boolean { return this.publishableMetadata().remote; }
  get description(): string { return this.publishableMetadata().description; }
  get descriptionMarkdown(): string { return this.publishableMetadata().descriptionMarkdown; }
  get documentationLinks(): ReadonlyArray<{ uri: string; name?: string }> {
    return structuredClone(this.publishableMetadata().documentationLinks);
  }

  /** ComponentSet's deprecated Figma-compatible variant summary remains useful
   * because it is the exact REST representation preserved by Canonical. */
  get variantGroupProperties(): Readonly<Record<string, { values: string[] }>> {
    if (this.type !== "COMPONENT_SET") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return structuredClone(this.componentSetMetadata().variantGroupProperties);
  }

  get componentPropertyDefinitions(): DocumentComponentMetadata["componentPropertyDefinitions"] {
    if (this.type !== "COMPONENT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return structuredClone(this.componentMetadata().componentPropertyDefinitions);
  }

  /** Canonical currently stores the exact values but not every Figma property
   * descriptor, so expose values explicitly instead of guessing API types. */
  get componentPropertyValues(): Readonly<Record<string, string | boolean>> {
    return structuredClone(this.instanceMetadata().componentProperties);
  }

  get overrides(): DocumentInstanceMetadata["overrides"] {
    return structuredClone(this.instanceMetadata().overrides);
  }

  get scaleFactor(): number { return this.instanceMetadata().scaleFactor; }
  get isExposedInstance(): boolean { return this.instanceMetadata().isExposedInstance; }

  get pointCount(): number {
    if (this.type !== "POLYGON" && this.type !== "STAR") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const shape = this.read().parametricShape;
    if (!shape || typeof shape !== "object" || !("pointCount" in shape) || !Number.isInteger(shape.pointCount)) {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    }
    return shape.pointCount as number;
  }
  set pointCount(value: number) {
    if ((this.type !== "POLYGON" && this.type !== "STAR") || !Number.isInteger(value) || value < 3 || value > 100) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const current = this.read().parametricShape;
    this.write(this.type === "POLYGON"
      ? { parametricShape: { kind: "polygon", pointCount: value } }
      : { parametricShape: { kind: "star", pointCount: value, innerRatio: starInnerRatio(current) } });
  }

  get innerRadius(): number {
    if (this.type !== "STAR") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return starInnerRatio(this.read().parametricShape);
  }

  get booleanOperation(): RuntimeBooleanOperation {
    if (this.type !== "BOOLEAN_OPERATION") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return runtimeBooleanOperation(this.read().booleanOperation);
  }
  set booleanOperation(value: RuntimeBooleanOperation) {
    if (this.type !== "BOOLEAN_OPERATION") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const canonical = canonicalBooleanOperation(value);
    if (!canonical) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ booleanOperation: canonical });
  }
  set innerRadius(value: number) {
    if (this.type !== "STAR" || !Number.isFinite(value) || value < .05 || value > .95) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.write({ parametricShape: { kind: "star", pointCount: this.pointCount, innerRatio: value } });
  }

  get cornerRadius(): number | typeof RUNTIME_MIXED {
    const radii = this.cornerRadii();
    return radii.every((radius) => radius === radii[0]) ? radii[0] : RUNTIME_MIXED;
  }
  set cornerRadius(value: number) {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.assertCornerProperties();
    this.writeUnboundVariableFields(["cornerRadius", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"], {
      cornerRadius: value,
      cornerRadii: [value, value, value, value],
    });
  }
  get topLeftRadius(): number { return this.cornerRadii()[0]; }
  set topLeftRadius(value: number) { this.writeCornerRadius("topLeftRadius", 0, value); }
  get topRightRadius(): number { return this.cornerRadii()[1]; }
  set topRightRadius(value: number) { this.writeCornerRadius("topRightRadius", 1, value); }
  get bottomRightRadius(): number { return this.cornerRadii()[2]; }
  set bottomRightRadius(value: number) { this.writeCornerRadius("bottomRightRadius", 2, value); }
  get bottomLeftRadius(): number { return this.cornerRadii()[3]; }
  set bottomLeftRadius(value: number) { this.writeCornerRadius("bottomLeftRadius", 3, value); }

  get strokeWeight(): number | typeof RUNTIME_MIXED {
    this.assertGeometry();
    if ((this.type === "FRAME" || this.type === "RECTANGLE") && Array.isArray(this.read().strokeWeights)) {
      const weights = this.individualStrokeWeights();
      if (!weights.every((weight) => weight === weights[0])) return RUNTIME_MIXED;
      return weights[0];
    }
    return this.number("strokeWidth");
  }
  set strokeWeight(value: number) {
    this.assertGeometry();
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeUnboundVariableFields(["strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"], { strokeWidth: value, strokeWeights: undefined });
  }

  get strokeTopWeight(): number { return this.individualStrokeWeights()[0]; }
  set strokeTopWeight(value: number) { this.writeIndividualStrokeWeight("strokeTopWeight", 0, value); }
  get strokeRightWeight(): number { return this.individualStrokeWeights()[1]; }
  set strokeRightWeight(value: number) { this.writeIndividualStrokeWeight("strokeRightWeight", 1, value); }
  get strokeBottomWeight(): number { return this.individualStrokeWeights()[2]; }
  set strokeBottomWeight(value: number) { this.writeIndividualStrokeWeight("strokeBottomWeight", 2, value); }
  get strokeLeftWeight(): number { return this.individualStrokeWeights()[3]; }
  set strokeLeftWeight(value: number) { this.writeIndividualStrokeWeight("strokeLeftWeight", 3, value); }

  get strokeCap(): RuntimeStrokeCapValue {
    this.assertGeometry();
    const node = this.read();
    const start = strokeCapFromCanonical(node.strokeCapStart);
    const end = strokeCapFromCanonical(node.strokeCapEnd);
    if (start !== end) return RUNTIME_MIXED;
    return start;
  }
  set strokeCap(value: RuntimeStrokeCap) {
    this.assertGeometry();
    const canonical = canonicalStrokeCap(value);
    if (!canonical) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ strokeCapStart: canonical, strokeCapEnd: canonical });
  }

  get strokeJoin(): RuntimeStrokeJoin {
    this.assertGeometry();
    return strokeJoinFromCanonical(this.read().strokeJoin);
  }
  set strokeJoin(value: RuntimeStrokeJoin) {
    this.assertGeometry();
    const canonical = canonicalStrokeJoin(value);
    if (!canonical) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ strokeJoin: canonical });
  }

  get strokeMiterLimit(): number {
    this.assertGeometry();
    const value = this.read().strokeMiterLimit;
    return typeof value === "number" ? value : 10;
  }
  set strokeMiterLimit(value: number) {
    this.assertGeometry();
    if (!Number.isFinite(value) || value < 1) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ strokeMiterLimit: value });
  }

  get dashPattern(): readonly number[] {
    this.assertGeometry();
    const value = this.read().strokeDashPattern;
    return Array.isArray(value) ? value.filter((segment): segment is number => typeof segment === "number") : [];
  }
  set dashPattern(value: readonly number[]) {
    this.assertGeometry();
    if (!Array.isArray(value) || value.some((segment) => !Number.isFinite(segment) || segment < 0) || (value.length > 0 && value.every((segment) => segment === 0))) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const canonical = value.length % 2 === 1 ? [...value, ...value] : [...value];
    if (canonical.length > 32) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ strokeDashPattern: canonical });
  }

  get vectorPaths(): readonly RuntimeVectorPath[] {
    if (this.type !== "VECTOR") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const path = this.read().vectorPath as DocumentVectorPath | undefined;
    if (!path) return [];
    return [{
      windingRule: path.subpaths.every((subpath) => !subpath.closed) ? "NONE" : path.fillRule === "evenOdd" ? "EVENODD" : "NONZERO",
      data: vectorPathSvgD(path),
    }];
  }
  set vectorPaths(value: readonly RuntimeVectorPath[]) {
    if (this.type !== "VECTOR" || !Array.isArray(value) || value.some((path) => !path || typeof path.data !== "string" || !["NONZERO", "EVENODD", "NONE"].includes(path.windingRule))) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const parsed = parseFigmaSvgPaths(
      value.map((path) => ({ path: path.data, windingRule: path.windingRule === "NONE" ? "NONZERO" : path.windingRule })),
      () => this.host.allocateRuntimeId(),
    );
    if ("reason" in parsed) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ vectorPath: parsed.path });
  }

  get vectorNetwork(): RuntimeVectorNetwork {
    if (this.type !== "VECTOR") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const node = this.read();
    const path = node.vectorPath as DocumentVectorPath | undefined;
    return runtimeVectorNetworkFromCanonical(
      path ?? { fillRule: "nonZero", subpaths: [] },
      canonicalStrokeCapValue(node.strokeCapStart),
      canonicalStrokeCapValue(node.strokeCapEnd),
    );
  }

  async setVectorNetworkAsync(value: RuntimeVectorNetwork): Promise<void> {
    if (this.type !== "VECTOR") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const node = this.read();
    const converted = canonicalVectorPathFromRuntimeNetwork(value, () => this.host.allocateRuntimeId(), {
      strokeCapStart: canonicalStrokeCapValue(node.strokeCapStart),
      strokeCapEnd: canonicalStrokeCapValue(node.strokeCapEnd),
      strokeJoin: canonicalStrokeJoinValue(node.strokeJoin),
    });
    if ("reason" in converted) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({
      vectorPath: converted.path,
      strokeCapStart: converted.strokeCapStart,
      strokeCapEnd: converted.strokeCapEnd,
      ...(converted.strokeJoin ? { strokeJoin: converted.strokeJoin } : {}),
    });
    await this.host.commitAsync();
  }

  async getMainComponentAsync(): Promise<RuntimeNodeProxy | null> {
    const main = await this.host.getNodeByIdAsync(this.instanceMetadata().mainComponentId);
    return main?.type === "COMPONENT" ? main : null;
  }

  getInstancesAsync(): Promise<readonly RuntimeNodeProxy[]> {
    if (this.type !== "COMPONENT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return this.host.getInstancesOfComponentAsync(this.handle.nodeId);
  }

  removeOverrides(): void {
    const metadata = this.instanceMetadata();
    this.write({ instanceMetadata: { ...structuredClone(metadata), overrides: [] } });
  }

  get characters(): string {
    this.assertTextCharacters();
    const value = this.read().characters;
    return typeof value === "string" ? value : "";
  }

  get text(): RuntimeTextSublayerProxy {
    if (this.type !== "SHAPE_WITH_TEXT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    this.assertLive();
    return this.textSublayerProxy ??= new RuntimeTextSublayerProxy(this.handle, this.host);
  }

  get connectorLineType(): DocumentConnectorMetadata["lineType"] {
    return this.connectorMetadata().lineType;
  }
  set connectorLineType(value: DocumentConnectorMetadata["lineType"]) {
    if (value !== "ELBOWED" && value !== "STRAIGHT" && value !== "CURVED") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeConnectorMetadata({ lineType: value });
  }

  get connectorStart(): FigmaConnectorEndpoint { return projectFigmaConnectorEndpoint(this.connectorMetadata().start); }
  set connectorStart(value: FigmaConnectorEndpoint) {
    const endpoint = canonicalConnectorEndpoint(value, this.connectorMetadata().start);
    if (!endpoint) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeConnectorMetadata({ start: endpoint });
  }

  get connectorEnd(): FigmaConnectorEndpoint { return projectFigmaConnectorEndpoint(this.connectorMetadata().end); }
  set connectorEnd(value: FigmaConnectorEndpoint) {
    const endpoint = canonicalConnectorEndpoint(value, this.connectorMetadata().end);
    if (!endpoint) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeConnectorMetadata({ end: endpoint });
  }

  get connectorStartStrokeCap(): FigmaConnectorStrokeCap {
    const value = this.connectorMetadata().startStrokeCap;
    return isFigmaConnectorStrokeCap(value) ? value : "NONE";
  }
  set connectorStartStrokeCap(value: FigmaConnectorStrokeCap) {
    if (!validConnectorCap(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeConnectorMetadata({ startStrokeCap: value });
  }

  get connectorEndStrokeCap(): FigmaConnectorStrokeCap {
    const value = this.connectorMetadata().endStrokeCap;
    return isFigmaConnectorStrokeCap(value) ? value : "NONE";
  }
  set connectorEndStrokeCap(value: FigmaConnectorStrokeCap) {
    if (!validConnectorCap(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeConnectorMetadata({ endStrokeCap: value });
  }

  get connectorText(): string { return this.connectorMetadata().text; }
  set connectorText(value: string) {
    if (typeof value !== "string") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeConnectorMetadata({ text: value });
  }

  reconnect(start: FigmaConnectorEndpoint, end: FigmaConnectorEndpoint): void {
    const metadata = this.connectorMetadata();
    const nextStart = canonicalConnectorEndpoint(start, metadata.start);
    const nextEnd = canonicalConnectorEndpoint(end, metadata.end);
    if (!nextStart || !nextEnd) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeConnectorMetadata({ start: nextStart, end: nextEnd });
  }

  get shapeType(): ShapeWithTextType {
    if (this.type !== "SHAPE_WITH_TEXT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const value = this.read().shapeWithTextType;
    return isShapeWithTextType(value) ? value : "ROUNDED_RECTANGLE";
  }
  set shapeType(value: ShapeWithTextType) {
    if (this.type !== "SHAPE_WITH_TEXT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    if (!isShapeWithTextType(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ shapeWithTextType: value });
  }

  get textPathStartData(): Readonly<{ segment: number; position: number }> {
    const metadata = this.textPathMetadata();
    return { segment: metadata.startSegment, position: metadata.startPosition };
  }

  get textAlignHorizontal(): DocumentTextPathMetadata["textAlignHorizontal"] { return this.textPathMetadata().textAlignHorizontal; }
  set textAlignHorizontal(value: DocumentTextPathMetadata["textAlignHorizontal"]) {
    if (!["LEFT", "CENTER", "RIGHT", "JUSTIFIED"].includes(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeTextPathMetadata({ textAlignHorizontal: value });
  }

  get textAlignVertical(): DocumentTextPathMetadata["textAlignVertical"] { return this.textPathMetadata().textAlignVertical; }
  set textAlignVertical(value: DocumentTextPathMetadata["textAlignVertical"]) {
    if (!["TOP", "CENTER", "BOTTOM"].includes(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeTextPathMetadata({ textAlignVertical: value });
  }

  get autoRename(): boolean { return this.textPathMetadata().autoRename; }
  set autoRename(value: boolean) {
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeTextPathMetadata({ autoRename: value });
  }

  get transformModifiers(): readonly DocumentTransformModifier[] {
    if (this.type !== "TRANSFORM_GROUP") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const value = this.read().transformModifiers;
    if (!isBoundedTransformModifierStack(value)) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return structuredClone(value);
  }
  set transformModifiers(value: readonly DocumentTransformModifier[]) {
    if (this.type !== "TRANSFORM_GROUP") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    if (!isBoundedTransformModifierStack(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ transformModifiers: structuredClone(value) });
  }
  set characters(value: string) {
    this.assertTextCharacters();
    if (this.type === "SHAPE_WITH_TEXT") {
      this.text.characters = value;
      return;
    }
    if (this.type !== "TEXT" && this.type !== "TEXT_PATH") {
      if (typeof value !== "string") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const patch: Record<string, unknown> = { characters: value };
      this.write(patch);
      return;
    }
    const node = this.read();
    const before = typeof node.characters === "string" ? node.characters : "";
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(before, node.textProperties as never));
    const next = updateRuntimeText(before, value, node.textProperties as never);
    this.writeUnboundVariableField("characters", this.type === "TEXT_PATH" && this.textPathMetadata().autoRename
      ? { ...next, name: value || "Text path" }
      : next);
  }

  get hasMissingFont(): boolean {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextHasMissingFont(this.host, text, node.textProperties as DocumentTextProperties | undefined);
  }

  get fontName(): RuntimeFontName | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeFontName(0, this.characters.length);
  }

  set fontName(value: RuntimeFontName | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeFontName(0, this.characters.length, value);
  }

  get fontSize(): number | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeFontSize(0, this.characters.length);
  }

  set fontSize(value: number | typeof RUNTIME_MIXED) {
    this.assertText();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.setRangeFontSize(0, this.characters.length, value);
  }

  get fontWeight(): number | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeFontWeight(0, this.characters.length);
  }

  get openTypeFeatures(): Readonly<Record<string, boolean>> | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeOpenTypeFeatures(0, this.characters.length);
  }

  get textStyleId(): string | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextStyleId(0, this.characters.length);
  }

  set textStyleId(value: string | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.host.assertSynchronousDocumentAccess();
    this.applyTextStyleRange(0, this.characters.length, value);
  }

  async setTextStyleIdAsync(styleId: string): Promise<void> {
    this.assertText();
    this.applyTextStyleRange(0, this.characters.length, styleId);
    await this.host.commitAsync();
  }

  get letterSpacing(): RuntimeLetterSpacing | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeLetterSpacing(0, this.characters.length);
  }

  set letterSpacing(value: RuntimeLetterSpacing | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeLetterSpacing(0, this.characters.length, value);
  }

  get textCase(): RuntimeTextCase | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextCase(0, this.characters.length);
  }

  set textCase(value: RuntimeTextCase | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === RUNTIME_MIXED || !isRuntimeTextCase(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextCase(0, this.characters.length, value);
  }

  get textDecoration(): RuntimeTextDecoration | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextDecoration(0, this.characters.length);
  }

  set textDecoration(value: RuntimeTextDecoration | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecoration(0, this.characters.length, value);
  }

  get textDecorationStyle(): RuntimeTextDecorationStyle | null | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextDecorationStyle(0, this.characters.length);
  }

  set textDecorationStyle(value: RuntimeTextDecorationStyle | null | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationStyle(0, this.characters.length, value);
  }

  get textDecorationOffset(): RuntimeTextDecorationOffset | null | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextDecorationOffset(0, this.characters.length);
  }

  set textDecorationOffset(value: RuntimeTextDecorationOffset | null | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationOffset(0, this.characters.length, value);
  }

  get textDecorationThickness(): RuntimeTextDecorationThickness | null | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextDecorationThickness(0, this.characters.length);
  }

  set textDecorationThickness(value: RuntimeTextDecorationThickness | null | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationThickness(0, this.characters.length, value);
  }

  get textDecorationColor(): RuntimeTextDecorationColor | null | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextDecorationColor(0, this.characters.length);
  }

  set textDecorationColor(value: RuntimeTextDecorationColor | null | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === null || value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationColor(0, this.characters.length, value);
  }

  get textDecorationSkipInk(): boolean | null | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeTextDecorationSkipInk(0, this.characters.length);
  }

  set textDecorationSkipInk(value: boolean | null | typeof RUNTIME_MIXED) {
    this.assertText();
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeTextDecorationSkipInk(0, this.characters.length, value);
  }

  get leadingTrim(): RuntimeLeadingTrim | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    return runtimeLeadingTrimForRange(this.characters, node.textProperties as DocumentTextProperties | undefined);
  }

  set leadingTrim(value: RuntimeLeadingTrim | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value !== "CAP_HEIGHT" && value !== "NONE") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(0, this.characters.length, { leadingTrim: value === "CAP_HEIGHT" ? "capHeight" : undefined });
  }

  get hyperlink(): RuntimeHyperlinkTarget | null | typeof RUNTIME_MIXED {
    this.assertText();
    return this.getRangeHyperlink(0, this.characters.length);
  }

  set hyperlink(value: RuntimeHyperlinkTarget | null | typeof RUNTIME_MIXED) {
    this.assertText();
    if (value === RUNTIME_MIXED) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setRangeHyperlink(0, this.characters.length, value);
  }

  get textAutoResize(): RuntimeTextAutoResize {
    this.assertText();
    const value = (this.read().textProperties as DocumentTextProperties | undefined)?.autoSize ?? "fixed";
    return value === "height" ? "HEIGHT" : value === "widthAndHeight" ? "WIDTH_AND_HEIGHT" : "NONE";
  }
  set textAutoResize(value: RuntimeTextAutoResize) {
    this.assertText();
    if (!["NONE", "HEIGHT", "WIDTH_AND_HEIGHT"].includes(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const current = node.textProperties as DocumentTextProperties | undefined;
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, current));
    const properties = updateRuntimeText(text, text, current).textProperties;
    this.write({ textProperties: { ...properties, autoSize: value === "HEIGHT" ? "height" : value === "WIDTH_AND_HEIGHT" ? "widthAndHeight" : "fixed" } });
  }

  get textTruncation(): RuntimeTextTruncation {
    this.assertText();
    return (this.read().textProperties as DocumentTextProperties | undefined)?.textTruncation === "ending" ? "ENDING" : "DISABLED";
  }
  set textTruncation(value: RuntimeTextTruncation) {
    this.assertText();
    if (value !== "DISABLED" && value !== "ENDING") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const current = node.textProperties as DocumentTextProperties | undefined;
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, current));
    const properties = updateRuntimeText(text, text, current).textProperties;
    this.write({ textProperties: {
      ...properties,
      textTruncation: value === "ENDING" ? "ending" : "disabled",
      ...(value === "DISABLED" ? { maxLines: undefined } : {}),
    } });
  }

  get maxLines(): number | null {
    this.assertText();
    return (this.read().textProperties as DocumentTextProperties | undefined)?.maxLines ?? null;
  }
  set maxLines(value: number | null) {
    this.assertText();
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const current = node.textProperties as DocumentTextProperties | undefined;
    if (value !== null && current?.textTruncation !== "ending") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, current));
    const properties = updateRuntimeText(text, text, current).textProperties;
    this.write({ textProperties: { ...properties, maxLines: value ?? undefined } });
  }

  /** Applies a common Figma Text range property using UTF-16 API offsets. */
  getRangeFontSize(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertText();
    return runtimeStyleNumberForRange(
      this.characters,
      this.read().textProperties as DocumentTextProperties | undefined,
      start,
      end,
      "fontSize",
      31,
    );
  }

  setRangeFontSize(start: number, end: number, fontSize: number): void {
    if (!Number.isFinite(fontSize) || fontSize <= 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { fontSize });
  }

  getRangeFontWeight(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertText();
    return runtimeStyleNumberForRange(
      this.characters,
      this.read().textProperties as DocumentTextProperties | undefined,
      start,
      end,
      "fontWeight",
      400,
    );
  }

  getRangeOpenTypeFeatures(start: number, end: number): Readonly<Record<string, boolean>> | typeof RUNTIME_MIXED {
    this.assertText();
    runtimeTextRange(this.characters, start, end);
    return runtimeOpenTypeFeaturesForRange(
      this.characters,
      this.read().textProperties as DocumentTextProperties | undefined,
      start,
      end,
    );
  }

  getRangeTextStyleId(start: number, end: number): string | typeof RUNTIME_MIXED {
    this.assertText();
    runtimeTextRange(this.characters, start, end);
    return runtimeTextStyleIdForRange(
      this.characters,
      this.read().textProperties as DocumentTextProperties | undefined,
      start,
      end,
    );
  }

  setRangeTextStyleId(start: number, end: number, styleId: string): void {
    this.assertText();
    this.host.assertSynchronousDocumentAccess();
    this.applyTextStyleRange(start, end, styleId);
  }

  async setRangeTextStyleIdAsync(start: number, end: number, styleId: string): Promise<void> {
    this.assertText();
    this.applyTextStyleRange(start, end, styleId);
    await this.host.commitAsync();
  }

  getRangeFillStyleId(start: number, end: number): string | typeof RUNTIME_MIXED {
    this.assertText();
    runtimeTextRange(this.characters, start, end);
    return runtimePaintStyleIdForRange(
      this.characters,
      this.read().textProperties as DocumentTextProperties | undefined,
      start,
      end,
    );
  }

  setRangeFillStyleId(start: number, end: number, styleId: string): void {
    this.assertText();
    this.host.assertSynchronousDocumentAccess();
    this.applyTextPaintStyleRange(start, end, styleId);
  }

  async setRangeFillStyleIdAsync(start: number, end: number, styleId: string): Promise<void> {
    this.assertText();
    this.applyTextPaintStyleRange(start, end, styleId);
    await this.host.commitAsync();
  }

  getRangeLetterSpacing(start: number, end: number): RuntimeLetterSpacing | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const styles = runtimeTextStylesForRange(
      text,
      node.textProperties as DocumentTextProperties | undefined,
      start,
      end,
    );
    const value = styles[0]?.letterSpacing ?? 0;
    return styles.some((style) => style.letterSpacing !== value)
      ? RUNTIME_MIXED
      : { value, unit: "PIXELS" };
  }

  setRangeLetterSpacing(start: number, end: number, value: RuntimeLetterSpacing): void {
    this.assertText();
    if (value?.unit !== "PIXELS" || !Number.isFinite(value.value)
      || value.value < -10_000 || value.value > 10_000) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.setTextRange(start, end, { letterSpacing: value.value });
  }

  getRangeFontName(start: number, end: number): RuntimeFontName | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeFontNameForRange(this.host, text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  getRangeAllFontNames(start: number, end: number): readonly RuntimeFontName[] {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeFontNamesForRange(this.host, text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeFontName(start: number, end: number, value: RuntimeFontName): void {
    this.assertText();
    const font = this.host.resolveFontName(value);
    this.setTextRange(start, end, { font });
  }

  getRangeTextCase(start: number, end: number): RuntimeTextCase | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextCaseForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextCase(start: number, end: number, value: RuntimeTextCase): void {
    this.assertText();
    if (!isRuntimeTextCase(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { textCase: documentTextCase(value) });
  }

  getRangeTextDecoration(start: number, end: number): RuntimeTextDecoration | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecoration(start: number, end: number, value: RuntimeTextDecoration): void {
    this.assertText();
    this.setTextRange(start, end, { textDecoration: documentTextDecoration(value) });
  }

  getRangeTextDecorationStyle(start: number, end: number): RuntimeTextDecorationStyle | null | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationStyleForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationStyle(start: number, end: number, value: RuntimeTextDecorationStyle): void {
    this.assertText();
    this.setTextRange(start, end, { textDecorationStyle: documentTextDecorationStyle(value) });
  }

  getRangeTextDecorationOffset(start: number, end: number): RuntimeTextDecorationOffset | null | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationOffsetForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationOffset(start: number, end: number, value: RuntimeTextDecorationOffset): void {
    this.assertText();
    this.setTextRange(start, end, { textDecorationOffset: documentTextDecorationOffset(value) });
  }

  getRangeTextDecorationThickness(start: number, end: number): RuntimeTextDecorationThickness | null | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationThicknessForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationThickness(start: number, end: number, value: RuntimeTextDecorationThickness): void {
    this.assertText();
    this.setTextRange(start, end, { textDecorationThickness: documentTextDecorationThickness(value) });
  }

  getRangeTextDecorationColor(start: number, end: number): RuntimeTextDecorationColor | null | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationColorForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationColor(start: number, end: number, value: RuntimeTextDecorationColor): void {
    this.assertText();
    this.setTextRange(start, end, { textDecorationColor: documentTextDecorationColorFromRuntime(value) });
  }

  getRangeTextDecorationSkipInk(start: number, end: number): boolean | null | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextDecorationSkipInkForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeTextDecorationSkipInk(start: number, end: number, value: boolean): void {
    this.assertText();
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, { textDecorationSkipInk: value ? true : undefined });
  }

  getRangeListOptions(start: number, end: number): RuntimeTextListOptions | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    runtimeTextRange(this.characters, start, end);
    return runtimeListOptionsForRange(this.characters, this.currentTextProperties(), start, end);
  }

  setRangeListOptions(start: number, end: number, value: RuntimeTextListOptions): void {
    this.assertParagraphText();
    runtimeTextRange(this.characters, start, end);
    if (!value || !["ORDERED", "UNORDERED", "NONE"].includes(value.type)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({
      textProperties: patchRuntimeParagraphListType(
        text,
        this.currentTextProperties(),
        start,
        end,
        value.type === "ORDERED" ? "ordered" : value.type === "UNORDERED" ? "unordered" : undefined,
      ),
    });
  }

  get lineHeight(): RuntimeLineHeight | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphLineHeightsForRange(
      this.characters,
      this.currentTextProperties(),
      0,
      this.characters.length,
    );
    return values.every((value) => sameRuntimeLineHeight(value, values[0]!)) ? values[0]! : RUNTIME_MIXED;
  }

  set lineHeight(value: RuntimeLineHeight | typeof RUNTIME_MIXED) {
    this.assertParagraphText();
    if (value === RUNTIME_MIXED || !isRuntimeLineHeight(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    const properties = this.currentTextProperties();
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, properties));
    this.write({ textProperties: patchRuntimeParagraphLineHeight(text, properties, 0, text.length, value) });
  }

  getRangeLineHeight(start: number, end: number): RuntimeLineHeight | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphLineHeightsForRange(this.characters, this.currentTextProperties(), start, end);
    return values.every((value) => sameRuntimeLineHeight(value, values[0]!)) ? values[0]! : RUNTIME_MIXED;
  }

  setRangeLineHeight(start: number, end: number, value: RuntimeLineHeight): void {
    this.assertParagraphText();
    if (!isRuntimeLineHeight(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const text = this.characters;
    const properties = this.currentTextProperties();
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(text, properties, start, end));
    this.write({ textProperties: patchRuntimeParagraphLineHeight(text, properties, start, end, value) });
  }

  get paragraphSpacing(): number | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphSpacingsForRange(
      this.characters,
      this.currentTextProperties(),
      0,
      this.characters.length,
    );
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  set paragraphSpacing(value: number | typeof RUNTIME_MIXED) {
    this.assertParagraphText();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphSpacing(text, this.currentTextProperties(), 0, text.length, value) });
  }

  getRangeParagraphSpacing(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphSpacingsForRange(this.characters, this.currentTextProperties(), start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeParagraphSpacing(start: number, end: number, value: number): void {
    this.assertParagraphText();
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphSpacing(text, this.currentTextProperties(), start, end, value) });
  }

  get paragraphIndent(): number | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphIndentsForRange(
      this.characters,
      this.currentTextProperties(),
      0,
      this.characters.length,
    );
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  set paragraphIndent(value: number | typeof RUNTIME_MIXED) {
    this.assertParagraphText();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphIndent(text, this.currentTextProperties(), 0, text.length, value) });
  }

  getRangeParagraphIndent(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphIndentsForRange(this.characters, this.currentTextProperties(), start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeParagraphIndent(start: number, end: number, value: number): void {
    this.assertParagraphText();
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphIndent(text, this.currentTextProperties(), start, end, value) });
  }

  get textWrapStyle(): "AUTO" | "BALANCE" | "PRETTY" | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphTextWrapStylesForRange(
      this.characters,
      this.currentTextProperties(),
      0,
      this.characters.length,
    );
    return values.every((value) => value === values[0]) ? runtimeTextWrapStyle(values[0] ?? "auto") : RUNTIME_MIXED;
  }

  set textWrapStyle(value: "AUTO" | "BALANCE" | "PRETTY" | typeof RUNTIME_MIXED) {
    this.assertParagraphText();
    if (value !== "AUTO" && value !== "BALANCE" && value !== "PRETTY") {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphTextWrapStyle(text, this.currentTextProperties(), 0, text.length, documentTextWrapStyle(value)) });
  }

  getRangeTextWrapStyle(start: number, end: number): "AUTO" | "BALANCE" | "PRETTY" | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    runtimeTextRange(this.characters, start, end);
    const values = runtimeParagraphTextWrapStylesForRange(this.characters, this.currentTextProperties(), start, end);
    return values.every((value) => value === values[0]) ? runtimeTextWrapStyle(values[0] ?? "auto") : RUNTIME_MIXED;
  }

  setRangeTextWrapStyle(start: number, end: number, value: "AUTO" | "BALANCE" | "PRETTY"): void {
    this.assertParagraphText();
    runtimeTextRange(this.characters, start, end);
    if (value !== "AUTO" && value !== "BALANCE" && value !== "PRETTY") {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphTextWrapStyle(text, this.currentTextProperties(), start, end, documentTextWrapStyle(value)) });
  }

  get listSpacing(): number | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphListSpacingsForRange(
      this.characters,
      this.currentTextProperties(),
      0,
      this.characters.length,
    );
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  set listSpacing(value: number | typeof RUNTIME_MIXED) {
    this.assertParagraphText();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphListSpacing(text, this.currentTextProperties(), 0, text.length, value) });
  }

  get hangingList(): boolean | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    return this.currentTextProperties().paragraph.hangingList ?? false;
  }

  set hangingList(value: boolean | typeof RUNTIME_MIXED) {
    this.assertParagraphText();
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeTextParagraph({ hangingList: value ? true : undefined });
  }

  get hangingPunctuation(): boolean {
    this.assertParagraphText();
    return this.currentTextProperties().paragraph.hangingPunctuation ?? false;
  }

  set hangingPunctuation(value: boolean) {
    this.assertParagraphText();
    if (typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeTextParagraph({ hangingPunctuation: value ? true : undefined });
  }

  getRangeListSpacing(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const values = runtimeParagraphListSpacingsForRange(this.characters, this.currentTextProperties(), start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeListSpacing(start: number, end: number, value: number): void {
    this.assertParagraphText();
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphListSpacing(text, this.currentTextProperties(), start, end, value) });
  }

  getRangeIndentation(start: number, end: number): number | typeof RUNTIME_MIXED {
    this.assertParagraphText();
    const properties = this.currentTextProperties();
    const values = runtimeParagraphIndentationsForRange(this.characters, properties, start, end);
    return values.every((value) => value === values[0]) ? (values[0] ?? 0) : RUNTIME_MIXED;
  }

  setRangeIndentation(start: number, end: number, value: number): void {
    this.assertParagraphText();
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    this.write({ textProperties: patchRuntimeParagraphIndentation(text, this.currentTextProperties(), start, end, value) });
  }

  getRangeHyperlink(start: number, end: number): RuntimeHyperlinkTarget | null | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeHyperlinkForRange(text, node.textProperties as DocumentTextProperties | undefined, start, end);
  }

  setRangeHyperlink(start: number, end: number, value: RuntimeHyperlinkTarget | null): void {
    this.assertText();
    this.setTextRange(start, end, { hyperlink: canonicalHyperlink(value) });
  }

  /** Runtime's asset-addressed equivalent of Figma's font-name range setter.
   * The AssetId is explicit because Canonical text never persists raw family
   * names or font bytes. */
  setRangeFontReference(start: number, end: number, font: DocumentFontReference): void {
    if (!font.assetId || !Number.isSafeInteger(font.faceIndex) || font.faceIndex < 0) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.setTextRange(start, end, { font: structuredClone(font) });
  }

  getRangeFills(start: number, end: number): readonly RuntimePaint[] | typeof RUNTIME_MIXED {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeTextFillsForRange(
      text,
      node.textProperties as DocumentTextProperties | undefined,
      start,
      end,
      runtimePaintsFromNode(node as Readonly<Record<string, unknown>>, "fill"),
    );
  }

  setRangeFills(start: number, end: number, value: readonly RuntimePaint[]): void {
    this.assertText();
    const fillStack = documentPaintStackFromRuntime(value, (hash) => this.host.hasImageHash(hash));
    this.setTextRange(start, end, { color: undefined, fillStack, paintStyleId: undefined });
  }

  getStyledTextSegments<Fields extends readonly RuntimeStyledTextSegmentField[]>(
    fields: Fields,
    start?: number,
    end?: number,
  ): Array<RuntimeStyledTextSegment<Fields>> {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return runtimeStyledTextSegments(
      text,
      node.textProperties as DocumentTextProperties | undefined,
      fields,
      runtimePaintsFromNode(node as Readonly<Record<string, unknown>>, "fill"),
      { fontSize: 31, fontWeight: 400, italic: false, letterSpacing: 0, lineHeight: 20 },
      start,
      end,
      (font) => this.host.fontNameForReference(font),
    );
  }

  insertCharacters(start: number, characters: string, useStyle: RuntimeTextInsertionStyle = "BEFORE"): void {
    if (useStyle !== "BEFORE" && useStyle !== "AFTER") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.replaceCharacters(start, start, characters, useStyle);
  }

  deleteCharacters(start: number, end: number): void {
    this.replaceCharacters(start, end, "");
  }

  setRangeCharacters(start: number, end: number, characters: string): void {
    this.replaceCharacters(start, end, characters);
  }

  /** Binds an admitted Runtime image to a paint-capable M2 node. The image
   * bytes are never copied into a PendingProjection or Canonical snapshot. */
  setImageAsset(image: RuntimeImage): void {
    if (!image.hash || this.type !== "IMAGE") {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    }
    this.write({ assetId: image.hash });
  }

  get imageHash(): string | null {
    const assetId = this.read().assetId;
    return typeof assetId === "string" ? assetId : null;
  }

  /** M3's ordered prototype reactions. Unsupported imported reactions are
   * omitted by the Core projection rather than claimed to be playable. */
  get reactions(): readonly PrototypeReaction[] {
    const reactions = this.read().reactions;
    return Array.isArray(reactions) ? validatePrototypeReactions(reactions as PrototypeReaction[]) : [];
  }

  /** Persists the complete reaction list as one Core transaction and resolves
   * only after its Ack + projection fence. */
  async setReactionsAsync(reactions: readonly PrototypeReaction[]): Promise<void> {
    this.assertLive();
    const known = new Set(reactions.flatMap((reaction) => reaction.actions.flatMap((action) => (action.type === "NODE" || action.type === "CHANGE_TO") && action.destinationId ? [action.destinationId] : [])));
    known.forEach((id) => { if (!this.host.hasLiveNode(id)) throw runtimeError("NODE_NOT_FOUND", { nodeId: id }); });
    const next = validatePrototypeReactions(reactions, known);
    this.write({ reactions: next });
    await this.host.commitAsync();
  }

  get prototypeMetadata(): PrototypeMetadata | undefined {
    return validatePrototypeMetadata(this.read().prototypeMetadata as PrototypeMetadata | undefined);
  }

  async setPrototypeMetadataAsync(metadata: PrototypeMetadata | undefined): Promise<void> {
    this.assertLive();
    if (this.type !== "FRAME") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    this.write({ prototypeMetadata: validatePrototypeMetadata(metadata) });
    await this.host.commitAsync();
  }

  /** W12-L's bounded Figma Auto Layout surface. GRID remains outside the
   * Runtime contract; setters reject combinations that Canonical cannot lay out. */
  get layoutMode(): RuntimeLayoutMode {
    const mode = this.autoLayout().mode;
    return mode === "horizontal" ? "HORIZONTAL" : mode === "vertical" ? "VERTICAL" : "NONE";
  }
  set layoutMode(value: RuntimeLayoutMode) {
    if (this.type !== "FRAME" || !["NONE", "HORIZONTAL", "VERTICAL"].includes(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const layout = this.autoLayout();
    if (value === "VERTICAL" && (layout.wrap || layout.counterAlignment === "baseline")) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ mode: value.toLowerCase() as RuntimeAutoLayout["mode"] });
  }

  get layoutWrap(): "NO_WRAP" | "WRAP" {
    this.assertActiveAutoLayoutFrame();
    return this.autoLayout().wrap ? "WRAP" : "NO_WRAP";
  }
  set layoutWrap(value: "NO_WRAP" | "WRAP") {
    this.assertActiveAutoLayoutFrame();
    const layout = this.autoLayout();
    const hasStretchFlowChild = value === "WRAP" && layout.counterSizing === "hug" && this.host.childrenOf(this.id).some((child) =>
      !child.autoLayout().absolute && child.readLayoutSizing(false) === "FILL");
    if (
      !["NO_WRAP", "WRAP"].includes(value) ||
      (value === "WRAP" && (
        this.layoutMode !== "HORIZONTAL" ||
        layout.primarySizing !== "fixed" ||
        layout.counterSizing === "fill" ||
        hasStretchFlowChild
      ))
    ) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ wrap: value === "WRAP" });
  }

  get primaryAxisSizingMode(): RuntimeAxisSizingMode {
    this.assertActiveAutoLayoutFrame();
    return this.autoLayout().primarySizing === "hug" ? "AUTO" : "FIXED";
  }
  set primaryAxisSizingMode(value: RuntimeAxisSizingMode) {
    this.assertActiveAutoLayoutFrame();
    if (!["FIXED", "AUTO"].includes(value) || (value === "AUTO" && this.autoLayout().wrap)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ primarySizing: value === "AUTO" ? "hug" : "fixed" });
  }

  get counterAxisSizingMode(): RuntimeAxisSizingMode {
    this.assertActiveAutoLayoutFrame();
    return this.autoLayout().counterSizing === "hug" ? "AUTO" : "FIXED";
  }
  set counterAxisSizingMode(value: RuntimeAxisSizingMode) {
    this.assertActiveAutoLayoutFrame();
    const hasStretchFlowChild = value === "AUTO" && this.autoLayout().wrap && this.host.childrenOf(this.id).some((child) =>
      !child.autoLayout().absolute && child.readLayoutSizing(false) === "FILL");
    if (!["FIXED", "AUTO"].includes(value) || hasStretchFlowChild) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ counterSizing: value === "AUTO" ? "hug" : "fixed" });
  }

  get primaryAxisAlignItems(): RuntimePrimaryAxisAlignment {
    this.assertActiveAutoLayoutFrame();
    const value = this.autoLayout().primaryAlignment;
    return value === "start" ? "MIN" : value === "end" ? "MAX" : value === "spaceBetween" ? "SPACE_BETWEEN" : "CENTER";
  }
  set primaryAxisAlignItems(value: RuntimePrimaryAxisAlignment) {
    this.assertActiveAutoLayoutFrame();
    const alignment = PRIMARY_ALIGNMENTS[value];
    if (!alignment) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeAutoLayout({ primaryAlignment: alignment });
  }

  get counterAxisAlignItems(): RuntimeCounterAxisAlignment {
    this.assertActiveAutoLayoutFrame();
    const value = this.autoLayout().counterAlignment;
    return value === "start" ? "MIN" : value === "end" ? "MAX" : value === "baseline" ? "BASELINE" : "CENTER";
  }
  set counterAxisAlignItems(value: RuntimeCounterAxisAlignment) {
    this.assertActiveAutoLayoutFrame();
    const alignment = COUNTER_ALIGNMENTS[value];
    if (!alignment || (alignment === "baseline" && this.layoutMode !== "HORIZONTAL")) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ counterAlignment: alignment });
  }

  get layoutSizingHorizontal(): RuntimeLayoutSizing { return this.readLayoutSizing(true); }
  set layoutSizingHorizontal(value: RuntimeLayoutSizing) { this.writeLayoutSizing(true, value); }
  get layoutSizingVertical(): RuntimeLayoutSizing { return this.readLayoutSizing(false); }
  set layoutSizingVertical(value: RuntimeLayoutSizing) { this.writeLayoutSizing(false, value); }

  get minWidth(): number | null { return this.readAutoLayoutLimit("minWidth"); }
  set minWidth(value: number | null) { this.writeAutoLayoutLimit("minWidth", value); }
  get maxWidth(): number | null { return this.readAutoLayoutLimit("maxWidth"); }
  set maxWidth(value: number | null) { this.writeAutoLayoutLimit("maxWidth", value); }
  get minHeight(): number | null { return this.readAutoLayoutLimit("minHeight"); }
  set minHeight(value: number | null) { this.writeAutoLayoutLimit("minHeight", value); }
  get maxHeight(): number | null { return this.readAutoLayoutLimit("maxHeight"); }
  set maxHeight(value: number | null) { this.writeAutoLayoutLimit("maxHeight", value); }

  get layoutPositioning(): "AUTO" | "ABSOLUTE" {
    this.assertAutoLayoutChild();
    return this.autoLayout().absolute ? "ABSOLUTE" : "AUTO";
  }
  set layoutPositioning(value: "AUTO" | "ABSOLUTE") {
    this.assertAutoLayoutChild();
    if (!["AUTO", "ABSOLUTE"].includes(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.writeAutoLayout({ absolute: value === "ABSOLUTE" });
  }

  /** Figma's child cross-axis property. MIN/CENTER/MAX are retained for
   * compatibility with the pinned Plugin API even though Figma deprecates
   * them in favor of the parent's counterAxisAlignItems. */
  get layoutAlign(): RuntimeLayoutAlign {
    this.assertAutoLayoutChild();
    const layout = this.autoLayout();
    if (layout.counterSizing === "fill") return "STRETCH";
    return layout.alignSelf === "start" ? "MIN"
      : layout.alignSelf === "center" ? "CENTER"
      : layout.alignSelf === "end" ? "MAX"
      : "INHERIT";
  }
  set layoutAlign(value: RuntimeLayoutAlign) {
    const parent = this.parentAutoLayout();
    if (!parent || this.autoLayout().absolute || (value === "STRETCH" && parent.wrap && parent.counterSizing === "hug") || !["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"].includes(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const alignSelf = value === "MIN" ? "start" : value === "CENTER" ? "center" : value === "MAX" ? "end" : undefined;
    this.writeAutoLayout({ alignSelf, counterSizing: value === "STRETCH" ? "fill" : "fixed" });
  }

  get paddingTop(): number { return this.autoLayout().padding[0]; }
  set paddingTop(value: number) { this.writePadding("paddingTop", 0, value); }
  get paddingRight(): number { return this.autoLayout().padding[1]; }
  set paddingRight(value: number) { this.writePadding("paddingRight", 1, value); }
  get paddingBottom(): number { return this.autoLayout().padding[2]; }
  set paddingBottom(value: number) { this.writePadding("paddingBottom", 2, value); }
  get paddingLeft(): number { return this.autoLayout().padding[3]; }
  set paddingLeft(value: number) { this.writePadding("paddingLeft", 3, value); }
  get itemSpacing(): number { return this.autoLayout().itemSpacing; }
  set itemSpacing(value: number) {
    if (!Number.isFinite(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.assertAutoLayoutFrame();
    this.writeAutoLayoutUnboundVariableFields(["itemSpacing"], { itemSpacing: value });
  }
  get counterAxisSpacing(): number | null {
    this.assertActiveAutoLayoutFrame();
    return this.autoLayout().trackSpacing ?? null;
  }
  set counterAxisSpacing(value: number | null) {
    this.assertActiveAutoLayoutFrame();
    if (!this.autoLayout().wrap || (value !== null && (!Number.isFinite(value) || value < 0))) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayoutUnboundVariableFields(["counterAxisSpacing"], { trackSpacing: value ?? undefined });
  }
  get counterAxisAlignContent(): RuntimeCounterAxisAlignContent {
    this.assertActiveAutoLayoutFrame();
    return this.autoLayout().trackAlignment === "spaceBetween" ? "SPACE_BETWEEN" : "AUTO";
  }
  set counterAxisAlignContent(value: RuntimeCounterAxisAlignContent) {
    this.assertActiveAutoLayoutFrame();
    if (!this.autoLayout().wrap || !["AUTO", "SPACE_BETWEEN"].includes(value)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ trackAlignment: value === "SPACE_BETWEEN" ? "spaceBetween" : "auto" });
  }

  resize(width: number, height: number): void {
    if (![width, height].every((value) => Number.isFinite(value) && value >= 0)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeUnboundVariableFields(["width", "height"], { width, height });
  }

  resizeWithoutConstraints(width: number, height: number): void {
    if (![width, height].every((value) => Number.isFinite(value) && value >= 0)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.assertLive();
    this.assertMutable();
    const node = this.read();
    const bindings = { ...variableBindingsFromExtensions(node.extensions) };
    const linked = Object.hasOwn(bindings, "width") || Object.hasOwn(bindings, "height");
    delete bindings.width;
    delete bindings.height;
    this.host.enqueueResizeWithoutConstraints(this.handle.nodeId, linked
      ? { width, height, extensions: extensionsWithVariableMap(node.extensions, VARIABLE_BINDINGS_EXTENSION, bindings) }
      : { width, height });
  }

  remove(): void {
    this.assertLive();
    this.assertMutable();
    this.host.enqueueRemove(this.handle.nodeId);
  }

  clone(): RuntimeNodeProxy {
    this.assertLive();
    this.assertMutable();
    return this.host.cloneNode(this.handle.nodeId);
  }

  /** Figma-shaped M4D export entry. The result is derived from a confirmed,
   * RevisionLease-frozen scene rather than this proxy's pending local overlay. */
  exportAsync(settings: RuntimeSvgExportSettings): Promise<string>;
  exportAsync(settings: RuntimePngExportSettings): Promise<Uint8Array>;
  exportAsync(settings: RuntimeExportSettings): Promise<string | Uint8Array> {
    this.assertLive();
    if (settings?.format === "SVG_STRING") return this.host.exportNodeSvgString(this.handle.nodeId);
    if (settings?.format === "PNG") return this.host.exportNodePng(this.handle.nodeId, settings);
    throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: this.handle.nodeId });
  }

  protected read(allowRemoved = false): RuntimeProjectionNode {
    this.host.assertOpen();
    const node = this.host.readNode(this.handle);
    if (!node || !this.host.isCurrent(this.handle) || (node.removed === true && !allowRemoved)) {
      throw runtimeError("NODE_REMOVED", { nodeId: this.handle.nodeId });
    }
    return node;
  }

  protected assertLive(): void { this.read(); }

  protected assertMutable(): void {
    if ((this.type === "COMPONENT" || this.type === "COMPONENT_SET") && this.publishableMetadata().remote) {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    }
  }

  private string(property: string): string {
    const value = this.read()[property];
    return typeof value === "string" ? value : "";
  }

  private number(property: string): number {
    const value = this.read()[property];
    return typeof value === "number" ? value : 0;
  }

  private writeFinite(property: string, value: number): void {
    if (!Number.isFinite(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.write({ [property]: value });
  }

  private writeUnboundVariableField(field: string, patch: Readonly<Record<string, unknown>>): void {
    const node = this.read();
    const bindings = { ...variableBindingsFromExtensions(node.extensions) };
    if (!Object.hasOwn(bindings, field)) {
      this.write(patch);
      return;
    }
    delete bindings[field];
    this.write({ ...patch, extensions: extensionsWithVariableMap(node.extensions, VARIABLE_BINDINGS_EXTENSION, bindings) });
  }

  private writeUnboundVariableFields(fields: readonly string[], patch: Readonly<Record<string, unknown>>): void {
    const node = this.read();
    const bindings = { ...variableBindingsFromExtensions(node.extensions) };
    const linked = fields.some((field) => Object.hasOwn(bindings, field));
    if (!linked) {
      this.write(patch);
      return;
    }
    for (const field of fields) delete bindings[field];
    this.write({ ...patch, extensions: extensionsWithVariableMap(node.extensions, VARIABLE_BINDINGS_EXTENSION, bindings) });
  }

  private applyExplicitVariableModes(modes: Readonly<Record<string, string>>): void {
    const source = this.read();
    const targets: RuntimeNodeProxy[] = [];
    const queue: RuntimeNodeProxy[] = [this];
    while (queue.length) {
      const target = queue.shift()!;
      targets.push(target);
      if (targets.length > MAX_VARIABLE_MODE_SUBTREE_NODES) throw runtimeError("RESOURCE_LIMIT", { nodeId: this.handle.nodeId });
      queue.push(...this.host.childrenOf(target.id));
    }
    const override = Object.freeze({ nodeId: this.id, modes });
    const patches = targets.map((target) => [target, target.boundVariableValuePatch(override)] as const);
    const sourcePatch = patches[0]![1];
    this.write({
      ...sourcePatch,
      extensions: extensionsWithVariableMap(source.extensions, VARIABLE_MODES_EXTENSION, modes),
    });
    for (const [target, patch] of patches.slice(1)) {
      if (Object.keys(patch).length) target.write(patch);
    }
  }

  private boundVariableValuePatch(override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<Record<string, unknown>> {
    const bindings = variableBindingsFromExtensions(this.read().extensions);
    const patch: Record<string, unknown> = {};
    for (const [field, variableId] of Object.entries(bindings)) {
      if (!isRuntimeVariableBindableNodeField(field)) continue;
      const resolved = this.host.resolveVariableValue(variableId, this.id, override);
      Object.assign(patch, this.variableFieldPatch(field, resolved.value, resolved.resolvedType, patch));
    }
    const layout = patch.autoLayout as RuntimeAutoLayout | undefined;
    if (layout && ((layout.minWidth ?? 0) > (layout.maxWidth ?? Number.POSITIVE_INFINITY) || (layout.minHeight ?? 0) > (layout.maxHeight ?? Number.POSITIVE_INFINITY))) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    Object.assign(patch, this.paintVariableValuePatch(override));
    Object.assign(patch, this.effectVariableValuePatch(override));
    return patch;
  }

  private paintVariableValuePatch(override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<Record<string, unknown>> {
    const node = this.read();
    const bindings = variablePaintBindingsFromExtensions(node.extensions);
    const stacks = new Map<"fill" | "stroke", DocumentPaintStack>();
    for (const [key, variableId] of Object.entries(bindings)) {
      const match = /^(fill|stroke):(\d+)$/.exec(key);
      if (!match) continue;
      const usage = match[1] as "fill" | "stroke";
      const index = Number(match[2]);
      if (!Number.isInteger(index) || index < 0 || index >= 16) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const source = node[`${usage}Stack`] as DocumentPaintStack | undefined;
      const stack = stacks.get(usage) ?? (source ? structuredClone(source) : undefined);
      const layer = stack?.layers[index];
      if (!stack || !layer?.paint || layer.paint.gradient || layer.paint.gradientPaint || layer.image) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const resolved = this.host.resolveVariableValue(variableId, this.id, override);
      if (resolved.resolvedType !== "COLOR" || !isDocumentVariableColor(resolved.value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      layer.paint = { css: colorToSrgbCss(resolved.value), color: structuredClone(resolved.value) };
      stacks.set(usage, stack);
    }
    return Object.fromEntries([...stacks].map(([usage, stack]) => [`${usage}Stack`, stack]));
  }

  private effectVariableValuePatch(override?: Readonly<{ nodeId: string; modes: Readonly<Record<string, string>> }>): Readonly<Record<string, unknown>> {
    const node = this.read();
    const bindings = variableEffectBindingsFromExtensions(node.extensions);
    if (!Object.keys(bindings).length) return {};
    const effects = structuredClone((node.effectStack as DocumentEffect[] | undefined) ?? []);
    for (const [key, variableId] of Object.entries(bindings)) {
      const match = /^effect:(\d+):(color|radius|spread|offsetX|offsetY)$/.exec(key);
      if (!match) continue;
      const index = Number(match[1]);
      const effect = effects[index];
      if (!effect) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const resolved = this.host.resolveVariableValue(variableId, this.id, override);
      this.applyVariableToDocumentEffect(effect, match[2] as RuntimeEffectVariableField, resolved.value, resolved.resolvedType);
    }
    return { effectStack: effects };
  }

  private variableFieldPatch(field: RuntimeVariableBindableNodeField, value: DocumentVariableValue, type: DocumentVariableResolvedType, stagedPatch?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    if (field === "characters") {
      this.assertTextCharacters();
      if (type !== "STRING" || typeof value !== "string") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const node = this.read();
      const before = typeof node.characters === "string" ? node.characters : "";
      const properties = node.textProperties as DocumentTextProperties | undefined;
      this.host.assertFontsLoaded(fontsForRuntimeTextRange(before, properties));
      const patch = updateRuntimeText(before, value, properties, this.type === "SHAPE_WITH_TEXT" ? SHAPE_WITH_TEXT_DEFAULTS : DEFAULT_RUNTIME_TEXT_STYLE);
      return this.type === "TEXT_PATH" && this.textPathMetadata().autoRename ? { ...patch, name: value || "Text path" } : patch;
    }
    if (field === "visible") {
      if (type !== "BOOLEAN" || typeof value !== "boolean") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      return { visible: value };
    }
    if (type !== "FLOAT" || typeof value !== "number" || !Number.isFinite(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    if (field === "opacity") {
      if (value < 0 || value > 1) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      return { opacity: value };
    }
    if (field === "width" || field === "height") {
      if (value <= 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      return { [field]: value };
    }
    if (field === "cornerRadius") {
      this.assertCornerProperties();
      if (value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      return { cornerRadius: value, cornerRadii: [value, value, value, value] };
    }
    if (isRuntimeCornerField(field)) {
      if (value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const stagedRadii = Array.isArray(stagedPatch?.cornerRadii) && stagedPatch.cornerRadii.length === 4
        ? stagedPatch.cornerRadii as readonly number[]
        : this.cornerRadii();
      const radii = [...stagedRadii] as [number, number, number, number];
      radii[RUNTIME_CORNER_INDEX[field]] = value;
      return { cornerRadii: radii };
    }
    const layout = stagedPatch?.autoLayout && typeof stagedPatch.autoLayout === "object"
      ? stagedPatch.autoLayout as RuntimeAutoLayout
      : this.autoLayout();
    if (field === "itemSpacing") {
      this.assertAutoLayoutFrame();
      return { autoLayout: { ...layout, itemSpacing: value } };
    }
    const paddingIndex = field === "paddingTop" ? 0
      : field === "paddingRight" ? 1
      : field === "paddingBottom" ? 2
      : field === "paddingLeft" ? 3
      : undefined;
    if (paddingIndex !== undefined) {
      this.assertAutoLayoutFrame();
      if (value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const padding = [...layout.padding] as [number, number, number, number];
      padding[paddingIndex] = value;
      return { autoLayout: { ...layout, padding } };
    }
    if (field === "counterAxisSpacing") {
      this.assertActiveAutoLayoutFrame();
      if (!layout.wrap || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      return { autoLayout: { ...layout, trackSpacing: value } };
    }
    if (field === "minWidth" || field === "maxWidth" || field === "minHeight" || field === "maxHeight") {
      this.assertAutoLayoutParticipant();
      if (value <= 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const next = { ...layout, [field]: value };
      if (!stagedPatch && ((next.minWidth ?? 0) > (next.maxWidth ?? Number.POSITIVE_INFINITY) || (next.minHeight ?? 0) > (next.maxHeight ?? Number.POSITIVE_INFINITY))) {
        throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      }
      return { autoLayout: next };
    }
    if (field === "strokeWeight") {
      this.assertGeometry();
      if (value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      return { strokeWidth: value, strokeWeights: undefined };
    }
    if (isRuntimeStrokeSideField(field)) {
      if (value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      const stagedWeights = Array.isArray(stagedPatch?.strokeWeights) && stagedPatch.strokeWeights.length === 4
        ? stagedPatch.strokeWeights as readonly number[]
        : this.individualStrokeWeights();
      const weights = [...stagedWeights] as [number, number, number, number];
      weights[RUNTIME_STROKE_SIDE_INDEX[field]] = value;
      return { strokeWeights: weights };
    }
    throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private assertGeometry(): void {
    if (!GEOMETRY_NODE_TYPES.has(this.type)) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private assertCornerProperties(): void {
    if (!CORNER_PROPERTY_NODE_TYPES.has(this.type)) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private cornerRadii(): [number, number, number, number] {
    this.assertCornerProperties();
    const value = this.read().cornerRadii;
    if (Array.isArray(value) && value.length === 4 && value.every((radius) => typeof radius === "number" && Number.isFinite(radius) && radius >= 0)) {
      return [...value] as [number, number, number, number];
    }
    const uniform = this.number("cornerRadius");
    return [uniform, uniform, uniform, uniform];
  }

  private writeCornerRadius(field: RuntimeVariableBindableCornerField, index: number, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const radii = this.cornerRadii();
    radii[index] = value;
    this.writeUnboundVariableFields([field, "cornerRadius"], { cornerRadii: radii });
  }

  private individualStrokeWeights(): [number, number, number, number] {
    if (this.type !== "FRAME" && this.type !== "RECTANGLE") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const value = this.read().strokeWeights;
    if (Array.isArray(value) && value.length === 4 && value.every((weight) => typeof weight === "number" && Number.isFinite(weight) && weight >= 0)) {
      return [...value] as [number, number, number, number];
    }
    const uniform = this.number("strokeWidth");
    return [uniform, uniform, uniform, uniform];
  }

  private writeIndividualStrokeWeight(field: RuntimeVariableBindableStrokeSideField, index: number, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const weights = this.individualStrokeWeights();
    weights[index] = value;
    this.writeUnboundVariableFields([field, "strokeWeight"], { strokeWeights: weights });
  }

  private assertConstraintsSupported(): void {
    if (CONSTRAINT_UNSUPPORTED_TYPES.has(this.type)) throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  protected write(patch: Readonly<Record<string, unknown>>): void {
    this.assertLive();
    this.assertMutable();
    this.host.enqueueUpdate(this.handle.nodeId, patch);
  }

  private publishableMetadata(): DocumentComponentMetadata | DocumentComponentSetMetadata {
    if (this.type === "COMPONENT") return this.componentMetadata();
    if (this.type === "COMPONENT_SET") return this.componentSetMetadata();
    throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private componentMetadata(): DocumentComponentMetadata {
    const value = this.read().componentMetadata;
    if (!value || typeof value !== "object") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return value as DocumentComponentMetadata;
  }

  private componentSetMetadata(): DocumentComponentSetMetadata {
    const value = this.read().componentSetMetadata;
    if (!value || typeof value !== "object") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return value as DocumentComponentSetMetadata;
  }

  private instanceMetadata(): DocumentInstanceMetadata {
    if (this.type !== "INSTANCE") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const value = this.read().instanceMetadata;
    if (!value || typeof value !== "object") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    return value as DocumentInstanceMetadata;
  }

  private assertAutoLayoutFrame(): void {
    if (this.type !== "FRAME") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
  }

  private assertActiveAutoLayoutFrame(): void {
    this.assertAutoLayoutFrame();
    if (this.autoLayout().mode === "none") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
  }

  private parentAutoLayout(): RuntimeAutoLayout | undefined {
    const parentId = this.read().parentId;
    if (typeof parentId !== "string") return undefined;
    const parent = this.host.proxyFor(parentId);
    if (parent.type !== "FRAME") return undefined;
    const layout = parent.autoLayout();
    return layout.mode === "none" ? undefined : layout;
  }

  private parentAutoLayoutMode(): Exclude<RuntimeLayoutMode, "NONE"> | undefined {
    const mode = this.parentAutoLayout()?.mode;
    return mode === "horizontal" ? "HORIZONTAL" : mode === "vertical" ? "VERTICAL" : undefined;
  }

  private assertAutoLayoutChild(): Exclude<RuntimeLayoutMode, "NONE"> {
    const mode = this.parentAutoLayoutMode();
    if (!mode) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    return mode;
  }

  private assertAutoLayoutParticipant(): void {
    if (this.type === "FRAME" && this.autoLayout().mode !== "none") return;
    this.assertAutoLayoutChild();
  }

  private physicalSizingKey(horizontal: boolean): "primarySizing" | "counterSizing" {
    const ownMode = this.type === "FRAME" ? this.layoutMode : "NONE";
    const mode = ownMode === "NONE" ? this.assertAutoLayoutChild() : ownMode;
    return (mode === "HORIZONTAL") === horizontal ? "primarySizing" : "counterSizing";
  }

  private readLayoutSizing(horizontal: boolean): RuntimeLayoutSizing {
    this.assertAutoLayoutParticipant();
    return this.autoLayout()[this.physicalSizingKey(horizontal)].toUpperCase() as RuntimeLayoutSizing;
  }

  private writeLayoutSizing(horizontal: boolean, value: RuntimeLayoutSizing): void {
    this.assertAutoLayoutParticipant();
    if (!["FIXED", "HUG", "FILL"].includes(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const parentLayout = this.parentAutoLayout();
    const parentMode = this.parentAutoLayoutMode();
    const sizingKey = this.physicalSizingKey(horizontal);
    if (value === "FILL" && !parentLayout) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    if (value === "FILL" && parentLayout?.wrap && parentLayout.counterSizing === "hug" && ((parentMode === "HORIZONTAL") !== horizontal)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    if (value === "HUG" && (this.type !== "FRAME" || this.layoutMode === "NONE" || (this.autoLayout().wrap && sizingKey === "primarySizing"))) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayout({ [sizingKey]: value.toLowerCase() });
  }

  private readAutoLayoutLimit(key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight"): number | null {
    this.assertAutoLayoutParticipant();
    return this.autoLayout()[key] ?? null;
  }

  private writeAutoLayoutLimit(key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight", value: number | null): void {
    this.assertAutoLayoutParticipant();
    if (value !== null && (!Number.isFinite(value) || value <= 0)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    const next = { ...this.autoLayout(), [key]: value ?? undefined };
    if ((next.minWidth ?? 0) > (next.maxWidth ?? Number.POSITIVE_INFINITY) || (next.minHeight ?? 0) > (next.maxHeight ?? Number.POSITIVE_INFINITY)) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    this.writeAutoLayoutUnboundVariableFields([key], { [key]: value ?? undefined });
  }

  private assertText(): void {
    if (this.type !== "TEXT" && this.type !== "TEXT_PATH") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private assertParagraphText(): void {
    if (this.type !== "TEXT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private currentTextProperties(): DocumentTextProperties {
    this.assertParagraphText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    return updateRuntimeText(text, text, node.textProperties as DocumentTextProperties | undefined).textProperties;
  }

  private assertWritableTextParagraphRange(start: number, end: number): void {
    const text = this.characters;
    runtimeTextRange(text, start, end);
    if (/\r\n|[\n\r\u2028\u2029]/u.test(text) && (start !== 0 || end !== text.length)) {
      throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: this.handle.nodeId });
    }
  }

  private writeTextParagraph(patch: Partial<DocumentTextProperties["paragraph"]>): void {
    const properties = this.currentTextProperties();
    this.write({ textProperties: { ...properties, paragraph: { ...properties.paragraph, ...patch } } });
  }

  private assertPaintsSupported(usage: "fill" | "stroke"): void {
    const kind = nodeKindFromExternalType(this.type);
    if (!kind || !(usage === "fill" ? supportsOwnFill(kind) : supportsOwnStroke(kind))) {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    }
  }

  private assertBackgroundStyleSupported(): void {
    if (!["FRAME", "COMPONENT", "INSTANCE", "SLOT", "COMPONENT_SET"].includes(this.type)) {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    }
  }

  private assertEffectsSupported(): void {
    if (["DOCUMENT", "PAGE", "BOOLEAN_OPERATION", "SLICE"].includes(this.type)) {
      throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    }
  }

  private runtimeEffectsWithVariableBindings(): readonly RuntimeEffect[] {
    const node = this.read();
    const bindings = variableEffectBindingsFromExtensions(node.extensions);
    return runtimeEffectsFromDocument(node.effectStack as DocumentEffect[] | undefined).map((effect, index) => {
      const boundVariables = Object.fromEntries(([
        "color",
        "radius",
        "spread",
        "offsetX",
        "offsetY",
      ] as const).flatMap((field) => {
        const variableId = bindings[`effect:${index}:${field}`];
        return variableId ? [[field, Object.freeze({ type: "VARIABLE_ALIAS" as const, id: variableId })] as const] : [];
      }));
      return Object.keys(boundVariables).length
        ? Object.freeze({ ...effect, boundVariables: Object.freeze(boundVariables) })
        : Object.freeze(effect);
    });
  }

  private writeNodeEffects(value: readonly RuntimeEffect[]): void {
    const node = this.read();
    const bindings = { ...variableEffectBindingsFromExtensions(node.extensions) };
    const oldKeys = Object.keys(bindings).filter((key) => key.startsWith("effect:"));
    for (const key of oldKeys) delete bindings[key];
    const sourceBindings = value.map((effect) => ({ ...effect.boundVariables }));
    const effects = documentEffectsFromRuntime(value.map((effect): RuntimeEffect => {
      const { boundVariables: _boundVariables, ...base } = effect;
      void _boundVariables;
      return base as RuntimeEffect;
    }));
    sourceBindings.forEach((effectBindings, index) => {
      for (const [field, alias] of Object.entries(effectBindings)) {
        if (!isRuntimeEffectVariableField(field)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
        if (!alias || alias.type !== "VARIABLE_ALIAS") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
        const resource = this.host.variableResource(alias.id);
        const expected = field === "color" ? "COLOR" : "FLOAT";
        if (!resource || resource.resolvedType !== expected) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: this.handle.nodeId });
        const resolved = this.host.resolveVariableValue(resource.id, this.id);
        this.applyVariableToDocumentEffect(effects[index]!, field, resolved.value, resolved.resolvedType);
        bindings[`effect:${index}:${field}`] = resource.id;
      }
    });
    const hasKeys = Object.keys(bindings).some((key) => key.startsWith("effect:"));
    this.write({
      effectStack: effects,
      ...((oldKeys.length || hasKeys) ? { extensions: extensionsWithVariableMap(node.extensions, VARIABLE_EFFECT_BINDINGS_EXTENSION, bindings) } : {}),
    });
  }

  private applyVariableToDocumentEffect(effect: DocumentEffect, field: RuntimeEffectVariableField, value: DocumentVariableValue, type: DocumentVariableResolvedType): void {
    const shadow = effect.dropShadow ?? effect.innerShadow;
    if (field === "color") {
      if (!shadow || type !== "COLOR" || !isDocumentVariableColor(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      shadow.color = structuredClone(value);
      return;
    }
    if (type !== "FLOAT" || typeof value !== "number" || !Number.isFinite(value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    if (field === "radius") {
      const blur = effect.layerBlur ?? effect.backgroundBlur;
      if (shadow) {
        if (value < 0 || value > 1_024) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
        shadow.blurRadius = value;
      } else if (blur) {
        if (value < 0 || value > 256) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
        blur.radius = value;
      } else throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      return;
    }
    if (!shadow || value < -10_000 || value > 10_000) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    if (field === "spread") shadow.spread = value;
    else if (field === "offsetX") shadow.offsetX = value;
    else shadow.offsetY = value;
  }

  private runtimePaintsWithVariableBindings(usage: "fill" | "stroke"): readonly RuntimePaint[] {
    const node = this.read();
    const bindings = variablePaintBindingsFromExtensions(node.extensions);
    const stack = node[`${usage}Stack`] as DocumentPaintStack | undefined;
    return runtimePaintsFromNode(node as Readonly<Record<string, unknown>>, usage).map((paint, index) => {
      const variableId = bindings[`${usage}:${index}`];
      if (!variableId || paint.type !== "SOLID") return structuredClone(paint);
      return {
        ...structuredClone(paint),
        ...(stack?.layers[index] ? { opacity: stack.layers[index]!.opacity } : {}),
        boundVariables: Object.freeze({ color: Object.freeze({ type: "VARIABLE_ALIAS" as const, id: variableId }) }),
      } satisfies RuntimeSolidPaint;
    });
  }

  private writeNodePaints(usage: "fill" | "stroke", value: readonly RuntimePaint[]): void {
    const node = this.read();
    const bindings = { ...variablePaintBindingsFromExtensions(node.extensions) };
    const prefix = `${usage}:`;
    const hadBindings = Object.keys(bindings).some((key) => key.startsWith(prefix));
    for (const key of Object.keys(bindings)) if (key.startsWith(prefix)) delete bindings[key];
    const colors = new Map<number, DocumentColor>();
    const paints = value.map((paint, index): RuntimePaint => {
      const alias = paint.boundVariables?.color;
      const { boundVariables: _boundVariables, ...base } = paint;
      void _boundVariables;
      if (!alias) return base as RuntimePaint;
      if (paint.type !== "SOLID" || alias.type !== "VARIABLE_ALIAS") throw runtimeError("UNSUPPORTED_FEATURE", { nodeId: this.handle.nodeId });
      const resource = this.host.variableResource(alias.id);
      if (!resource || resource.resolvedType !== "COLOR") throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: this.handle.nodeId });
      const resolved = this.host.resolveVariableValue(resource.id, this.id);
      if (resolved.resolvedType !== "COLOR" || !isDocumentVariableColor(resolved.value)) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
      bindings[`${usage}:${index}`] = resource.id;
      colors.set(index, structuredClone(resolved.value));
      return base as RuntimePaint;
    });
    const stack = documentPaintStackFromRuntime(paints, (hash) => this.host.hasImageHash(hash));
    for (const [index, color] of colors) {
      const layer = stack.layers[index];
      if (!layer?.paint) throw runtimeError("INTERNAL_ERROR", { nodeId: this.handle.nodeId });
      layer.paint = { css: colorToSrgbCss(color), color };
    }
    const hasBindings = Object.keys(bindings).some((key) => key.startsWith(prefix));
    this.write({
      [`${usage}Stack`]: stack,
      ...(usage === "fill" ? { fillStyleId: undefined, backgroundStyleId: undefined } : { strokeStyleId: undefined }),
      ...((hadBindings || hasBindings) ? { extensions: extensionsWithVariableMap(node.extensions, VARIABLE_PAINT_BINDINGS_EXTENSION, bindings) } : {}),
    });
  }

  private writeWithClearedPaintBindings(usage: "fill" | "stroke", patch: Readonly<Record<string, unknown>>): void {
    const node = this.read();
    const bindings = { ...variablePaintBindingsFromExtensions(node.extensions) };
    const prefix = `${usage}:`;
    const keys = Object.keys(bindings).filter((key) => key.startsWith(prefix));
    for (const key of keys) delete bindings[key];
    this.write({
      ...patch,
      ...(keys.length ? { extensions: extensionsWithVariableMap(node.extensions, VARIABLE_PAINT_BINDINGS_EXTENSION, bindings) } : {}),
    });
  }

  private applyPaintStyle(usage: "fill" | "stroke" | "background", styleId: string): void {
    if (typeof styleId !== "string") throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    if (usage === "background") this.assertBackgroundStyleSupported();
    else this.assertPaintsSupported(usage);
    if (!styleId) {
      this.write(usage === "stroke"
        ? { strokeStyleId: undefined }
        : { fillStyleId: undefined, backgroundStyleId: undefined });
      return;
    }
    const resource = this.host.paintStyleResource(styleId);
    if (!resource || resource.id !== styleId) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: this.handle.nodeId });
    const paints = structuredClone(resource.paints);
    const patch = usage === "stroke"
      ? { strokeStack: paints, strokeStyleId: styleId }
      : usage === "background"
        ? { fillStack: paints, fillStyleId: styleId, backgroundStyleId: styleId }
        : { fillStack: paints, fillStyleId: styleId, backgroundStyleId: undefined };
    this.writeWithClearedPaintBindings(usage === "stroke" ? "stroke" : "fill", patch);
  }

  private assertTextCharacters(): void {
    if (this.type !== "TEXT" && this.type !== "TEXT_PATH" && this.type !== "SHAPE_WITH_TEXT") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
  }

  private connectorMetadata(): DocumentConnectorMetadata {
    if (this.type !== "CONNECTOR") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const value = this.read().connectorMetadata as DocumentConnectorMetadata | undefined;
    return value ?? { lineType: "STRAIGHT", start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, startStrokeCap: "NONE", endStrokeCap: "NONE", text: "", cornerRadius: 0 };
  }

  private writeConnectorMetadata(patch: Partial<DocumentConnectorMetadata>): void {
    this.write({ connectorMetadata: { ...structuredClone(this.connectorMetadata()), ...patch } });
  }

  private textPathMetadata(): DocumentTextPathMetadata {
    if (this.type !== "TEXT_PATH") throw runtimeError("UNSUPPORTED_PROPERTY", { nodeId: this.handle.nodeId });
    const value = this.read().textPathMetadata as DocumentTextPathMetadata | undefined;
    return value ?? { startSegment: 0, startPosition: 0, autoRename: true, textAlignHorizontal: "LEFT", textAlignVertical: "CENTER" };
  }

  private writeTextPathMetadata(patch: Partial<DocumentTextPathMetadata>): void {
    this.write({ textPathMetadata: { ...structuredClone(this.textPathMetadata()), ...patch } });
  }

  private setTextRange(start: number, end: number, patch: RuntimeTextStylePatch): void {
    this.assertText();
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    const properties = node.textProperties as never;
    const replacesFont = Object.prototype.hasOwnProperty.call(patch, "font");
    if (start === end) {
      const next = patchRuntimeTextRange(text, properties, start, end, patch);
      if (text.length === 0) {
        const fonts = replacesFont
          ? patch.font ? [patch.font] : []
          : fontsForRuntimeTextRange(text, next, start, end);
        this.host.assertFontsLoaded(fonts);
        this.write({ textProperties: next });
      }
      return;
    }
    const fonts = replacesFont
      ? patch.font ? [patch.font] : []
      : fontsForRuntimeTextRange(text, properties, start, end);
    this.host.assertFontsLoaded(fonts);
    this.write({ textProperties: patchRuntimeTextRange(text, properties, start, end, patch) });
  }

  private applyTextStyleRange(start: number, end: number, styleId: string): void {
    this.assertText();
    if (typeof styleId !== "string" || styleId.includes("\0") || new TextEncoder().encode(styleId).byteLength > 2_048) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const node = this.read();
    const text = typeof node.characters === "string" ? node.characters : "";
    if (text.length > 0 && start === end) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    runtimeTextRange(text, start, end);
    const resource = styleId ? this.host.textStyleResource(styleId) : undefined;
    if (resource?.style.font) this.host.assertFontsLoaded([resource.style.font]);
    this.write({
      textProperties: applyRuntimeTextStyleRange(
        text,
        node.textProperties as DocumentTextProperties | undefined,
        start,
        end,
        styleId,
        resource,
        DEFAULT_RUNTIME_TEXT_STYLE,
      ),
    });
  }

  private applyTextPaintStyleRange(start: number, end: number, styleId: string): void {
    this.assertText();
    if (typeof styleId !== "string" || styleId.includes("\0") || new TextEncoder().encode(styleId).byteLength > 2_048) {
      throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    }
    const text = this.characters;
    if (text.length > 0 && start === end) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    runtimeTextRange(text, start, end);
    const resource = styleId ? this.host.paintStyleResource(styleId) : undefined;
    if (styleId && (!resource || resource.id !== styleId)) throw runtimeError("RESOURCE_UNAVAILABLE", { nodeId: this.handle.nodeId });
    this.setTextRange(start, end, styleId
      ? { color: undefined, fillStack: structuredClone(resource!.paints), paintStyleId: styleId }
      : { paintStyleId: undefined });
  }

  private replaceCharacters(start: number, end: number, replacement: string, insertionStyle: RuntimeTextInsertionStyle = "BEFORE"): void {
    this.assertText();
    const node = this.read();
    const before = typeof node.characters === "string" ? node.characters : "";
    const properties = node.textProperties as never;
    if (start === end && replacement.length === 0) {
      replaceRuntimeTextRangeWithStyles(before, properties, start, end, replacement, { insertionStyle });
      return;
    }
    this.host.assertFontsLoaded(fontsForRuntimeTextRange(before, properties, start, end, insertionStyle));
    this.write(replaceRuntimeTextRangeWithStyles(before, properties, start, end, replacement, { insertionStyle }));
  }

  private autoLayout(): RuntimeAutoLayout {
    const value = this.read().autoLayout;
    if (!value || typeof value !== "object") return defaultAutoLayout();
    const layout = value as Partial<RuntimeAutoLayout>;
    const padding = Array.isArray(layout.padding) && layout.padding.length === 4 && layout.padding.every(Number.isFinite)
      ? layout.padding as [number, number, number, number]
      : [0, 0, 0, 0];
    return {
      ...defaultAutoLayout(),
      ...layout,
      padding: [...padding] as [number, number, number, number],
    };
  }

  private writePadding(field: "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft", index: number, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw runtimeError("INVALID_ARGUMENT", { nodeId: this.handle.nodeId });
    this.assertAutoLayoutFrame();
    const layout = this.autoLayout();
    const padding = [...layout.padding] as [number, number, number, number];
    padding[index] = value;
    this.writeAutoLayoutUnboundVariableFields([field], { padding });
  }

  private writeAutoLayoutUnboundVariableFields(fields: readonly RuntimeVariableBindableNodeField[], patch: Partial<RuntimeAutoLayout>): void {
    const node = this.read();
    const bindings = { ...variableBindingsFromExtensions(node.extensions) };
    const linked = fields.some((field) => Object.hasOwn(bindings, field));
    for (const field of fields) delete bindings[field];
    this.write({
      autoLayout: { ...this.autoLayout(), ...patch },
      ...(linked ? { extensions: extensionsWithVariableMap(node.extensions, VARIABLE_BINDINGS_EXTENSION, bindings) } : {}),
    });
  }

  private writeAutoLayout(patch: Partial<RuntimeAutoLayout>): void {
    this.write({ autoLayout: { ...this.autoLayout(), ...patch } });
  }
}

function runtimeTextFillsForRange(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
  fallback: readonly RuntimePaint[],
): readonly RuntimePaint[] | typeof RUNTIME_MIXED {
  const range = runtimeTextRange(text, start, end);
  const runs = properties?.runs ?? [];
  const matching = range.start === range.end
    ? (() => {
      const containing = runs.find((run) => run.start <= range.start && range.start < run.end);
      if (containing) return [containing];
      const preceding = [...runs].reverse().find((run) => run.end === range.start);
      return preceding ? [preceding] : [];
    })()
    : runs.filter((run) => run.start < range.end && run.end > range.start);
  const fills = matching.length
    ? matching.map((run) => run.fillStack !== undefined
      ? runtimePaintsFromDocumentStack(run.fillStack)
      : run.color
        ? runtimeFillsFromDocumentTextColor(run.color)
        : fallback)
    : properties?.baseStyle
      ? [properties.baseStyle.fillStack !== undefined
        ? runtimePaintsFromDocumentStack(properties.baseStyle.fillStack)
        : properties.baseStyle.color
          ? runtimeFillsFromDocumentTextColor(properties.baseStyle.color)
          : fallback]
      : [fallback];
  const first = fills[0] ?? fallback;
  return fills.every((value) => JSON.stringify(value) === JSON.stringify(first))
    ? structuredClone(first)
    : RUNTIME_MIXED;
}

function runtimeStyleNumberForRange<K extends "fontSize" | "fontWeight" | "letterSpacing">(
  text: string,
  properties: DocumentTextProperties | undefined,
  start: number,
  end: number,
  property: K,
  fallback: DocumentTextProperties["runs"][number][K],
): DocumentTextProperties["runs"][number][K] | typeof RUNTIME_MIXED {
  const styles = runtimeTextStylesForRange(text, properties, start, end);
  const values = styles.length ? styles.map((style) => style[property]) : [properties?.baseStyle?.[property] ?? fallback];
  return values.some((value) => value !== values[0]) ? RUNTIME_MIXED : values[0]!;
}

const GEOMETRY_NODE_TYPES = new Set<M1NodeType>(["RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "LINE"]);
const CORNER_PROPERTY_NODE_TYPES = new Set<M1NodeType>(["FRAME", "COMPONENT", "INSTANCE", "RECTANGLE", "SECTION"]);
function isDocumentVariableColor(value: DocumentVariableValue): value is DocumentColor {
  return typeof value === "object" && value !== null && "space" in value && "components" in value && "alpha" in value;
}
const CONSTRAINT_UNSUPPORTED_TYPES = new Set<M1NodeType>(["DOCUMENT", "PAGE", "GROUP", "BOOLEAN_OPERATION", "SECTION", "SLIDE"]);
const CONSTRAINTS: Readonly<Record<RuntimeConstraintType, DocumentConstraints["horizontal"]>> = {
  MIN: "min",
  CENTER: "center",
  MAX: "max",
  STRETCH: "stretch",
  SCALE: "scale",
};
const PRIMARY_ALIGNMENTS: Readonly<Record<RuntimePrimaryAxisAlignment, RuntimeAutoLayout["primaryAlignment"]>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "spaceBetween",
};
const COUNTER_ALIGNMENTS: Readonly<Record<RuntimeCounterAxisAlignment, RuntimeAutoLayout["counterAlignment"]>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  BASELINE: "baseline",
};
const STROKE_CAPS: Readonly<Record<RuntimeStrokeCap, StrokeCap>> = {
  NONE: "none",
  ROUND: "round",
  SQUARE: "square",
  ARROW_LINES: "arrowLines",
  ARROW_EQUILATERAL: "arrowEquilateral",
  DIAMOND_FILLED: "diamondFilled",
  TRIANGLE_FILLED: "triangleFilled",
  CIRCLE_FILLED: "circleFilled",
};
const STROKE_JOINS: Readonly<Record<RuntimeStrokeJoin, StrokeJoin>> = { MITER: "miter", BEVEL: "bevel", ROUND: "round" };
const BOOLEAN_OPERATIONS: Readonly<Record<RuntimeBooleanOperation, DocumentBooleanOperation>> = {
  UNION: "union",
  INTERSECT: "intersect",
  SUBTRACT: "subtract",
  EXCLUDE: "exclude",
};
const SHAPE_WITH_TEXT_TYPES = new Set<ShapeWithTextType>([
  "SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN",
  "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER",
  "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT",
  "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT",
  "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE",
]);

function runtimeTextWrapStyle(value: "auto" | "balance" | "pretty"): "AUTO" | "BALANCE" | "PRETTY" {
  return value === "balance" ? "BALANCE" : value === "pretty" ? "PRETTY" : "AUTO";
}

function documentTextWrapStyle(value: "AUTO" | "BALANCE" | "PRETTY"): "auto" | "balance" | "pretty" {
  return value === "BALANCE" ? "balance" : value === "PRETTY" ? "pretty" : "auto";
}

function canonicalConstraint(value: RuntimeConstraintType | undefined): DocumentConstraints["horizontal"] | undefined {
  return value ? CONSTRAINTS[value] : undefined;
}
function runtimeConstraint(value: DocumentConstraints["horizontal"]): RuntimeConstraintType {
  const entry = Object.entries(CONSTRAINTS).find(([, canonical]) => canonical === value);
  return (entry?.[0] as RuntimeConstraintType | undefined) ?? "MIN";
}

function canonicalStrokeCap(value: RuntimeStrokeCap): StrokeCap | undefined { return STROKE_CAPS[value]; }
function strokeCapFromCanonical(value: unknown): RuntimeStrokeCap {
  const entry = Object.entries(STROKE_CAPS).find(([, canonical]) => canonical === (value ?? "none"));
  return (entry?.[0] as RuntimeStrokeCap | undefined) ?? "NONE";
}
function canonicalStrokeCapValue(value: unknown): StrokeCap { return canonicalStrokeCap(strokeCapFromCanonical(value))!; }
function canonicalStrokeJoin(value: RuntimeStrokeJoin): StrokeJoin | undefined { return STROKE_JOINS[value]; }
function strokeJoinFromCanonical(value: unknown): RuntimeStrokeJoin {
  const entry = Object.entries(STROKE_JOINS).find(([, canonical]) => canonical === (value ?? "miter"));
  return (entry?.[0] as RuntimeStrokeJoin | undefined) ?? "MITER";
}
function canonicalStrokeJoinValue(value: unknown): StrokeJoin { return canonicalStrokeJoin(strokeJoinFromCanonical(value))!; }
function canonicalBooleanOperation(value: RuntimeBooleanOperation): DocumentBooleanOperation | undefined { return BOOLEAN_OPERATIONS[value]; }
function runtimeBooleanOperation(value: unknown): RuntimeBooleanOperation {
  const entry = Object.entries(BOOLEAN_OPERATIONS).find(([, canonical]) => canonical === (value ?? "union"));
  return (entry?.[0] as RuntimeBooleanOperation | undefined) ?? "UNION";
}

function isShapeWithTextType(value: unknown): value is ShapeWithTextType {
  return typeof value === "string" && SHAPE_WITH_TEXT_TYPES.has(value as ShapeWithTextType);
}

function validConnectorCap(value: unknown): value is FigmaConnectorStrokeCap { return isFigmaConnectorStrokeCap(value); }

function starInnerRatio(value: unknown): number {
  if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "star" || !("innerRatio" in value) || typeof value.innerRatio !== "number") {
    return .5;
  }
  return value.innerRatio;
}

function defaultAutoLayout(): RuntimeAutoLayout {
  return {
    mode: "none",
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    wrap: false,
    primaryAlignment: "start",
    counterAlignment: "start",
    primarySizing: "fixed",
    counterSizing: "fixed",
    absolute: false,
  };
}
