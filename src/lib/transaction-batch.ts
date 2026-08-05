import { documentColorFromCssHex, type CanvasNode, type CoreBatchCommand, type CoreProjectionNode, type EditorCommand } from "./editor-protocol";
import { orderNewLayerAtFront } from "./layer-order";

export type { CoreBatchCommand, CoreProjectionNode } from "./editor-protocol";
export type ResolvedCoreBatch = { batch: CoreBatchCommand[]; nextNodes: CanvasNode[]; createdIds: string[] };

export function coreProjectionNode(node: CanvasNode): CoreProjectionNode {
  return { id: node.id, pageId: node.pageId, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, positionId: node.positionId, stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokeWidth: node.strokeWidth, opacity: node.opacity, cornerRadius: node.radius, text: node.text ?? "", textProperties: node.textProperties, visible: node.visible !== false, locked: Boolean(node.locked), assetId: node.assetId };
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
      nextNodes.splice(0, nextNodes.length, ...nextNodes.filter((node) => !command.ids.includes(node.id)));
      batch.push({ type: "delete", ids: command.ids });
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
    if (command.type === "duplicate") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !nextNodes.some((node) => node.id === id))) return undefined;
      const sourceNodes = nextNodes.filter((node) => command.ids.includes(node.id));
      const copies: CanvasNode[] = [];
      for (const [index, source] of sourceNodes.entries()) {
        const id = createId();
        if (copies.some((node) => node.id === id) || nextNodes.some((node) => node.id === id)) return undefined;
        const pageId = source.pageId;
        const siblings = nextNodes.filter((node) => node.pageId === pageId);
        const positionId = orderNewLayerAtFront(siblings, id);
        copies.push({ ...source, id, name: `${source.name} copy`, x: source.x + 24 + index * 8, y: source.y + 24 + index * 8, positionId });
        const node = copies.at(-1)!;
        nextNodes.push(node);
        batch.push({ type: "create", node: coreProjectionNode(node) });
        createdIds.push(node.id);
      }
      continue;
    }
    return undefined;
  }
  return batch.length ? { batch, nextNodes, createdIds } : undefined;
}
