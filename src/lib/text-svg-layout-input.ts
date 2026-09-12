import type { CanvasNode, DocumentFontReference } from "./editor-protocol";

export type TextSvgLayoutInput = Readonly<{
  source: string;
  fontBytes: ArrayBuffer;
  faceIndex: number;
  axes: string;
  fontSize: number;
}>;

export type TextFrozenLayoutFace = Readonly<{
  source: string;
  font: DocumentFontReference;
  axes: string;
  fontSize: number;
}>;

function canonicalAxes(font: DocumentFontReference) {
  return JSON.stringify([...(font.variationAxes ?? [])]
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map((axis) => ({ tag: axis.tag, value: axis.value })));
}

/**
 * Returns the single Rust shaping input that Canvas also uses for a text node.
 * Multiple Style Runs are safe only when they cover the source contiguously and
 * differ in paint-only attributes (for example colour). A font/size/weight/
 * italic/tracking change can change advances, so those intentionally keep the
 * browser fallback rather than making SVG export invent a second line breaker.
 *
 * The current Rust boundary receives an explicit face and variation axes, but
 * not browser font synthesis. Thus a CSS-only weight, italic synthesis or
 * letter-spacing must not be frozen from the unmodified face, even if every
 * Style Run happens to use the same metric fields.
 */
export function textFrozenLayoutFace(node: CanvasNode): TextFrozenLayoutFace | undefined {
  if (node.kind !== "text" || !Number.isFinite(node.width) || node.width <= 0) return undefined;
  const source = node.text ?? "Text";
  const sourceLength = new TextEncoder().encode(source).byteLength;
  const runs = node.textProperties?.runs ?? [];
  const primary = runs[0];
  const fallback = !primary?.font ? node.textProperties?.fallbackFonts?.[0] : undefined;
  const font = primary?.font ?? fallback;
  const fontSize = primary?.fontSize ?? 31;
  const fontWeight = primary?.fontWeight ?? 500;
  const italic = primary?.italic ?? false;
  const letterSpacing = primary?.letterSpacing ?? 0;
  if (!sourceLength || !font || !Number.isFinite(fontSize) || fontSize <= 0) return undefined;
  if (fontWeight !== 400 || italic || letterSpacing !== 0) return undefined;
  const axes = canonicalAxes(font);
  let cursor = 0;
  for (const run of runs) {
    const fontMismatch = primary?.font
      ? !run.font || run.font.assetId !== font.assetId || run.font.faceIndex !== font.faceIndex || canonicalAxes(run.font) !== axes
      : Boolean(run.font);
    if (run.start !== cursor || run.end <= cursor || run.end > sourceLength || fontMismatch
      || run.fontSize !== fontSize || run.fontWeight !== fontWeight
      || run.italic !== italic || run.letterSpacing !== letterSpacing) return undefined;
    cursor = run.end;
  }
  // A default-style span has Canvas's synthetic 500 weight today. Until that
  // synthesis is a Rust shaping parameter, do not use the raw fallback face as
  // an apparently equivalent frozen layout.
  if (runs.length && cursor !== sourceLength) return undefined;
  return { source, font, axes, fontSize };
}

export function textSvgLayoutInput(node: CanvasNode, fontBytes: ReadonlyMap<string, ArrayBuffer>): TextSvgLayoutInput | undefined {
  const face = textFrozenLayoutFace(node);
  const bytes = face && fontBytes.get(face.font.assetId);
  return face && bytes
    ? { source: face.source, fontBytes: bytes, faceIndex: face.font.faceIndex, axes: face.axes, fontSize: face.fontSize }
    : undefined;
}
