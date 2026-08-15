import type { CanvasNode, CoreProjectionNode } from "./editor-protocol";

/** Restores the browser rendering projection from the Canonical WASM snapshot.
 * Keep Core-owned appearance values here so a post-commit snapshot cannot
 * silently reset an Inspector control to its browser-side default. */
export function canvasNodeFromWasmProjection(node: CoreProjectionNode): CanvasNode {
  return {
    id: node.id, pageId: node.pageId, parentId: node.parentId, name: node.name, kind: node.kind, x: node.x, y: node.y, width: node.width, height: node.height,
    rotation: node.rotation, fill: node.fill, fillColor: node.fillColor, fillGradient: node.fillGradient, fills: node.fills, positionId: node.positionId,
    stroke: node.stroke, strokeColor: node.strokeColor, strokeGradient: node.strokeGradient, strokes: node.strokes, strokeWidth: node.strokeWidth, strokeCapStart: node.strokeCapStart, strokeCapEnd: node.strokeCapEnd, strokeJoin: node.strokeJoin, strokeMiterLimit: node.strokeMiterLimit, strokeDashPattern: node.strokeDashPattern, strokeWeights: node.strokeWeights?.length === 4 ? [node.strokeWeights[0], node.strokeWeights[1], node.strokeWeights[2], node.strokeWeights[3]] : undefined, strokeAlign: node.strokeAlign, arcData: node.arcData, parametricShape: node.parametricShape, vectorPath: node.vectorPath, booleanOperation: node.booleanOperation, relativeTransform: node.relativeTransform, clipsContent: node.clipsContent,
    radius: node.cornerRadius, cornerRadii: node.cornerRadii?.length === 4 ? [node.cornerRadii[0], node.cornerRadii[1], node.cornerRadii[2], node.cornerRadii[3]] : undefined, cornerSmoothing: node.cornerSmoothing, constraints: node.constraints, autoLayout: node.autoLayout, opacity: node.opacity, blendMode: node.blendMode, dropShadow: node.dropShadow, effectStack: node.effectStack, text: node.text, textProperties: node.textProperties, assetId: node.assetId, visible: node.visible, locked: node.locked, contentsHidden: node.contentsHidden, isMask: node.isMask, extensions: node.extensions,
  };
}
