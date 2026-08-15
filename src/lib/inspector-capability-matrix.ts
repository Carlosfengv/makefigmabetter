import type { CanvasNode } from "./editor-protocol";
import { mixedInspectorCapabilities } from "./inspector-capabilities";
import { mixedSelectionValue } from "./mixed-selection";
import { resolvedStrokeWeights } from "./stroke-weight-selection";
import { resolvedCornerRadii } from "./corner-radius-selection";

/**
 * The multi-select Inspector resolves every control to exactly one of three
 * states, never a silently-writable value on a heterogeneous selection:
 *   - `notApplicable`: at least one selected node cannot accept the control at
 *     all (the capability boundary from `mixedInspectorCapabilities`).
 *   - `mixed`: every node accepts the control, but the resolved values differ,
 *     so the field shows "Mixed" and requires an explicit edit before writing.
 *   - `same`: every node accepts the control and shares one resolved value.
 *
 * Centralising this here keeps the applicability decision (which node kinds can
 * accept a write) and the value decision (do they currently agree) from drifting
 * apart across React sections, and gives the capability matrix a single testable
 * tri-state per cell.
 */
export type InspectorCapabilityState = "notApplicable" | "mixed" | "same";

export type InspectorCapabilityMatrix = Readonly<Record<InspectorCapabilityField, InspectorCapabilityState>>;

export type InspectorCapabilityField =
  | "fill"
  | "strokeWidth"
  | "strokeAlign"
  | "perSideStroke"
  | "corners"
  | "strokeDetails"
  | "lineStroke"
  | "frameClip"
  | "sectionContents"
  | "dropShadow";

type MatrixNode = Pick<CanvasNode,
  | "kind" | "arcData" | "fill" | "strokeWidth" | "strokeAlign" | "strokeWeights"
  | "radius" | "cornerRadii" | "cornerSmoothing" | "strokeJoin" | "strokeMiterLimit"
  | "strokeDashPattern" | "strokeCapStart" | "strokeCapEnd" | "clipsContent" | "contentsHidden" | "dropShadow">;

/** A comparable digest of each field's writable value for a single node. Tuple
 * and compound fields (per-side weights, stroke details, caps) are serialized so
 * two selections agree only when every constituent value matches. */
const fieldValue: Record<InspectorCapabilityField, (node: MatrixNode) => string> = {
  fill: (node) => String(node.fill ?? ""),
  strokeWidth: (node) => String(node.strokeWidth ?? 0),
  strokeAlign: (node) => node.strokeAlign ?? "inside",
  perSideStroke: (node) => resolvedStrokeWeights(node).join(","),
  corners: (node) => `${resolvedCornerRadii(node).join(",")}:${node.cornerSmoothing ?? 0}`,
  strokeDetails: (node) => `${node.strokeJoin ?? "miter"}:${node.strokeMiterLimit ?? 10}:${(node.strokeDashPattern ?? []).join(",")}`,
  lineStroke: (node) => `${node.strokeCapStart ?? "none"}:${node.strokeCapEnd ?? "none"}:${(node.strokeDashPattern ?? []).join(",")}`,
  frameClip: (node) => String(node.clipsContent !== false),
  sectionContents: (node) => String(Boolean(node.contentsHidden)),
  dropShadow: (node) => JSON.stringify(node.dropShadow ?? null),
};

/**
 * Resolves the Same/Mixed/NotApplicable state of every Inspector control for a
 * selection. Applicability comes from `mixedInspectorCapabilities`; when a
 * control is applicable, its value agreement is compared with the same
 * `mixedSelectionValue` rule the individual sections use.
 */
export function inspectorCapabilityMatrix(nodes: readonly MatrixNode[]): InspectorCapabilityMatrix {
  const capabilities = mixedInspectorCapabilities(nodes);
  const resolve = (field: InspectorCapabilityField): InspectorCapabilityState => {
    if (!capabilities[field]) return "notApplicable";
    return mixedSelectionValue(nodes.map(fieldValue[field])).kind === "same" ? "same" : "mixed";
  };
  return {
    fill: resolve("fill"),
    strokeWidth: resolve("strokeWidth"),
    strokeAlign: resolve("strokeAlign"),
    perSideStroke: resolve("perSideStroke"),
    corners: resolve("corners"),
    strokeDetails: resolve("strokeDetails"),
    lineStroke: resolve("lineStroke"),
    frameClip: resolve("frameClip"),
    sectionContents: resolve("sectionContents"),
    dropShadow: resolve("dropShadow"),
  };
}

/** Human-readable control label for each field, used by the screen-reader
 * announcement so a non-visual user hears the same tri-state the sighted
 * Inspector renders. */
const FIELD_LABEL: Record<InspectorCapabilityField, string> = {
  fill: "Fill",
  strokeWidth: "Stroke width",
  strokeAlign: "Stroke align",
  perSideStroke: "Per-side stroke",
  corners: "Corner radius",
  strokeDetails: "Stroke details",
  lineStroke: "Line endpoints",
  frameClip: "Clip content",
  sectionContents: "Section contents",
  dropShadow: "Drop shadow",
};

const FIELD_ORDER: readonly InspectorCapabilityField[] = [
  "fill", "strokeWidth", "strokeAlign", "perSideStroke", "corners", "strokeDetails", "lineStroke", "frameClip", "sectionContents", "dropShadow",
];

/**
 * Builds the polite live-region sentence the multi-select Inspector announces on
 * every selection change. It reports, in one utterance, which controls a screen
 * reader user can edit (Same), which need an explicit value first (Mixed), and
 * which do not apply to the whole selection (NotApplicable) — so the tri-state
 * is conveyed non-visually, not just through the visible layout. Deriving it
 * from the same `inspectorCapabilityMatrix` the UI uses keeps the announcement
 * from drifting away from what is actually rendered.
 */
export function inspectorCapabilityAnnouncement(nodes: readonly MatrixNode[]): string {
  if (nodes.length === 0) return "No layers selected.";
  const matrix = inspectorCapabilityMatrix(nodes);
  const editable = FIELD_ORDER.filter((field) => matrix[field] === "same").map((field) => FIELD_LABEL[field]);
  const mixed = FIELD_ORDER.filter((field) => matrix[field] === "mixed").map((field) => FIELD_LABEL[field]);
  const notApplicable = FIELD_ORDER.filter((field) => matrix[field] === "notApplicable").map((field) => FIELD_LABEL[field]);
  const clauses = [`${nodes.length} layers selected.`];
  clauses.push(editable.length ? `Editable: ${editable.join(", ")}.` : "No shared editable controls.");
  if (mixed.length) clauses.push(`Mixed values: ${mixed.join(", ")}.`);
  if (notApplicable.length) clauses.push(`Not applicable: ${notApplicable.join(", ")}.`);
  return clauses.join(" ");
}
