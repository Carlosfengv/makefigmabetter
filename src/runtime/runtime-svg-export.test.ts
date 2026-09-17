import { describe, expect, it } from "vitest";
import { createNode, type DocumentAsset } from "../lib/editor-protocol";
import { isRuntimeError } from "./runtime-errors";
import { RevisionLeasePool, type RevisionLeaseResource } from "./revision-lease";
import { exportRuntimeNodeSvgResult } from "./runtime-svg-export";
import type { RuntimeProjection } from "./runtime-projection-store";

describe("Runtime SVG export lease lifecycle", () => {
  it("materializes a live Boolean from the supplied Worker path", () => {
    const pool = new RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>({ maxLeases: 1, maxUniqueResourceBytes: 64 });
    const boolean = { ...createNode("booleanOperation", 30, 40), id: "boolean", pageId: "page", width: 100, height: 80, fill: "#0048ff", stroke: "transparent" };
    const first = { ...createNode("vector", 0, 0), id: "first", pageId: "page", parentId: boolean.id, width: 100, height: 80 };
    const second = { ...createNode("vector", 20, 20), id: "second", pageId: "page", parentId: boolean.id, width: 40, height: 30 };
    const projection: RuntimeProjection = {
      revision: 11,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document" },
        { id: "page", type: "PAGE", parentId: "document", name: "Page" },
        { ...boolean, type: "BOOLEAN_OPERATION", parentId: "page" },
        { ...first, type: "VECTOR" },
        { ...second, type: "VECTOR" },
      ],
    };
    const path = { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [
      { id: "p0", x: 0, y: 0, pointType: "corner" as const },
      { id: "p1", x: 100, y: 0, pointType: "corner" as const },
      { id: "p2", x: 100, y: 80, pointType: "corner" as const },
      { id: "p3", x: 0, y: 80, pointType: "corner" as const },
    ] }] };

    const result = exportRuntimeNodeSvgResult(pool, projection, "page", boolean.id, new Map([[boolean.id, path]]));

    expect(result.svg).toContain("<path");
    expect(result.svg).not.toContain("Live BooleanOperation");
    expect(result.fallbacks).not.toEqual(expect.arrayContaining([expect.objectContaining({ capability: "live-boolean" })]));
  });

  it("releases frozen projection and resource references after success and failure", () => {
    let nextLease = 0;
    const pool = new RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>({
      maxLeases: 1,
      maxUniqueResourceBytes: 64,
      createId: () => `export-lease-${nextLease++}`,
    });
    const asset: DocumentAsset = {
      assetId: "image",
      contentHash: "a".repeat(64),
      mediaType: "image/png",
      byteLength: 64,
    };
    const rectangle = { ...createNode("rectangle", 10, 20), id: "rectangle", pageId: "page", width: 40, height: 30 };
    const projection: RuntimeProjection = {
      revision: 7,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", assets: [asset] },
        { id: "page", type: "PAGE", parentId: "document", name: "Page" },
        { ...rectangle, type: "RECTANGLE", parentId: "page" },
      ],
    };

    expect(exportRuntimeNodeSvgResult(pool, projection, "page", rectangle.id).sourceRevision).toBe(7);
    expect(pool.state()).toEqual({ activeLeaseIds: [], uniqueResourceBytes: 0 });

    let failure: unknown;
    try {
      exportRuntimeNodeSvgResult(pool, projection, "page", "missing");
    } catch (error) {
      failure = error;
    }
    expect(isRuntimeError(failure, "NODE_NOT_FOUND")).toBe(true);
    expect(pool.state()).toEqual({ activeLeaseIds: [], uniqueResourceBytes: 0 });
  });

  it("passes authorized Runtime image bytes into structural SVG paint patterns", () => {
    const pool = new RevisionLeasePool<RuntimeProjection, RevisionLeaseResource>({ maxLeases: 1, maxUniqueResourceBytes: 64 });
    const asset: DocumentAsset = {
      assetId: "runtime-image",
      contentHash: "b".repeat(64),
      mediaType: "image/png",
      byteLength: 4,
      pixelWidth: 1,
      pixelHeight: 1,
    };
    const rectangle = {
      ...createNode("rectangle", 10, 20),
      id: "painted-rectangle",
      pageId: "page",
      width: 40,
      height: 30,
      fillStack: { layers: [{
        image: { assetId: asset.assetId, scaleMode: "tile" as const, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
        visible: true,
        opacity: .5,
        blendMode: "screen" as const,
      }] },
    };
    const projection: RuntimeProjection = {
      revision: 8,
      nodes: [
        { id: "document", type: "DOCUMENT", name: "Document", assets: [asset] },
        { id: "page", type: "PAGE", parentId: "document", name: "Page" },
        { ...rectangle, type: "RECTANGLE", parentId: "page" },
      ],
    };

    const result = exportRuntimeNodeSvgResult(
      pool,
      projection,
      "page",
      rectangle.id,
      undefined,
      new Map([[asset.assetId, "data:image/png;base64,AAAA"]]),
    );

    expect(result.svg).toContain('<pattern id="makefigma-image-pattern-');
    expect(result.svg).toContain('href="data:image/png;base64,AAAA"');
    expect(result.svg).toContain('patternUnits="userSpaceOnUse" width="1" height="1"');
    expect(result.svg).toContain('opacity="0.5"');
    expect(result.svg).toContain("mix-blend-mode:screen");
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "image-asset" }),
    ]));
  });
});
