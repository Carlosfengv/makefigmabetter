import type { CanvasNode, Viewport } from "./editor-protocol";
import type { CompositeSurfaceWindow } from "./composite-surface-window";
import { clipsChildren } from "./node-capabilities";
import { normalizedFillLayers, normalizedNodeEffects, normalizedStrokeLayers } from "./normalized-node-view";

export type RenderedMaskAlphaHit = Readonly<{
  revision: number;
  resourceGeneration: string | number;
  viewport: Viewport;
  canvasWidth: number;
  canvasHeight: number;
  window: CompositeSurfaceWindow;
  alpha: Uint8Array;
}>;

export type RenderedMaskAlphaHitState = Readonly<{
  revision: number;
  resourceGeneration: string | number;
  viewport: Viewport;
  canvasWidth: number;
  canvasHeight: number;
}>;

/** Returns undefined when the cached surface belongs to another presentation
 * fence. False is authoritative when the point lies outside this rendered
 * surface or samples a zero-alpha pixel. */
export function renderedMaskAlphaAtWorldPoint(
  rendered: RenderedMaskAlphaHit,
  state: RenderedMaskAlphaHitState,
  point: Readonly<{ x: number; y: number }>,
): boolean | undefined {
  if (
    rendered.revision !== state.revision
    || rendered.resourceGeneration !== state.resourceGeneration
    || rendered.canvasWidth !== state.canvasWidth
    || rendered.canvasHeight !== state.canvasHeight
    || rendered.viewport.x !== state.viewport.x
    || rendered.viewport.y !== state.viewport.y
    || rendered.viewport.zoom !== state.viewport.zoom
    || rendered.alpha.length !== rendered.window.pixelWidth * rendered.window.pixelHeight
  ) return undefined;
  const screenX = (point.x + state.viewport.x) * state.viewport.zoom + state.canvasWidth / 2;
  const screenY = (point.y + state.viewport.y) * state.viewport.zoom + state.canvasHeight / 2;
  const localX = Math.floor(screenX * rendered.window.dpr) - rendered.window.pixelX;
  const localY = Math.floor(screenY * rendered.window.dpr) - rendered.window.pixelY;
  if (localX < 0 || localY < 0 || localX >= rendered.window.pixelWidth || localY >= rendered.window.pixelHeight) return false;
  return rendered.alpha[localY * rendered.window.pixelWidth + localX]! > 0;
}

export function alphaChannelFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || rgba.length !== width * height * 4) return undefined;
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3]!;
  return alpha;
}

/** Simple single-fill rectangles/ellipses and single image fills already have
 * exact analytic/source-image predicates. Effects, arbitrary paths, visible
 * strokes, gradients and multi-layer stacks require the rendered source alpha
 * because their visible support cannot be reconstructed from one geometry. */
export function maskNeedsRenderedAlphaHit(node: CanvasNode): boolean {
  const fills = normalizedFillLayers(node);
  const strokes = normalizedStrokeLayers(node);
  const hasActiveEffect = normalizedNodeEffects(node).some((effect) =>
    effect.layerBlur?.visible && effect.layerBlur.radius > 0
    || effect.dropShadow?.visible && effect.dropShadow.color.alpha > 0
    || effect.innerShadow?.visible && effect.innerShadow.color.alpha > 0
    || effect.backgroundBlur?.visible && effect.backgroundBlur.radius > 0,
  );
  const hasVisibleStroke = node.strokeWidth > 0 && strokes.length > 0;
  const hasGradient = [...fills, ...strokes].some((layer) => Boolean(layer.paint?.gradient));
  const simpleGeometry = node.kind === "ellipse" && !node.arcData
    || node.kind === "rectangle"
    || clipsChildren(node.kind);
  return hasActiveEffect || hasVisibleStroke || hasGradient || fills.length > 1 || !simpleGeometry;
}
