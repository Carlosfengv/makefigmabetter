import type { CanvasNode, DocumentEffect } from "./editor-protocol";
import { isLinearBlendMode } from "./linear-blend-composite";
import { isolatesNormalBlend } from "./node-blend-semantics";
import { normalizedFillLayers, normalizedNodeEffects, normalizedStrokeLayers } from "./normalized-node-view";

export function effectChangesPixels(effect: DocumentEffect): boolean {
  return Boolean(
    (effect.dropShadow?.visible && effect.dropShadow.color.alpha > 0)
    || (effect.innerShadow?.visible && effect.innerShadow.color.alpha > 0)
    || (effect.layerBlur?.visible && effect.layerBlur.radius > 0)
    || (effect.backgroundBlur?.visible && effect.backgroundBlur.radius > 0),
  );
}

export function activeNodeEffects(node: CanvasNode): readonly DocumentEffect[] {
  return normalizedNodeEffects(node).filter(effectChangesPixels);
}

/** Alpha masks consume the rendered source alpha. Background Blur only
 * changes destination colour behind that source, so feeding it a real backing
 * would incorrectly turn backdrop alpha into mask coverage. Preserve the
 * canonical effect data while omitting that colour-only pass from the mask
 * surface executor. */
export function activeMaskAlphaEffects(node: CanvasNode): readonly DocumentEffect[] {
  return activeNodeEffects(node).filter((effect) => !effect.backgroundBlur);
}

/** Returns whether this node's visible presentation must read pixels already
 * painted behind it. Structural callers use this shared predicate before they
 * choose a transparent or backdrop-seeded intermediate surface. */
export function nodePresentationRequiresBackdrop(node: CanvasNode): boolean {
  const blendMode = node.blendMode ?? "normal";
  return !node.isMask && (
    (blendMode !== "normal" && blendMode !== "pass-through")
    || [...normalizedFillLayers(node), ...normalizedStrokeLayers(node)]
      .some((layer) => layer.blendMode !== "normal")
    || activeNodeEffects(node).some((effect) => Boolean(effect.backgroundBlur))
  );
}

/** A layer with descendants owns opacity, blend and effects for the complete
 * source subtree. Primitive-only layers keep the cheaper node paint path. */
export function requiresSubtreeComposition(
  node: CanvasNode,
  hasDescendants: boolean,
  effects: readonly DocumentEffect[] = activeNodeEffects(node),
): boolean {
  return isLinearBlendMode(node.blendMode) || hasDescendants && (
    isolatesNormalBlend(node)
    ||
    node.opacity !== 1
    || (node.blendMode !== undefined && node.blendMode !== "normal" && node.blendMode !== "pass-through")
    || effects.length > 0
  );
}

/** Presentation-only source copy. Canonical state remains untouched while the
 * executor defers the owner presentation fields to the enclosing surface. */
export function subtreeSourceNode(node: CanvasNode): CanvasNode {
  return {
    ...node,
    opacity: 1,
    blendMode: "normal",
    dropShadow: undefined,
    effectStack: undefined,
  };
}
