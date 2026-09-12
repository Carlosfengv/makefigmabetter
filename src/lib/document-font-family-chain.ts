import type { DocumentFontReference } from "./editor-protocol";

/** Builds the loaded portion of a Canonical FontRef fallback chain for Canvas.
 * Asset IDs are durable references, while returned families are runtime-only;
 * unavailable assets are deliberately skipped so the platform's final generic
 * fallback can still resolve missing glyphs. */
export function documentFontFamilyChain(
  primary: DocumentFontReference | undefined,
  fallbacks: readonly DocumentFontReference[] | undefined,
  familyForAsset: (assetId: string) => string | undefined,
): string {
  const families = [primary, ...(fallbacks ?? [])]
    .flatMap((font) => font ? [familyForAsset(font.assetId)] : [])
    .filter((family): family is string => Boolean(family));
  return [...new Set(families)].map(cssFamily).join(", ");
}

function cssFamily(family: string) {
  return `"${family.replace(/["\\\n\r\f]/g, "\\$&")}"`;
}
