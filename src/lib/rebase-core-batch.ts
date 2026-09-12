import type { CanvasNode, CoreBatchCommand, CoreProjectionNode } from "./editor-protocol";
import { orderNewLayerAtFront } from "./layer-order";

const defaultPageId = "00000000-0000-0000-0000-000000000001";

/** Reassigns only position keys that collide with an authoritative remote
 * snapshot. Node IDs and all semantic fields remain unchanged, so later local
 * operations can still refer to the same objects after reconciliation. */
export function rebaseCoreBatchForSnapshot(currentNodes: readonly CanvasNode[], batch: readonly CoreBatchCommand[]): CoreBatchCommand[] {
  const planned: CanvasNode[] = structuredClone([...currentNodes]);
  return batch.map((command) => {
    if (command.type === "create" || command.type === "restore") {
      const node = structuredClone(command.node);
      const pageId = node.pageId ?? defaultPageId;
      if (node.positionId && planned.some((candidate) => (candidate.pageId ?? defaultPageId) === pageId && candidate.positionId === node.positionId)) {
        node.positionId = orderNewLayerAtFront(planned.filter((candidate) => (candidate.pageId ?? defaultPageId) === pageId), node.id);
      }
      planned.push(canvasNode(node));
      return { type: command.type, node };
    }
    if (command.type === "delete") {
      const ids = new Set(command.ids);
      planned.splice(0, planned.length, ...planned.filter((node) => !ids.has(node.id)));
      return { type: "delete", ids: [...command.ids] };
    }
    if (command.type === "update") {
      const node = structuredClone(command.node);
      const index = planned.findIndex((candidate) => candidate.id === node.id);
      if (index >= 0) planned[index] = { ...planned[index], ...canvasNode(node), id: planned[index].id, kind: planned[index].kind };
      return { type: "update", node };
    }
    if (command.type === "createPage" || command.type === "registerAsset" || command.type === "moveVectorPoint" || command.type === "setVectorSubpathClosed" || command.type === "insertVectorPoint" || command.type === "splitVectorSegment" || command.type === "connectVectorEndpoints" || command.type === "setMask" || command.type === "deleteVectorPoint" || command.type === "setVectorPointHandles" || command.type === "setExtensions") {
      return { ...command };
    }
    if (command.type === "reparent") {
      const parentIds = command.parentIds.map((entry) => {
        const index = planned.findIndex((node) => node.id === entry.id);
        if (index >= 0) planned[index] = { ...planned[index], parentId: entry.parentId, positionId: entry.positionId };
        return { ...entry };
      });
      return { type: "reparent", parentIds };
    }
    const moving = new Set(command.positionIds.map((entry) => entry.id));
    const retained = planned.filter((node) => !moving.has(node.id));
    const positionIds = command.positionIds.map((entry) => {
      const node = planned.find((candidate) => candidate.id === entry.id);
      const pageId = node?.pageId ?? defaultPageId;
      const collision = retained.some((candidate) => (candidate.pageId ?? defaultPageId) === pageId && candidate.positionId === entry.positionId);
      const positionId = collision ? orderNewLayerAtFront(retained.filter((candidate) => (candidate.pageId ?? defaultPageId) === pageId), entry.id) ?? entry.positionId : entry.positionId;
      if (node) retained.push({ ...node, positionId });
      return { id: entry.id, positionId };
    });
    planned.splice(0, planned.length, ...retained);
    return { type: "reposition", positionIds };
  });
}

function canvasNode(node: CoreProjectionNode): CanvasNode {
  return {
    id: node.id, pageId: node.pageId, parentId: node.parentId, name: node.name, kind: node.kind, x: node.x, y: node.y,
    width: node.width, height: node.height, rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fills: node.fills,
    fillGradient: node.fillGradient, positionId: node.positionId, stroke: node.stroke, strokeColor: node.strokeColor, strokes: node.strokes,
    strokeGradient: node.strokeGradient, strokeWidth: node.strokeWidth, strokeCapStart: node.strokeCapStart, strokeCapEnd: node.strokeCapEnd, radius: node.cornerRadius, cornerRadii: node.cornerRadii, cornerSmoothing: node.cornerSmoothing, constraints: node.constraints, opacity: node.opacity,
    text: node.text, textProperties: node.textProperties, assetId: node.assetId, visible: node.visible, locked: node.locked, isMask: node.isMask,
  };
}
