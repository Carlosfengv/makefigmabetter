import type { ShapeWithTextType } from "./editor-protocol";
import { pointInPolygon } from "./parametric-shape";

export type ShapeWithTextPoint = Readonly<{ x: number; y: number }>;
export type ShapeWithTextPath = Readonly<{ kind: "ellipse" }> | Readonly<{ kind: "polygon"; points: readonly ShapeWithTextPoint[] }>;
export type ShapeWithTextDecoration = Readonly<{ kind: "polyline"; points: readonly ShapeWithTextPoint[] }> | Readonly<{ kind: "cubic"; start: ShapeWithTextPoint; control1: ShapeWithTextPoint; control2: ShapeWithTextPoint; end: ShapeWithTextPoint }>;

/**
 * Deterministic silhouette geometry for ShapeWithText. Canonical currently
 * has no per-shape interior-detail parameters, so the separate standard
 * decoration paths below intentionally cover only stable semantic marks,
 * rather than claiming full Figma parametric-shape fidelity.
 */
export function shapeWithTextPath(type: ShapeWithTextType | undefined, width: number, height: number): ShapeWithTextPath | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const resolved = type ?? "ROUNDED_RECTANGLE";
  const inset = Math.min(width * .22, height * .3);
  switch (resolved) {
    case "ELLIPSE": return { kind: "ellipse" };
    case "SUMMING_JUNCTION": return { kind: "ellipse" };
    case "OR": return { kind: "ellipse" };
    case "ENG_QUEUE": return { kind: "ellipse" };
    case "DIAMOND": return polygon([{ x: width / 2, y: 0 }, { x: width, y: height / 2 }, { x: width / 2, y: height }, { x: 0, y: height / 2 }]);
    case "TRIANGLE_UP": return polygon([{ x: width / 2, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
    case "TRIANGLE_DOWN": return polygon([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width / 2, y: height }]);
    case "PARALLELOGRAM_RIGHT": return polygon([{ x: inset, y: 0 }, { x: width, y: 0 }, { x: width - inset, y: height }, { x: 0, y: height }]);
    case "PARALLELOGRAM_LEFT": return polygon([{ x: 0, y: 0 }, { x: width - inset, y: 0 }, { x: width, y: height }, { x: inset, y: height }]);
    case "MANUAL_INPUT": return polygon([{ x: width * .16, y: 0 }, { x: width, y: 0 }, { x: width * .84, y: height }, { x: 0, y: height }]);
    case "TRAPEZOID": return polygon([{ x: inset, y: 0 }, { x: width - inset, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
    case "HEXAGON": return polygon([{ x: inset, y: 0 }, { x: width - inset, y: 0 }, { x: width, y: height / 2 }, { x: width - inset, y: height }, { x: inset, y: height }, { x: 0, y: height / 2 }]);
    case "CHEVRON": return polygon([{ x: 0, y: 0 }, { x: width - inset, y: 0 }, { x: width, y: height / 2 }, { x: width - inset, y: height }, { x: 0, y: height }, { x: inset, y: height / 2 }]);
    case "PENTAGON": return polygon([{ x: width / 2, y: 0 }, { x: width, y: height * .38 }, { x: width * .81, y: height }, { x: width * .19, y: height }, { x: 0, y: height * .38 }]);
    case "OCTAGON": return polygon([{ x: inset, y: 0 }, { x: width - inset, y: 0 }, { x: width, y: inset }, { x: width, y: height - inset }, { x: width - inset, y: height }, { x: inset, y: height }, { x: 0, y: height - inset }, { x: 0, y: inset }]);
    case "SHIELD": return polygon([{ x: width * .12, y: 0 }, { x: width * .88, y: 0 }, { x: width, y: height * .22 }, { x: width / 2, y: height }, { x: 0, y: height * .22 }]);
    case "ENG_FILE": return polygon([{ x: 0, y: 0 }, { x: width * .72, y: 0 }, { x: width, y: height * .28 }, { x: width, y: height }, { x: 0, y: height }]);
    case "ENG_FOLDER": return polygon([{ x: 0, y: height * .16 }, { x: width * .4, y: height * .16 }, { x: width * .5, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
    case "DOCUMENT_SINGLE": return polygon([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height * .88 }, { x: width * .76, y: height }, { x: width * .5, y: height * .88 }, { x: width * .24, y: height }, { x: 0, y: height * .88 }]);
    case "DOCUMENT_MULTIPLE": return polygon([{ x: width * .12, y: 0 }, { x: width, y: 0 }, { x: width, y: height * .88 }, { x: width * .76, y: height }, { x: width * .5, y: height * .88 }, { x: width * .24, y: height }, { x: width * .12, y: height * .88 }]);
    case "PREDEFINED_PROCESS": return polygon([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
    case "INTERNAL_STORAGE": return polygon([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
    case "ENG_DATABASE": return polygon([{ x: width * .16, y: 0 }, { x: width * .84, y: 0 }, { x: width, y: height * .14 }, { x: width, y: height * .86 }, { x: width * .84, y: height }, { x: width * .16, y: height }, { x: 0, y: height * .86 }, { x: 0, y: height * .14 }]);
    case "PLUS": {
      const armX = width * .3; const armY = height * .3;
      return polygon([{ x: armX, y: 0 }, { x: width - armX, y: 0 }, { x: width - armX, y: armY }, { x: width, y: armY }, { x: width, y: height - armY }, { x: width - armX, y: height - armY }, { x: width - armX, y: height }, { x: armX, y: height }, { x: armX, y: height - armY }, { x: 0, y: height - armY }, { x: 0, y: armY }, { x: armX, y: armY }]);
    }
    case "STAR": return polygon(starPoints(width, height));
    case "SPEECH_BUBBLE": return polygon([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height * .72 }, { x: width * .62, y: height * .72 }, { x: width * .46, y: height }, { x: width * .42, y: height * .72 }, { x: 0, y: height * .72 }]);
    case "ARROW_RIGHT": {
      const head = Math.min(width * .4, height * .6);
      return polygon([{ x: 0, y: height * .25 }, { x: width - head, y: height * .25 }, { x: width - head, y: 0 }, { x: width, y: height / 2 }, { x: width - head, y: height }, { x: width - head, y: height * .75 }, { x: 0, y: height * .75 }]);
    }
    case "ARROW_LEFT": {
      const head = Math.min(width * .4, height * .6);
      return polygon([{ x: head, y: 0 }, { x: width, y: height * .25 }, { x: width, y: height * .75 }, { x: head, y: height * .75 }, { x: head, y: height }, { x: 0, y: height / 2 }, { x: head, y: 0 }]);
    }
    default: return undefined;
  }
}

/**
 * Standard, presentation-only interior marks for the ShapeWithText variants
 * whose meaning depends on more than their outer silhouette.  The marks are
 * deliberately kept as local geometry: Canvas and SVG can paint the same
 * paths, while hit testing continues to use the editable outer contour.
 */
export function shapeWithTextDecorations(type: ShapeWithTextType | undefined, width: number, height: number): readonly ShapeWithTextDecoration[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  switch (type ?? "ROUNDED_RECTANGLE") {
    case "PREDEFINED_PROCESS":
      return [verticalMark(width * .12, height), verticalMark(width * .88, height)];
    case "INTERNAL_STORAGE":
      return [verticalMark(width * .14, height), horizontalMark(width, height * .2)];
    case "ENG_FILE":
      return [{ kind: "polyline", points: [{ x: width * .72, y: 0 }, { x: width * .72, y: height * .28 }, { x: width, y: height * .28 }] }];
    case "ENG_DATABASE":
      return [
        { kind: "cubic", start: { x: width * .16, y: height * .14 }, control1: { x: width * .3, y: height * .28 }, control2: { x: width * .7, y: height * .28 }, end: { x: width * .84, y: height * .14 } },
        { kind: "cubic", start: { x: width * .16, y: height * .86 }, control1: { x: width * .3, y: height * .72 }, control2: { x: width * .7, y: height * .72 }, end: { x: width * .84, y: height * .86 } },
      ];
    case "DOCUMENT_MULTIPLE":
      return [{ kind: "polyline", points: [{ x: 0, y: height * .1 }, { x: width * .12, y: height * .1 }] }];
    default:
      return [];
  }
}

export function traceShapeWithTextPath(context: Pick<CanvasRenderingContext2D, "beginPath" | "closePath" | "ellipse" | "lineTo" | "moveTo">, type: ShapeWithTextType | undefined, width: number, height: number): boolean {
  const path = shapeWithTextPath(type, width, height);
  if (!path) return false;
  context.beginPath();
  if (path.kind === "ellipse") context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else {
    path.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.closePath();
  }
  return true;
}

export function traceShapeWithTextDecorations(context: Pick<CanvasRenderingContext2D, "beginPath" | "bezierCurveTo" | "lineTo" | "moveTo">, type: ShapeWithTextType | undefined, width: number, height: number): boolean {
  const decorations = shapeWithTextDecorations(type, width, height);
  if (!decorations.length) return false;
  context.beginPath();
  decorations.forEach((decoration) => {
    if (decoration.kind === "cubic") {
      context.moveTo(decoration.start.x, decoration.start.y);
      context.bezierCurveTo(decoration.control1.x, decoration.control1.y, decoration.control2.x, decoration.control2.y, decoration.end.x, decoration.end.y);
      return;
    }
    decoration.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  });
  return true;
}

export function shapeWithTextPathD(path: ShapeWithTextPath, number: (value: number) => string): string | undefined {
  if (path.kind === "ellipse") return undefined;
  return `M ${number(path.points[0]!.x)} ${number(path.points[0]!.y)}${path.points.slice(1).map((point) => ` L ${number(point.x)} ${number(point.y)}`).join("")} Z`;
}

export function shapeWithTextDecorationPathD(decoration: ShapeWithTextDecoration, number: (value: number) => string): string {
  if (decoration.kind === "cubic") return `M ${number(decoration.start.x)} ${number(decoration.start.y)} C ${number(decoration.control1.x)} ${number(decoration.control1.y)} ${number(decoration.control2.x)} ${number(decoration.control2.y)} ${number(decoration.end.x)} ${number(decoration.end.y)}`;
  return `M ${number(decoration.points[0]!.x)} ${number(decoration.points[0]!.y)}${decoration.points.slice(1).map((point) => ` L ${number(point.x)} ${number(point.y)}`).join("")}`;
}

export function shapeWithTextContains(type: ShapeWithTextType | undefined, width: number, height: number, point: ShapeWithTextPoint): boolean | undefined {
  const path = shapeWithTextPath(type, width, height);
  if (!path) return undefined;
  if (path.kind === "ellipse") {
    const x = (point.x - width / 2) / (width / 2);
    const y = (point.y - height / 2) / (height / 2);
    return x * x + y * y <= 1;
  }
  return pointInPolygon(point, path.points);
}

function polygon(points: readonly ShapeWithTextPoint[]): ShapeWithTextPath { return { kind: "polygon", points }; }
function verticalMark(x: number, height: number): ShapeWithTextDecoration { return { kind: "polyline", points: [{ x, y: 0 }, { x, y: height }] }; }
function horizontalMark(width: number, y: number): ShapeWithTextDecoration { return { kind: "polyline", points: [{ x: 0, y }, { x: width, y }] }; }
function starPoints(width: number, height: number): readonly ShapeWithTextPoint[] {
  const outerX = width / 2; const outerY = height / 2;
  const outerRadius = Math.min(width, height) / 2;
  const innerRadius = outerRadius * .42;
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const radius = index % 2 ? innerRadius : outerRadius;
    return { x: outerX + Math.cos(angle) * radius, y: outerY + Math.sin(angle) * radius };
  });
}
