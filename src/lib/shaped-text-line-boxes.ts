import type { CanvasNode } from "./editor-protocol";
import type { RustTextLayout } from "./rust-text-layout";
import {
  textLineStartsParagraph,
  textIndentedLineBox,
  textListIndentationOffset,
  textListMarkerBaseIndent,
  textParagraphIndentAt,
  textParagraphRanges,
  textParagraphStartAtOffset,
  textParagraphWrapStyleAt,
} from "./text-layout";

export type ShapedTextParagraphWrapStyle = "auto" | "balance" | "pretty";

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
  listMarkerGutter = 0,
): readonly number[] | undefined {
  const indents = textParagraphRanges(source).map(({ start }) =>
    textListIndentationOffset(source, node.textProperties, start, listMarkerGutter)
    + textParagraphIndentAt(node.textProperties, start)
    + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, start));
  return indents.every((indent) => Number.isFinite(indent) && indent >= 0)
    ? indents
    : undefined;
}

/** Returns the list nesting inset retained by wrapped continuation lines. */
export function shapedTextContinuationLineIndents(
  node: CanvasNode,
  source = node.text ?? "",
  listMarkerGutter = 0,
): readonly number[] | undefined {
  const indents = textParagraphRanges(source).map(({ start }) =>
    textListIndentationOffset(source, node.textProperties, start, listMarkerGutter));
  return indents.every((indent) => Number.isFinite(indent) && indent >= 0)
    ? indents
    : undefined;
}

export function shapedTextParagraphWrapStyles(
  node: CanvasNode,
  source = node.text ?? "",
): readonly ShapedTextParagraphWrapStyle[] {
  return textParagraphRanges(source).map(({ start }) =>
    textParagraphWrapStyleAt(node.textProperties, start));
}

/** Replays the horizontal line box used by Canvas after Rust has frozen the
 * line ranges. Continuation lines retain the full authored text-box width. */
export function shapedTextLineBoxes(
  node: CanvasNode,
  layout: RustTextLayout,
  width: number,
  listMarkerGutter = 0,
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
    const nestingIndent = textListIndentationOffset(source, node.textProperties, paragraphStart, listMarkerGutter);
    const indent = nestingIndent + (startsParagraph
      ? textParagraphIndentAt(node.textProperties, paragraphStart)
        + textListMarkerBaseIndent(node.textProperties, listMarkerGutter, paragraphStart)
      : 0);
    if (!Number.isFinite(indent) || indent < 0) return undefined;
    const lineBox = textIndentedLineBox(0, width, indent, line.direction);
    xOffsets.push(lineBox.start);
    widths.push(lineBox.width);
    previousEnd = line.end;
  }
  return { xOffsets, widths };
}
