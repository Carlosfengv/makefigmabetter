import type { DocumentVectorPath, StrokeCap, StrokeJoin } from "../lib/editor-protocol";

export type RuntimeHandleMirroring = "NONE" | "ANGLE" | "ANGLE_AND_LENGTH";
export type RuntimeNetworkStrokeCap = "NONE" | "ROUND" | "SQUARE" | "ARROW_LINES" | "ARROW_EQUILATERAL" | "DIAMOND_FILLED" | "TRIANGLE_FILLED" | "CIRCLE_FILLED";
export type RuntimeNetworkStrokeJoin = "MITER" | "BEVEL" | "ROUND";
export type RuntimeVector = Readonly<{ x: number; y: number }>;
export type RuntimeVectorVertex = Readonly<{
  x: number;
  y: number;
  strokeCap?: RuntimeNetworkStrokeCap;
  strokeJoin?: RuntimeNetworkStrokeJoin;
  cornerRadius?: number;
  handleMirroring?: RuntimeHandleMirroring;
}>;
export type RuntimeVectorSegment = Readonly<{
  start: number;
  end: number;
  tangentStart?: RuntimeVector;
  tangentEnd?: RuntimeVector;
}>;
export type RuntimeVectorRegion = Readonly<{
  windingRule: "NONZERO" | "EVENODD";
  loops: readonly (readonly number[])[];
  fills?: readonly unknown[];
  fillStyleId?: string;
}>;
export type RuntimeVectorNetwork = Readonly<{
  vertices: readonly RuntimeVectorVertex[];
  segments: readonly RuntimeVectorSegment[];
  regions?: readonly RuntimeVectorRegion[];
}>;

type NetworkConversion = Readonly<{
  path: DocumentVectorPath;
  strokeCapStart: StrokeCap;
  strokeCapEnd: StrokeCap;
  strokeJoin?: StrokeJoin;
  network?: RuntimeVectorNetwork;
}>;

const MAX_VECTOR_SUBPATHS = 64;
const MAX_VECTOR_POINTS = 8_192;
const MAX_VECTOR_NETWORK_EXTENSION_BYTES = 256 * 1024;
export const VECTOR_NETWORK_EXTENSION = "figma.runtime.vector-network.v1";

/**
 * Canonical VectorPath is a collection of independent cubic chains. This
 * adapter exposes that exact topology as a Figma-shaped VectorNetwork without
 * inventing shared vertices or region-local paints that Core cannot persist.
 */
export function runtimeVectorNetworkFromCanonical(
  path: DocumentVectorPath,
  strokeCapStart: StrokeCap,
  strokeCapEnd: StrokeCap,
): RuntimeVectorNetwork {
  const vertices: RuntimeVectorVertex[] = [];
  const segments: RuntimeVectorSegment[] = [];
  const loops: number[][] = [];

  for (const subpath of path.subpaths) {
    const vertexOffset = vertices.length;
    for (let pointIndex = 0; pointIndex < subpath.points.length; pointIndex += 1) {
      const point = subpath.points[pointIndex]!;
      const endpointCap = subpath.closed
        ? undefined
        : pointIndex === 0
          ? runtimeStrokeCap(strokeCapStart)
          : pointIndex === subpath.points.length - 1
            ? runtimeStrokeCap(strokeCapEnd)
            : undefined;
      vertices.push({
        x: point.x,
        y: point.y,
        ...(endpointCap ? { strokeCap: endpointCap } : {}),
        handleMirroring: point.pointType === "mirrored" ? "ANGLE_AND_LENGTH" : point.pointType === "asymmetric" ? "ANGLE" : "NONE",
      });
    }

    const loop: number[] = [];
    const segmentCount = Math.max(0, subpath.points.length - 1) + (subpath.closed && subpath.points.length > 1 ? 1 : 0);
    for (let pointIndex = 0; pointIndex < segmentCount; pointIndex += 1) {
      const nextIndex = (pointIndex + 1) % subpath.points.length;
      const start = subpath.points[pointIndex]!;
      const end = subpath.points[nextIndex]!;
      loop.push(segments.length);
      segments.push({
        start: vertexOffset + pointIndex,
        end: vertexOffset + nextIndex,
        ...(start.handleOut ? { tangentStart: { ...start.handleOut } } : {}),
        ...(end.handleIn ? { tangentEnd: { ...end.handleIn } } : {}),
      });
    }
    if (subpath.closed) loops.push(loop);
  }

  return {
    vertices,
    segments,
    regions: loops.length ? [{ windingRule: path.fillRule === "evenOdd" ? "EVENODD" : "NONZERO", loops }] : [],
  };
}

/**
 * Converts the lossless VectorNetwork subset back to Canonical. Supported
 * networks are independent directed chains/cycles with one global fill rule.
 * Branches, per-region paints, per-vertex corners and mixed joins are rejected
 * before an optimistic Runtime write is staged.
 */
export function canonicalVectorPathFromRuntimeNetwork(
  input: RuntimeVectorNetwork,
  allocatePointId: () => string,
  defaults: Readonly<{ strokeCapStart: StrokeCap; strokeCapEnd: StrokeCap; strokeJoin: StrokeJoin }>,
): NetworkConversion | { reason: string } {
  if (!input || typeof input !== "object" || !Array.isArray(input.vertices) || !Array.isArray(input.segments) || (input.regions !== undefined && !Array.isArray(input.regions))) {
    return { reason: "VectorNetwork must contain vertices and segments arrays." };
  }
  if (input.vertices.length > MAX_VECTOR_POINTS || input.segments.length > MAX_VECTOR_POINTS) {
    return { reason: `VectorNetwork exceeds Core's ${MAX_VECTOR_POINTS}-point/segment limit.` };
  }
  if (input.vertices.some((vertex) => !validVertex(vertex)) || input.segments.some((segment) => !validSegment(segment, input.vertices.length))) {
    return { reason: "VectorNetwork contains an invalid vertex or segment." };
  }

  const incoming = Array.from({ length: input.vertices.length }, () => [] as number[]);
  const outgoing = Array.from({ length: input.vertices.length }, () => [] as number[]);
  input.segments.forEach((segment, segmentIndex) => {
    outgoing[segment.start]!.push(segmentIndex);
    incoming[segment.end]!.push(segmentIndex);
  });
  const hasSharedTopology = incoming.some((segments, vertexIndex) => segments.length > 1 || outgoing[vertexIndex]!.length > 1 || (segments.length + outgoing[vertexIndex]!.length > 1 && (segments.length !== 1 || outgoing[vertexIndex]!.length !== 1)));
  if (hasSharedTopology) {
    return canonicalBranchedNetwork(input, allocatePointId, defaults);
  }

  const visitedSegments = new Set<number>();
  const visitedVertices = new Set<number>();
  const components: Array<{ vertexIndexes: number[]; segmentIndexes: number[]; closed: boolean }> = [];
  const starts = input.vertices.map((_, index) => index).filter((index) => incoming[index]!.length === 0 && outgoing[index]!.length === 1);
  const isolated = input.vertices.map((_, index) => index).filter((index) => incoming[index]!.length === 0 && outgoing[index]!.length === 0);

  const walk = (start: number, closed: boolean) => {
    const vertexIndexes: number[] = [];
    const segmentIndexes: number[] = [];
    let current = start;
    while (!visitedVertices.has(current)) {
      visitedVertices.add(current);
      vertexIndexes.push(current);
      const nextSegment = outgoing[current]![0];
      if (nextSegment === undefined) break;
      if (visitedSegments.has(nextSegment)) break;
      visitedSegments.add(nextSegment);
      segmentIndexes.push(nextSegment);
      current = input.segments[nextSegment]!.end;
    }
    if ((closed && current !== start) || (!closed && outgoing[current]?.length)) return false;
    components.push({ vertexIndexes, segmentIndexes, closed });
    return true;
  };

  for (const start of starts) if (!walk(start, false)) return { reason: "VectorNetwork contains a malformed directed chain." };
  for (const vertexIndex of isolated) {
    visitedVertices.add(vertexIndex);
    components.push({ vertexIndexes: [vertexIndex], segmentIndexes: [], closed: false });
  }
  for (let vertexIndex = 0; vertexIndex < input.vertices.length; vertexIndex += 1) {
    if (!visitedVertices.has(vertexIndex) && !walk(vertexIndex, true)) return { reason: "VectorNetwork contains a malformed directed cycle." };
  }
  if (visitedSegments.size !== input.segments.length || visitedVertices.size !== input.vertices.length) {
    return { reason: "VectorNetwork contains disconnected segment state." };
  }
  if (components.length > MAX_VECTOR_SUBPATHS) return { reason: `VectorNetwork exceeds Core's ${MAX_VECTOR_SUBPATHS}-subpath limit.` };

  const regions = input.regions ?? [];
  const closedComponents = components.filter((component) => component.closed);
  let fillRule: DocumentVectorPath["fillRule"] = "nonZero";
  if (closedComponents.length) {
    if (regions.length !== 1) return { reason: "Closed VectorNetwork cycles require exactly one globally representable region." };
    const region = regions[0]!;
    if (!validRegion(region) || region.fills !== undefined || region.fillStyleId !== undefined) {
      return { reason: "Canonical VectorPath cannot represent region-local fills or fill styles." };
    }
    if (region.loops.length !== closedComponents.length || !loopsMatchComponents(region.loops, closedComponents)) {
      return { reason: "VectorNetwork regions must cover every closed cycle exactly once." };
    }
    fillRule = region.windingRule === "EVENODD" ? "evenOdd" : "nonZero";
  } else if (regions.length) {
    return { reason: "Open VectorNetwork chains cannot contain fill regions." };
  }

  const hasExplicitJoin = input.vertices.some((vertex) => vertex.strokeJoin !== undefined);
  const resolvedJoins = input.vertices.map((vertex) => vertex.strokeJoin === undefined ? defaults.strokeJoin : canonicalStrokeJoin(vertex.strokeJoin));
  if (resolvedJoins.some((join) => !join) || new Set(resolvedJoins).size > 1) {
    return { reason: "Canonical VectorPath cannot represent mixed per-vertex stroke joins." };
  }
  if (input.vertices.some((vertex) => vertex.cornerRadius !== undefined)) {
    return { reason: "Canonical VectorPath cannot represent per-vertex corner radii." };
  }

  const startCaps: StrokeCap[] = [];
  const endCaps: StrokeCap[] = [];
  for (const component of components) {
    for (let index = 0; index < component.vertexIndexes.length; index += 1) {
      const vertex = input.vertices[component.vertexIndexes[index]!]!;
      if (vertex.strokeCap === undefined) continue;
      if (component.closed || (index !== 0 && index !== component.vertexIndexes.length - 1)) {
        return { reason: "Canonical VectorPath supports stroke caps only at open-path endpoints." };
      }
    }
    if (component.closed) continue;
    const first = input.vertices[component.vertexIndexes[0]!]!;
    const last = input.vertices[component.vertexIndexes.at(-1)!]!;
    const firstCap = first.strokeCap === undefined ? defaults.strokeCapStart : canonicalStrokeCap(first.strokeCap);
    const lastCap = last.strokeCap === undefined ? defaults.strokeCapEnd : canonicalStrokeCap(last.strokeCap);
    if (!firstCap || !lastCap) return { reason: "VectorNetwork contains an unsupported stroke cap." };
    startCaps.push(firstCap);
    endCaps.push(lastCap);
  }
  if (new Set(startCaps).size > 1 || new Set(endCaps).size > 1) {
    return { reason: "Canonical VectorPath requires one shared start cap and one shared end cap across open subpaths." };
  }

  const subpaths: DocumentVectorPath["subpaths"] = [];
  for (const component of components) {
    const componentVertices = component.vertexIndexes.map((vertexIndex) => input.vertices[vertexIndex]!);
    if (component.closed && componentVertices.length < 3) return { reason: "Closed VectorNetwork cycles require at least three vertices." };
    if (componentVertices.some((vertex, index) => index > 0 && samePoint(vertex, componentVertices[index - 1]!)) || (component.closed && samePoint(componentVertices[0]!, componentVertices.at(-1)!))) {
      return { reason: "VectorNetwork contains duplicate adjacent vertex positions." };
    }
    const points = component.vertexIndexes.map((vertexIndex) => {
      const vertex = input.vertices[vertexIndex]!;
      const incomingSegment = incoming[vertexIndex]![0];
      const outgoingSegment = outgoing[vertexIndex]![0];
      const handleIn = incomingSegment === undefined ? undefined : input.segments[incomingSegment]!.tangentEnd;
      const handleOut = outgoingSegment === undefined ? undefined : input.segments[outgoingSegment]!.tangentStart;
      return {
        id: allocatePointId(),
        x: vertex.x,
        y: vertex.y,
        ...(handleIn ? { handleIn: { ...handleIn } } : {}),
        ...(handleOut ? { handleOut: { ...handleOut } } : {}),
        pointType: vertex.handleMirroring === "ANGLE_AND_LENGTH" ? "mirrored" as const : vertex.handleMirroring === "ANGLE" ? "asymmetric" as const : "corner" as const,
      };
    });
    subpaths.push({ closed: component.closed, points });
  }

  return {
    path: { fillRule, subpaths },
    strokeCapStart: startCaps[0] ?? defaults.strokeCapStart,
    strokeCapEnd: endCaps[0] ?? defaults.strokeCapEnd,
    ...(hasExplicitJoin && resolvedJoins[0] ? { strokeJoin: resolvedJoins[0] } : {}),
  };
}

/** Reads the exact shared-topology record only while its derived VectorPath is
 * still current. Generic path edits therefore invalidate the extension
 * without requiring every mutation surface to know about VectorNetwork. */
export function runtimeVectorNetworkFromExtension(extensions: unknown, path: DocumentVectorPath): RuntimeVectorNetwork | undefined {
  if (!extensions || typeof extensions !== "object") return undefined;
  const bytes = (extensions as Record<string, unknown>)[VECTOR_NETWORK_EXTENSION];
  if (!Array.isArray(bytes) || bytes.length > MAX_VECTOR_NETWORK_EXTENSION_BYTES || bytes.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 255)) return undefined;
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))) as unknown;
    if (!decoded || typeof decoded !== "object") return undefined;
    const record = decoded as { version?: unknown; network?: unknown; path?: unknown };
    if (record.version !== 1 || stableJson(record.path) !== stableJson(path) || !validNetworkShape(record.network)) return undefined;
    return structuredClone(record.network);
  } catch {
    return undefined;
  }
}

export function extensionsWithRuntimeVectorNetwork(
  extensions: unknown,
  network: RuntimeVectorNetwork | undefined,
  path?: DocumentVectorPath,
): Record<string, number[]> {
  const next = extensions && typeof extensions === "object"
    ? structuredClone(extensions as Record<string, number[]>)
    : {};
  delete next[VECTOR_NETWORK_EXTENSION];
  if (!network || !path) return next;
  const encoded = [...new TextEncoder().encode(JSON.stringify({ version: 1, network, path }))];
  if (encoded.length > MAX_VECTOR_NETWORK_EXTENSION_BYTES) throw new Error("VectorNetwork extension exceeds its byte budget.");
  next[VECTOR_NETWORK_EXTENSION] = encoded;
  return next;
}

function canonicalBranchedNetwork(
  input: RuntimeVectorNetwork,
  allocatePointId: () => string,
  defaults: Readonly<{ strokeCapStart: StrokeCap; strokeCapEnd: StrokeCap; strokeJoin: StrokeJoin }>,
): NetworkConversion | { reason: string } {
  const regions = input.regions ?? [];
  if (regions.length > 1) return { reason: "Branched VectorNetwork supports at most one globally styled region." };
  const region = regions[0];
  if (region && (!validRegion(region) || region.fills !== undefined || region.fillStyleId !== undefined)) {
    return { reason: "Canonical VectorPath cannot represent region-local fills or fill styles." };
  }
  if (input.vertices.some((vertex) => vertex.cornerRadius !== undefined)) return { reason: "Canonical VectorPath cannot represent per-vertex corner radii." };
  if (input.vertices.some((vertex) => vertex.strokeJoin !== undefined)) return { reason: "Branched VectorNetwork vertices cannot preserve explicit per-vertex stroke joins." };
  if (input.vertices.some((vertex) => vertex.strokeCap !== undefined) || defaults.strokeCapStart !== "none" || defaults.strokeCapEnd !== "none") {
    return { reason: "Branched VectorNetwork rendering requires NONE endpoint caps." };
  }
  const connectedVertices = new Set(input.segments.flatMap((segment) => [segment.start, segment.end]));
  const isolated = input.vertices.map((_, index) => index).filter((index) => !connectedVertices.has(index));
  const edgeKeys = new Set<string>();
  for (const segment of input.segments) {
    const key = segment.start < segment.end ? `${segment.start}:${segment.end}` : `${segment.end}:${segment.start}`;
    if (edgeKeys.has(key)) return { reason: "Branched VectorNetwork contains duplicate edges." };
    edgeKeys.add(key);
  }
  const point = (vertexIndex: number, handleIn?: RuntimeVector, handleOut?: RuntimeVector) => {
    const vertex = input.vertices[vertexIndex]!;
    return {
      id: allocatePointId(),
      x: vertex.x,
      y: vertex.y,
      ...(handleIn ? { handleIn: { ...handleIn } } : {}),
      ...(handleOut ? { handleOut: { ...handleOut } } : {}),
      pointType: vertex.handleMirroring === "ANGLE_AND_LENGTH" ? "mirrored" as const : vertex.handleMirroring === "ANGLE" ? "asymmetric" as const : "corner" as const,
    };
  };
  const loopSegmentIndexes = new Set<number>();
  const subpaths: DocumentVectorPath["subpaths"] = [];
  for (const loop of region?.loops ?? []) {
    if (loop.length < 3 || loop.some((segmentIndex) => segmentIndex >= input.segments.length || loopSegmentIndexes.has(segmentIndex))) {
      return { reason: "Branched VectorNetwork region loops must contain at least three unique in-range segments." };
    }
    const segments = loop.map((segmentIndex) => input.segments[segmentIndex]!);
    if (segments.some((segment, index) => segment.end !== segments[(index + 1) % segments.length]!.start)) {
      return { reason: "Branched VectorNetwork region loops must form directed closed chains." };
    }
    loop.forEach((segmentIndex) => loopSegmentIndexes.add(segmentIndex));
    subpaths.push({
      closed: true,
      points: segments.map((segment, index) => point(
        segment.start,
        segments[(index + segments.length - 1) % segments.length]!.tangentEnd,
        segment.tangentStart,
      )),
    });
  }
  input.segments.forEach((segment, segmentIndex) => {
    if (loopSegmentIndexes.has(segmentIndex)) return;
    subpaths.push({
      closed: false,
      points: [
        point(segment.start, undefined, segment.tangentStart),
        point(segment.end, segment.tangentEnd, undefined),
      ],
    });
  });
  isolated.forEach((vertexIndex) => subpaths.push({ closed: false, points: [point(vertexIndex)] }));
  if (subpaths.length > MAX_VECTOR_SUBPATHS) return { reason: `VectorNetwork exceeds Core's ${MAX_VECTOR_SUBPATHS}-subpath limit.` };
  return {
    path: { fillRule: region?.windingRule === "EVENODD" ? "evenOdd" : "nonZero", subpaths },
    strokeCapStart: "none",
    strokeCapEnd: "none",
    strokeJoin: defaults.strokeJoin,
    network: structuredClone(input),
  };
}

function validNetworkShape(value: unknown): value is RuntimeVectorNetwork {
  if (!value || typeof value !== "object") return false;
  const network = value as RuntimeVectorNetwork;
  return Array.isArray(network.vertices)
    && Array.isArray(network.segments)
    && network.vertices.length <= MAX_VECTOR_POINTS
    && network.segments.length <= MAX_VECTOR_POINTS
    && network.vertices.every(validVertex)
    && network.segments.every((segment) => validSegment(segment, network.vertices.length))
    && (network.regions === undefined || Array.isArray(network.regions) && network.regions.every(validRegion));
}

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]));
  };
  return JSON.stringify(normalize(value));
}

function validVertex(vertex: RuntimeVectorVertex): boolean {
  return Boolean(vertex && typeof vertex === "object")
    && Number.isFinite(vertex.x)
    && Number.isFinite(vertex.y)
    && (vertex.strokeCap === undefined || canonicalStrokeCap(vertex.strokeCap) !== undefined)
    && (vertex.strokeJoin === undefined || canonicalStrokeJoin(vertex.strokeJoin) !== undefined)
    && (vertex.cornerRadius === undefined || Number.isFinite(vertex.cornerRadius) && vertex.cornerRadius >= 0)
    && (vertex.handleMirroring === undefined || ["NONE", "ANGLE", "ANGLE_AND_LENGTH"].includes(vertex.handleMirroring));
}

function validSegment(segment: RuntimeVectorSegment, vertexCount: number): boolean {
  return Boolean(segment && typeof segment === "object")
    && Number.isSafeInteger(segment.start) && segment.start >= 0 && segment.start < vertexCount
    && Number.isSafeInteger(segment.end) && segment.end >= 0 && segment.end < vertexCount
    && segment.start !== segment.end
    && validOptionalVector(segment.tangentStart)
    && validOptionalVector(segment.tangentEnd);
}

function validOptionalVector(vector: RuntimeVector | undefined): boolean {
  return vector === undefined || Boolean(vector && typeof vector === "object" && Number.isFinite(vector.x) && Number.isFinite(vector.y));
}

function validRegion(region: RuntimeVectorRegion): boolean {
  return Boolean(region && typeof region === "object")
    && (region.windingRule === "NONZERO" || region.windingRule === "EVENODD")
    && Array.isArray(region.loops)
    && region.loops.every((loop) => Array.isArray(loop) && loop.every((segmentIndex) => Number.isSafeInteger(segmentIndex) && segmentIndex >= 0));
}

function loopsMatchComponents(
  loops: readonly (readonly number[])[],
  components: readonly { segmentIndexes: number[] }[],
): boolean {
  const unmatched = new Set(components.map((_, index) => index));
  for (const loop of loops) {
    if (new Set(loop).size !== loop.length) return false;
    const match = [...unmatched].find((componentIndex) => sameIntegerSet(loop, components[componentIndex]!.segmentIndexes));
    if (match === undefined) return false;
    unmatched.delete(match);
  }
  return unmatched.size === 0;
}

function sameIntegerSet(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function samePoint(left: Readonly<{ x: number; y: number }>, right: Readonly<{ x: number; y: number }>): boolean {
  return left.x === right.x && left.y === right.y;
}

function runtimeStrokeCap(cap: StrokeCap): RuntimeNetworkStrokeCap {
  return cap === "arrowLines" ? "ARROW_LINES"
    : cap === "arrowEquilateral" ? "ARROW_EQUILATERAL"
      : cap === "diamondFilled" ? "DIAMOND_FILLED"
        : cap === "triangleFilled" ? "TRIANGLE_FILLED"
          : cap === "circleFilled" ? "CIRCLE_FILLED"
            : cap.toUpperCase() as RuntimeNetworkStrokeCap;
}

function canonicalStrokeCap(cap: RuntimeNetworkStrokeCap): StrokeCap | undefined {
  return cap === "NONE" ? "none"
    : cap === "ROUND" ? "round"
      : cap === "SQUARE" ? "square"
        : cap === "ARROW_LINES" ? "arrowLines"
          : cap === "ARROW_EQUILATERAL" ? "arrowEquilateral"
            : cap === "DIAMOND_FILLED" ? "diamondFilled"
              : cap === "TRIANGLE_FILLED" ? "triangleFilled"
                : cap === "CIRCLE_FILLED" ? "circleFilled"
                  : undefined;
}

function canonicalStrokeJoin(join: RuntimeNetworkStrokeJoin): StrokeJoin | undefined {
  return join === "MITER" ? "miter" : join === "BEVEL" ? "bevel" : join === "ROUND" ? "round" : undefined;
}
