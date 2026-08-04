import { documentColorFromCssHex, type CanvasNode, type EditorCommand } from "./editor-protocol";

export type CoreProjectionNode = Pick<CanvasNode, "id" | "name" | "kind" | "x" | "y" | "width" | "height" | "rotation" | "fill" | "fillColor" | "fillGradient" | "positionId" | "stroke" | "strokeColor" | "strokeGradient" | "strokeWidth" | "opacity" | "visible" | "locked"> & { cornerRadius: number; text: string };
export type CoreBatchCommand = { type: "create"; node: CoreProjectionNode } | { type: "update"; node: CoreProjectionNode } | { type: "delete"; ids: string[] };
export type ResolvedCoreBatch = { batch: CoreBatchCommand[]; nextNodes: CanvasNode[]; createdIds: string[] };

function projectionNode(node: CanvasNode): CoreProjectionNode {
  return { id: node.id, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, positionId: node.positionId, stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokeWidth: node.strokeWidth, opacity: node.opacity, cornerRadius: node.radius, text: node.text ?? "", visible: node.visible !== false, locked: Boolean(node.locked) };
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
      batch.push({ type: "create", node: projectionNode(node) });
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
      batch.push({ type: "update", node: projectionNode(node) });
      continue;
    }
    if (command.type === "delete") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !nextNodes.some((node) => node.id === id))) return undefined;
      nextNodes.splice(0, nextNodes.length, ...nextNodes.filter((node) => !command.ids.includes(node.id)));
      batch.push({ type: "delete", ids: command.ids });
      continue;
    }
    if (command.type === "duplicate") {
      if (!command.ids.length || new Set(command.ids).size !== command.ids.length || command.ids.some((id) => !nextNodes.some((node) => node.id === id))) return undefined;
      const copies = nextNodes.filter((node) => command.ids.includes(node.id)).map((node, index) => ({ ...node, id: createId(), name: `${node.name} copy`, x: node.x + 24 + index * 8, y: node.y + 24 + index * 8 }));
      if (new Set(copies.map((node) => node.id)).size !== copies.length || copies.some((node) => nextNodes.some((current) => current.id === node.id))) return undefined;
      copies.forEach((node) => {
        nextNodes.push(node);
        batch.push({ type: "create", node: projectionNode(node) });
        createdIds.push(node.id);
      });
      continue;
    }
    return undefined;
  }
  return batch.length ? { batch, nextNodes, createdIds } : undefined;
}
