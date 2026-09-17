import type { CanvasNode } from "./editor-protocol";
import type { RustTextLayout } from "./rust-text-layout";
import {
  textLineStartsParagraph,
  textParagraphIndentAt,
  textParagraphRanges,
  textParagraphStartAtOffset,
} from "./text-layout";

export type ShapedTextLineBoxes = Readonly<{
  xOffsets: readonly number[];
  widths: readonly number[];
}>;

/** Returns one Canonical first-line inset per hard-break paragraph. These
 * values are passed into Rust before line fitting, so shaped ranges and later
 * Canvas/GPU projections cannot disagree about the wrap caused by an inset. */
export function shapedTextFirstLineIndents(
  node: CanvasNode,
  source = node.text ?? "",
): readonly number[] | undefined {
  const indents = textParagraphRanges(source).map(({ start }) =>
    textParagraphIndentAt(node.textProperties, start));
  return indents.every((indent) => Number.isFinite(indent) && indent >= 0)
    ? indents
    : undefined;
}

/** Replays the horizontal line box used by Canvas after Rust has frozen the
 * line ranges. Continuation lines retain the full authored text-box width. */
export function shapedTextLineBoxes(
  node: CanvasNode,
  layout: RustTextLayout,
  width: number,
): ShapedTextLineBoxes | undefined {
  if (!Number.isFinite(width) || width <= 0) return undefined;
  const source = node.text ?? "";
  const bytes = new TextEncoder().encode(source);
  const xOffsets: number[] = [];
  const widths: number[] = [];
  let previousEnd = 0;
  for (const [lineIndex, line] of layout.lines.entries()) {
    if (line.start < previousEnd || line.end < line.start || line.end > bytes.byteLength) return undefined;
    const skipped = new TextDecoder().decode(bytes.slice(previousEnd, line.start));
    const startsParagraph = textLineStartsParagraph(lineIndex, skipped);
    const paragraphStart = textParagraphStartAtOffset(source, line.start);
    const indent = startsParagraph ? textParagraphIndentAt(node.textProperties, paragraphStart) : 0;
    if (!Number.isFinite(indent) || indent < 0) return undefined;
    xOffsets.push(indent);
    widths.push(Math.max(0, width - indent));
    previousEnd = line.end;
  }
  return { xOffsets, widths };
}
