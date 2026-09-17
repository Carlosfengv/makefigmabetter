import type { CanvasNode } from "./editor-protocol";
import { gpuTextFontMetrics, projectGpuTextGlyphs, type GpuTextProjectionRun } from "./gpu-text-projection";
import type { RustTextLayout } from "./rust-text-layout";
import { resolvedTextLineHeightAt } from "./text-line-height";
import { shapedTextLineBoxes } from "./shaped-text-line-boxes";
import { shapedTextLineMetrics } from "./shaped-text-line-metrics";
import { textParagraphGap } from "./text-layout";
import { textDisplayLines } from "./text-truncation";

/** Builds node-local shaped ink boxes for interaction. Authored/world transforms
 * are deliberately excluded; callers invert the current complete node affine,
 * so the same cache remains correct for rotation and nested Relative-v1 nodes. */
export function projectTextHitGlyphs(input: Readonly<{
  node: CanvasNode;
  runs: readonly GpuTextProjectionRun[];
  layout: RustTextLayout;
  lineHeight: number;
  listMarkerGutter?: number;
}>) {
  if (input.node.kind !== "text") return undefined;
  const layout = visibleTextHitLayout(input.node, input.layout, input.lineHeight);
  const metrics = shapedTextLineMetrics(
    input.node,
    layout,
    31,
    input.lineHeight,
    gpuTextFontMetrics(input.runs[0]),
  );
  const boxes = shapedTextLineBoxes(input.node, layout, input.node.width, input.listMarkerGutter);
  if (!metrics || !boxes) return undefined;
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
    lineXOffsets: boxes.xOffsets,
    lineWidths: boxes.widths,
    lineYOffsets: metrics.tops,
    layout,
  });
}

/** Removes every hidden truncation line and conservatively excludes the
 * ellipsis-bearing final line. The ellipsis is presentation-only and reshaped
 * from a retained prefix, so the original full-line glyph stream cannot prove
 * a safe Canonical hyperlink hit for that line. */
export function visibleTextHitLayout(
  node: CanvasNode,
  layout: RustTextLayout,
  fallbackLineHeight: number,
): RustTextLayout {
  if (node.kind !== "text" || node.textProperties?.textTruncation !== "ending") return layout;
  const source = node.text ?? "";
  const bytes = new TextEncoder().encode(source);
  const lines = layout.lines.map((line) => ({
    ...line,
    text: new TextDecoder().decode(bytes.slice(line.start, line.end)),
  }));
  const visible = textDisplayLines(
    source,
    lines,
    node.textProperties,
    node.height,
    (paragraphStart) => resolvedTextLineHeightAt(node.textProperties, paragraphStart, 31, fallbackLineHeight),
    (previousStart, nextStart) => textParagraphGap(node.textProperties, previousStart, nextStart),
  );
  const safeLineCount = Math.max(0, visible.length - (visible.at(-1)?.truncateEnding ? 1 : 0));
  return { ...layout, lines: layout.lines.slice(0, safeLineCount) };
}
