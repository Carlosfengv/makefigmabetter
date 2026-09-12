import type { CanvasNode } from "./editor-protocol";
import { shapeWithTextPath } from "./shape-with-text-path";
import { layoutTextPath } from "./text-path-layout";
import { canMaterializeTransformGroupRepeat } from "./transform-group-repeat";

/**
 * The M6 nodes are durable Canonical records even where a target renderer
 * cannot reproduce the live Figma service behind them.  Keep the target
 * boundary explicit and shared: a renderer may show the deterministic card
 * below, but it must not claim to have reproduced routing, remote playback or
 * transform-derived instances that it did not calculate.
 */
export type SpecialNodeRenderTarget = "canvas" | "svg";

export type SpecialNodeFallback = Readonly<{
  code: string;
  reason: string;
}>;

export function specialNodeFallback(node: CanvasNode, target: SpecialNodeRenderTarget): SpecialNodeFallback | undefined {
  switch (node.kind) {
    case "connector":
      return undefined;
    case "shapeWithText":
      if ((node.shapeWithTextType ?? "ROUNDED_RECTANGLE") !== "SQUARE" && (node.shapeWithTextType ?? "ROUNDED_RECTANGLE") !== "ROUNDED_RECTANGLE" && !shapeWithTextPath(node.shapeWithTextType, node.width, node.height)) {
        return fallback("SHAPE_WITH_TEXT_GEOMETRY", `${target === "canvas" ? "Canvas" : "SVG"} preserves the editable ShapeWithText record but falls back from this unsupported parametric geometry.`);
      }
      return undefined;
    case "sticky":
    case "table":
    case "tableCell":
      return undefined;
    case "media":
      return fallback("MEDIA_PLAYBACK", `${target === "canvas" ? "Canvas" : "SVG"} renders a deterministic media poster; remote media decoding and playback are not activated.`);
    case "embed":
      return fallback("EMBED_PREVIEW", `${target === "canvas" ? "Canvas" : "SVG"} renders a safe embed preview; remote content is never activated during rendering or export.`);
    case "linkUnfurl":
      return fallback("LINK_UNFURL_PREVIEW", `${target === "canvas" ? "Canvas" : "SVG"} renders stored link metadata only; remote unfurl fetching is not activated.`);
    case "textPath":
      return layoutTextPath(node, textPathAdvance(node)) === undefined
        ? fallback("TEXT_PATH_LAYOUT", `${target === "canvas" ? "Canvas" : "SVG"} retains the path and text but falls back from unsupported curved/complex glyph-by-glyph path layout.`)
        : undefined;
    case "transformGroup":
      return node.transformModifiers?.length && (target !== "svg" || !canMaterializeTransformGroupRepeat(node))
        ? fallback("TRANSFORM_GROUP_REPEAT", `${target === "canvas" ? "Canvas" : "SVG"} renders the source children once; REPEAT-derived instances are retained but not materialized.`)
        : undefined;
    case "interactiveSlideElement":
      return fallback("SLIDE_INTERACTION", `${target === "canvas" ? "Canvas" : "SVG"} renders a static slide-interaction placeholder; polling, embeds and playback are not activated.`);
    default:
      return undefined;
  }
}

function textPathAdvance(node: CanvasNode): number { return Math.max(1, (node.textProperties?.runs[0]?.fontSize ?? 14) * .6); }

function fallback(code: string, reason: string): SpecialNodeFallback {
  return { code: `M6_${code}_FALLBACK`, reason };
}
