import { colorToOpaqueSrgbCss } from "./color-rendering";
import { cornerSmoothingExponent, resolveCornerSmoothing } from "./corner-smoothing";
import { insetRoundedRectRadii, outsetRoundedRectRadii } from "./aligned-rounded-rect";
import { DEFAULT_TEXT_LINE_HEIGHT, type CanvasNode, type DocumentPaint } from "./editor-protocol";
import { visibleNodesOnPage } from "./hierarchy-visibility";
import { sortNodesByLayerOrder } from "./layer-order";
import { solidLineStrokeOutlinePath } from "./line-stroke-outline";
import { decorativeCapMeshPath, isDecorativeCap } from "./decorative-cap-mesh";
import { perSideStrokeCenters } from "./per-side-stroke";
import { styledTextSpans, type RenderTextStyle } from "./text-style-runs";
import { worldTransformForNode } from "./scene-transform";
import { worldVisualBoundsForNode } from "./world-visual-bounds";
import { ellipseStrokeRing } from "./ellipse-stroke-ring";

export type SvgExportResult = {
  svg: string;
  /** Export never embeds asset bytes. Callers can make this explicit to users. */
  warnings: string[];
};

export type SvgExportOptions = {
  pageId: string;
  defaultPageId: string;
  padding?: number;
};

type SvgPaint = Readonly<{ value: string; opacity?: number }>;

/**
 * Produces a self-contained SVG for the active page's vector common nodes.
 * It deliberately consumes the shared world-transform and hierarchy helpers,
 * so Dual-read nodes, paint order and Frame clipping do not diverge from the
 * canvas projection. Asset bytes are not part of a CanvasNode, therefore image
 * fills remain visible as their vector fallback and are reported to the caller.
 */
export function exportPageToSvg(nodes: readonly CanvasNode[], options: SvgExportOptions): SvgExportResult {
  const pageNodes = sortNodesByLayerOrder(visibleNodesOnPage(nodes, options.pageId, options.defaultPageId));
  const bounds = pageNodes
    .filter((node) => node.kind !== "group")
    .map((node) => worldVisualBoundsForNode(nodes, node))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const padding = Math.max(0, options.padding ?? 16);
  const left = bounds.length ? Math.min(...bounds.map((value) => value.left)) - padding : 0;
  const top = bounds.length ? Math.min(...bounds.map((value) => value.top)) - padding : 0;
  const right = bounds.length ? Math.max(...bounds.map((value) => value.right)) + padding : 1;
  const bottom = bounds.length ? Math.max(...bounds.map((value) => value.bottom)) + padding : 1;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const byId = new Map(pageNodes.map((node) => [node.id, node]));
  const children = new Map<string, CanvasNode[]>();
  const roots: CanvasNode[] = [];
  for (const node of pageNodes) {
    if (!node.parentId || !byId.has(node.parentId)) roots.push(node);
    else {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  }

  const definitions: string[] = [];
  const warnings = new Set<string>();
  let nextDefinitionId = 0;
  const paintValue = (paint: DocumentPaint): SvgPaint => {
    if (!paint.gradient) return paint.color
      ? { value: colorToOpaqueSrgbCss(paint.color), opacity: paint.color.alpha }
      : { value: paint.css };
    const id = `makefigma-gradient-${nextDefinitionId++}`;
    const gradient = paint.gradient;
    definitions.push(`<linearGradient id="${id}" x1="${number(gradient.start[0])}" y1="${number(gradient.start[1])}" x2="${number(gradient.end[0])}" y2="${number(gradient.end[1])}">${gradient.stops.map((stop) => `<stop offset="${number(stop.position)}" stop-color="${attribute(colorToOpaqueSrgbCss(stop.color))}" stop-opacity="${number(stop.color.alpha)}"/>`).join("")}</linearGradient>`);
    return { value: `url(#${id})` };
  };
  const activePaints = (node: CanvasNode, kind: "fill" | "stroke"): DocumentPaint[] => {
    const stack = kind === "fill" ? node.fills : node.strokes;
    if (stack?.length) return stack;
    const legacy = kind === "fill"
      ? { css: node.fill, color: node.fillColor, gradient: node.fillGradient }
      : { css: node.stroke, color: node.strokeColor, gradient: node.strokeGradient };
    return [legacy];
  };
  // Decorative Line endpoints (arrowheads, diamond, dot) are filled from the
  // shared `decorative-cap-mesh` triangle source — the exact geometry Canvas
  // draws and hit testing selects — instead of an independently sized SVG
  // <marker>. `endpoint`/`direction` place it in the Line's local space.
  const decorativeCapPaint = (cap: CanvasNode["strokeCapStart"], endpoint: number, direction: -1 | 1, node: CanvasNode, paint: SvgPaint) => {
    if (!isDecorativeCap(cap)) return "";
    const d = decorativeCapMeshPath(cap, endpoint, direction, node.strokeWidth, number);
    if (!d) return "";
    return `<path d="${d}" fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} stroke="none" fill-rule="nonzero"/>`;
  };
  const shape = (node: CanvasNode, fill: SvgPaint, stroke: SvgPaint, fillRule = "nonzero") => {
    const common = `fill="${attribute(fill.value)}"${paintOpacity("fill", fill)} stroke="${attribute(stroke.value)}"${paintOpacity("stroke", stroke)} fill-rule="${fillRule}" stroke-linecap="${svgStrokeCap(node)}" stroke-linejoin="${attribute(node.strokeJoin ?? "miter")}" stroke-miterlimit="${number(node.strokeMiterLimit ?? 10)}"${node.strokeDashPattern?.length ? ` stroke-dasharray="${node.strokeDashPattern.map(number).join(" ")}"` : ""}${stroke.value !== "none" ? ` stroke-width="${number(node.strokeWidth)}"` : ""}`;
    if (node.kind === "line") {
      const markers = stroke.value === "none" ? "" : `${decorativeCapPaint(node.strokeCapStart, 0, -1, node, stroke)}${decorativeCapPaint(node.strokeCapEnd, node.width, 1, node, stroke)}`;
      if (stroke.value !== "none" && !node.strokeDashPattern?.length && needsIndependentLineOutline(node)) {
        return `<path d="${solidLineStrokeOutlinePath(node.width, node.strokeWidth, node.strokeCapStart, node.strokeCapEnd, number)}" fill="${attribute(stroke.value)}"${paintOpacity("fill", stroke)} stroke="none" fill-rule="nonzero"/>${markers}`;
      }
      return `<path d="M 0 0 H ${number(node.width)}" ${common}/>${markers}`;
    }
    if (node.kind === "ellipse") {
      if (node.arcData) return `<path d="${ellipseArcPath(node)}" ${common.replace(`fill-rule="${fillRule}"`, 'fill-rule="evenodd"')}/>`;
      return `<ellipse cx="${number(node.width / 2)}" cy="${number(node.height / 2)}" rx="${number(node.width / 2)}" ry="${number(node.height / 2)}" ${common}/>`;
    }
    return `<path d="${roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing)}" ${common}/>`;
  };
  const filledPath = (path: string, paint: SvgPaint, transform = "") => `<path d="${path}"${transform} fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} stroke="none"/>`;
  const filledEllipse = (cx: number, cy: number, rx: number, ry: number, paint: SvgPaint) => `<ellipse cx="${number(cx)}" cy="${number(cy)}" rx="${number(rx)}" ry="${number(ry)}" fill="${attribute(paint.value)}"${paintOpacity("fill", paint)} stroke="none"/>`;
  const alignedClosedShapeLayers = (node: CanvasNode, fills: SvgPaint[], strokes: SvgPaint[]) => {
    if ((node.kind !== "frame" && node.kind !== "rectangle") || node.strokeWidth <= 0) return undefined;
    if (node.strokeWeights?.length === 4) return undefined;
    if (node.strokeAlign === "center") return undefined;
    const path = roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing);
    const dashedStroke = (outline: string, paint: SvgPaint, transform = "") => `<path d="${outline}"${transform} fill="none" stroke="${attribute(paint.value)}"${paintOpacity("stroke", paint)} stroke-width="${number(node.strokeWidth)}" stroke-linecap="butt" stroke-linejoin="${attribute(node.strokeJoin ?? "miter")}" stroke-miterlimit="${number(node.strokeMiterLimit ?? 10)}" stroke-dasharray="${node.strokeDashPattern!.map(number).join(" ")}"/>`;
    if (node.strokeDashPattern?.length) {
      const half = node.strokeWidth / 2;
      if (node.strokeAlign === "outside") {
        const outerRadii = outsetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, half);
        const outer = roundedRectPath(node.width + node.strokeWidth, node.height + node.strokeWidth, node.radius + half, outerRadii, node.cornerSmoothing);
        return `${strokes.map((paint) => dashedStroke(outer, paint, ` transform="translate(${-number(half)} ${-number(half)})"`)).join("")}${fills.map((paint) => filledPath(path, paint)).join("")}`;
      }
      const innerWidth = Math.max(0, node.width - node.strokeWidth);
      const innerHeight = Math.max(0, node.height - node.strokeWidth);
      const innerRadii = insetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, half);
      const inner = roundedRectPath(innerWidth, innerHeight, Math.max(0, node.radius - half), innerRadii, node.cornerSmoothing);
      return `${fills.map((paint) => filledPath(path, paint)).join("")}${innerWidth > 0 && innerHeight > 0 ? strokes.map((paint) => dashedStroke(inner, paint, ` transform="translate(${number(half)} ${number(half)})"`)).join("") : ""}`;
    }
    const shortestSide = Math.max(0, Math.min(node.width, node.height));
    if (node.strokeAlign === "outside") {
      const outset = node.strokeWidth;
      const outerRadii = outsetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, outset);
      const outer = roundedRectPath(node.width + outset * 2, node.height + outset * 2, node.radius + outset, outerRadii, node.cornerSmoothing);
      return `${strokes.map((paint) => filledPath(outer, paint, ` transform="translate(${-number(outset)} ${-number(outset)})"`)).join("")}${fills.map((paint) => filledPath(path, paint)).join("")}`;
    }
    const inset = Math.min(node.strokeWidth, shortestSide / 2);
    const innerWidth = Math.max(0, node.width - inset * 2);
    const innerHeight = Math.max(0, node.height - inset * 2);
    const innerRadii = insetRoundedRectRadii(node.width, node.height, node.radius, node.cornerRadii, inset);
    const inner = roundedRectPath(innerWidth, innerHeight, Math.max(0, node.radius - inset), innerRadii, node.cornerSmoothing);
    const innerPaints = innerWidth > 0 && innerHeight > 0
      ? fills.map((paint) => filledPath(inner, paint, ` transform="translate(${number(inset)} ${number(inset)})"`)).join("")
      : "";
    return `${strokes.map((paint) => filledPath(path, paint)).join("")}${innerPaints}`;
  };
  const alignedEllipseLayers = (node: CanvasNode, fills: SvgPaint[], strokes: SvgPaint[]) => {
    if (node.kind !== "ellipse" || node.arcData || node.strokeWidth <= 0 || node.strokeAlign === "center") return undefined;
    const cx = node.width / 2;
    const cy = node.height / 2;
    const ring = ellipseStrokeRing(node.width, node.height, node.strokeWidth, node.strokeAlign);
    if (!ring) return undefined;
    const inner = ring.innerRx !== undefined && ring.innerRy !== undefined
      ? fills.map((paint) => filledEllipse(cx, cy, ring.innerRx!, ring.innerRy!, paint)).join("")
      : "";
    return `${strokes.map((paint) => filledEllipse(cx, cy, ring.outerRx, ring.outerRy, paint)).join("")}${inner}`;
  };
  const perSideStrokeLayers = (node: CanvasNode, fills: SvgPaint[], strokes: SvgPaint[]) => {
    if ((node.kind !== "frame" && node.kind !== "rectangle") || node.strokeWeights?.length !== 4) return undefined;
    const path = roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing);
    const [top, right, bottom, left] = node.strokeWeights.map((value) => Math.max(0, value));
    const align = node.strokeAlign ?? "inside";
    const { topY, rightX, bottomY, leftX } = perSideStrokeCenters(node.width, node.height, [top, right, bottom, left], align);
    const sides: ReadonlyArray<readonly [width: number, d: string]> = [
      [top, `M 0 ${number(topY)} H ${number(node.width)}`],
      [right, `M ${number(rightX)} 0 V ${number(node.height)}`],
      [bottom, `M ${number(node.width)} ${number(bottomY)} H 0`],
      [left, `M ${number(leftX)} ${number(node.height)} V 0`],
    ];
    const rendered = sides.flatMap(([width, d]) => width > 0
      ? strokes.map((paint) => `<path d="${d}" fill="none" stroke="${attribute(paint.value)}"${paintOpacity("stroke", paint)} stroke-width="${number(width)}" stroke-linecap="butt" stroke-linejoin="${attribute(node.strokeJoin ?? "miter")}" stroke-miterlimit="${number(node.strokeMiterLimit ?? 10)}"${node.strokeDashPattern?.length ? ` stroke-dasharray="${node.strokeDashPattern.map(number).join(" ")}"` : ""}/>`)
      : []);
    const strokeMarkup = align === "inside"
      ? (() => {
        const clipId = `makefigma-stroke-clip-${nextDefinitionId++}`;
        definitions.push(`<clipPath id="${clipId}"><path d="${path}"/></clipPath>`);
        return `<g clip-path="url(#${clipId})">${rendered.join("")}</g>`;
      })()
      : rendered.join("");
    return `${fills.map((paint) => filledPath(path, paint)).join("")}${strokeMarkup}`;
  };
  const nodeMarkup = (node: CanvasNode) => {
    if (node.kind === "group") return "";
    if (node.kind === "image" && node.assetId) warnings.add("Image assets are represented by their vector fallback; SVG export does not embed asset bytes yet.");
    const fills = activePaints(node, "fill");
    const strokes = activePaints(node, "stroke");
    const transform = worldTransformForNode(nodes, node.id);
    if (!transform) return "";
    const matrix = `matrix(${number(transform.a)} ${number(transform.b)} ${number(transform.c)} ${number(transform.d)} ${number(transform.e)} ${number(transform.f)})`;
    if (node.kind === "text") {
      const fill = paintValue(fills[0]);
      return `<g transform="${matrix}" opacity="${number(node.opacity)}">${svgTextMarkup(node, fill)}</g>`;
    }
    const fillPaints = fills.map(paintValue);
    const strokePaints = strokes.map(paintValue);
    const layers = perSideStrokeLayers(node, fillPaints, strokePaints)
      ?? alignedClosedShapeLayers(node, fillPaints, strokePaints)
      ?? alignedEllipseLayers(node, fillPaints, strokePaints)
      ?? [
        ...fillPaints.map((paint) => shape(node, paint, { value: "none" })),
        ...strokePaints.filter(() => node.strokeWidth > 0).map((paint) => shape(node, { value: "none" }, paint)),
      ].join("");
    return `<g transform="${matrix}" opacity="${number(node.opacity)}">${layers}</g>`;
  };
  const renderBranch = (node: CanvasNode, lineage: Set<string>): string => {
    if (lineage.has(node.id)) return "";
    const descendants = children.get(node.id) ?? [];
    const nextLineage = new Set(lineage).add(node.id);
    const descendantsMarkup = descendants.map((child) => renderBranch(child, nextLineage)).join("");
    const own = nodeMarkup(node);
    if (node.kind !== "frame" || node.clipsContent === false || !descendantsMarkup) return `${own}${descendantsMarkup}`;
    const transform = worldTransformForNode(nodes, node.id);
    if (!transform) return `${own}${descendantsMarkup}`;
    const clipId = `makefigma-clip-${nextDefinitionId++}`;
    definitions.push(`<clipPath id="${clipId}"><g transform="matrix(${number(transform.a)} ${number(transform.b)} ${number(transform.c)} ${number(transform.d)} ${number(transform.e)} ${number(transform.f)})"><path d="${roundedRectPath(node.width, node.height, node.radius, node.cornerRadii, node.cornerSmoothing)}"/></g></clipPath>`);
    return `${own}<g clip-path="url(#${clipId})">${descendantsMarkup}</g>`;
  };
  const content = roots.map((node) => renderBranch(node, new Set())).join("");
  const defs = definitions.length ? `<defs>${definitions.join("")}</defs>` : "";
  return {
    svg: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="${number(left)} ${number(top)} ${number(width)} ${number(height)}" width="${number(width)}" height="${number(height)}">${defs}${content}</svg>`,
    warnings: [...warnings],
  };
}

function roundedRectPath(width: number, height: number, radius: number, radii: CanvasNode["cornerRadii"], cornerSmoothing?: number) {
  const [topLeft, topRight, bottomRight, bottomLeft] = resolvedRadii(width, height, radius, radii);
  const smoothing = resolveCornerSmoothing(cornerSmoothing);
  if (smoothing > 0) {
    const exponent = cornerSmoothingExponent(smoothing);
    const segments = Math.round(8 + smoothing * 8);
    const corner = (centerX: number, centerY: number, cornerRadius: number, start: number, end: number) => {
      if (cornerRadius <= 0) return "";
      return Array.from({ length: segments }, (_, offset) => {
        const angle = start + (end - start) * (offset + 1) / segments;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const x = centerX + Math.sign(cosine) * Math.abs(cosine) ** (2 / exponent) * cornerRadius;
        const y = centerY + Math.sign(sine) * Math.abs(sine) ** (2 / exponent) * cornerRadius;
        return ` L ${number(x)} ${number(y)}`;
      }).join("");
    };
    return `M ${number(topLeft)} 0 H ${number(width - topRight)}${corner(width - topRight, topRight, topRight, -Math.PI / 2, 0)} V ${number(height - bottomRight)}${corner(width - bottomRight, height - bottomRight, bottomRight, 0, Math.PI / 2)} H ${number(bottomLeft)}${corner(bottomLeft, height - bottomLeft, bottomLeft, Math.PI / 2, Math.PI)} V ${number(topLeft)}${corner(topLeft, topLeft, topLeft, Math.PI, Math.PI * 1.5)} Z`;
  }
  return `M ${number(topLeft)} 0 H ${number(width - topRight)} A ${number(topRight)} ${number(topRight)} 0 0 1 ${number(width)} ${number(topRight)} V ${number(height - bottomRight)} A ${number(bottomRight)} ${number(bottomRight)} 0 0 1 ${number(width - bottomRight)} ${number(height)} H ${number(bottomLeft)} A ${number(bottomLeft)} ${number(bottomLeft)} 0 0 1 0 ${number(height - bottomLeft)} V ${number(topLeft)} A ${number(topLeft)} ${number(topLeft)} 0 0 1 ${number(topLeft)} 0 Z`;
}

function ellipseArcPath(node: CanvasNode) {
  const arc = node.arcData!;
  const start = arc.startingAngle * Math.PI / 180;
  const span = arc.endingAngle * Math.PI / 180 - start;
  const radiusX = node.width / 2;
  const radiusY = node.height / 2;
  const centerX = radiusX;
  const centerY = radiusY;
  const inner = Math.max(0, Math.min(.999999, arc.innerRadius));
  if (Math.abs(span) >= Math.PI * 2 - 1e-8) {
    const outer = `M ${number(centerX + radiusX)} ${number(centerY)} A ${number(radiusX)} ${number(radiusY)} 0 1 1 ${number(centerX - radiusX)} ${number(centerY)} A ${number(radiusX)} ${number(radiusY)} 0 1 1 ${number(centerX + radiusX)} ${number(centerY)}`;
    if (inner === 0) return `${outer} Z`;
    const innerX = radiusX * inner;
    const innerY = radiusY * inner;
    return `${outer} Z M ${number(centerX + innerX)} ${number(centerY)} A ${number(innerX)} ${number(innerY)} 0 1 0 ${number(centerX - innerX)} ${number(centerY)} A ${number(innerX)} ${number(innerY)} 0 1 0 ${number(centerX + innerX)} ${number(centerY)} Z`;
  }
  const end = start + span;
  const outerStart = pointOnEllipse(centerX, centerY, radiusX, radiusY, start);
  const outerEnd = pointOnEllipse(centerX, centerY, radiusX, radiusY, end);
  const largeArc = Math.abs(span) > Math.PI ? 1 : 0;
  const sweep = span >= 0 ? 1 : 0;
  let path = `M ${number(outerStart.x)} ${number(outerStart.y)} A ${number(radiusX)} ${number(radiusY)} 0 ${largeArc} ${sweep} ${number(outerEnd.x)} ${number(outerEnd.y)}`;
  if (inner === 0) return `${path} L ${number(centerX)} ${number(centerY)} Z`;
  const innerStart = pointOnEllipse(centerX, centerY, radiusX * inner, radiusY * inner, start);
  const innerEnd = pointOnEllipse(centerX, centerY, radiusX * inner, radiusY * inner, end);
  path += ` L ${number(innerEnd.x)} ${number(innerEnd.y)} A ${number(radiusX * inner)} ${number(radiusY * inner)} 0 ${largeArc} ${sweep ? 0 : 1} ${number(innerStart.x)} ${number(innerStart.y)} Z`;
  return path;
}

function pointOnEllipse(centerX: number, centerY: number, radiusX: number, radiusY: number, angle: number) {
  return { x: centerX + radiusX * Math.cos(angle), y: centerY + radiusY * Math.sin(angle) };
}

function resolvedRadii(width: number, height: number, radius: number, radii: CanvasNode["cornerRadii"]) {
  const source = radii?.length === 4 ? radii : [radius, radius, radius, radius];
  const values = source.map((value) => Math.max(0, Number.isFinite(value) ? value : 0));
  const scale = Math.min(1, width / Math.max(1e-12, values[0] + values[1]), width / Math.max(1e-12, values[2] + values[3]), height / Math.max(1e-12, values[0] + values[3]), height / Math.max(1e-12, values[1] + values[2]));
  return values.map((value) => value * scale) as [number, number, number, number];
}

function strokeCap(value: CanvasNode["strokeCapStart"]) {
  return value === "round" ? "round" : value === "square" ? "square" : "butt";
}

/** SVG needs explicit tspans to retain Canvas' newline semantics and its
 * Canonical UTF-8 Style Runs. Advanced shaping/kerning remains Partial, but
 * ordinary mixed size/weight/italic/tracking no longer flattens to run zero. */
function svgTextMarkup(node: CanvasNode, fill: SvgPaint) {
  const primary = node.textProperties?.runs[0];
  const size = primary?.fontSize ?? 31;
  const paragraph = node.textProperties?.paragraph;
  const alignment = paragraph?.alignment ?? "left";
  const anchor = alignment === "center" ? "middle" : alignment === "right" ? "end" : "start";
  const x = alignment === "center" ? node.width / 2 : alignment === "right" ? node.width : 0;
  const lineHeight = paragraph?.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT;
  const paragraphSpacing = paragraph?.paragraphSpacing ?? 0;
  const source = node.text ?? "";
  const lines = svgTextLineRanges(source);
  const attributes = `x="${number(x)}" fill="${attribute(fill.value)}"${paintOpacity("fill", fill)} text-anchor="${anchor}"`;
  const lineMarkup = lines.map((line, index) => {
    const spans = styledTextSpans(source, line.start, line.end, node.textProperties);
    const content = spans.map((span) => `<tspan ${svgTextStyleAttributes(span.style)}>${text(span.text)}</tspan>`).join("");
    return `<tspan x="${number(x)}" y="${number(size + index * (lineHeight + paragraphSpacing))}">${content}</tspan>`;
  }).join("");
  return `<text ${attributes}>${lineMarkup}</text>`;
}

function svgTextLineRanges(source: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const bytes = new TextEncoder();
  const separator = /\r\n|[\n\r\u2028\u2029]/gu;
  let utf16Start = 0;
  for (const match of source.matchAll(separator)) {
    const index = match.index ?? utf16Start;
    ranges.push({ start: bytes.encode(source.slice(0, utf16Start)).byteLength, end: bytes.encode(source.slice(0, index)).byteLength });
    utf16Start = index + match[0].length;
  }
  ranges.push({ start: bytes.encode(source.slice(0, utf16Start)).byteLength, end: bytes.encode(source).byteLength });
  return ranges;
}

function svgTextStyleAttributes(style: RenderTextStyle) {
  return `font-size="${number(style.fontSize)}" font-weight="${number(style.fontWeight)}" font-style="${style.italic ? "italic" : "normal"}" letter-spacing="${number(style.letterSpacing)}"`;
}

/** Canvas and SVG cannot apply different caps to individual dash segments.
 * Keep the documented conservative Butt fallback when a dashed Line's two
 * endpoints differ, rather than accidentally applying the start style to all
 * dashes in the exported SVG. */
function svgStrokeCap(node: CanvasNode) {
  if (node.kind === "line" && node.strokeDashPattern?.length && node.strokeCapStart !== node.strokeCapEnd) return "butt";
  return strokeCap(node.strokeCapStart);
}

function needsIndependentLineOutline(node: CanvasNode) {
  return [node.strokeCapStart, node.strokeCapEnd].some((cap) => cap === "round" || cap === "square");
}

function paintOpacity(kind: "fill" | "stroke", paint: SvgPaint) {
  return paint.opacity === undefined || paint.opacity >= 1 ? "" : ` ${kind}-opacity="${number(Math.max(0, paint.opacity))}"`;
}

function number(value: number) {
  if (!Number.isFinite(value)) return "0";
  const nearestInteger = Math.round(value);
  const normalized = Math.abs(value - nearestInteger) <= 1e-12 ? nearestInteger : value;
  return String(Object.is(normalized, -0) ? 0 : normalized);
}

function attribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function text(value: string) {
  return attribute(value).replaceAll("'", "&apos;");
}
