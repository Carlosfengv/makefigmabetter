import type { CanvasNode } from "./editor-protocol";
import { IDENTITY_AFFINE, invertAffine, multiplyAffine, worldTransformForNode, type AffineMatrix } from "./scene-transform";

const MAX_REPEAT_INSTANCES = 64;

/** The initial materialization subset deliberately accepts one bounded linear
 * repeat. It has a complete, stable transform definition; radial and stacked
 * modifiers need additional Canonical parameters before a renderer can claim
 * Figma-equivalent output. */
export function canMaterializeTransformGroupRepeat(node: CanvasNode): boolean {
  const modifiers = node.kind === "transformGroup" ? node.transformModifiers : undefined;
  const modifier = modifiers?.[0];
  return Boolean(modifiers?.length === 1
    && modifier?.type === "REPEAT"
    && modifier.repeatType === "LINEAR"
    && (modifier.axis === "HORIZONTAL" || modifier.axis === "VERTICAL")
    && Number.isSafeInteger(modifier.count)
    && modifier.count >= 1
    && modifier.count <= MAX_REPEAT_INSTANCES
    && Number.isFinite(modifier.offset));
}

/** Returns the world-space affine transform for every repeat-derived copy.
 * The original source children stay at identity; callers draw them once, then
 * wrap each complete source subtree in these matrices. */
export function transformGroupRepeatMatrices(nodes: readonly CanvasNode[], group: CanvasNode): readonly AffineMatrix[] | undefined {
  if (!canMaterializeTransformGroupRepeat(group)) return undefined;
  const modifier = group.transformModifiers![0]!;
  if (modifier.repeatType !== "LINEAR") return undefined;
  const groupWorld = worldTransformForNode(nodes, group.id);
  const inverse = groupWorld && invertAffine(groupWorld);
  if (!groupWorld || !inverse) return undefined;
  const unit = modifier.unitType === "RELATIVE"
    ? (modifier.axis === "HORIZONTAL" ? group.width : group.height)
    : 1;
  const delta = modifier.offset * unit;
  if (!Number.isFinite(delta)) return undefined;
  return Array.from({ length: modifier.count }, (_, index) => {
    const scalar = index + 1;
    const local: AffineMatrix = modifier.axis === "HORIZONTAL"
      ? { ...IDENTITY_AFFINE, e: delta * scalar }
      : { ...IDENTITY_AFFINE, f: delta * scalar };
    return multiplyAffine(multiplyAffine(groupWorld, local), inverse);
  });
}

export function affineSvgMatrix(matrix: AffineMatrix, number: (value: number) => string): string {
  return `matrix(${number(matrix.a)} ${number(matrix.b)} ${number(matrix.c)} ${number(matrix.d)} ${number(matrix.e)} ${number(matrix.f)})`;
}

/** Conjugates a world affine through the current viewport transform. Canvas
 * receives CSS-pixel coordinates after `toScreen`, so merely scaling its
 * translation would rotate around the wrong point whenever the viewport pans. */
export function affineScreenMatrix(matrix: AffineMatrix, origin: Readonly<{ x: number; y: number }>, zoom: number): AffineMatrix {
  return {
    a: matrix.a,
    b: matrix.b,
    c: matrix.c,
    d: matrix.d,
    e: matrix.e * zoom + origin.x - matrix.a * origin.x - matrix.c * origin.y,
    f: matrix.f * zoom + origin.y - matrix.b * origin.x - matrix.d * origin.y,
  };
}
