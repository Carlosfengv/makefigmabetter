import type { CanvasNode } from "./editor-protocol";
import { projectGpuTextGlyphs, type GpuTextProjectionRun } from "./gpu-text-projection";
import type { RustTextLayout } from "./rust-text-layout";
import type { WebGpuTextGlyph } from "./webgpu-scene";
import { shapedTextLineMetrics } from "./shaped-text-line-metrics";

export type ShapeWithTextGlyphProjectionInput = Readonly<{
  node: CanvasNode;
  runs: readonly GpuTextProjectionRun[];
  layout: RustTextLayout;
  lineHeight: number;
}>;

/** Projects shaped glyph ink boxes into ShapeWithText's Canvas-local text box.
 * These glyphs are interaction evidence only: the shape and its TextSublayer
 * remain one Canvas node, while hyperlink hit testing gets the same inset,
 * horizontal alignment and vertical centering as the visible sublayer. */
export function projectShapeWithTextHitGlyphs(
  input: ShapeWithTextGlyphProjectionInput,
): WebGpuTextGlyph[] | undefined {
  const { node, layout, lineHeight } = input;
  if (node.kind !== "shapeWithText" || !layout.lines.length
    || !Number.isFinite(lineHeight) || lineHeight <= 0) return undefined;
  const inset = 10;
  const width = Math.max(1, node.width - inset * 2);
  const height = Math.max(1, node.height - inset * 2);
  const metrics = shapedTextLineMetrics(node, layout, 14, lineHeight);
  if (!metrics) return undefined;
  const y = inset + Math.max(0, (height - metrics.totalHeight) / 2);
  return projectGpuTextGlyphs({
    nodeId: node.id,
    runs: input.runs,
    x: inset,
    y,
    width,
    rotation: 0,
    alignment: node.textProperties?.paragraph.alignment ?? "center",
    fill: node.fill,
    opacity: node.opacity,
    lineHeight,
    lineYOffsets: metrics.tops,
    layout,
  });
}
