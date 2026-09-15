import type { DocumentAsset, DocumentFontReference } from "../lib/editor-protocol";
import { fontFamilyForAsset } from "../lib/font-face-registry";

/** Figma's public font identity. Canonical documents continue to store the
 * content-addressed FontReference; this value is a reversible Runtime view. */
export type RuntimeFontName = Readonly<{ family: string; style: string }>;

export const DEFAULT_RUNTIME_FONT_NAME: RuntimeFontName = Object.freeze({
  family: "Inter",
  style: "Regular",
});

const FACE_STYLE_PREFIX = "Face ";
const MAX_FONT_NAME_LENGTH = 256;

export function isRuntimeFontName(value: unknown): value is RuntimeFontName {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeFontName>;
  return validPart(candidate.family) && validPart(candidate.style);
}

/** Admitted name-table metadata is the public Figma identity. Legacy assets
 * retain the document-scoped synthetic family and reversible face labels. */
export function runtimeFontNameForReference(
  font: DocumentFontReference,
  assets: readonly DocumentAsset[] = [],
): RuntimeFontName {
  const face = assets
    .find((asset) => asset.assetId === font.assetId)
    ?.fontFaces?.find((candidate) => candidate.faceIndex === font.faceIndex);
  if (face) return { family: face.family, style: face.style };
  return {
    family: fontFamilyForAsset(font.assetId),
    style: font.faceIndex === 0 ? "Regular" : `${FACE_STYLE_PREFIX}${font.faceIndex}`,
  };
}

export function runtimeFontReferenceForName(
  fontName: RuntimeFontName,
  assets: readonly DocumentAsset[],
): DocumentFontReference | undefined | null {
  if (!isRuntimeFontName(fontName)) return null;
  if (sameRuntimeFontName(fontName, DEFAULT_RUNTIME_FONT_NAME)) return undefined;
  const metadataMatches = assets.flatMap((asset) => (asset.fontFaces ?? [])
    .filter((face) => (face.family === fontName.family && face.style === fontName.style)
      || (face.aliases ?? []).some((alias) => alias.family === fontName.family && alias.style === fontName.style))
    .map((face) => ({ assetId: asset.assetId, faceIndex: face.faceIndex })));
  if (metadataMatches.length === 1) return metadataMatches[0]!;
  if (metadataMatches.length > 1) return null;
  const faceIndex = faceIndexForStyle(fontName.style);
  if (faceIndex === undefined) return null;
  const asset = assets.find((candidate) =>
    candidate.mediaType.startsWith("font/")
    && !(candidate.fontFaces?.length)
    && fontFamilyForAsset(candidate.assetId) === fontName.family,
  );
  return asset ? { assetId: asset.assetId, faceIndex } : null;
}

export function sameRuntimeFontName(left: RuntimeFontName, right: RuntimeFontName): boolean {
  return left.family === right.family && left.style === right.style;
}

function faceIndexForStyle(style: string): number | undefined {
  if (style === "Regular") return 0;
  if (!style.startsWith(FACE_STYLE_PREFIX)) return undefined;
  const index = Number(style.slice(FACE_STYLE_PREFIX.length));
  return Number.isSafeInteger(index) && index > 0 && index <= 0xffff_ffff ? index : undefined;
}

function validPart(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_FONT_NAME_LENGTH
    && value.trim() === value;
}
