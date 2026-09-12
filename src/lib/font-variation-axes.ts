import type { DocumentFontReference } from "./editor-protocol";

export type FontVariationAxesParse =
  | { valid: true; axes: NonNullable<DocumentFontReference["variationAxes"]> }
  | { valid: false; error: string };

const MAX_AXES = 16;

/** Parses the compact inspector form (`wght=650,wdth=92`) without inventing
 * coordinates. The returned list is canonicalized before it crosses the Rust
 * Core/Protobuf boundary, making cache and operation identities stable. */
export function parseFontVariationAxes(source: string): FontVariationAxesParse {
  const value = source.trim();
  if (!value) return { valid: true, axes: [] };
  const axes = value.split(",").map((entry) => entry.trim());
  if (axes.length > MAX_AXES) return { valid: false, error: `At most ${MAX_AXES} variable-font axes are supported.` };
  const seen = new Set<string>();
  const parsed: NonNullable<DocumentFontReference["variationAxes"]> = [];
  for (const axis of axes) {
    const separator = axis.indexOf("=");
    if (separator <= 0 || separator !== axis.lastIndexOf("=")) return { valid: false, error: "Use four-character axis tags, for example wght=650." };
    const tag = axis.slice(0, separator).trim();
    const valueText = axis.slice(separator + 1).trim();
    const coordinate = Number(valueText);
    if (tag.length !== 4 || !/^[\x20-\x7e]{4}$/.test(tag)) return { valid: false, error: "Each variation axis tag must be exactly four ASCII characters." };
    if (!Number.isFinite(coordinate)) return { valid: false, error: `The ${tag} coordinate must be a finite number.` };
    if (seen.has(tag)) return { valid: false, error: `The ${tag} axis appears more than once.` };
    seen.add(tag);
    parsed.push({ tag, value: coordinate });
  }
  parsed.sort((left, right) => left.tag.localeCompare(right.tag));
  return { valid: true, axes: parsed };
}

export function formatFontVariationAxes(axes: DocumentFontReference["variationAxes"]): string {
  return [...(axes ?? [])]
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map((axis) => `${axis.tag}=${axis.value}`)
    .join(", ");
}

/** Canonical CSS/SVG `font-variation-settings` value. JSON string escaping is
 * valid CSS quoted-string escaping and keeps a persisted four-byte tag from
 * becoming an attribute/style injection vector during Canvas or SVG export. */
export function fontVariationCss(axes: DocumentFontReference["variationAxes"]): string {
  return [...(axes ?? [])]
    .filter((axis) => axis.tag.length === 4 && /^[\x20-\x7e]{4}$/.test(axis.tag) && Number.isFinite(axis.value))
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map((axis) => `${JSON.stringify(axis.tag)} ${axis.value === 0 ? 0 : axis.value}`)
    .join(", ") || "normal";
}
