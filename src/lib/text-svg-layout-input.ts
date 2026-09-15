import type { CanvasNode, DocumentFontReference } from "./editor-protocol";
import {
  hasMissingRustTextGlyph,
  parseRustTextLayout,
  remapRustTextLayoutToSource,
} from "./rust-text-layout";
import {
  projectDocumentTextCaseRanges,
  sourceBoundaryToDisplay,
  usesSmallCaps,
  type TextCaseProjection,
} from "./text-case";

export type TextSvgLayoutInput = Readonly<{
  /** Unchanged Canonical source used to validate remapped line/caret offsets. */
  source: string;
  /** Presentation string shaped by Rustybuzz. */
  shapingSource: string;
  projection: TextCaseProjection;
  /** Concatenated unique font assets referenced by `runsJson`. */
  fontBundle: ArrayBuffer;
  runsJson: string;
  fontSize: number;
}>;

export type TextFrozenLayoutRun = Readonly<{
  sourceStart: number;
  sourceEnd: number;
  start: number;
  end: number;
  font: DocumentFontReference;
  axes: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
}>;

export type TextFrozenLayoutPlan = Readonly<{
  source: string;
  shapingSource: string;
  projection: TextCaseProjection;
  runs: readonly TextFrozenLayoutRun[];
  fontSize: number;
}>;

export type TextFrozenLayoutFace = Readonly<{
  source: string;
  shapingSource: string;
  projection: TextCaseProjection;
  font: DocumentFontReference;
  axes: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
}>;

export type TextSvgLayoutProjection = Readonly<{
  lines: ReadonlyArray<Readonly<{
    start: number;
    end: number;
    direction: "ltr" | "rtl";
  }>>;
}>;

export type TextPathSvgLayoutProjection = Readonly<{
  unitsPerEm: number;
  lines: ReadonlyArray<Readonly<{
    start: number;
    end: number;
    direction: "ltr" | "rtl";
    advance: number;
  }>>;
}>;

export const TEXT_PATH_SINGLE_LINE_WIDTH = 1_000_000_000;

function canonicalAxes(font: DocumentFontReference) {
  return JSON.stringify([...(font.variationAxes ?? [])]
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map((axis) => ({ tag: axis.tag, value: axis.value })));
}

function canonicalVariationAxes(font: DocumentFontReference) {
  return [...(font.variationAxes ?? [])]
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map((axis) => ({ tag: axis.tag, value: axis.value }));
}

/** Builds the complete metric-bearing shaping plan. Every source byte must be
 * owned by exactly one explicit or document-fallback font run. Synthetic
 * weight/italic are presentation-only raster styles with authored advances;
 * small caps remain outside Rust. PIXELS tracking is metric bearing and
 * therefore travels with each admitted run. */
export function textFrozenLayoutPlan(node: CanvasNode): TextFrozenLayoutPlan | undefined {
  if ((node.kind !== "text" && node.kind !== "textPath") || !Number.isFinite(node.width) || node.width <= 0) return undefined;
  const source = node.text ?? "Text";
  const sourceLength = new TextEncoder().encode(source).byteLength;
  const runs = node.textProperties?.runs ?? [];
  const fallback = node.textProperties?.fallbackFonts?.[0];
  if (!sourceLength || !runs.length || runs.length > 4_096) return undefined;
  let cursor = 0;
  for (const run of runs) {
    if (run.start !== cursor || run.end <= cursor || run.end > sourceLength
      || !run.font && !fallback
      || !Number.isFinite(run.fontSize) || run.fontSize <= 0
      || !Number.isInteger(run.fontWeight) || run.fontWeight < 1 || run.fontWeight > 1_000
      || typeof run.italic !== "boolean"
      || !Number.isFinite(run.letterSpacing) || run.letterSpacing < -10_000 || run.letterSpacing > 10_000
      || usesSmallCaps(run.textCase)) return undefined;
    cursor = run.end;
  }
  if (cursor !== sourceLength) return undefined;
  const projection = projectDocumentTextCaseRanges(source, runs.map((run) => ({
    start: run.start,
    end: run.end,
    textCase: run.textCase,
  })));
  if (!projection) return undefined;
  const shapingRuns = runs.map((run) => {
    const start = sourceBoundaryToDisplay(projection, run.start);
    const end = sourceBoundaryToDisplay(projection, run.end);
    const font = run.font ?? fallback;
    return start === undefined || end === undefined || !font
      ? undefined
      : {
          sourceStart: run.start,
          sourceEnd: run.end,
          start,
          end,
          font,
          axes: canonicalAxes(font),
          fontSize: run.fontSize,
          fontWeight: run.fontWeight,
          italic: run.italic,
          letterSpacing: run.letterSpacing,
        };
  });
  if (shapingRuns.some((run) => !run)) return undefined;
  return {
    source,
    shapingSource: projection.display,
    projection,
    runs: shapingRuns as TextFrozenLayoutRun[],
    fontSize: runs[0]!.fontSize,
  };
}

/** Returns a strict single-face compatibility subset for callers that need one
 * immutable font resource. Canvas, SVG, caret layout and the per-glyph WebGPU
 * path use `textFrozenLayoutPlan` directly. */
export function textFrozenLayoutFace(node: CanvasNode): TextFrozenLayoutFace | undefined {
  const plan = textFrozenLayoutPlan(node);
  const primary = plan?.runs[0];
  if (!plan || !primary || plan.runs.some((run) =>
    run.font.assetId !== primary.font.assetId
      || run.font.faceIndex !== primary.font.faceIndex
      || run.axes !== primary.axes
      || run.fontSize !== primary.fontSize
      || run.fontWeight !== primary.fontWeight
      || run.italic !== primary.italic
      || run.letterSpacing !== 0)) return undefined;
  return {
    source: plan.source,
    shapingSource: plan.shapingSource,
    projection: plan.projection,
    font: primary.font,
    axes: primary.axes,
    fontSize: primary.fontSize,
    fontWeight: primary.fontWeight,
    italic: primary.italic,
  };
}

export function textSvgLayoutInput(node: CanvasNode, fontBytes: ReadonlyMap<string, ArrayBuffer>): TextSvgLayoutInput | undefined {
  const plan = textFrozenLayoutPlan(node);
  return plan && textLayoutInputFromPlan(plan, fontBytes);
}

export function textLayoutInputFromPlan(
  plan: TextFrozenLayoutPlan,
  fontBytes: ReadonlyMap<string, ArrayBuffer>,
): TextSvgLayoutInput | undefined {
  const assets = new Map<string, { offset: number; bytes: Uint8Array }>();
  let bundleLength = 0;
  for (const run of plan.runs) {
    if (assets.has(run.font.assetId)) continue;
    const bytes = fontBytes.get(run.font.assetId);
    if (!bytes) return undefined;
    const view = new Uint8Array(bytes);
    assets.set(run.font.assetId, { offset: bundleLength, bytes: view });
    bundleLength += view.byteLength;
  }
  const fontBundle = new Uint8Array(bundleLength);
  for (const asset of assets.values()) fontBundle.set(asset.bytes, asset.offset);
  const runsJson = JSON.stringify(plan.runs.map((run) => {
    const asset = assets.get(run.font.assetId)!;
    return {
      start: run.start,
      end: run.end,
      fontOffset: asset.offset,
      fontLength: asset.bytes.byteLength,
      faceIndex: run.font.faceIndex,
      variationAxes: canonicalVariationAxes(run.font),
      fontSize: run.fontSize,
      fontWeight: run.fontWeight,
      italic: run.italic,
      letterSpacing: run.letterSpacing,
    };
  }));
  return {
    source: plan.source,
    shapingSource: plan.shapingSource,
    projection: plan.projection,
    fontBundle: fontBundle.buffer,
    runsJson,
    fontSize: plan.fontSize,
  };
}

/** Validates a layout shaped from the presentation string, then projects its
 * structural ranges back onto the immutable Canonical source coordinates used
 * by SVG style slicing. A payload shaped from the source string by mistake is
 * rejected whenever TextCase changes its UTF-8 structure instead of silently
 * exporting different line breaks from Canvas. */
export function parseTextSvgLayoutProjection(
  payload: string,
  input: Pick<TextSvgLayoutInput, "source" | "shapingSource" | "projection">,
): TextSvgLayoutProjection | undefined {
  const displayLayout = parseRustTextLayout(payload, input.shapingSource);
  const sourceLayout = displayLayout
    && remapRustTextLayoutToSource(displayLayout, input.projection);
  if (!sourceLayout || hasMissingRustTextGlyph(sourceLayout)) return undefined;
  return {
    lines: sourceLayout.lines.map(({ start, end, direction }) => ({
      start,
      end,
      direction,
    })),
  };
}

/** Preserves the metric payload required to anchor one TextPath line without
 * persisting derived glyph positions in the Canonical document. */
export function parseTextPathSvgLayoutProjection(
  payload: string,
  input: Pick<TextSvgLayoutInput, "source" | "shapingSource" | "projection">,
): TextPathSvgLayoutProjection | undefined {
  const displayLayout = parseRustTextLayout(payload, input.shapingSource);
  const sourceLayout = displayLayout && remapRustTextLayoutToSource(displayLayout, input.projection);
  if (!sourceLayout || hasMissingRustTextGlyph(sourceLayout) || sourceLayout.lines.length !== 1) return undefined;
  return {
    unitsPerEm: sourceLayout.unitsPerEm,
    lines: sourceLayout.lines.map(({ start, end, direction, advance }) => ({ start, end, direction, advance })),
  };
}
