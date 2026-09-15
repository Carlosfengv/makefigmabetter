import type { CanvasNode } from "./editor-protocol";
import { effectiveConstraints } from "./constraint-selection";
import { constraintApplicability } from "./frame-constraint-scope";
import {
  invertAffine,
  transformPoint,
  worldTransformForNode,
  type AffineMatrix,
} from "./scene-transform";

export type ConstraintGuide = Readonly<{
  axis: "horizontal" | "vertical";
  role: "min" | "center" | "max" | "scale";
  start: Readonly<{ x: number; y: number }>;
  end: Readonly<{ x: number; y: number }>;
}>;

function resolvedWorldTransform(
  nodes: readonly CanvasNode[],
  id: string,
  supplied?: ReadonlyMap<string, AffineMatrix>,
): AffineMatrix | undefined {
  return supplied?.get(id) ?? worldTransformForNode(nodes, id);
}

/** Produces world-space Figma-style dotted relationship guides. All anchors
 * are resolved in the owning Frame's local coordinate system, which keeps the
 * overlay correct through transparent Groups and rotated Frame hierarchies. */
export function constraintGuidesForNode(
  nodes: readonly CanvasNode[],
  node: CanvasNode,
  worldTransforms?: ReadonlyMap<string, AffineMatrix>,
): ConstraintGuide[] {
  const applicability = constraintApplicability(nodes, node);
  if (applicability.status !== "applicable") return [];
  const frame = nodes.find((candidate) => candidate.id === applicability.frameId);
  const frameWorld = frame && resolvedWorldTransform(nodes, frame.id, worldTransforms);
  const nodeWorld = resolvedWorldTransform(nodes, node.id, worldTransforms);
  const inverseFrame = frameWorld && invertAffine(frameWorld);
  if (!frame || !frameWorld || !nodeWorld || !inverseFrame) return [];

  const corners = [
    transformPoint(nodeWorld, { x: 0, y: 0 }),
    transformPoint(nodeWorld, { x: node.width, y: 0 }),
    transformPoint(nodeWorld, { x: node.width, y: node.height }),
    transformPoint(nodeWorld, { x: 0, y: node.height }),
  ].map((point) => transformPoint(inverseFrame, point));
  const left = Math.min(...corners.map((point) => point.x));
  const right = Math.max(...corners.map((point) => point.x));
  const top = Math.min(...corners.map((point) => point.y));
  const bottom = Math.max(...corners.map((point) => point.y));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const constraints = effectiveConstraints(node);
  const guide = (
    axis: ConstraintGuide["axis"],
    role: ConstraintGuide["role"],
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): ConstraintGuide => ({
    axis,
    role,
    start: transformPoint(frameWorld, start),
    end: transformPoint(frameWorld, end),
  });
  const horizontal: ConstraintGuide[] =
    constraints.horizontal === "min"
      ? [guide("horizontal", "min", { x: 0, y: centerY }, { x: left, y: centerY })]
      : constraints.horizontal === "max"
        ? [guide("horizontal", "max", { x: right, y: centerY }, { x: frame.width, y: centerY })]
        : constraints.horizontal === "center"
          ? [guide("horizontal", "center", { x: frame.width / 2, y: centerY }, { x: centerX, y: centerY })]
          : [
              guide("horizontal", constraints.horizontal === "scale" ? "scale" : "min", { x: 0, y: centerY }, { x: left, y: centerY }),
              guide("horizontal", constraints.horizontal === "scale" ? "scale" : "max", { x: right, y: centerY }, { x: frame.width, y: centerY }),
            ];
  const vertical: ConstraintGuide[] =
    constraints.vertical === "min"
      ? [guide("vertical", "min", { x: centerX, y: 0 }, { x: centerX, y: top })]
      : constraints.vertical === "max"
        ? [guide("vertical", "max", { x: centerX, y: bottom }, { x: centerX, y: frame.height })]
        : constraints.vertical === "center"
          ? [guide("vertical", "center", { x: centerX, y: frame.height / 2 }, { x: centerX, y: centerY })]
          : [
              guide("vertical", constraints.vertical === "scale" ? "scale" : "min", { x: centerX, y: 0 }, { x: centerX, y: top }),
              guide("vertical", constraints.vertical === "scale" ? "scale" : "max", { x: centerX, y: bottom }, { x: centerX, y: frame.height }),
            ];
  return [...horizontal, ...vertical].filter((item) =>
    Number.isFinite(item.start.x + item.start.y + item.end.x + item.end.y),
  );
}
