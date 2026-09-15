import type { DocumentConnectorMetadata } from "./editor-protocol";

export type FigmaConnectorMagnet = "NONE" | "AUTO" | "TOP" | "LEFT" | "BOTTOM" | "RIGHT" | "CENTER";

/** Exact public ConnectorEndpoint shape from the Figma Plugin API. Canonical
 * additionally retains local x/y for deterministic rendering. */
export type FigmaConnectorEndpoint =
  | Readonly<{ position: Readonly<{ x: number; y: number }> }>
  | Readonly<{ position: Readonly<{ x: number; y: number }>; endpointNodeId: string }>
  | Readonly<{ endpointNodeId: string; magnet: FigmaConnectorMagnet }>;

export const FIGMA_CONNECTOR_STROKE_CAPS = [
  "NONE",
  "ARROW_EQUILATERAL",
  "ARROW_LINES",
  "TRIANGLE_FILLED",
  "DIAMOND_FILLED",
  "CIRCLE_FILLED",
  "ERD_ZERO_OR_ONE",
  "ERD_EXACTLY_ONE",
  "ERD_ZERO_OR_MORE",
  "ERD_ONE_OR_MORE",
  "ERD_ONE",
  "ERD_MANY",
] as const;
export type FigmaConnectorStrokeCap = typeof FIGMA_CONNECTOR_STROKE_CAPS[number];
const FIGMA_CONNECTOR_STROKE_CAP_SET: ReadonlySet<string> = new Set(FIGMA_CONNECTOR_STROKE_CAPS);

export function isFigmaConnectorStrokeCap(value: unknown): value is FigmaConnectorStrokeCap {
  return typeof value === "string" && FIGMA_CONNECTOR_STROKE_CAP_SET.has(value);
}

export function projectFigmaConnectorEndpoint(endpoint: DocumentConnectorMetadata["start"]): FigmaConnectorEndpoint {
  if (endpoint.endpointNodeId && endpoint.magnet) {
    return { endpointNodeId: endpoint.endpointNodeId, magnet: endpoint.magnet };
  }
  const position = { x: endpoint.x, y: endpoint.y };
  return endpoint.endpointNodeId ? { endpointNodeId: endpoint.endpointNodeId, position } : { position };
}

/** Converts the Plugin discriminated union into Canonical's renderable form.
 * Magnet-only writes retain the previous local point until dynamic routing is
 * available, while preserving every official magnet value for round-trips. */
export function canonicalConnectorEndpoint(
  value: unknown,
  fallback: DocumentConnectorMetadata["start"],
): DocumentConnectorMetadata["start"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const endpoint = value as Record<string, unknown>;
  const endpointNodeId = validEndpointNodeId(endpoint.endpointNodeId);
  if (endpoint.position !== undefined) {
    if (endpoint.magnet !== undefined || (endpoint.endpointNodeId !== undefined && !endpointNodeId)) return undefined;
    const position = point(endpoint.position);
    if (!position) return undefined;
    return { ...position, ...(endpointNodeId ? { endpointNodeId } : {}) };
  }
  const magnet = canonicalMagnet(endpoint.magnet);
  if (!endpointNodeId || !magnet) return undefined;
  return { x: fallback.x, y: fallback.y, endpointNodeId, magnet };
}

function point(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === "number" && Number.isFinite(candidate.x) && typeof candidate.y === "number" && Number.isFinite(candidate.y)
    ? { x: candidate.x, y: candidate.y }
    : undefined;
}

function validEndpointNodeId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value) ? value : undefined;
}

function canonicalMagnet(value: unknown): DocumentConnectorMetadata["start"]["magnet"] {
  return value === "NONE" || value === "AUTO" || value === "TOP" || value === "RIGHT" || value === "BOTTOM" || value === "LEFT" || value === "CENTER" ? value : undefined;
}
