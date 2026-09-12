import type { CanvasNode, EditorCommand } from "./editor-protocol";
import { isEffectivelyLocked } from "./hierarchy-lock";
import { movableSelectionIds } from "./selection-move-roots";
import { translateNodeWorldPatch } from "./scene-transform";
import { worldVisualBoundsForNode } from "./world-visual-bounds";

type ArrangeCommand = Extract<EditorCommand, { type: "arrange" }>;
type GeometryPatch = Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform">;
type ArrangeUpdate = { id: string; patch: Partial<CanvasNode> };

export type ArrangeResolution =
  | { ok: true; patches: Array<{ id: string; patch: GeometryPatch }>; updates: ArrangeUpdate[] }
  | { ok: false; reason: "invalid-selection" | "locked" | "auto-layout-flow" | "invalid-geometry" };

type Entry = { id: string; start: number; end: number; center: number };

/**
 * Resolves a Figma-style arrangement intent against *render* bounds, then
 * produces world-space translation patches. Keeping only concrete updates at
 * the Core boundary makes undo, remote replay and rebasing deterministic.
 */
export function resolveArrangeCommand(nodes: readonly CanvasNode[], command: ArrangeCommand): ArrangeResolution {
  if (!command.ids.length || new Set(command.ids).size !== command.ids.length) return { ok: false, reason: "invalid-selection" };
  if (command.operation === "tidyUp" && (!Number.isFinite(command.gap) || command.gap < 0)) return { ok: false, reason: "invalid-geometry" };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = selectionRoots(byId, command.ids);
  if (roots.length < 2) return { ok: false, reason: "invalid-selection" };
  if (new Set(roots.map((node) => node.pageId)).size !== 1) return { ok: false, reason: "invalid-selection" };
  if (roots.some((node) => isEffectivelyLocked(byId, node.id))) return { ok: false, reason: "locked" };
  const flowRoots = roots.filter((node) => isAutoLayoutFlowChild(byId, node));
  if (flowRoots.length) return resolveFlowChildArrange(byId, roots, command);
  const axis: "x" | "y" = command.operation === "tidyUp"
    ? command.axis === "auto" ? resolveAutoAxis(nodes, roots) : command.axis
    : command.axis;
  const entries = roots.map((node) => entryForAxis(nodes, node, axis));
  const resolvedEntries = entries.filter((entry): entry is Entry => entry !== undefined);
  if (resolvedEntries.length !== roots.length) return { ok: false, reason: "invalid-geometry" };
  const ordered = [...resolvedEntries].sort((a, b) => a.start - b.start || a.center - b.center || a.id.localeCompare(b.id));
  const targets = new Map<string, number>();
  if (command.operation === "align") {
    const primary = command.reference === "primaryNode" ? ordered.find((entry) => entry.id === roots[0]?.id) : undefined;
    const target = primary
      ? command.mode === "min" ? primary.start : command.mode === "max" ? primary.end : primary.center
      : command.mode === "min" ? Math.min(...ordered.map((entry) => entry.start))
        : command.mode === "max" ? Math.max(...ordered.map((entry) => entry.end))
          : (Math.min(...ordered.map((entry) => entry.start)) + Math.max(...ordered.map((entry) => entry.end))) / 2;
    ordered.forEach((entry) => targets.set(entry.id, target - (command.mode === "min" ? entry.start : command.mode === "max" ? entry.end : entry.center)));
  } else if (command.operation === "distribute") {
    if (ordered.length < 3) return { ok: true, patches: [], updates: [] };
    const first = ordered[0];
    const last = ordered.at(-1)!;
    if (command.mode === "edgeGap") {
      const gap = ((last.end - first.start) - ordered.reduce((sum, entry) => sum + entry.end - entry.start, 0)) / (ordered.length - 1);
      let cursor = first.start;
      ordered.forEach((entry) => { targets.set(entry.id, cursor - entry.start); cursor += entry.end - entry.start + gap; });
    } else {
      const interval = (last.center - first.center) / (ordered.length - 1);
      ordered.forEach((entry, index) => targets.set(entry.id, first.center + interval * index - entry.center));
    }
  } else {
    const anchor = command.anchor === "first" ? ordered[0].start : Math.min(...ordered.map((entry) => entry.start));
    let cursor = anchor;
    ordered.forEach((entry) => { targets.set(entry.id, cursor - entry.start); cursor += entry.end - entry.start + command.gap; });
  }
  const patches = ordered.flatMap((entry) => {
    const delta = targets.get(entry.id) ?? 0;
    if (Math.abs(delta) < 1e-9) return [];
    // A selected Group owns its Relative-v1 descendants but legacy descendants
    // still keep world x/y, so preserve the established selection-move rule.
    return [...movableSelectionIds(nodes, [entry.id])].flatMap((id) => {
      const patch = translateNodeWorldPatch(nodes, id, axis === "x" ? delta : 0, axis === "y" ? delta : 0);
      return patch ? [{ id, patch }] : [];
    });
  });
  return { ok: true, patches, updates: patches };
}

/** Only the cross axis of a common Auto Layout Frame has a lossless direct
 * equivalent for an Arrange alignment: Figma's child `alignSelf`. Primary-axis
 * and mixed-parent organization cannot be expressed without changing order or
 * container gap, so they remain atomically rejected instead of writing x/y. */
function resolveFlowChildArrange(byId: ReadonlyMap<string, CanvasNode>, roots: readonly CanvasNode[], command: ArrangeCommand): ArrangeResolution {
  const parentId = roots[0]?.parentId;
  const parent = parentId ? byId.get(parentId) : undefined;
  if (!parent || parent.kind !== "frame" || parent.autoLayout?.mode === undefined || parent.autoLayout.mode === "none"
    || roots.some((node) => node.parentId !== parentId || !isAutoLayoutFlowChild(byId, node))) return { ok: false, reason: "auto-layout-flow" };
  const crossAxis = parent.autoLayout.mode === "horizontal" ? "y" : "x";
  if (command.operation !== "align" || command.axis !== crossAxis) return { ok: false, reason: "auto-layout-flow" };
  const alignSelf: NonNullable<CanvasNode["autoLayout"]>["alignSelf"] = command.mode === "min" ? "start" : command.mode === "center" ? "center" : "end";
  const updates = roots.flatMap((node) => {
    if (node.autoLayout?.alignSelf === alignSelf) return [];
    return [{ id: node.id, patch: { autoLayout: { ...(node.autoLayout ?? defaultChildLayout()), alignSelf } } }];
  });
  return { ok: true, patches: [], updates };
}

function defaultChildLayout(): NonNullable<CanvasNode["autoLayout"]> {
  return { mode: "none", padding: [0, 0, 0, 0], itemSpacing: 0, wrap: false, primaryAlignment: "start", counterAlignment: "start", primarySizing: "fixed", counterSizing: "fixed", absolute: false };
}

function entryForAxis(nodes: readonly CanvasNode[], node: CanvasNode, axis: "x" | "y"): Entry | undefined {
  const bounds = worldVisualBoundsForNode(nodes, node);
  if (!bounds) return undefined;
  const start = axis === "x" ? bounds.left : bounds.top;
  const end = axis === "x" ? bounds.right : bounds.bottom;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { id: node.id, start, end, center: (start + end) / 2 } : undefined;
}

function resolveAutoAxis(nodes: readonly CanvasNode[], roots: readonly CanvasNode[]): "x" | "y" {
  const bounds = roots.map((node) => worldVisualBoundsForNode(nodes, node)).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const width = Math.max(...bounds.map((bound) => bound.right)) - Math.min(...bounds.map((bound) => bound.left));
  const height = Math.max(...bounds.map((bound) => bound.bottom)) - Math.min(...bounds.map((bound) => bound.top));
  return width >= height ? "x" : "y";
}

function isAutoLayoutFlowChild(byId: ReadonlyMap<string, CanvasNode>, node: CanvasNode) {
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  return parent?.kind === "frame" && parent.autoLayout?.mode !== undefined && parent.autoLayout.mode !== "none" && !node.autoLayout?.absolute;
}

function selectionRoots(byId: ReadonlyMap<string, CanvasNode>, ids: readonly string[]) {
  const selected = new Set(ids);
  return ids.flatMap((id) => {
    const node = byId.get(id);
    if (!node) return [];
    const visited = new Set<string>([id]);
    let parentId = node.parentId;
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) return [];
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return [node];
  });
}
