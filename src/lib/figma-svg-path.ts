import type { DocumentVectorPath } from "./editor-protocol";

type Point = { x: number; y: number; handleIn?: Point; handleOut?: Point };
type ParsedSubpath = { closed: boolean; points: Point[] };
type Token = string | number;
const MAX_VECTOR_SUBPATHS = 64;
const MAX_VECTOR_POINTS = 8_192;

/** Converts Figma REST `fillGeometry[].path` SVG data into the editable cubic
 * path model used by Canonical Core. Figma exposes this geometry relative to the
 * node; callers retain the node's REST `relativeTransform` independently.
 *
 * Elliptical arcs are deterministically segmented into bounded cubic handles.
 * Callers preserve the original SVG source separately when source-level arc
 * parameters must remain inspectable. */
export function parseFigmaSvgPaths(
  sources: Array<{ path: string; windingRule?: string }>,
  allocatePointId: () => string,
): { path: DocumentVectorPath } | { reason: string } {
  if (!sources.length) return { reason: "Figma VECTOR has no fillGeometry paths." };
  const windingRules = new Set(sources.map((source) => source.windingRule ?? "NONZERO"));
  if (windingRules.size !== 1) return { reason: "Mixed Figma winding rules cannot be represented by one Canonical VectorPath." };
  const windingRule = [...windingRules][0];
  if (windingRule !== "NONZERO" && windingRule !== "EVENODD") return { reason: `Unsupported Figma winding rule ${windingRule}.` };
  const subpaths: ParsedSubpath[] = [];
  for (const source of sources) {
    const parsed = parsePath(source.path);
    if (typeof parsed === "string") return { reason: parsed };
    subpaths.push(...parsed);
  }
  if (!subpaths.length) return { reason: "Figma VECTOR has no drawable subpaths." };
  if (subpaths.length > MAX_VECTOR_SUBPATHS) return { reason: `Figma VECTOR exceeds Core's ${MAX_VECTOR_SUBPATHS}-subpath limit.` };
  if (subpaths.reduce((total, subpath) => total + subpath.points.length, 0) > MAX_VECTOR_POINTS) return { reason: `Figma VECTOR exceeds Core's ${MAX_VECTOR_POINTS}-point limit.` };
  return {
    path: {
      fillRule: windingRule === "EVENODD" ? "evenOdd" : "nonZero",
      subpaths: subpaths.map((subpath) => ({
        closed: subpath.closed,
        points: subpath.points.map((point) => ({
          id: allocatePointId(),
          x: point.x,
          y: point.y,
          handleIn: point.handleIn,
          handleOut: point.handleOut,
          pointType: point.handleIn || point.handleOut ? "asymmetric" : "corner",
        })),
      })),
    },
  };
}

function parsePath(path: string): ParsedSubpath[] | string {
  const tokens = tokenize(path);
  if (!tokens) return "SVG path contains an invalid token or separator.";
  const subpaths: ParsedSubpath[] = [];
  let cursor = 0;
  let command: string | undefined;
  let current: Point | undefined;
  let start: Point | undefined;
  let active: ParsedSubpath | undefined;
  let previousCubicControl: Point | undefined;
  let previousQuadraticControl: Point | undefined;

  const read = (count: number): number[] | undefined => {
    if (cursor + count > tokens.length || tokens.slice(cursor, cursor + count).some((token) => typeof token !== "number")) return undefined;
    const values = tokens.slice(cursor, cursor + count) as number[];
    cursor += count;
    return values;
  };
  const point = (x: number, y: number, relative: boolean): Point | undefined => {
    if (relative && !current) return undefined;
    return { x: relative ? current!.x + x : x, y: relative ? current!.y + y : y };
  };
  const resetControls = () => { previousCubicControl = undefined; previousQuadraticControl = undefined; };
  const begin = (next: Point) => {
    active = { closed: false, points: [{ x: next.x, y: next.y }] };
    subpaths.push(active);
    current = next;
    start = { ...next };
    resetControls();
  };
  const line = (next: Point) => {
    if (!active || !current) return false;
    active.points.push({ x: next.x, y: next.y });
    current = next;
    resetControls();
    return true;
  };
  const cubic = (first: Point, second: Point, end: Point) => {
    if (!active || !current) return false;
    const previous = active.points.at(-1)!;
    previous.handleOut = { x: first.x - previous.x, y: first.y - previous.y };
    active.points.push({ x: end.x, y: end.y, handleIn: { x: second.x - end.x, y: second.y - end.y } });
    current = end;
    previousCubicControl = second;
    previousQuadraticControl = undefined;
    return true;
  };
  const quadratic = (control: Point, end: Point) => {
    if (!current) return false;
    const first = { x: current.x + (control.x - current.x) * 2 / 3, y: current.y + (control.y - current.y) * 2 / 3 };
    const second = { x: end.x + (control.x - end.x) * 2 / 3, y: end.y + (control.y - end.y) * 2 / 3 };
    if (!cubic(first, second, end)) return false;
    previousQuadraticControl = control;
    previousCubicControl = undefined;
    return true;
  };
  const reflect = (control: Point | undefined) => control && current ? { x: current.x * 2 - control.x, y: current.y * 2 - control.y } : current && { x: current.x, y: current.y };

  while (cursor < tokens.length) {
    if (typeof tokens[cursor] === "string") command = tokens[cursor++] as string;
    if (!command) return "SVG path is missing a command.";
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    if (upper === "A") {
      const values = read(7);
      const end = values && point(values[5]!, values[6]!, relative);
      if (!values || !end || !current) return "SVG elliptical arc command has incomplete coordinates.";
      const curves = arcCubics(current, end, values[0]!, values[1]!, values[2]!, values[3]!, values[4]!);
      if (curves === "line") {
        if (!line(end)) return "SVG elliptical arc command has no active subpath.";
      } else {
        if (typeof curves === "string") return curves;
        for (const curve of curves) if (!cubic(curve.first, curve.second, curve.end)) return "SVG elliptical arc command has no active subpath.";
        // SVG smooth-Cubic reflection applies only after C/S, never after Arc.
        resetControls();
      }
      continue;
    }
    if (upper === "Z") {
      if (!active || !start) return "SVG close command has no active subpath.";
      // SVG producers commonly serialize the closing segment explicitly back
      // to the move point and then append Z. Canonical closed subpaths store the
      // first anchor only once, so fold that duplicate endpoint into the first
      // anchor while retaining the incoming control handle of the closing
      // cubic. Core deliberately rejects a duplicated first/last anchor.
      const first = active.points[0];
      const last = active.points.at(-1);
      if (first && last && first !== last && samePoint(first, last)) {
        if (last.handleIn) first.handleIn = { ...last.handleIn };
        active.points.pop();
      }
      active.closed = true;
      current = { ...start };
      resetControls();
      command = undefined;
      continue;
    }
    if (upper === "M") {
      const values = read(2);
      const next = values && point(values[0]!, values[1]!, relative);
      if (!next) return "SVG move command has incomplete coordinates.";
      begin(next);
      command = relative ? "l" : "L";
      continue;
    }
    if (upper === "L") {
      const values = read(2);
      const next = values && point(values[0]!, values[1]!, relative);
      if (!next || !line(next)) return "SVG line command has incomplete coordinates.";
      continue;
    }
    if (upper === "H" || upper === "V") {
      const values = read(1);
      if (!values || !current) return "SVG horizontal/vertical command has incomplete coordinates.";
      const next = upper === "H" ? point(values[0]!, 0, relative) : point(0, values[0]!, relative);
      if (!next) return "SVG horizontal/vertical command has invalid coordinates.";
      if (upper === "H" && !relative) next.y = current.y;
      if (upper === "V" && !relative) next.x = current.x;
      if (!line(next)) return "SVG horizontal/vertical command has no active subpath.";
      continue;
    }
    if (upper === "C") {
      const values = read(6);
      const first = values && point(values[0]!, values[1]!, relative);
      const second = values && point(values[2]!, values[3]!, relative);
      const end = values && point(values[4]!, values[5]!, relative);
      if (!first || !second || !end || !cubic(first, second, end)) return "SVG cubic command has incomplete coordinates.";
      continue;
    }
    if (upper === "S") {
      const values = read(4);
      const first = reflect(previousCubicControl);
      const second = values && point(values[0]!, values[1]!, relative);
      const end = values && point(values[2]!, values[3]!, relative);
      if (!first || !second || !end || !cubic(first, second, end)) return "SVG smooth cubic command has incomplete coordinates.";
      continue;
    }
    if (upper === "Q") {
      const values = read(4);
      const control = values && point(values[0]!, values[1]!, relative);
      const end = values && point(values[2]!, values[3]!, relative);
      if (!control || !end || !quadratic(control, end)) return "SVG quadratic command has incomplete coordinates.";
      continue;
    }
    if (upper === "T") {
      const values = read(2);
      const control = reflect(previousQuadraticControl);
      const end = values && point(values[0]!, values[1]!, relative);
      if (!control || !end || !quadratic(control, end)) return "SVG smooth quadratic command has incomplete coordinates.";
      continue;
    }
    return `Unsupported SVG path command ${command}.`;
  }
  if (subpaths.some((subpath) => subpath.points.length < (subpath.closed ? 3 : 2))) return "SVG path contains a subpath with too few editable points.";
  return subpaths;
}

function tokenize(path: string): Token[] | undefined {
  const tokens: Token[] = [];
  const token = /[\s,]*([AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/y;
  const input = path.trim();
  let cursor = 0;
  while (cursor < input.length) {
    token.lastIndex = cursor;
    const match = token.exec(input);
    if (!match || match.index !== cursor) return undefined;
    cursor = token.lastIndex;
    const value = match[1]!;
    tokens.push(value.length === 1 && /[A-Za-z]/.test(value) ? value : Number(value));
  }
  return tokens;
}

type CubicSegment = { first: Point; second: Point; end: Point };

/** SVG endpoint-parameterized elliptical arc conversion from the SVG 1.1
 * implementation notes. A maximum 22.5° segment keeps the cubic deviation
 * bounded while still retaining ordinary Core Vector point limits. */
function arcCubics(start: Point, end: Point, rawRx: number, rawRy: number, rotationDegrees: number, largeArcFlag: number, sweepFlag: number): CubicSegment[] | "line" | string {
  if (![rawRx, rawRy, rotationDegrees, largeArcFlag, sweepFlag].every(Number.isFinite)) return "SVG elliptical arc command has non-finite parameters.";
  if (!Number.isInteger(largeArcFlag) || !Number.isInteger(sweepFlag) || (largeArcFlag !== 0 && largeArcFlag !== 1) || (sweepFlag !== 0 && sweepFlag !== 1)) return "SVG elliptical arc flags must be 0 or 1.";
  let rx = Math.abs(rawRx);
  let ry = Math.abs(rawRy);
  if (rx === 0 || ry === 0) return "line";
  if (samePoint(start, end)) return [];

  const rotation = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const deltaX = (start.x - end.x) / 2;
  const deltaY = (start.y - end.y) / 2;
  const x1 = cosine * deltaX + sine * deltaY;
  const y1 = -sine * deltaX + cosine * deltaY;
  const lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x12 = x1 * x1;
  const y12 = y1 * y1;
  const denominator = rx2 * y12 + ry2 * x12;
  if (!Number.isFinite(denominator) || denominator === 0) return "SVG elliptical arc parameters cannot determine a center.";
  const numerator = Math.max(0, rx2 * ry2 - rx2 * y12 - ry2 * x12);
  const sign = largeArcFlag === sweepFlag ? -1 : 1;
  const coefficient = sign * Math.sqrt(numerator / denominator);
  const centerXPrime = coefficient * rx * y1 / ry;
  const centerYPrime = coefficient * -ry * x1 / rx;
  const center = {
    x: cosine * centerXPrime - sine * centerYPrime + (start.x + end.x) / 2,
    y: sine * centerXPrime + cosine * centerYPrime + (start.y + end.y) / 2,
  };
  const startVector = { x: (x1 - centerXPrime) / rx, y: (y1 - centerYPrime) / ry };
  const endVector = { x: (-x1 - centerXPrime) / rx, y: (-y1 - centerYPrime) / ry };
  const startAngle = Math.atan2(startVector.y, startVector.x);
  let deltaAngle = signedAngle(startVector, endVector);
  if (!sweepFlag && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (sweepFlag && deltaAngle < 0) deltaAngle += Math.PI * 2;
  const segmentCount = Math.ceil(Math.abs(deltaAngle) / (Math.PI / 8));
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1 || segmentCount > 16) return "SVG elliptical arc exceeds the bounded conversion segment count.";
  const map = (x: number, y: number): Point => ({ x: center.x + cosine * rx * x - sine * ry * y, y: center.y + sine * rx * x + cosine * ry * y });
  const segments: CubicSegment[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const firstAngle = startAngle + deltaAngle * index / segmentCount;
    const secondAngle = startAngle + deltaAngle * (index + 1) / segmentCount;
    const tangent = 4 / 3 * Math.tan((secondAngle - firstAngle) / 4);
    const first = { x: Math.cos(firstAngle), y: Math.sin(firstAngle) };
    const second = { x: Math.cos(secondAngle), y: Math.sin(secondAngle) };
    segments.push({
      first: map(first.x - tangent * first.y, first.y + tangent * first.x),
      second: map(second.x + tangent * second.y, second.y - tangent * second.x),
      end: index === segmentCount - 1 ? end : map(second.x, second.y),
    });
  }
  return segments;
}

function signedAngle(left: Point, right: Point) {
  return Math.atan2(left.x * right.y - left.y * right.x, left.x * right.x + left.y * right.y);
}
function samePoint(left: Point, right: Point) { return left.x === right.x && left.y === right.y; }
