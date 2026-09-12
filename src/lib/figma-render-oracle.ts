export type FigmaRenderFormat = "png" | "jpg" | "svg";

export type FigmaRenderOracleRequest = Readonly<{
  fileKey: string;
  nodeIds: readonly string[];
  accessToken: string;
  format?: FigmaRenderFormat;
  scale?: number;
}>;

export type FigmaRenderOracleResult = Readonly<{
  request: Readonly<{
    fileKey: string;
    nodeIds: readonly string[];
    format: FigmaRenderFormat;
    scale: number;
    endpoint: string;
  }>;
  images: Readonly<Record<string, string>>;
}>;

export class FigmaRenderOracleError extends Error {
  readonly name = "FigmaRenderOracleError";

  constructor(readonly code: "INVALID_ARGUMENT" | "REQUEST_FAILED" | "INVALID_RESPONSE", readonly status?: number) {
    super(code === "REQUEST_FAILED" ? "Figma Render Oracle request failed." : "Figma Render Oracle received invalid input or response.");
  }
}

type FetchLike = (input: string, init: Readonly<{ headers: Record<string, string> }>) => Promise<Readonly<{ ok: boolean; status: number; json: () => Promise<unknown> }>>;

/**
 * Retrieves Figma's independently rendered image URLs for a fixed fixture.
 * Callers provide the token at the process boundary; the returned provenance
 * intentionally never contains it, so artifacts can be checked into a Golden
 * review without credential leakage. Live calls are opt-in, not normal CI.
 */
export async function requestFigmaRenderOracle(request: FigmaRenderOracleRequest, fetcher: FetchLike = fetch): Promise<FigmaRenderOracleResult> {
  const normalized = normalizeRequest(request);
  const response = await fetcher(normalized.endpoint, { headers: { "X-Figma-Token": request.accessToken } });
  if (!response.ok) throw new FigmaRenderOracleError("REQUEST_FAILED", response.status);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !isStringMap((payload as { images?: unknown }).images)) {
    throw new FigmaRenderOracleError("INVALID_RESPONSE", response.status);
  }
  const images = Object.fromEntries(Object.entries((payload as { images: Record<string, string> }).images)
    .filter(([nodeId, url]) => normalized.nodeIds.includes(nodeId) && isHttpsUrl(url))
    .sort(([left], [right]) => left.localeCompare(right)));
  if (!Object.keys(images).length) throw new FigmaRenderOracleError("INVALID_RESPONSE", response.status);
  return Object.freeze({
    request: Object.freeze({ ...normalized, nodeIds: Object.freeze([...normalized.nodeIds]) }),
    images: Object.freeze(images),
  });
}

export function figmaRenderOracleEndpoint(fileKey: string, nodeIds: readonly string[], format: FigmaRenderFormat = "png", scale = 1): string {
  const normalized = normalizeRequest({ fileKey, nodeIds, accessToken: "not-used", format, scale });
  return normalized.endpoint;
}

function normalizeRequest(request: FigmaRenderOracleRequest): { fileKey: string; nodeIds: string[]; format: FigmaRenderFormat; scale: number; endpoint: string } {
  const fileKey = request.fileKey.trim();
  const nodeIds = [...new Set(request.nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean))].sort();
  const format = request.format ?? "png";
  const scale = request.scale ?? 1;
  if (!fileKey || !nodeIds.length || !request.accessToken.trim() || !["png", "jpg", "svg"].includes(format) || !Number.isFinite(scale) || scale <= 0 || scale > 4) {
    throw new FigmaRenderOracleError("INVALID_ARGUMENT");
  }
  const params = new URLSearchParams({ ids: nodeIds.join(","), format, scale: String(scale) });
  return { fileKey, nodeIds, format, scale, endpoint: `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?${params}` };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && Object.values(value).every((entry) => typeof entry === "string");
}

function isHttpsUrl(value: string): boolean {
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}
