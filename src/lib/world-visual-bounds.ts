import type { CanvasNode } from "./editor-protocol";
import { closedShapeStrokeLocalBounds } from "./closed-shape-stroke-bounds";
import { worldLineVisualBounds } from "./line-world-bounds";
import { normalizedNodeEffects } from "./normalized-node-view";
import { textListMarkerGutterForProperties, textParagraphListTypeAt, textParagraphRanges } from "./text-layout";
import { transformPoint, worldBoundsForNode, worldTransformForNode, type AffineMatrix, type TransformBounds } from "./scene-transform";

type PrecomputedWorldGeometry = Readonly<{ transform: AffineMatrix; bounds: TransformBounds; defaultPageId?: string; nodeById?: ReadonlyMap<string, CanvasNode>; worldTransformByNodeId?: ReadonlyMap<string, AffineMatrix> }>;

/**
 * The selection/culling/export envelope for common shapes. Line already owns
 * a precise cap/marker envelope; full Ellipse, Frame and Rectangle expand when
 * their visible Stroke is Center or Outside; hanging list markers extend the
 * Text or ShapeWithText envelope at each listed paragraph's visual start. The affine rectangle is
 * conservative for rotated shapes, which is desirable here: it must never
 * clip rendered paint.
 */
export function worldVisualBoundsForNode(nodes: readonly CanvasNode[], node: CanvasNode, precomputed?: PrecomputedWorldGeometry): TransformBounds | undefined {
  if (node.kind === "line" || node.kind === "connector") return withDropShadow(nodes, node, worldLineVisualBounds(nodes, node, precomputed), precomputed?.transform);
  const localBounds = unionLocalBounds(closedShapeStrokeLocalBounds(node), hangingTextLocalBounds(node));
  if (!localBounds) return withDropShadow(nodes, node, precomputed?.bounds ?? worldBoundsForNode(nodes, node), precomputed?.transform);
  const transform = precomputed?.transform ?? worldTransformForNode(nodes, node.id);
  if (!transform) return undefined;
  return withDropShadow(nodes, node, transformedLocalBounds(localBounds, transform), transform);
}

type LocalBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * A font-independent, conservative marker envelope used where Canvas font
 * metrics are unavailable. Runtime fonts may have wider advances than the
 * SVG fallback's 0.6em estimate, so culling uses 1.25em per marker scalar.
 * ShapeWithText first spends its 10px content inset before paint can cross the
 * owning shape's geometry.
 */
export function hangingListLocalBounds(node: CanvasNode): LocalBounds | undefined {
  if ((node.kind !== "text" && node.kind !== "shapeWithText")
    || node.textProperties?.paragraph.hangingList !== true
  ) return undefined;
  const source = node.text ?? (node.kind === "text" ? "Text" : "");
  if (!source) return undefined;
  const primary = node.textProperties.runs[0];
  const fallbackSize = node.kind === "shapeWithText" ? 14 : 31;
  const fontSize = Number.isFinite(primary?.fontSize) && (primary?.fontSize ?? 0) > 0
    ? primary!.fontSize
    : fallbackSize;
  const letterSpacing = Number.isFinite(primary?.letterSpacing)
    ? Math.max(0, primary!.letterSpacing)
    : 0;
  const conservativeScalarAdvance = fontSize * 1.25 + letterSpacing;
  const gutter = textListMarkerGutterForProperties(source, node.textProperties, (value) =>
    Array.from(value).length * conservativeScalarAdvance);
  const inset = node.kind === "shapeWithText" ? 10 : 0;
  const extension = Math.max(0, gutter - inset);
  if (extension <= 0) return undefined;
  const listedParagraphs = textParagraphRanges(source).filter(({ start }) =>
    textParagraphListTypeAt(node.textProperties, start));
  const extendsLeft = listedParagraphs.some(({ direction }) => direction === "ltr");
  const extendsRight = listedParagraphs.some(({ direction }) => direction === "rtl");
  if (!extendsLeft && !extendsRight) return undefined;
  return {
    x: extendsLeft ? -extension : 0,
    y: 0,
    width: node.width + (extendsLeft ? extension : 0) + (extendsRight ? extension : 0),
    height: node.height,
  };
}

export function hangingTextLocalBounds(node: CanvasNode): LocalBounds | undefined {
  const listBounds = hangingListLocalBounds(node);
  if ((node.kind !== "text" && node.kind !== "shapeWithText")
    || node.textProperties?.paragraph.hangingPunctuation !== true
  ) return listBounds;
  const primary = node.textProperties.runs[0];
  const fallbackSize = node.kind === "shapeWithText" ? 14 : 31;
  const fontSize = Number.isFinite(primary?.fontSize) && (primary?.fontSize ?? 0) > 0
    ? primary!.fontSize
    : fallbackSize;
  const inset = node.kind === "shapeWithText" ? 10 : 0;
  const extension = Math.max(0, fontSize * 1.25 - inset);
  const punctuationBounds = extension > 0
    ? { x: -extension, y: 0, width: node.width + extension * 2, height: node.height }
    : undefined;
  return unionLocalBounds(listBounds, punctuationBounds);
}

function unionLocalBounds(left: LocalBounds | undefined, right: LocalBounds | undefined): LocalBounds | undefined {
  if (!left) return right;
  if (!right) return left;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function transformedLocalBounds(bounds: LocalBounds, transform: AffineMatrix): TransformBounds {
  const corners = [
    { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
  ].map((point) => transformPoint(transform, point));
  return {
    left: Math.min(...corners.map((point) => point.x)), top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)), bottom: Math.max(...corners.map((point) => point.y)),
  };
}

/** Conservative Canvas filter padding in world units. Geometry caches do not
 * contain a shadow footprint, while `worldVisualBoundsForNode` already
 * contains one blur radius, spread and the directional offset. Keeping that
 * distinction explicit prevents cached composite surfaces from clipping the
 * remaining soft tail. */
export function worldEffectPaddingForNodeBounds(
  node: CanvasNode,
  transform: AffineMatrix | undefined,
  boundsContainDropShadow: boolean,
) {
  const scale = transform
    ? Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d))
    : 1;
  return normalizedNodeEffects(node).reduce((padding, effect) => {
    if (effect.layerBlur?.visible) return padding + Math.max(0, effect.layerBlur.radius) * 3 * scale;
    if (effect.backgroundBlur?.visible) return padding + Math.max(0, effect.backgroundBlur.radius) * 3 * scale;
    if (effect.dropShadow?.visible && effect.dropShadow.color.alpha > 0) {
      const shadow = effect.dropShadow;
      return padding + (
        Math.max(0, shadow.blurRadius) * (boundsContainDropShadow ? 2 : 3)
        + (boundsContainDropShadow
          ? 0
          : Math.abs(shadow.spread) + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)))
      ) * scale;
    }
    return padding;
  }, 0);
}

/** Canvas has no spread property, but its shadow footprint and our export
 * envelope use the same conservative approximation: blur plus positive spread.
 * Offset follows the node's affine axes, so rotated nodes cannot clip a shadow. */
function withDropShadow(nodes: readonly CanvasNode[], node: CanvasNode, bounds: TransformBounds | undefined, precomputedTransform?: AffineMatrix): TransformBounds | undefined {
  const shadows = normalizedNodeEffects(node).map((effect) => effect.dropShadow).filter((shadow): shadow is NonNullable<CanvasNode["dropShadow"]> => Boolean(shadow))
    .filter((shadow) => shadow.visible && shadow.color.alpha > 0);
  if (!bounds || !shadows.length) return bounds;
  const transform = precomputedTransform ?? worldTransformForNode(nodes, node.id);
  if (!transform) return bounds;
  const scale = Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d));
  return shadows.reduce((result, shadow) => {
    const offsetX = transform.a * shadow.offsetX + transform.c * shadow.offsetY;
    const offsetY = transform.b * shadow.offsetX + transform.d * shadow.offsetY;
    const extent = (Math.max(0, shadow.blurRadius) + Math.max(0, shadow.spread)) * scale;
    return {
      left: Math.min(result.left, bounds.left + offsetX - extent),
      top: Math.min(result.top, bounds.top + offsetY - extent),
      right: Math.max(result.right, bounds.right + offsetX + extent),
      bottom: Math.max(result.bottom, bounds.bottom + offsetY + extent),
    };
  }, bounds);
}
