import type { DocumentHyperlinkTarget } from "./editor-protocol";

export type TextHyperlinkHover = Readonly<{
  revision: number;
  pageId: string;
  x: number;
  y: number;
  target?: DocumentHyperlinkTarget;
}>;

/** Accepts only the Worker answer for the same immutable document/page and the
 * immediately adjacent browser pointer position. This keeps asynchronous
 * shaping evidence from authorizing a later or unrelated trusted click. */
export function freshTextHyperlinkHoverTarget(
  hover: TextHyperlinkHover | undefined,
  current: Readonly<{ revision: number; pageId: string; x: number; y: number }>,
  tolerance = 2,
): DocumentHyperlinkTarget | undefined {
  if (!hover?.target || hover.revision !== current.revision || hover.pageId !== current.pageId
    || ![hover.x, hover.y, current.x, current.y, tolerance].every(Number.isFinite)
    || tolerance < 0 || Math.hypot(hover.x - current.x, hover.y - current.y) > tolerance) return undefined;
  return hover.target;
}
