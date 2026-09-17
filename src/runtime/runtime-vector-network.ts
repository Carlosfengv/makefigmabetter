import type { DocumentPaintStack, DocumentVectorPath, StrokeCap, StrokeJoin } from "../lib/editor-protocol";
import {
  documentPaintStackFromRuntime,
  runtimePaintsFromDocumentStack,
  type RuntimePaint,
} from "./runtime-paint";

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
  fills?: readonly RuntimePaint[];
  fillStyleId?: string;
}>;
export type RuntimeVectorNetwork = Readonly<{
  vertices: readonly RuntimeVectorVertex[];
  segments: readonly RuntimeVectorSegment[];
  regions?: readonly RuntimeVectorRegion[];
}>;

type NetworkConversion = Readonly<{
  path: DocumentVectorPath;
  regionPaths?: readonly DocumentVectorPath[];
  strokeCapStart: StrokeCap;
  strokeCapEnd: StrokeCap;
  strokeJoin?: StrokeJoin;
  network?: RuntimeVectorNetwork;
}>;

export type VectorNetworkRegionPaintRecord = Readonly<{
  fillStack?: DocumentPaintStack;
  hasExplicitFills: boolean;
}>;

export type VectorNetworkRegionPaintPlan = Readonly<{
  path: DocumentVectorPath;
  fillStack?: DocumentPaintStack;
}>;

export type VectorNetworkStrokePoint = Readonly<{ x: number; y: number }>;
export type VectorNetworkStrokeTriangle = readonly [VectorNetworkStrokePoint, VectorNetworkStrokePoint, VectorNetworkStrokePoint];
export type VectorNetworkMixedStrokeMesh = Readonly<{
  triangles: readonly VectorNetworkStrokeTriangle[];
  bounds?: Readonly<{ min: VectorNetworkStrokePoint; max: VectorNetworkStrokePoint }>;
}>;

const MAX_VECTOR_SUBPATHS = 64;
const MAX_VECTOR_POINTS = 8_192;
const MAX_VECTOR_NETWORK_EXTENSION_BYTES = 256 * 1024;
const MIXED_STROKE_CURVE_TOLERANCE = .25;
const MAX_MIXED_STROKE_CURVE_DEPTH = 20;
const MIXED_STROKE_CURVE_MITER_LIMIT = 4;
// 16,384 centerline segments leave enough room under the 200K triangle cap
// even when every one of the 8,192 authored vertices uses a round join.
const MAX_MIXED_STROKE_SEGMENTS = 16_384;
const MAX_MIXED_STROKE_TRIANGLES = 200_000;
export const VECTOR_NETWORK_EXTENSION = "figma.runtime.vector-network.v1";

/**
 * Canonical VectorPath is a collection of independent cubic chains. This
 * adapter exposes that exact topology as a Figma-shaped VectorNetwork. Shared
 * vertices and region-local paints use the path-bound extension below.
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
 * networks are independent directed chains/cycles or bounded shared-vertex
 * branches with region-local fill rules. Region render data is persisted
 * separately from the derived fallback path. Bounded straight-chain corner
 * radii materialize into cubic fillets while the authored vertices survive in
 * the path-bound extension. Mixed joins are admitted only for independent
 * topology consumed by the shared bounded stroke mesh.
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
  const closedComponentIndexes = components.flatMap((component, index) => component.closed ? [index] : []);
  let fillRule: DocumentVectorPath["fillRule"] = "nonZero";
  const regionComponentIndexes: number[][] = [];
  if (closedComponentIndexes.length) {
    if (!regions.length) return { reason: "Closed VectorNetwork cycles require at least one fill region." };
    const unmatched = new Set(closedComponentIndexes);
    for (const region of regions) {
      if (!validRegion(region)) return { reason: "VectorNetwork contains an invalid fill region." };
      const matches: number[] = [];
      for (const loop of region.loops) {
        if (new Set(loop).size !== loop.length) return { reason: "VectorNetwork region loops cannot repeat segments." };
        const match = [...unmatched].find((componentIndex) => sameIntegerSet(loop, components[componentIndex]!.segmentIndexes));
        if (match === undefined) return { reason: "VectorNetwork regions must cover every closed cycle exactly once." };
        unmatched.delete(match);
        matches.push(match);
      }
      regionComponentIndexes.push(matches);
    }
    if (unmatched.size) return { reason: "VectorNetwork regions must cover every closed cycle exactly once." };
    fillRule = regions[0]!.windingRule === "EVENODD" ? "evenOdd" : "nonZero";
  } else if (regions.length) {
    return { reason: "Open VectorNetwork chains cannot contain fill regions." };
  }

  const hasExplicitJoin = input.vertices.some((vertex) => vertex.strokeJoin !== undefined);
  const resolvedVertexJoins = input.vertices.map((vertex) => vertex.strokeJoin === undefined ? defaults.strokeJoin : canonicalStrokeJoin(vertex.strokeJoin));
  if (resolvedVertexJoins.some((join) => !join)) return { reason: "VectorNetwork contains an unsupported stroke join." };
  const activeJoinVertexIndexes = components.flatMap((component) => component.closed
    ? component.vertexIndexes
    : component.vertexIndexes.slice(1, -1));
  const hasMixedActiveJoins = new Set(activeJoinVertexIndexes.map((vertexIndex) => resolvedVertexJoins[vertexIndex])).size > 1;
  const hasPerVertexCorners = input.vertices.some((vertex) => vertex.cornerRadius !== undefined);
  if (hasMixedActiveJoins && input.vertices.some((vertex) => (vertex.cornerRadius ?? 0) > 0)) {
    return { reason: "Mixed per-vertex stroke joins cannot be combined with corner radii." };
  }
  if (hasMixedActiveJoins && !mixedNetworkStrokeSegmentsWithinBudget(input, components)) {
    return { reason: "Mixed per-vertex stroke joins exceed the bounded curve tessellation budget or contain degenerate curve geometry." };
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
  if (hasMixedActiveJoins && [...startCaps, ...endCaps].some((cap) => cap !== "none" && cap !== "round" && cap !== "square")) {
    return { reason: "Mixed per-vertex stroke joins support only NONE, ROUND or SQUARE endpoint caps." };
  }

  const subpaths: DocumentVectorPath["subpaths"] = [];
  for (const component of components) {
    const componentVertices = component.vertexIndexes.map((vertexIndex) => input.vertices[vertexIndex]!);
    if (component.closed && componentVertices.length < 3) return { reason: "Closed VectorNetwork cycles require at least three vertices." };
    if (componentVertices.some((vertex, index) => index > 0 && samePoint(vertex, componentVertices[index - 1]!)) || (component.closed && samePoint(componentVertices[0]!, componentVertices.at(-1)!))) {
      return { reason: "VectorNetwork contains duplicate adjacent vertex positions." };
    }
    const sourcePoints = component.vertexIndexes.map((vertexIndex) => {
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
    const rounded = materializeRuntimeCornerRadii(
      component.vertexIndexes.map((vertexIndex) => input.vertices[vertexIndex]!),
      sourcePoints,
      component.closed,
      allocatePointId,
    );
    if ("reason" in rounded) return rounded;
    subpaths.push({ closed: component.closed, points: rounded.points });
  }

  if (subpaths.reduce((total, subpath) => total + subpath.points.length, 0) > MAX_VECTOR_POINTS) {
    return { reason: `Rounded VectorNetwork exceeds Core's ${MAX_VECTOR_POINTS}-point limit.` };
  }

  return {
    path: { fillRule, subpaths },
    ...(regionComponentIndexes.length ? {
      regionPaths: regionComponentIndexes.map((componentIndexes, regionIndex) => ({
        fillRule: regions[regionIndex]!.windingRule === "EVENODD" ? "evenOdd" : "nonZero",
        subpaths: componentIndexes.map((componentIndex) => subpaths[componentIndex]!),
      })),
    } : {}),
    strokeCapStart: startCaps[0] ?? defaults.strokeCapStart,
    strokeCapEnd: endCaps[0] ?? defaults.strokeCapEnd,
    ...(hasExplicitJoin && new Set(resolvedVertexJoins).size === 1 && resolvedVertexJoins[0] ? { strokeJoin: resolvedVertexJoins[0] } : {}),
    ...(hasPerVertexCorners || hasExplicitJoin ? { network: structuredClone(input) } : {}),
  };
}

function materializeRuntimeCornerRadii(
  vertices: readonly RuntimeVectorVertex[],
  sourcePoints: DocumentVectorPath["subpaths"][number]["points"],
  closed: boolean,
  allocatePointId: () => string,
): Readonly<{ points: DocumentVectorPath["subpaths"][number]["points"] }> | { reason: string } {
  const radii = vertices.map((vertex) => vertex.cornerRadius ?? 0);
  if (radii.every((radius) => radius === 0)) return { points: sourcePoints };
  if (vertices.length < (closed ? 3 : 2)) return { reason: "Per-vertex corner radii require a connected chain." };
  if (!closed && (radii[0]! > 0 || radii.at(-1)! > 0)) {
    return { reason: "Open VectorNetwork endpoints cannot carry a positive corner radius." };
  }
  if (sourcePoints.some((point) => point.handleIn || point.handleOut)) {
    return { reason: "Per-vertex corner radii currently require straight adjacent segments." };
  }

  const offsets = Array.from({ length: vertices.length }, () => 0);
  const handleLengths = Array.from({ length: vertices.length }, () => 0);
  for (let index = 0; index < vertices.length; index += 1) {
    const radius = radii[index]!;
    if (radius === 0 || !closed && (index === 0 || index === vertices.length - 1)) continue;
    const previous = vertices[(index + vertices.length - 1) % vertices.length]!;
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    const previousLength = Math.hypot(previous.x - current.x, previous.y - current.y);
    const nextLength = Math.hypot(next.x - current.x, next.y - current.y);
    if (previousLength <= 1e-12 || nextLength <= 1e-12) return { reason: "Per-vertex corner radius touches a zero-length edge." };
    const toPrevious = { x: (previous.x - current.x) / previousLength, y: (previous.y - current.y) / previousLength };
    const toNext = { x: (next.x - current.x) / nextLength, y: (next.y - current.y) / nextLength };
    const angle = Math.acos(Math.max(-1, Math.min(1, toPrevious.x * toNext.x + toPrevious.y * toNext.y)));
    if (!Number.isFinite(angle) || angle <= 1e-9) return { reason: "Per-vertex corner radius cannot materialize a reversal." };
    const offset = radius / Math.tan(angle / 2);
    const arcAngle = Math.PI - angle;
    const handleLength = 4 / 3 * Math.tan(arcAngle / 4) * radius;
    if (![offset, handleLength].every(Number.isFinite) || offset < 0 || handleLength < 0) {
      return { reason: "Per-vertex corner radius is geometrically invalid." };
    }
    offsets[index] = offset;
    handleLengths[index] = handleLength;
  }
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const nextIndex = (index + 1) % vertices.length;
    const segmentLength = Math.hypot(vertices[nextIndex]!.x - vertices[index]!.x, vertices[nextIndex]!.y - vertices[index]!.y);
    const consumed = offsets[index]! + offsets[nextIndex]!;
    if (consumed > segmentLength + 1e-9 * Math.max(1, segmentLength)) {
      return { reason: "Adjacent per-vertex corner radii overlap on one segment." };
    }
  }

  const points: DocumentVectorPath["subpaths"][number]["points"] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index]!;
    const offset = offsets[index]!;
    if (offset <= 1e-12) {
      points.push({ id: sourcePoints[index]!.id, x: current.x, y: current.y, pointType: "corner" });
      continue;
    }
    const previous = vertices[(index + vertices.length - 1) % vertices.length]!;
    const next = vertices[(index + 1) % vertices.length]!;
    const previousLength = Math.hypot(previous.x - current.x, previous.y - current.y);
    const nextLength = Math.hypot(next.x - current.x, next.y - current.y);
    const toPrevious = { x: (previous.x - current.x) / previousLength, y: (previous.y - current.y) / previousLength };
    const toNext = { x: (next.x - current.x) / nextLength, y: (next.y - current.y) / nextLength };
    const handleLength = handleLengths[index]!;
    points.push({
      id: sourcePoints[index]!.id,
      x: stableGeometryNumber(current.x + toPrevious.x * offset),
      y: stableGeometryNumber(current.y + toPrevious.y * offset),
      handleOut: {
        x: stableGeometryNumber(-toPrevious.x * handleLength),
        y: stableGeometryNumber(-toPrevious.y * handleLength),
      },
      pointType: "asymmetric",
    });
    points.push({
      id: allocatePointId(),
      x: stableGeometryNumber(current.x + toNext.x * offset),
      y: stableGeometryNumber(current.y + toNext.y * offset),
      handleIn: {
        x: stableGeometryNumber(-toNext.x * handleLength),
        y: stableGeometryNumber(-toNext.y * handleLength),
      },
      pointType: "asymmetric",
    });
  }
  return { points };
}

function stableGeometryNumber(value: number) {
  const nearestInteger = Math.round(value);
  if (Math.abs(value - nearestInteger) <= 1e-12 * Math.max(1, Math.abs(value))) return Object.is(nearestInteger, -0) ? 0 : nearestInteger;
  return Object.is(value, -0) ? 0 : value;
}

/** Reads the exact shared-topology record only while its derived VectorPath is
 * still current. Generic path edits therefore invalidate the extension
 * without requiring every mutation surface to know about VectorNetwork. */
export function runtimeVectorNetworkFromExtension(extensions: unknown, path: DocumentVectorPath): RuntimeVectorNetwork | undefined {
  const record = vectorNetworkExtensionRecord(extensions, path);
  if (!record) return undefined;
  const network = structuredClone(record.network);
  if (record.regionPaints && network.regions) {
    return {
      ...network,
      regions: network.regions.map((region, index) => {
        const paint = record.regionPaints?.[index];
        return paint?.hasExplicitFills && paint.fillStack
          ? { ...region, fills: runtimePaintsFromDocumentStack(paint.fillStack) }
          : region;
      }),
    };
  }
  return network;
}

export function extensionsWithRuntimeVectorNetwork(
  extensions: unknown,
  network: RuntimeVectorNetwork | undefined,
  path?: DocumentVectorPath,
  regionPaints?: readonly VectorNetworkRegionPaintRecord[],
): Record<string, number[]> {
  const next = extensions && typeof extensions === "object"
    ? structuredClone(extensions as Record<string, number[]>)
    : {};
  delete next[VECTOR_NETWORK_EXTENSION];
  if (!network || !path) return next;
  const storedNetwork = network.regions ? {
    ...network,
    regions: network.regions.map((region) => ({
      windingRule: region.windingRule,
      loops: region.loops,
      ...(region.fillStyleId ? { fillStyleId: region.fillStyleId } : {}),
    })),
  } : network;
  const encoded = [...new TextEncoder().encode(JSON.stringify(regionPaints
    ? { version: 2, network: storedNetwork, path, regionPaints }
    : { version: 1, network: storedNetwork, path }))];
  if (encoded.length > MAX_VECTOR_NETWORK_EXTENSION_BYTES) throw new Error("VectorNetwork extension exceeds its byte budget.");
  next[VECTOR_NETWORK_EXTENSION] = encoded;
  return next;
}

/** Returns the exact region geometry plus its optional local PaintStack. A
 * missing stack means that region inherits the node-level fills; an explicit
 * empty stack paints no fill. Invalid or stale extension bytes fail closed. */
export function vectorNetworkRegionPaintPlansFromExtension(
  extensions: unknown,
  path: DocumentVectorPath,
): readonly VectorNetworkRegionPaintPlan[] | undefined {
  const record = vectorNetworkExtensionRecord(extensions, path);
  if (!record?.regionPaints?.length) return undefined;
  const converted = canonicalVectorPathFromRuntimeNetwork(
    record.network,
    (() => { let index = 0; return () => `region-${index++}`; })(),
    { strokeCapStart: "none", strokeCapEnd: "none", strokeJoin: "miter" },
  );
  if ("reason" in converted || !converted.regionPaths || converted.regionPaths.length !== record.regionPaints.length) return undefined;
  return converted.regionPaths.map((regionPath, index) => ({
    path: regionPath,
    ...(record.regionPaints![index]!.fillStack ? { fillStack: structuredClone(record.regionPaints![index]!.fillStack) } : {}),
  }));
}

type IndependentNetworkComponent = Readonly<{
  vertexIndexes: readonly number[];
  segmentIndexes: readonly number[];
  closed: boolean;
}>;

type MixedStrokeOptions = Readonly<{
  strokeWidth: number;
  strokeJoin: StrokeJoin;
  strokeMiterLimit: number;
  strokeCapStart?: StrokeCap;
  strokeCapEnd?: StrokeCap;
  strokeDashPattern?: readonly number[];
}>;

/** True only when two or more rendered joins in an independent network have
 * different effective values. Open-path endpoints are excluded because they
 * have caps rather than joins. */
export function runtimeVectorNetworkHasMixedActiveJoins(
  network: RuntimeVectorNetwork,
  defaultJoin: StrokeJoin,
): boolean {
  if (!validNetworkShape(network)) return false;
  const components = independentNetworkComponents(network);
  if (!components) return false;
  const joins = components.flatMap((component) => (component.closed
    ? component.vertexIndexes
    : component.vertexIndexes.slice(1, -1))
    .map((vertexIndex) => effectiveNetworkJoin(network.vertices[vertexIndex]!, defaultJoin)));
  return new Set(joins).size > 1;
}

/** Builds the bounded solid-stroke mesh used for mixed VectorNetwork joins.
 * Curves use deterministic adaptive subdivision; the path-bound extension
 * remains authoritative while Canvas paint, hit testing and SVG share this
 * derived presentation mesh. */
export function vectorNetworkMixedStrokeMeshFromExtension(
  extensions: unknown,
  path: DocumentVectorPath,
  options: MixedStrokeOptions,
): VectorNetworkMixedStrokeMesh | undefined {
  const record = vectorNetworkExtensionRecord(extensions, path);
  return record ? vectorNetworkMixedStrokeMesh(record.network, options) : undefined;
}

export function vectorNetworkMixedStrokeMesh(
  network: RuntimeVectorNetwork,
  options: MixedStrokeOptions,
): VectorNetworkMixedStrokeMesh | undefined {
  if (!validNetworkShape(network)
    || !Number.isFinite(options.strokeWidth) || options.strokeWidth <= 0
    || !Number.isFinite(options.strokeMiterLimit) || options.strokeMiterLimit < 1
    || options.strokeDashPattern?.length
    || network.vertices.some((vertex) => (vertex.cornerRadius ?? 0) > 0)
  ) return undefined;
  const components = independentNetworkComponents(network);
  if (!components || !runtimeVectorNetworkHasMixedActiveJoins(network, options.strokeJoin)) return undefined;
  const hasOpenComponent = components.some((component) => !component.closed && component.segmentIndexes.length > 0);
  if (hasOpenComponent && (!["none", "round", "square"].includes(options.strokeCapStart ?? "none")
    || !["none", "round", "square"].includes(options.strokeCapEnd ?? "none"))) return undefined;

  const triangles: VectorNetworkStrokeTriangle[] = [];
  const half = options.strokeWidth / 2;
  let remainingSegments = MAX_MIXED_STROKE_SEGMENTS;
  for (const component of components) {
    if (component.vertexIndexes.length < 2) continue;
    const points = component.vertexIndexes.map((vertexIndex) => network.vertices[vertexIndex]!);
    const resolved = networkStrokeSegmentGroups(network, component, remainingSegments);
    if (!resolved || resolved.count === 0) return undefined;
    remainingSegments -= resolved.count;
    for (const segment of resolved.groups.flat()) {
      addNetworkStrokeQuad(triangles,
        offsetNetworkStrokePoint(segment.from, segment.normal, half),
        offsetNetworkStrokePoint(segment.to, segment.normal, half),
        offsetNetworkStrokePoint(segment.to, segment.normal, -half),
        offsetNetworkStrokePoint(segment.from, segment.normal, -half));
    }
    for (const group of resolved.groups) {
      for (let index = 1; index < group.length; index += 1) {
        addNetworkStrokeJoin(triangles, group[index]!.from, group[index - 1]!, group[index]!, half, "miter", MIXED_STROKE_CURVE_MITER_LIMIT);
      }
    }
    const joinStart = component.closed ? 0 : 1;
    const joinEnd = component.closed ? points.length : points.length - 1;
    for (let index = joinStart; index < joinEnd; index += 1) {
      const vertexIndex = index % points.length;
      const previous = resolved.groups[(index + resolved.groups.length - 1) % resolved.groups.length]!.at(-1)!;
      const next = resolved.groups[index % resolved.groups.length]![0]!;
      addNetworkStrokeJoin(
        triangles,
        points[vertexIndex]!,
        previous,
        next,
        half,
        effectiveNetworkJoin(points[vertexIndex]!, options.strokeJoin),
        options.strokeMiterLimit,
      );
    }
    if (!component.closed) {
      addNetworkStrokeCap(triangles, resolved.groups[0]![0]!, true, half, options.strokeCapStart ?? "none");
      addNetworkStrokeCap(triangles, resolved.groups.at(-1)!.at(-1)!, false, half, options.strokeCapEnd ?? "none");
    }
  }
  if (!triangles.length || triangles.length > MAX_MIXED_STROKE_TRIANGLES) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  triangles.forEach((triangle) => triangle.forEach((point) => {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }));
  return {
    triangles,
    bounds: {
      min: { x: minX, y: minY },
      max: { x: maxX, y: maxY },
    },
  };
}

export function vectorNetworkStrokeMeshContains(
  mesh: VectorNetworkMixedStrokeMesh,
  point: VectorNetworkStrokePoint,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (mesh.bounds && (point.x < mesh.bounds.min.x || point.x > mesh.bounds.max.x || point.y < mesh.bounds.min.y || point.y > mesh.bounds.max.y)) return false;
  return mesh.triangles.some(([a, b, c]) => {
    const ab = networkStrokeCross(a, b, point);
    const bc = networkStrokeCross(b, c, point);
    const ca = networkStrokeCross(c, a, point);
    return ab >= -1e-9 && bc >= -1e-9 && ca >= -1e-9;
  });
}

function independentNetworkComponents(network: RuntimeVectorNetwork): readonly IndependentNetworkComponent[] | undefined {
  const incoming = Array.from({ length: network.vertices.length }, () => [] as number[]);
  const outgoing = Array.from({ length: network.vertices.length }, () => [] as number[]);
  network.segments.forEach((segment, segmentIndex) => {
    if (!incoming[segment.end] || !outgoing[segment.start]) return;
    incoming[segment.end]!.push(segmentIndex);
    outgoing[segment.start]!.push(segmentIndex);
  });
  if (incoming.some((segments, vertexIndex) => segments.length > 1 || outgoing[vertexIndex]!.length > 1
    || segments.length + outgoing[vertexIndex]!.length > 1 && (segments.length !== 1 || outgoing[vertexIndex]!.length !== 1))) return undefined;
  const visitedSegments = new Set<number>();
  const visitedVertices = new Set<number>();
  const components: IndependentNetworkComponent[] = [];
  const walk = (start: number, closed: boolean) => {
    const vertexIndexes: number[] = [];
    const segmentIndexes: number[] = [];
    let current = start;
    while (!visitedVertices.has(current)) {
      visitedVertices.add(current);
      vertexIndexes.push(current);
      const nextSegment = outgoing[current]![0];
      if (nextSegment === undefined || visitedSegments.has(nextSegment)) break;
      visitedSegments.add(nextSegment);
      segmentIndexes.push(nextSegment);
      current = network.segments[nextSegment]!.end;
    }
    if ((closed && current !== start) || (!closed && outgoing[current]?.length)) return false;
    components.push({ vertexIndexes, segmentIndexes, closed });
    return true;
  };
  const starts = network.vertices.map((_, index) => index).filter((index) => incoming[index]!.length === 0 && outgoing[index]!.length === 1);
  const isolated = network.vertices.map((_, index) => index).filter((index) => incoming[index]!.length === 0 && outgoing[index]!.length === 0);
  for (const start of starts) if (!walk(start, false)) return undefined;
  isolated.forEach((vertexIndex) => {
    visitedVertices.add(vertexIndex);
    components.push({ vertexIndexes: [vertexIndex], segmentIndexes: [], closed: false });
  });
  for (let vertexIndex = 0; vertexIndex < network.vertices.length; vertexIndex += 1) {
    if (!visitedVertices.has(vertexIndex) && !walk(vertexIndex, true)) return undefined;
  }
  return visitedSegments.size === network.segments.length && visitedVertices.size === network.vertices.length ? components : undefined;
}

type NetworkStrokeSegment = Readonly<{
  from: VectorNetworkStrokePoint;
  to: VectorNetworkStrokePoint;
  tangent: VectorNetworkStrokePoint;
  normal: VectorNetworkStrokePoint;
}>;

type NetworkStrokeSegmentGroups = Readonly<{
  groups: readonly (readonly NetworkStrokeSegment[])[];
  count: number;
}>;

function mixedNetworkStrokeSegmentsWithinBudget(
  network: RuntimeVectorNetwork,
  components: readonly IndependentNetworkComponent[],
): boolean {
  let remaining = MAX_MIXED_STROKE_SEGMENTS;
  for (const component of components) {
    if (!component.segmentIndexes.length) continue;
    const resolved = networkStrokeSegmentGroups(network, component, remaining);
    if (!resolved) return false;
    remaining -= resolved.count;
  }
  return true;
}

function networkStrokeSegmentGroups(
  network: RuntimeVectorNetwork,
  component: IndependentNetworkComponent,
  maximumSegments: number,
): NetworkStrokeSegmentGroups | undefined {
  const groups: Array<readonly NetworkStrokeSegment[]> = [];
  let count = 0;
  for (const segmentIndex of component.segmentIndexes) {
    const segment = network.segments[segmentIndex]!;
    const remaining = maximumSegments - count;
    if (remaining <= 0) return undefined;
    const group = networkStrokeSegments(
      network.vertices[segment.start]!,
      network.vertices[segment.end]!,
      segment,
      remaining,
    );
    if (!group?.length) return undefined;
    groups.push(group);
    count += group.length;
  }
  return { groups, count };
}

function networkStrokeSegments(
  from: VectorNetworkStrokePoint,
  to: VectorNetworkStrokePoint,
  segment: RuntimeVectorSegment,
  maximumSegments: number,
): readonly NetworkStrokeSegment[] | undefined {
  if (!segment.tangentStart && !segment.tangentEnd) {
    const straight = networkStrokeSegment(from, to);
    return straight ? [straight] : undefined;
  }
  const control1 = segment.tangentStart ? offsetNetworkStrokePoint(from, segment.tangentStart, 1) : from;
  const control2 = segment.tangentEnd ? offsetNetworkStrokePoint(to, segment.tangentEnd, 1) : to;
  if (![control1.x, control1.y, control2.x, control2.y].every(Number.isFinite)) return undefined;
  const points: VectorNetworkStrokePoint[] = [from];
  if (!flattenNetworkStrokeCubic(points, from, control1, control2, to, maximumSegments + 1)) return undefined;
  const result: NetworkStrokeSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const resolved = networkStrokeSegment(points[index - 1]!, points[index]!);
    if (resolved) result.push(resolved);
  }
  return result.length && result.length <= maximumSegments ? result : undefined;
}

function flattenNetworkStrokeCubic(
  result: VectorNetworkStrokePoint[],
  from: VectorNetworkStrokePoint,
  control1: VectorNetworkStrokePoint,
  control2: VectorNetworkStrokePoint,
  to: VectorNetworkStrokePoint,
  maximumPoints: number,
  depth = 0,
): boolean {
  const flatEnough = networkStrokeCubicFlatEnough(from, control1, control2, to);
  if (!flatEnough && depth >= MAX_MIXED_STROKE_CURVE_DEPTH) return false;
  if (flatEnough) {
    if (result.length >= maximumPoints) return false;
    result.push(to);
    return true;
  }
  const fromControl1 = networkStrokeMidpoint(from, control1);
  const control1Control2 = networkStrokeMidpoint(control1, control2);
  const control2To = networkStrokeMidpoint(control2, to);
  const leftRight = networkStrokeMidpoint(fromControl1, control1Control2);
  const rightLeft = networkStrokeMidpoint(control1Control2, control2To);
  const middle = networkStrokeMidpoint(leftRight, rightLeft);
  return flattenNetworkStrokeCubic(result, from, fromControl1, leftRight, middle, maximumPoints, depth + 1)
    && flattenNetworkStrokeCubic(result, middle, rightLeft, control2To, to, maximumPoints, depth + 1);
}

function networkStrokeCubicFlatEnough(
  from: VectorNetworkStrokePoint,
  control1: VectorNetworkStrokePoint,
  control2: VectorNetworkStrokePoint,
  to: VectorNetworkStrokePoint,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chordLength = Math.hypot(dx, dy);
  if (!Number.isFinite(chordLength)) return false;
  if (chordLength <= 1e-9) {
    return Math.max(
      Math.hypot(control1.x - from.x, control1.y - from.y),
      Math.hypot(control2.x - from.x, control2.y - from.y),
    ) <= MIXED_STROKE_CURVE_TOLERANCE;
  }
  const lengthSquared = chordLength * chordLength;
  const projection1 = ((control1.x - from.x) * dx + (control1.y - from.y) * dy) / lengthSquared;
  const projection2 = ((control2.x - from.x) * dx + (control2.y - from.y) * dy) / lengthSquared;
  if (![projection1, projection2].every(Number.isFinite)
    || projection1 < 0 || projection2 > 1 || projection1 > projection2) return false;
  const distance = (point: VectorNetworkStrokePoint) => Math.abs(
    -dy / chordLength * (point.x - from.x) + dx / chordLength * (point.y - from.y),
  );
  return Math.max(distance(control1), distance(control2)) <= MIXED_STROKE_CURVE_TOLERANCE;
}

function networkStrokeMidpoint(left: VectorNetworkStrokePoint, right: VectorNetworkStrokePoint): VectorNetworkStrokePoint {
  return { x: left.x / 2 + right.x / 2, y: left.y / 2 + right.y / 2 };
}

function networkStrokeSegment(from: VectorNetworkStrokePoint, to: VectorNetworkStrokePoint): NetworkStrokeSegment | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-12) return undefined;
  const tangent = { x: dx / length, y: dy / length };
  return { from, to, tangent, normal: { x: -tangent.y, y: tangent.x } };
}

function effectiveNetworkJoin(vertex: RuntimeVectorVertex, fallback: StrokeJoin): StrokeJoin {
  return vertex.strokeJoin ? canonicalStrokeJoin(vertex.strokeJoin) ?? fallback : fallback;
}

function offsetNetworkStrokePoint(point: VectorNetworkStrokePoint, vector: VectorNetworkStrokePoint, scale: number): VectorNetworkStrokePoint {
  return { x: point.x + vector.x * scale, y: point.y + vector.y * scale };
}

function addNetworkStrokeQuad(
  triangles: VectorNetworkStrokeTriangle[],
  a: VectorNetworkStrokePoint,
  b: VectorNetworkStrokePoint,
  c: VectorNetworkStrokePoint,
  d: VectorNetworkStrokePoint,
): void {
  pushNetworkStrokeTriangle(triangles, a, b, c);
  pushNetworkStrokeTriangle(triangles, a, c, d);
}

function pushNetworkStrokeTriangle(
  triangles: VectorNetworkStrokeTriangle[],
  a: VectorNetworkStrokePoint,
  b: VectorNetworkStrokePoint,
  c: VectorNetworkStrokePoint,
): void {
  const area = networkStrokeCross(a, b, c);
  if (!Number.isFinite(area) || Math.abs(area) <= 1e-12) return;
  triangles.push(area > 0 ? [a, b, c] : [a, c, b]);
}

function addNetworkStrokeJoin(
  triangles: VectorNetworkStrokeTriangle[],
  vertex: VectorNetworkStrokePoint,
  previous: NetworkStrokeSegment,
  next: NetworkStrokeSegment,
  half: number,
  join: StrokeJoin,
  miterLimit: number,
): void {
  const turn = previous.tangent.x * next.tangent.y - previous.tangent.y * next.tangent.x;
  if (Math.abs(turn) <= 1e-12) return;
  if (join === "round") {
    for (let index = 0; index < 16; index += 1) {
      const start = index * Math.PI * 2 / 16;
      const end = (index + 1) * Math.PI * 2 / 16;
      pushNetworkStrokeTriangle(triangles, vertex,
        { x: vertex.x + Math.cos(start) * half, y: vertex.y + Math.sin(start) * half },
        { x: vertex.x + Math.cos(end) * half, y: vertex.y + Math.sin(end) * half });
    }
    return;
  }
  const side = turn > 0 ? -1 : 1;
  const previousOuter = offsetNetworkStrokePoint(vertex, previous.normal, side * half);
  const nextOuter = offsetNetworkStrokePoint(vertex, next.normal, side * half);
  if (join === "miter") {
    const miter = networkStrokeLineIntersection(previousOuter, previous.tangent, nextOuter, next.tangent);
    if (miter && Math.hypot(miter.x - vertex.x, miter.y - vertex.y) <= miterLimit * half + 1e-12) {
      pushNetworkStrokeTriangle(triangles, previousOuter, miter, nextOuter);
      return;
    }
  }
  pushNetworkStrokeTriangle(triangles, previousOuter, vertex, nextOuter);
}

function addNetworkStrokeCap(
  triangles: VectorNetworkStrokeTriangle[],
  segment: NetworkStrokeSegment,
  atStart: boolean,
  half: number,
  cap: StrokeCap,
): void {
  if (cap === "none") return;
  const center = atStart ? segment.from : segment.to;
  if (cap === "round") {
    for (let index = 0; index < 16; index += 1) {
      const start = index * Math.PI * 2 / 16;
      const end = (index + 1) * Math.PI * 2 / 16;
      pushNetworkStrokeTriangle(triangles, center,
        { x: center.x + Math.cos(start) * half, y: center.y + Math.sin(start) * half },
        { x: center.x + Math.cos(end) * half, y: center.y + Math.sin(end) * half });
    }
    return;
  }
  if (cap !== "square") return;
  const direction = atStart ? -half : half;
  const extended = offsetNetworkStrokePoint(center, segment.tangent, direction);
  addNetworkStrokeQuad(triangles,
    offsetNetworkStrokePoint(center, segment.normal, half),
    offsetNetworkStrokePoint(extended, segment.normal, half),
    offsetNetworkStrokePoint(extended, segment.normal, -half),
    offsetNetworkStrokePoint(center, segment.normal, -half));
}

function networkStrokeLineIntersection(
  left: VectorNetworkStrokePoint,
  leftDirection: VectorNetworkStrokePoint,
  right: VectorNetworkStrokePoint,
  rightDirection: VectorNetworkStrokePoint,
): VectorNetworkStrokePoint | undefined {
  const denominator = leftDirection.x * rightDirection.y - leftDirection.y * rightDirection.x;
  if (Math.abs(denominator) <= 1e-12) return undefined;
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const amount = (dx * rightDirection.y - dy * rightDirection.x) / denominator;
  const point = { x: left.x + leftDirection.x * amount, y: left.y + leftDirection.y * amount };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
}

function networkStrokeCross(a: VectorNetworkStrokePoint, b: VectorNetworkStrokePoint, c: VectorNetworkStrokePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function canonicalBranchedNetwork(
  input: RuntimeVectorNetwork,
  allocatePointId: () => string,
  defaults: Readonly<{ strokeCapStart: StrokeCap; strokeCapEnd: StrokeCap; strokeJoin: StrokeJoin }>,
): NetworkConversion | { reason: string } {
  const regions = input.regions ?? [];
  if (regions.length > MAX_VECTOR_SUBPATHS || regions.some((region) => !validRegion(region))) {
    return { reason: `VectorNetwork exceeds Core's ${MAX_VECTOR_SUBPATHS}-region limit or contains an invalid region.` };
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
  const regionPaths: DocumentVectorPath[] = [];
  for (const region of regions) {
    const regionSubpaths: DocumentVectorPath["subpaths"] = [];
    for (const loop of region.loops) {
      if (loop.length < 3 || loop.some((segmentIndex) => segmentIndex >= input.segments.length || loopSegmentIndexes.has(segmentIndex))) {
        return { reason: "Branched VectorNetwork region loops must contain at least three unique in-range segments." };
      }
      const segments = loop.map((segmentIndex) => input.segments[segmentIndex]!);
      if (segments.some((segment, index) => segment.end !== segments[(index + 1) % segments.length]!.start)) {
        return { reason: "Branched VectorNetwork region loops must form directed closed chains." };
      }
      loop.forEach((segmentIndex) => loopSegmentIndexes.add(segmentIndex));
      const subpath = {
        closed: true,
        points: segments.map((segment, index) => point(
          segment.start,
          segments[(index + segments.length - 1) % segments.length]!.tangentEnd,
          segment.tangentStart,
        )),
      };
      subpaths.push(subpath);
      regionSubpaths.push(subpath);
    }
    regionPaths.push({
      fillRule: region.windingRule === "EVENODD" ? "evenOdd" : "nonZero",
      subpaths: regionSubpaths,
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
    path: { fillRule: regions[0]?.windingRule === "EVENODD" ? "evenOdd" : "nonZero", subpaths },
    ...(regionPaths.length ? { regionPaths } : {}),
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

type VectorNetworkExtensionRecord = Readonly<{
  network: RuntimeVectorNetwork;
  regionPaints?: readonly VectorNetworkRegionPaintRecord[];
}>;

function vectorNetworkExtensionRecord(extensions: unknown, path: DocumentVectorPath): VectorNetworkExtensionRecord | undefined {
  if (!extensions || typeof extensions !== "object") return undefined;
  const bytes = (extensions as Record<string, unknown>)[VECTOR_NETWORK_EXTENSION];
  if (!Array.isArray(bytes) || bytes.length > MAX_VECTOR_NETWORK_EXTENSION_BYTES || bytes.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 255)) return undefined;
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))) as unknown;
    if (!decoded || typeof decoded !== "object") return undefined;
    const record = decoded as { version?: unknown; network?: unknown; path?: unknown; regionPaints?: unknown };
    const network = record.network;
    if ((record.version !== 1 && record.version !== 2)
      || stableJson(record.path) !== stableJson(path)
      || !validNetworkShape(network)
      || network.regions?.some((region) => region.fills !== undefined)) return undefined;
    if (record.version === 1) return { network: structuredClone(network) };
    if (!Array.isArray(record.regionPaints)
      || record.regionPaints.length !== (network.regions?.length ?? 0)) return undefined;
    const regionPaints = record.regionPaints.map(normalizeRegionPaintRecord);
    if (regionPaints.some((entry) => !entry)) return undefined;
    return {
      network: structuredClone(network),
      regionPaints: regionPaints as VectorNetworkRegionPaintRecord[],
    };
  } catch {
    return undefined;
  }
}

function normalizeRegionPaintRecord(value: unknown): VectorNetworkRegionPaintRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { fillStack?: unknown; hasExplicitFills?: unknown };
  if (typeof record.hasExplicitFills !== "boolean") return undefined;
  if (record.fillStack === undefined) return record.hasExplicitFills ? undefined : { hasExplicitFills: false };
  try {
    const runtimePaints = runtimePaintsFromDocumentStack(record.fillStack as DocumentPaintStack);
    const fillStack = documentPaintStackFromRuntime(runtimePaints, () => true);
    return { fillStack, hasExplicitFills: record.hasExplicitFills };
  } catch {
    return undefined;
  }
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
    && region.loops.length > 0
    && region.loops.every((loop) => Array.isArray(loop) && loop.every((segmentIndex) => Number.isSafeInteger(segmentIndex) && segmentIndex >= 0))
    && (region.fills === undefined || Array.isArray(region.fills))
    && (region.fillStyleId === undefined || typeof region.fillStyleId === "string"
      && !region.fillStyleId.includes("\0")
      && new TextEncoder().encode(region.fillStyleId).byteLength <= 2_048);
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
