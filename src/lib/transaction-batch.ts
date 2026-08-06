import { createNode, documentColorFromCssHex, type CanvasNode, type CoreBatchCommand, type CoreProjectionNode, type EditorCommand } from "./editor-protocol";
import { orderNewLayerAtFront, sortNodesByLayerOrder } from "./layer-order";
import { nodePropsForWorldTransform, worldBoundsForNode, worldTransformForNode } from "./scene-transform";

export type { CoreBatchCommand, CoreProjectionNode } from "./editor-protocol";
export type ResolvedCoreBatch = { batch: CoreBatchCommand[]; nextNodes: CanvasNode[]; createdIds: string[] };

export function coreProjectionNode(node: CanvasNode): CoreProjectionNode {
  return { id: node.id, pageId: node.pageId, parentId: node.parentId, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, fills: node.fills, positionId: node.positionId, stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokes: node.strokes, strokeWidth: node.strokeWidth, strokeCapStart: node.strokeCapStart ?? "none", strokeCapEnd: node.strokeCapEnd ?? "none", strokeJoin: node.strokeJoin ?? "miter", strokeMiterLimit: node.strokeMiterLimit ?? 10, strokeDashPattern: node.strokeDashPattern ?? [], strokeWeights: node.strokeWeights, strokeAlign: node.strokeAlign ?? "inside", arcData: node.arcData, cornerRadii: node.cornerRadii, cornerSmoothing: node.cornerSmoothing, constraints: node.constraints, relativeTransform: node.relativeTransform, opacity: node.opacity, cornerRadius: node.radius ?? 0, text: node.text ?? "", textProperties: node.textProperties, visible: node.visible !== false, locked: Boolean(node.locked), contentsHidden: Boolean(node.contentsHidden), clipsContent: node.kind === "frame" ? node.clipsContent !== false : undefined, assetId: node.assetId };
}

/** Resolves UI-level partial patches to the concrete Core commands accepted by WASM.
 * A failed resolution returns nothing and deliberately leaves the caller's projection
 * untouched, matching Rust's all-or-nothing transaction boundary. */
export function resolveCoreBatch(nodes: CanvasNode[], commands: EditorCommand[], createId: () => string = () => crypto.randomUUID()): ResolvedCoreBatch | undefined {
  const nextNodes = structuredClone(nodes);
  const batch: CoreBatchCommand[] = [];
  const createdIds: string[] = [];
  for (const command of commands) {
    if (command.type === "create") {
      if (nextNodes.some((node) => node.id === command.node.id)) return undefined;
      const node = structuredClone(command.node);
      nextNodes.push(node);
      batch.push({ type: "create", node: coreProjectionNode(node) });
      createdIds.push(node.id);
      continue;
    }
    if (command.type === "update") {
      const index = nextNodes.findIndex((node) => node.id === command.id);
      if (index === -1) return undefined;
      const previous = nextNodes[index];
      // IDs and kinds are document identity, never Inspector-editable values.
      const node = { ...previous, ...command.patch, id: previous.id, kind: previous.kind };
      if ("fill" in command.patch) { node.fillColor = documentColorFromCssHex(node.fill); node.fillGradient = undefined; }
      if ("stroke" in command.patch) { node.strokeColor = documentColorFromCssHex(node.stroke); node.strokeGradient = undefined; }
      nextNodes[index] = node;
      batch.push({ type: "update", node: coreProjectionNode(node) });
      continue;
    }
    if (command.type === "delete") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !nextNodes.some((node) => node.id === id))) return undefined;
      const ids = new Set<string>();
      const ordered = (id: string) => {
        if (ids.has(id)) return;
        nextNodes.filter((node) => node.parentId === id).forEach((child) => ordered(child.id));
        ids.add(id);
      };
      command.ids.forEach(ordered);
      const subtreeIds = [...ids];
      // Core automatically dissolves an occupied Group when its final child is
      // deleted. Sending a second explicit delete for it would invalidate the
      // otherwise atomic subtree transaction.
      const coreIds = subtreeIds.filter((id) => {
        const node = nextNodes.find((candidate) => candidate.id === id);
        return node?.kind !== "group" || !nextNodes.some((candidate) => candidate.parentId === id);
      });
      nextNodes.splice(0, nextNodes.length, ...nextNodes.filter((node) => !ids.has(node.id)));
      batch.push({ type: "delete", ids: coreIds });
      continue;
    }
    if (command.type === "reposition") {
      if (!command.positionIds.length || new Set(command.positionIds.map(({ id }) => id)).size !== command.positionIds.length || command.positionIds.some(({ id, positionId }) => !nextNodes.some((node) => node.id === id) || !positionId)) return undefined;
      command.positionIds.forEach(({ id, positionId }) => {
        const index = nextNodes.findIndex((node) => node.id === id);
        nextNodes[index] = { ...nextNodes[index], positionId };
      });
      batch.push({ type: "reposition", positionIds: command.positionIds.map((entry) => ({ ...entry })) });
      continue;
    }
    if (command.type === "reparent") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length) return undefined;
      const selected = nextNodes.filter((node) => command.ids.includes(node.id));
      if (selected.length !== command.ids.length) return undefined;
      const target = command.parentId ? nextNodes.find((node) => node.id === command.parentId) : undefined;
      if (command.parentId && (!target || !["frame", "group", "section"].includes(target.kind))) return undefined;
      const pageId = selected[0].pageId;
      if (selected.some((node) => node.pageId !== pageId || (target && node.pageId !== target.pageId))) return undefined;
      const selectedIds = new Set(selected.map((node) => node.id));
      const roots = selected.filter((node) => {
        let ancestor = node.parentId;
        while (ancestor) {
          if (selectedIds.has(ancestor)) return false;
          ancestor = nextNodes.find((candidate) => candidate.id === ancestor)?.parentId;
        }
        return true;
      });
      if (!roots.length) return undefined;
      let targetAncestor = command.parentId;
      while (targetAncestor) {
        if (selectedIds.has(targetAncestor)) return undefined;
        targetAncestor = nextNodes.find((node) => node.id === targetAncestor)?.parentId;
      }
      const parentWorld = command.parentId ? worldTransformForNode(nextNodes, command.parentId) : undefined;
      if (command.parentId && !parentWorld) return undefined;
      const siblingNodes = nextNodes.filter((node) => node.pageId === pageId && node.parentId === command.parentId && !selectedIds.has(node.id));
      const reparented: CanvasNode[] = [];
      for (const node of sortNodesByLayerOrder(roots)) {
        const world = worldTransformForNode(nextNodes, node.id);
        const local = world && nodePropsForWorldTransform(world, parentWorld, node.width, node.height);
        if (!local) return undefined;
        const positionId = orderNewLayerAtFront([...siblingNodes, ...reparented], node.id);
        if (!positionId) return undefined;
        const index = nextNodes.findIndex((candidate) => candidate.id === node.id);
        nextNodes[index] = { ...nextNodes[index], ...local, parentId: command.parentId, positionId };
        reparented.push(nextNodes[index]);
      }
      reparented.forEach((node) => batch.push({ type: "update", node: coreProjectionNode(node) }));
      batch.push({ type: "reparent", parentIds: reparented.map((node) => ({ id: node.id, parentId: command.parentId, positionId: node.positionId! })) });
      continue;
    }
    if (command.type === "group") {
      const selected = nextNodes.filter((node) => command.ids.includes(node.id));
      if (selected.length < 2 || new Set(command.ids).size !== command.ids.length || selected.length !== command.ids.length) return undefined;
      const selectedIds = new Set(selected.map((node) => node.id));
      // A selected Group owns its descendants. Do not try to wrap both the
      // Group and one of its children: that would create a cycle rather than a
      // nested Group. Independent selected Groups remain normal roots and can
      // be wrapped together with sibling shapes or other Groups.
      const roots = sortNodesByLayerOrder(selected.filter((node) => !hasSelectedAncestor(nextNodes, node, selectedIds)));
      if (roots.length < 2) return undefined;
      const pageId = selected[0].pageId;
      if (roots.some((node) => node.pageId !== pageId)) return undefined;
      const parentId = nearestCommonParentId(nextNodes, roots);
      const parent = parentId ? nextNodes.find((node) => node.id === parentId) : undefined;
      if (parentId && (!parent || !["frame", "group", "section"].includes(parent.kind))) return undefined;
      const id = createId();
      if (nextNodes.some((node) => node.id === id)) return undefined;
      const bounds = roots.map((node) => worldBoundsForNode(nextNodes, node));
      if (bounds.some((bound) => !bound)) return undefined;
      const resolvedBounds = bounds as NonNullable<(typeof bounds)[number]>[];
      const left = Math.min(...resolvedBounds.map((bound) => bound.left));
      const top = Math.min(...resolvedBounds.map((bound) => bound.top));
      const right = Math.max(...resolvedBounds.map((bound) => bound.right));
      const bottom = Math.max(...resolvedBounds.map((bound) => bound.bottom));
      const siblings = nextNodes.filter((node) => node.pageId === pageId && node.parentId === parentId);
      const group = { ...createNode("group", left, top), id, pageId, parentId, width: Math.max(1, right - left), height: Math.max(1, bottom - top), positionId: orderNewLayerAtFront(siblings, id) };
      nextNodes.push(group);
      const groupWorld = worldTransformForNode(nextNodes, group.id);
      if (!groupWorld) return undefined;
      const reparented: CanvasNode[] = [];
      roots.forEach((node) => {
        const childWorld = worldTransformForNode(nextNodes, node.id);
        const local = childWorld && nodePropsForWorldTransform(childWorld, groupWorld, node.width, node.height);
        if (!local) return;
        const positionId = node.positionId && !reparented.some((candidate) => candidate.positionId === node.positionId)
          ? node.positionId
          : orderNewLayerAtFront(reparented, node.id);
        if (!positionId) return;
        const index = nextNodes.findIndex((candidate) => candidate.id === node.id);
        nextNodes[index] = { ...nextNodes[index], ...local, parentId: id, positionId };
        reparented.push(nextNodes[index]);
      });
      if (reparented.length !== roots.length) return undefined;
      batch.push({ type: "create", node: coreProjectionNode(group) });
      reparented.forEach((node) => batch.push({ type: "update", node: coreProjectionNode(node) }));
      batch.push({ type: "reparent", parentIds: reparented.map((node) => ({ id: node.id, parentId: id, positionId: node.positionId! })) });
      createdIds.push(id);
      continue;
    }
    if (command.type === "ungroup") {
      const group = nextNodes.find((node) => node.id === command.id);
      if (!group || group.kind !== "group") return undefined;
      const children = nextNodes.filter((node) => node.parentId === group.id);
      if (!children.length) return undefined;
      const parentWorld = group.parentId ? worldTransformForNode(nextNodes, group.parentId) : undefined;
      const reparented: CanvasNode[] = [];
      children.forEach((child) => {
        const childWorld = worldTransformForNode(nextNodes, child.id);
        const local = childWorld && nodePropsForWorldTransform(childWorld, parentWorld, child.width, child.height);
        if (!local) return;
        const index = nextNodes.findIndex((node) => node.id === child.id);
        nextNodes[index] = { ...nextNodes[index], ...local, parentId: group.parentId };
        reparented.push(nextNodes[index]);
      });
      if (reparented.length !== children.length) return undefined;
      nextNodes.splice(nextNodes.findIndex((node) => node.id === group.id), 1);
      reparented.forEach((node) => batch.push({ type: "update", node: coreProjectionNode(node) }));
      batch.push({ type: "reparent", parentIds: children.map((node) => ({ id: node.id, parentId: group.parentId, positionId: node.positionId ?? orderNewLayerAtFront([], node.id) ?? `${node.id.replaceAll("-", "")}:00000000000000000000000000000000` })) });
      // The Core dissolves a Group when its final child leaves. Keeping this
      // as only a parent move makes the history entry atomic and replayable.
      continue;
    }
    if (command.type === "duplicate") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !nextNodes.some((node) => node.id === id))) return undefined;
      // Figma duplicates selected roots, not just their container records. A
      // Group/Frame/Section copy must therefore bring along its complete
      // subtree, remapping every internal parent reference to the new IDs.
      // When both an ancestor and descendant are selected, the ancestor owns
      // the copy and the descendant is never duplicated twice.
      const sourceDocument = structuredClone(nextNodes);
      const requestedIds = new Set(command.ids);
      const selectedRoots = sortNodesByLayerOrder(sourceDocument.filter((node) => requestedIds.has(node.id)).filter((node) => !hasSelectedAncestor(sourceDocument, node, requestedIds)));
      const copiedIds = new Set<string>();
      for (const root of selectedRoots) {
        const subtree = subtreeNodes(sourceDocument, root.id);
        if (!subtree.length) return undefined;
        const idMap = new Map<string, string>();
        for (const source of subtree) {
          const id = createId();
          if (copiedIds.has(id) || nextNodes.some((node) => node.id === id)) return undefined;
          copiedIds.add(id);
          idMap.set(source.id, id);
        }
        for (const source of subtree) {
          const id = idMap.get(source.id);
          if (!id) return undefined;
          const isRoot = source.id === root.id;
          const parentId = source.parentId && idMap.get(source.parentId) ? idMap.get(source.parentId) : source.parentId;
          let copy: CanvasNode = { ...source, id, parentId };
          if (isRoot) {
            const siblings = nextNodes.filter((node) => node.pageId === source.pageId && node.parentId === source.parentId);
            const positionId = orderNewLayerAtFront(siblings, id);
            if (!positionId) return undefined;
            copy = { ...copy, name: `${source.name} copy`, positionId, ...duplicateRootOffset(sourceDocument, source) };
          } else if (!source.relativeTransform) {
            // Legacy descendants retain world-space geometry. Relative-v1
            // descendants inherit the translated copied ancestor instead.
            copy = { ...copy, x: source.x + 24, y: source.y + 24 };
          }
          nextNodes.push(copy);
          batch.push({ type: "create", node: coreProjectionNode(copy) });
          if (isRoot) createdIds.push(copy.id);
        }
      }
      continue;
    }
    return undefined;
  }
  return batch.length ? { batch, nextNodes, createdIds } : undefined;
}

function hasSelectedAncestor(nodes: readonly CanvasNode[], node: CanvasNode, selectedIds: ReadonlySet<string>) {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    if (selectedIds.has(parentId)) return true;
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

/** Returns the closest shared container (or the page root) for a wrap action. */
function nearestCommonParentId(nodes: readonly CanvasNode[], roots: readonly CanvasNode[]): string | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestorChain = (node: CanvasNode) => {
    const chain: Array<string | undefined> = [];
    const visited = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      chain.push(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    chain.push(undefined);
    return chain;
  };
  const [first, ...rest] = roots.map(ancestorChain);
  return first?.find((candidate) => rest.every((chain) => chain.includes(candidate)));
}

/** Parent-first order lets a Core create a copied Group before its children. */
function subtreeNodes(nodes: readonly CanvasNode[], rootId: string): CanvasNode[] {
  const byParent = new Map<string, CanvasNode[]>();
  nodes.forEach((node) => {
    if (!node.parentId) return;
    const children = byParent.get(node.parentId) ?? [];
    children.push(node);
    byParent.set(node.parentId, children);
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: CanvasNode[] = [];
  const visit = (id: string, visited = new Set<string>()) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    result.push(node);
    sortNodesByLayerOrder(byParent.get(id) ?? []).forEach((child) => visit(child.id, visited));
  };
  visit(rootId);
  return result;
}

/** Applies Figma-style duplicate displacement without breaking Relative-v1 roots. */
function duplicateRootOffset(nodes: readonly CanvasNode[], source: CanvasNode): Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform"> {
  if (!source.relativeTransform) return { x: source.x + 24, y: source.y + 24, rotation: source.rotation, relativeTransform: undefined };
  const world = worldTransformForNode(nodes, source.id);
  const parentWorld = source.parentId ? worldTransformForNode(nodes, source.parentId) : undefined;
  const translated = world && { ...world, e: world.e + 24, f: world.f + 24 };
  const offset = translated && nodePropsForWorldTransform(translated, parentWorld, source.width, source.height);
  return offset ?? { x: source.x + 24, y: source.y + 24, rotation: source.rotation, relativeTransform: source.relativeTransform };
}
