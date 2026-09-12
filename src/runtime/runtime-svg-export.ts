import type { CanvasNode, DocumentAsset } from "../lib/editor-protocol";
import { exportPageToSvg, type SvgExportResult } from "../lib/svg-export";
import { rasterizeSvgToPng, SliceExportError } from "../lib/slice-export";
import { compileScene } from "./scene-compiler";
import { runtimeError, type RuntimeError } from "./runtime-errors";
import type { RuntimeProjection, RuntimeProjectionNode } from "./runtime-projection-store";
import type { RevisionLeasePool, RevisionLeaseResource } from "./revision-lease";

/** The P0 Runtime export contract. SVG and PNG originate from exactly the
 * same confirmed RevisionLease; PNG only rasterizes the already-frozen SVG. */
export type RuntimeSvgExportSettings = Readonly<{ format: "SVG_STRING" }>;
export type RuntimePngExportSettings = Readonly<{
  format: "PNG";
  constraint?: Readonly<{ type: "SCALE"; value: number }>;
}>;
export type RuntimeExportSettings = RuntimeSvgExportSettings | RuntimePngExportSettings;
export type RuntimePngRasterizer = (input: Readonly<{ svg: string; width: number; height: number; scale: number }>) => Promise<Uint8Array>;

export function exportRuntimeNodeAsSvg(
  leasePool: RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>,
  projection: RuntimeProjection,
  pageId: string,
  nodeId: string,
): string {
  return exportRuntimeNodeSvgResult(leasePool, projection, pageId, nodeId).svg;
}

export function exportRuntimeNodeSvgResult(
  leasePool: RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>,
  projection: RuntimeProjection,
  pageId: string,
  nodeId: string,
): SvgExportResult {
  const lease = leasePool.acquire({ revision: projection.revision, projection, resources: exportResourcesFor(projection) });
  try {
    const page = lease.projection.nodes.find((node) => node.id === pageId && node.type === "PAGE" && node.removed !== true);
    const target = lease.projection.nodes.find((node) => node.id === nodeId && node.removed !== true);
    if (!page || !target) throw runtimeError("NODE_NOT_FOUND", { nodeId });
    const nodes = canvasNodesFrom(lease.projection);
    if (!nodes.some((node) => node.id === nodeId)) throw runtimeError("UNSUPPORTED_FEATURE", { nodeId, revision: lease.revision });
    const defaultPageId = lease.projection.nodes.find((node) => node.type === "PAGE" && node.removed !== true)?.id;
    if (!defaultPageId) throw runtimeError("EXPORT_FAILED", { nodeId, revision: lease.revision });
    const scene = compileScene({ revision: lease.revision, nodes, pageId, defaultPageId }).scene;
    return exportPageToSvg(nodes, {
      pageId,
      defaultPageId,
      sourceRevision: lease.revision,
      scene,
      nodeIds: [nodeId],
    });
  } catch (error) {
    if (isRuntimeError(error)) throw error;
    throw runtimeError("EXPORT_FAILED", { nodeId, revision: lease.revision });
  } finally {
    leasePool.release(lease.id);
  }
}

export function runtimePngScale(settings: RuntimePngExportSettings): number {
  const constraint = settings.constraint;
  if (!constraint) return 1;
  if (constraint.type !== "SCALE" || !Number.isFinite(constraint.value) || constraint.value <= 0 || constraint.value > 8) throw runtimeError("INVALID_ARGUMENT");
  return constraint.value;
}

/** Browser-default PNG conversion. Session callers may inject an equivalent
 * raster boundary in workers/tests, but every implementation receives only a
 * frozen SVG payload plus its immutable physical dimensions. */
export const rasterizeRuntimePng: RuntimePngRasterizer = async ({ svg, width, height, scale }) => {
  try {
    const blob = await rasterizeSvgToPng(svg, width, height, scale);
    return new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    if (error instanceof SliceExportError && error.code === "RESOURCE_LIMIT") throw runtimeError("RESOURCE_LIMIT");
    throw runtimeError("EXPORT_FAILED");
  }
};

export function exportResourcesFor(projection: RuntimeProjection): RevisionLeaseResource[] {
  const document = projection.nodes.find((node) => node.type === "DOCUMENT" && node.removed !== true);
  const assets = Array.isArray(document?.assets) ? document.assets : [];
  return assets.flatMap((asset): RevisionLeaseResource[] => isLeaseAsset(asset)
    ? [{ id: asset.assetId, contentHash: asset.contentHash, byteLength: asset.byteLength }]
    : []);
}

function canvasNodesFrom(projection: RuntimeProjection): CanvasNode[] {
  const candidates = projection.nodes.filter((node) => node.removed !== true && node.type !== "DOCUMENT" && node.type !== "PAGE");
  const canvasNodes = candidates.map((node) => {
    if (!isCanvasProjectionNode(node)) throw runtimeError("UNSUPPORTED_FEATURE", { revision: projection.revision });
    return node;
  });
  const pageIds = new Set(projection.nodes.filter((node) => node.type === "PAGE" && node.removed !== true).map((node) => node.id));
  // Runtime models a Page as the direct parent of every page root while
  // CanvasNode intentionally represents page ownership separately. Remove
  // only that synthetic edge; real frame/group hierarchy is retained.
  return canvasNodes.map((node) => pageIds.has(node.parentId ?? "")
    ? { ...node, parentId: undefined }
    : node);
}

/** RuntimeSession may also be constructed with a deliberately narrow Plugin
 * projection. Refuse that projection at the boundary instead of inventing a
 * fill, stroke or NodeKind the canonical source did not provide. */
function isCanvasProjectionNode(node: RuntimeProjectionNode): node is RuntimeProjectionNode & CanvasNode {
  return typeof node.kind === "string"
    && typeof node.name === "string"
    && ["x", "y", "width", "height", "rotation", "strokeWidth", "radius", "opacity"].every((field) => typeof node[field] === "number" && Number.isFinite(node[field]))
    && typeof node.fill === "string"
    && typeof node.stroke === "string";
}

function isLeaseAsset(value: unknown): value is DocumentAsset {
  return Boolean(value) && typeof value === "object"
    && typeof (value as DocumentAsset).assetId === "string"
    && typeof (value as DocumentAsset).contentHash === "string"
    && typeof (value as DocumentAsset).byteLength === "number";
}

function isRuntimeError(error: unknown): error is RuntimeError {
  return Boolean(error) && typeof error === "object" && (error as { name?: unknown }).name === "RuntimeError";
}
