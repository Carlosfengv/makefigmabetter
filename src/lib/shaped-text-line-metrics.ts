import type { CanvasNode } from "./editor-protocol";
import type { RustTextLayout } from "./rust-text-layout";
import { resolvedTextLineHeightAt } from "./text-line-height";
import { textLineStartsParagraph, textParagraphGap, textParagraphStartAtOffset } from "./text-layout";

export type ShapedTextLineMetrics = Readonly<{
  tops: readonly number[];
  heights: readonly number[];
  totalHeight: number;
}>;

/** Replays Canonical paragraph vertical metrics over Rust-shaped line ranges. */
export function shapedTextLineMetrics(
  node: CanvasNode,
  layout: RustTextLayout,
  fallbackFontSize: number,
  fallbackLineHeight: number,
): ShapedTextLineMetrics | undefined {
  const source = node.text ?? "";
  const bytes = new TextEncoder().encode(source);
  const tops: number[] = [];
  const heights: number[] = [];
  let cursor = 0;
  let previousEnd = 0;
  let previousParagraphStart = 0;
  for (const [lineIndex, line] of layout.lines.entries()) {
    if (line.start < previousEnd || line.end < line.start || line.end > bytes.byteLength) return undefined;
    const skipped = new TextDecoder().decode(bytes.slice(previousEnd, line.start));
    const startsParagraph = textLineStartsParagraph(lineIndex, skipped);
    const paragraphStart = textParagraphStartAtOffset(source, line.start);
    if (lineIndex > 0 && startsParagraph) {
      cursor += textParagraphGap(node.textProperties, previousParagraphStart, paragraphStart);
      previousParagraphStart = paragraphStart;
    }
    const height = resolvedTextLineHeightAt(node.textProperties, paragraphStart, fallbackFontSize, fallbackLineHeight);
    if (!Number.isFinite(height) || height <= 0) return undefined;
    tops.push(cursor);
    heights.push(height);
    cursor += height;
    previousEnd = line.end;
  }
  return { tops, heights, totalHeight: cursor };
}
