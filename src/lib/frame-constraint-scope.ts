import type { CanvasNode } from "./editor-protocol";

const FRAME_LIKE_KINDS = new Set<CanvasNode["kind"]>([
  "frame", "component", "instance", "slot", "componentSet",
]);
const TRANSPARENT_CONSTRAINT_CONTAINERS = new Set<CanvasNode["kind"]>([
  "group", "booleanOperation",
]);
const UNSUPPORTED_CONSTRAINT_KINDS = new Set<CanvasNode["kind"]>([
  "group", "booleanOperation", "section",
]);

export type ConstraintApplicability =
  | Readonly<{ status: "applicable"; frameId: string }>
  | Readonly<{ status: "auto-layout-flow"; frameId: string }>
  | Readonly<{ status: "unsupported-node" }>
  | Readonly<{ status: "no-frame" }>;

/** Resolves the same closest Frame-like owner used by Core. Groups and Boolean
 * operations are transparent ancestry; Sections and nested Frame contexts end
 * the search. In active Auto Layout, only an absolute direct child (or its
 * transparent structural subtree) keeps Constraints active. */
export function constraintApplicability(nodes: readonly CanvasNode[], node: CanvasNode): ConstraintApplicability {
  if (UNSUPPORTED_CONSTRAINT_KINDS.has(node.kind)) return { status: "unsupported-node" };
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>([node.id]);
  let directChild = node;
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return { status: "no-frame" };
    if (FRAME_LIKE_KINDS.has(parent.kind)) {
      const autoLayoutActive = Boolean(parent.autoLayout?.mode && parent.autoLayout.mode !== "none");
      return autoLayoutActive && !directChild.autoLayout?.absolute
        ? { status: "auto-layout-flow", frameId: parent.id }
        : { status: "applicable", frameId: parent.id };
    }
    if (!TRANSPARENT_CONSTRAINT_CONTAINERS.has(parent.kind)) return { status: "no-frame" };
    directChild = parent;
    parentId = parent.parentId;
  }
  return { status: "no-frame" };
}

export function hasFrameConstraintScope(nodes: readonly CanvasNode[], node: CanvasNode): boolean {
  const status = constraintApplicability(nodes, node).status;
  return status === "applicable" || status === "auto-layout-flow";
}

export function hasActiveAutoLayoutConstraintOverride(nodes: readonly CanvasNode[], node: CanvasNode): boolean {
  return constraintApplicability(nodes, node).status === "auto-layout-flow";
}
