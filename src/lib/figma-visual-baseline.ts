import type { FigmaRenderOracleResult } from "./figma-render-oracle";

type FigmaImagesRestSource = Readonly<{
  provider: "figma-images-rest";
  fileKey: string;
  nodeIds: readonly string[];
  endpoint: string;
  format: "png" | "jpg" | "svg";
  scale: number;
  figmaApiVersion: string;
  pluginTypingsVersion: string;
}>;

type FigmaMcpSource = Readonly<{
  provider: "figma-mcp";
  fileKey: string;
  nodeIds: readonly string[];
  designUrl: string;
  format: "png" | "jpg" | "svg";
  scale: number;
  figmaApiVersion: string;
  pluginTypingsVersion: string;
}>;

export type FigmaVisualBaselineSource = FigmaImagesRestSource | FigmaMcpSource;

export type FigmaVisualBaseline = Readonly<{
  format: "makefigma-figma-visual-baseline-v1";
  fixtureId: string;
  capturedAt: string;
  source: FigmaVisualBaselineSource;
  environment: Readonly<{ browser: string; dpr: number; colorProfile: "srgb" | "display-p3"; normalization: readonly string[] }>;
  references: Readonly<Record<string, Readonly<{ path: string; sha256: string }>>>;
  threshold: Readonly<{ maxChannelDelta: number; maxMismatchedPixels: number; maxMeanChannelDelta: number }>;
}>;

export type FigmaVisualBaselineInput = Omit<FigmaVisualBaseline, "format" | "source"> & Readonly<{
  source: Readonly<{ figmaApiVersion: string; pluginTypingsVersion: string }>;
}>;

export type FigmaMcpVisualBaselineInput = Omit<FigmaVisualBaseline, "format" | "source"> & Readonly<{
  source: Readonly<{ fileKey: string; nodeIds: readonly string[]; designUrl: string; format: "png" | "jpg" | "svg"; scale: number; figmaApiVersion: string; pluginTypingsVersion: string }>;
}>;

export type RgbaVisualDiff = Readonly<{
  width: number;
  height: number;
  pixels: number;
  mismatchedPixels: number;
  maxChannelDelta: number;
  meanChannelDelta: number;
  passed: boolean;
}>;

/** Creates a credential-free sidecar from an Oracle response. The caller is
 * responsible for downloading each short-lived Figma URL into the reviewed
 * local artifact path before this record is committed. */
export function createFigmaVisualBaseline(oracle: FigmaRenderOracleResult, input: FigmaVisualBaselineInput): FigmaVisualBaseline {
  const baseline: FigmaVisualBaseline = {
    format: "makefigma-figma-visual-baseline-v1",
    fixtureId: input.fixtureId,
    capturedAt: input.capturedAt,
    source: {
      provider: "figma-images-rest",
      fileKey: oracle.request.fileKey,
      nodeIds: [...oracle.request.nodeIds],
      endpoint: oracle.request.endpoint,
      format: oracle.request.format,
      scale: oracle.request.scale,
      figmaApiVersion: input.source.figmaApiVersion,
      pluginTypingsVersion: input.source.pluginTypingsVersion,
    },
    environment: input.environment,
    references: input.references,
    threshold: input.threshold,
  };
  validateFigmaVisualBaseline(baseline);
  return deepFreeze(baseline);
}

/** Records a Figma MCP export after its temporary asset URL was downloaded into
 * a reviewed local reference. The stable design URL is retained; signed MCP
 * asset URLs and connected-account credentials are deliberately excluded. */
export function createFigmaMcpVisualBaseline(input: FigmaMcpVisualBaselineInput): FigmaVisualBaseline {
  const baseline: FigmaVisualBaseline = {
    format: "makefigma-figma-visual-baseline-v1",
    fixtureId: input.fixtureId,
    capturedAt: input.capturedAt,
    source: { provider: "figma-mcp", ...input.source, nodeIds: [...input.source.nodeIds] },
    environment: input.environment,
    references: input.references,
    threshold: input.threshold,
  };
  validateFigmaVisualBaseline(baseline);
  return deepFreeze(baseline);
}

/** Validates a checked-in baseline before an offline runner reads its paths or
 * accepts a diff threshold. URLs are provenance only; no live token or image
 * URL is persisted here. */
export function validateFigmaVisualBaseline(value: unknown): asserts value is FigmaVisualBaseline {
  if (!isRecord(value) || value.format !== "makefigma-figma-visual-baseline-v1" || !validId(value.fixtureId) || !validIsoDate(value.capturedAt)) throw new Error("Invalid Figma visual baseline.");
  const source = value.source;
  if (!validSource(source) || !validEnvironment(value.environment) || !validReferences(value.references, source.nodeIds) || !validThreshold(value.threshold)) throw new Error("Invalid Figma visual baseline.");
}

/** Compares pre-normalized equal-sized RGBA pixels. Image decoding and ICC
 * conversion stay outside this pure gate, making accepted/rejected output
 * deterministic for reviewed baselines and CI. */
export function compareRgbaVisuals(actual: Uint8Array, reference: Uint8Array, width: number, height: number, threshold: FigmaVisualBaseline["threshold"]): RgbaVisualDiff {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || actual.length !== reference.length || actual.length !== width * height * 4 || !validThreshold(threshold)) throw new Error("Invalid RGBA visual comparison.");
  let mismatchedPixels = 0;
  let maxChannelDelta = 0;
  let channelDeltaTotal = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    let pixelMax = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(actual[offset + channel]! - reference[offset + channel]!);
      pixelMax = Math.max(pixelMax, delta);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      channelDeltaTotal += delta;
    }
    if (pixelMax > threshold.maxChannelDelta) mismatchedPixels += 1;
  }
  const pixels = width * height;
  const meanChannelDelta = channelDeltaTotal / actual.length;
  return Object.freeze({ width, height, pixels, mismatchedPixels, maxChannelDelta, meanChannelDelta, passed: mismatchedPixels <= threshold.maxMismatchedPixels && meanChannelDelta <= threshold.maxMeanChannelDelta });
}

function validSource(value: unknown): value is FigmaVisualBaselineSource {
  if (!isRecord(value) || !validId(value.fileKey) || !Array.isArray(value.nodeIds) || !value.nodeIds.length || value.nodeIds.length > 128 || !value.nodeIds.every(validId) || !["png", "jpg", "svg"].includes(String(value.format)) || !finiteInRange(value.scale, 0.01, 4) || !validId(value.figmaApiVersion) || !validId(value.pluginTypingsVersion) || [...new Set(value.nodeIds)].length !== value.nodeIds.length) return false;
  if (value.provider === "figma-images-rest") return validHttpsUrl(value.endpoint);
  return value.provider === "figma-mcp" && validFigmaDesignUrl(value.designUrl, value.fileKey, value.nodeIds);
}
function validEnvironment(value: unknown): boolean {
  return isRecord(value) && typeof value.browser === "string" && value.browser.length > 0 && value.browser.length <= 256 && finiteInRange(value.dpr, 0.5, 8) && ["srgb", "display-p3"].includes(String(value.colorProfile)) && Array.isArray(value.normalization) && value.normalization.length <= 32 && value.normalization.every((step) => typeof step === "string" && step.length > 0 && step.length <= 256);
}
function validReferences(value: unknown, nodeIds: readonly string[]): boolean {
  if (!isRecord(value) || Object.keys(value).length !== nodeIds.length || !nodeIds.every((nodeId) => Object.hasOwn(value, nodeId))) return false;
  return Object.entries(value).every(([nodeId, reference]) => validId(nodeId) && isRecord(reference) && typeof reference.path === "string" && /^fixtures\/golden-images\/[A-Za-z0-9._/-]+\.(?:png|jpg|svg)$/u.test(reference.path) && typeof reference.sha256 === "string" && /^[a-f0-9]{64}$/u.test(reference.sha256));
}
function validThreshold(value: unknown): value is FigmaVisualBaseline["threshold"] {
  if (!isRecord(value)) return false;
  const maxChannelDelta = value.maxChannelDelta;
  const maxMismatchedPixels = value.maxMismatchedPixels;
  return typeof maxChannelDelta === "number" && Number.isInteger(maxChannelDelta) && maxChannelDelta >= 0 && maxChannelDelta <= 255
    && typeof maxMismatchedPixels === "number" && Number.isSafeInteger(maxMismatchedPixels) && maxMismatchedPixels >= 0
    && finiteInRange(value.maxMeanChannelDelta, 0, 255);
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000\r\n]/u.test(value); }
function validIsoDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validHttpsUrl(value: unknown): boolean { try { return typeof value === "string" && new URL(value).protocol === "https:"; } catch { return false; } }
function validFigmaDesignUrl(value: unknown, fileKey: string, nodeIds: readonly string[]): boolean {
  if (typeof value !== "string" || value.length > 2048 || !validHttpsUrl(value)) return false;
  try {
    const url = new URL(value);
    if (!/(^|\.)figma\.com$/u.test(url.hostname) || !url.pathname.startsWith(`/design/${encodeURIComponent(fileKey)}/`)) return false;
    const nodeId = url.searchParams.get("node-id")?.replace("-", ":");
    return Boolean(nodeId && nodeIds.includes(nodeId));
  } catch { return false; }
}
function finiteInRange(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach((entry) => deepFreeze(entry)); Object.freeze(value); } return value; }
