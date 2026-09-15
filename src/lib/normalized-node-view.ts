import type { CanvasNode, DocumentEffect, DocumentPaint, DocumentPaintLayer, RelativeTransform } from "./editor-protocol";

/**
 * Read-only compatibility view for render, hit-test and export consumers.
 * New ordered fields win when non-empty; otherwise the historical singular
 * field remains authoritative. This projection never rewrites Canonical data.
 */
export type NormalizedNodeView = Readonly<{
  fills: readonly DocumentPaint[];
  strokes: readonly DocumentPaint[];
  effects: readonly DocumentEffect[];
  transform: Readonly<
    | { source: "relative-v1"; value: RelativeTransform }
    | { source: "legacy-world"; value: Readonly<{ x: number; y: number; rotation: number }> }
  >;
}>;

function legacyLayers(paints: readonly DocumentPaint[]): readonly DocumentPaintLayer[] {
  return paints.map((paint) => ({ paint, visible: true, opacity: 1, blendMode: "normal" }));
}

export function normalizedFillLayers(node: CanvasNode): readonly DocumentPaintLayer[] {
  if (node.fillStack !== undefined) {
    return node.fillStack.layers.filter((layer) => layer.visible && layer.opacity > 0);
  }
  return legacyLayers(node.fills?.length
    ? node.fills
    : [{ css: node.fill, color: node.fillColor, gradient: node.fillGradient }]);
}

export function normalizedStrokeLayers(node: CanvasNode): readonly DocumentPaintLayer[] {
  if (node.strokeStack !== undefined) {
    return node.strokeStack.layers.filter((layer) => layer.visible && layer.opacity > 0);
  }
  return legacyLayers(node.strokes?.length
    ? node.strokes
    : [{ css: node.stroke, color: node.strokeColor, gradient: node.strokeGradient }]);
}

export function normalizedNodeTransform(
  node: Pick<CanvasNode, "x" | "y" | "rotation" | "relativeTransform">,
): NormalizedNodeView["transform"] {
  return node.relativeTransform
    ? { source: "relative-v1", value: node.relativeTransform }
    : { source: "legacy-world", value: { x: node.x, y: node.y, rotation: node.rotation } };
}

export function normalizedFillPaints(node: CanvasNode): readonly DocumentPaint[] {
  if (node.fillStack === undefined) {
    return node.fills?.length
      ? node.fills
      : [{ css: node.fill, color: node.fillColor, gradient: node.fillGradient }];
  }
  return normalizedFillLayers(node).flatMap((layer) => layer.paint
    ? [{ ...layer.paint, layerOpacity: layer.opacity, layerBlendMode: layer.blendMode }]
    : []);
}

export function normalizedStrokePaints(node: CanvasNode): readonly DocumentPaint[] {
  if (node.strokeStack === undefined) {
    return node.strokes?.length
      ? node.strokes
      : [{ css: node.stroke, color: node.strokeColor, gradient: node.strokeGradient }];
  }
  return normalizedStrokeLayers(node).flatMap((layer) => layer.paint
    ? [{ ...layer.paint, layerOpacity: layer.opacity, layerBlendMode: layer.blendMode }]
    : []);
}

export function normalizedNodeEffects(node: CanvasNode): readonly DocumentEffect[] {
  return node.effectStack?.length
    ? node.effectStack
    : node.dropShadow
      ? [{ dropShadow: node.dropShadow }]
      : [];
}

export function normalizedNodeView(node: CanvasNode): NormalizedNodeView {
  return {
    fills: normalizedFillPaints(node),
    strokes: normalizedStrokePaints(node),
    effects: normalizedNodeEffects(node),
    transform: normalizedNodeTransform(node),
  };
}
