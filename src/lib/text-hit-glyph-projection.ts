import type { CanvasNode } from "./editor-protocol";
import { projectGpuTextGlyphs, type GpuTextProjectionRun } from "./gpu-text-projection";
import type { RustTextLayout } from "./rust-text-layout";
import { shapedTextLineMetrics } from "./shaped-text-line-metrics";

/** Builds node-local shaped ink boxes for interaction. Authored/world transforms
 * are deliberately excluded; callers invert the current complete node affine,
 * so the same cache remains correct for rotation and nested Relative-v1 nodes. */
export function projectTextHitGlyphs(input: Readonly<{
  node: CanvasNode;
  runs: readonly GpuTextProjectionRun[];
  layout: RustTextLayout;
  lineHeight: number;
}>) {
  if (input.node.kind !== "text") return undefined;
  const metrics = shapedTextLineMetrics(input.node, input.layout, 31, input.lineHeight);
  if (!metrics) return undefined;
  return projectGpuTextGlyphs({
    nodeId: input.node.id,
    runs: input.runs,
    x: 0,
    y: 0,
    width: input.node.width,
    rotation: 0,
    alignment: input.node.textProperties?.paragraph.alignment,
    fill: input.node.fill,
    opacity: input.node.opacity,
    lineHeight: input.lineHeight,
    lineYOffsets: metrics.tops,
    layout: input.layout,
  });
}
