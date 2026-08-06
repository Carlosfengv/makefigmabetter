import type { CanvasNode } from "./editor-protocol";
import { mixedSelectionValue, type MixedSelectionValue } from "./mixed-selection";

export type LineSelectionAppearance = Readonly<{
  strokeCapStart: MixedSelectionValue<NonNullable<CanvasNode["strokeCapStart"]>>;
  strokeCapEnd: MixedSelectionValue<NonNullable<CanvasNode["strokeCapEnd"]>>;
  strokeJoin: MixedSelectionValue<NonNullable<CanvasNode["strokeJoin"]>>;
  strokeMiterLimit: MixedSelectionValue<number>;
  strokeDashPattern: MixedSelectionValue<string>;
}>;

export type StrokeSelectionAppearance = Readonly<{
  strokeJoin: MixedSelectionValue<NonNullable<CanvasNode["strokeJoin"]>>;
  strokeMiterLimit: MixedSelectionValue<number>;
  strokeDashPattern: MixedSelectionValue<string>;
}>;

/** Parses the Inspector's comma-separated Dash input at the browser boundary.
 * Core remains the authoritative validator; this only avoids minting a known
 * invalid UI transaction and applies its documented odd-array normalization. */
export function parseLineDashPattern(value: string): number[] | undefined {
  const source = value.trim();
  if (!source) return [];
  const pattern = source.split(",").map((part) => Number(part.trim()));
  if (!pattern.length || pattern.length > 32 || !pattern.every((segment) => Number.isFinite(segment) && segment >= 0) || !pattern.some((segment) => segment > 0)) return undefined;
  return pattern.length % 2 === 0 ? pattern : [...pattern, ...pattern];
}

/** Returns editable common stroke properties only for an all-Line selection.
 * Any other node kind is deliberately NotApplicable rather than silently
 * applying endpoint-only properties to closed shapes or containers. */
export function lineSelectionAppearance(nodes: readonly CanvasNode[]): LineSelectionAppearance | undefined {
  if (!nodes.length || !nodes.every((node) => node.kind === "line")) return undefined;
  return {
    strokeCapStart: mixedSelectionValue(nodes.map((node) => node.strokeCapStart ?? "none")),
    strokeCapEnd: mixedSelectionValue(nodes.map((node) => node.strokeCapEnd ?? "none")),
    strokeJoin: mixedSelectionValue(nodes.map((node) => node.strokeJoin ?? "miter")),
    strokeMiterLimit: mixedSelectionValue(nodes.map((node) => node.strokeMiterLimit ?? 10)),
    strokeDashPattern: mixedSelectionValue(nodes.map((node) => (node.strokeDashPattern ?? []).join(", "))),
  };
}

/** Shared closed/open Stroke fields. Caps intentionally remain Line-only. */
export function strokeSelectionAppearance(nodes: readonly CanvasNode[]): StrokeSelectionAppearance | undefined {
  if (!nodes.length || nodes.some((node) => node.kind === "group" || node.kind === "text")) return undefined;
  return {
    strokeJoin: mixedSelectionValue(nodes.map((node) => node.strokeJoin ?? "miter")),
    strokeMiterLimit: mixedSelectionValue(nodes.map((node) => node.strokeMiterLimit ?? 10)),
    strokeDashPattern: mixedSelectionValue(nodes.map((node) => (node.strokeDashPattern ?? []).join(", "))),
  };
}
