import type { DocumentAutoLayout } from "./editor-protocol";

const finiteNonNegative = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;

// serde_wasm_bindgen/JSON projects an absent Rust Option as null. Preserve
// that absence so a later full Auto Layout update cannot turn an unset maximum
// into a real zero-size constraint.
const optionalFiniteNonNegative = (value: unknown) =>
  value === null || value === undefined ? undefined : finiteNonNegative(value);

/**
 * Old imported snapshots can contain the Auto Layout mode while omitting
 * fields introduced later. Presentation code must treat those omissions as
 * Figma defaults instead of dropping the relationship or throwing while
 * reading the padding tuple.
 */
export function normalizeAutoLayout(
  value: DocumentAutoLayout | undefined,
): DocumentAutoLayout | undefined {
  if (!value) return undefined;
  const source = value as Partial<DocumentAutoLayout> & {
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
  };
  const rawPadding = Array.isArray(source.padding) ? source.padding : [];
  const padding: DocumentAutoLayout["padding"] = [
    finiteNonNegative(rawPadding[0], finiteNonNegative(source.paddingTop)),
    finiteNonNegative(rawPadding[1], finiteNonNegative(source.paddingRight)),
    finiteNonNegative(rawPadding[2], finiteNonNegative(source.paddingBottom)),
    finiteNonNegative(rawPadding[3], finiteNonNegative(source.paddingLeft)),
  ];
  const mode = source.mode === "horizontal" || source.mode === "vertical"
    ? source.mode
    : "none";
  const alignment = (candidate: unknown, counter = false): DocumentAutoLayout["primaryAlignment"] =>
    candidate === "center" || candidate === "end" || candidate === "spaceBetween"
      || (counter && candidate === "baseline") ? candidate : "start";
  const sizing = (candidate: unknown): DocumentAutoLayout["primarySizing"] =>
    candidate === "hug" || candidate === "fill" ? candidate : "fixed";
  return {
    mode,
    padding,
    itemSpacing: finiteNonNegative(source.itemSpacing),
    trackSpacing: optionalFiniteNonNegative(source.trackSpacing),
    trackAlignment: source.trackAlignment === "spaceBetween" ? "spaceBetween" : undefined,
    wrap: source.wrap === true,
    primaryAlignment: alignment(source.primaryAlignment),
    counterAlignment: alignment(source.counterAlignment, true),
    primarySizing: sizing(source.primarySizing),
    counterSizing: sizing(source.counterSizing),
    alignSelf: source.alignSelf === "start" || source.alignSelf === "center" || source.alignSelf === "end" ? source.alignSelf : undefined,
    minWidth: optionalFiniteNonNegative(source.minWidth),
    maxWidth: optionalFiniteNonNegative(source.maxWidth),
    minHeight: optionalFiniteNonNegative(source.minHeight),
    maxHeight: optionalFiniteNonNegative(source.maxHeight),
    absolute: source.absolute === true,
  };
}
