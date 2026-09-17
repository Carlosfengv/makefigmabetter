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

const optionalGridSpan = (value: unknown) =>
  value === null || value === undefined || value === 1
    ? undefined
    : typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 128
      ? value
      : undefined;

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
  const mode = source.mode === "horizontal" || source.mode === "vertical" || source.mode === "grid"
    ? source.mode
    : "none";
  const alignment = (candidate: unknown, counter = false): DocumentAutoLayout["primaryAlignment"] =>
    candidate === "center" || candidate === "end" || candidate === "spaceBetween"
      || (counter && candidate === "baseline") ? candidate : "start";
  const sizing = (candidate: unknown): DocumentAutoLayout["primarySizing"] =>
    candidate === "hug" || candidate === "fill" ? candidate : "fixed";
  const gridAnchor = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 && candidate < 128
      ? candidate
      : undefined;
  const rowAnchor = gridAnchor(source.gridRowAnchor);
  const columnAnchor = gridAnchor(source.gridColumnAnchor);
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
    gridRows: mode === "grid" ? normalizeGridTracks(source.gridRows) : undefined,
    gridColumns: mode === "grid" ? normalizeGridTracks(source.gridColumns) : undefined,
    gridRowGap: mode === "grid" ? optionalFiniteNonNegative(source.gridRowGap) ?? 0 : undefined,
    gridColumnGap: mode === "grid" ? optionalFiniteNonNegative(source.gridColumnGap) ?? 0 : undefined,
    gridRowSpan: optionalGridSpan(source.gridRowSpan),
    gridColumnSpan: optionalGridSpan(source.gridColumnSpan),
    gridItemsPositioning: mode === "grid" && source.gridItemsPositioning === "manual" ? "manual" : undefined,
    gridAutoTracks: mode === "grid" && source.gridAutoTracks === "rows" ? "rows" : undefined,
    gridChildHorizontalAlign: source.gridChildHorizontalAlign === "min" || source.gridChildHorizontalAlign === "center" || source.gridChildHorizontalAlign === "max" ? source.gridChildHorizontalAlign : undefined,
    gridChildVerticalAlign: source.gridChildVerticalAlign === "min" || source.gridChildVerticalAlign === "center" || source.gridChildVerticalAlign === "max" ? source.gridChildVerticalAlign : undefined,
    gridRowAnchor: rowAnchor !== undefined && columnAnchor !== undefined ? rowAnchor : undefined,
    gridColumnAnchor: rowAnchor !== undefined && columnAnchor !== undefined ? columnAnchor : undefined,
  };
}

/** A structural aggregate inside an active Auto Layout parent must stay out
 * of flow so its precomputed union bounds remain authoritative. */
export function absoluteStructuralChildAutoLayout(): DocumentAutoLayout {
  return {
    mode: "none",
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    wrap: false,
    primaryAlignment: "start",
    counterAlignment: "start",
    primarySizing: "fixed",
    counterSizing: "fixed",
    absolute: true,
  };
}

/** A bounded structural aggregate can remain in a linear flow only when it
 * replaces every flow child. The wrapper then owns the former children'
 * internal spacing while the parent continues to position one fixed item. */
export function flowStructuralChildAutoLayout(): DocumentAutoLayout {
  return {
    ...absoluteStructuralChildAutoLayout(),
    absolute: false,
  };
}

export type StructuralAggregateLayoutAdmission = Readonly<{
  kind: "absolute" | "flow";
  autoLayout: DocumentAutoLayout;
}>;

type StructuralAggregateLayoutNode = Readonly<{
  id: string;
  autoLayout?: DocumentAutoLayout | null;
  relativeTransform?: unknown;
  rotation?: unknown;
  width?: unknown;
  height?: unknown;
  visible?: unknown;
}>;

/** Returns the only child-layout record that keeps a structural replacement
 * valid inside an active Auto Layout owner. Absolute sources preserve the
 * existing out-of-flow contract. The flow subset is deliberately limited to
 * all visible, axis-aligned, fixed-size children of one non-wrapping linear
 * owner; partial flow aggregation would change gap and alignment semantics. */
export function structuralAggregateLayoutAdmission(
  parentValue: DocumentAutoLayout | null | undefined,
  sources: readonly StructuralAggregateLayoutNode[],
  siblings: readonly StructuralAggregateLayoutNode[],
): StructuralAggregateLayoutAdmission | undefined {
  const parent = normalizeAutoLayout(parentValue ?? undefined);
  if (!parent || !["horizontal", "vertical"].includes(parent.mode) || !sources.length) return undefined;
  const sourceIds = new Set(sources.map((source) => source.id));
  if (sourceIds.size !== sources.length) return undefined;
  if (sources.every((source) => normalizeAutoLayout(source.autoLayout ?? undefined)?.absolute === true)) {
    return { kind: "absolute", autoLayout: absoluteStructuralChildAutoLayout() };
  }
  if (
    parent.wrap
    || parent.primaryAlignment === "spaceBetween"
    || parent.counterAlignment === "spaceBetween"
    || parent.counterAlignment === "baseline"
  ) return undefined;
  const flowSiblings = siblings.filter((sibling) => normalizeAutoLayout(sibling.autoLayout ?? undefined)?.absolute !== true);
  if (flowSiblings.length !== sources.length || flowSiblings.some((sibling) => !sourceIds.has(sibling.id))) return undefined;
  for (const source of sources) {
    const layout = normalizeAutoLayout(source.autoLayout ?? undefined);
    if (
      (layout && (layout.mode !== "none" || layout.absolute || layout.primarySizing !== "fixed" || layout.counterSizing !== "fixed" || layout.alignSelf !== undefined))
      || source.relativeTransform != null
      || (source.rotation !== undefined && source.rotation !== 0)
      || source.visible === false
      || typeof source.width !== "number"
      || !Number.isFinite(source.width)
      || source.width < 0
      || typeof source.height !== "number"
      || !Number.isFinite(source.height)
      || source.height < 0
    ) return undefined;
  }
  return { kind: "flow", autoLayout: flowStructuralChildAutoLayout() };
}

/** A complete structural-container replacement keeps one existing layout
 * slot, so it may preserve that slot's fixed child record without requiring
 * every sibling in the parent's flow to participate. */
export function structuralReplacementLayoutAdmission(
  parentValue: DocumentAutoLayout | null | undefined,
  source: StructuralAggregateLayoutNode,
): StructuralAggregateLayoutAdmission | undefined {
  const parent = normalizeAutoLayout(parentValue ?? undefined);
  if (!parent || !["horizontal", "vertical", "grid"].includes(parent.mode)) return undefined;
  const sourceLayout = normalizeAutoLayout(source.autoLayout ?? undefined) ?? flowStructuralChildAutoLayout();
  if (
    sourceLayout.mode !== "none"
    || sourceLayout.primarySizing !== "fixed"
    || sourceLayout.counterSizing !== "fixed"
    || sourceLayout.alignSelf !== undefined
    || typeof source.width !== "number"
    || !Number.isFinite(source.width)
    || source.width < 0
    || typeof source.height !== "number"
    || !Number.isFinite(source.height)
    || source.height < 0
  ) return undefined;
  if (!sourceLayout.absolute && (source.relativeTransform != null || (source.rotation !== undefined && source.rotation !== 0))) return undefined;
  return { kind: sourceLayout.absolute ? "absolute" : "flow", autoLayout: sourceLayout };
}

export function matchesStructuralAggregateChildLayout(
  value: DocumentAutoLayout | null | undefined,
  kind: StructuralAggregateLayoutAdmission["kind"],
): boolean {
  const layout = normalizeAutoLayout(value ?? undefined);
  // Core elides its stable default record. Absence therefore represents a
  // fixed, non-absolute flow child rather than an unknown layout contract.
  if (!layout) return kind === "flow";
  return Boolean(layout
    && layout.mode === "none"
    && layout.absolute === (kind === "absolute")
    && layout.primarySizing === "fixed"
    && layout.counterSizing === "fixed"
    && layout.alignSelf === undefined);
}

export function matchesStructuralReplacementLayout(
  value: DocumentAutoLayout | null | undefined,
  admission: StructuralAggregateLayoutAdmission,
): boolean {
  const actual = normalizeAutoLayout(value ?? undefined) ?? flowStructuralChildAutoLayout();
  const expected = normalizeAutoLayout(admission.autoLayout)!;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function normalizeGridTracks(value: unknown): DocumentAutoLayout["gridRows"] {
  if (!Array.isArray(value)) return [{ type: "flex", value: 1 }];
  const tracks: NonNullable<DocumentAutoLayout["gridRows"]> = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const { type, value } = candidate as { type?: unknown; value?: unknown };
    if (type === "hug") tracks.push({ type });
    else if (type === "fixed" && typeof value === "number" && Number.isFinite(value) && value >= 0) tracks.push({ type, value });
    else if (type === "flex" && typeof value === "number" && Number.isFinite(value) && value > 0) tracks.push({ type, value });
  }
  return tracks.length ? tracks.slice(0, 128) : [{ type: "flex", value: 1 }];
}
