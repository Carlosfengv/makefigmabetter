import type { CanvasNode } from "./editor-protocol";
import type { GpuTextProjectionRun } from "./gpu-text-projection";
import type { RustTextLayout } from "./rust-text-layout";
import { textPathGeometry, textPathPlacement, textPathPoseAt } from "./text-path-layout";
import { multiplyAffine, nodeRelativeTransform, transformPoint, type AffineMatrix } from "./scene-transform";
import type { WebGpuTextGlyph } from "./webgpu-scene";

export type TextPathGpuProjectionRun = GpuTextProjectionRun & Readonly<{
  fill: string;
  opacity: number;
}>;

export type TextPathGpuProjectionInput = Readonly<{
  node: CanvasNode;
  runs: readonly TextPathGpuProjectionRun[];
  layout: RustTextLayout;
  /** Resolved Canonical local → world transform for nested Relative-v1 nodes. */
  worldTransform?: AffineMatrix;
}>;

/**
 * Projects Rustybuzz glyph ids and advances into the TextPath node's local
 * coordinate space. Canvas applies the node's existing outer transform, so
 * this representation remains valid for rotation, skew, reflection and nested
 * Relative-v1 ancestry without flattening an affine into an axis-aligned quad.
 */
export function projectTextPathLocalGlyphs(input: TextPathGpuProjectionInput): WebGpuTextGlyph[] | undefined {
  const { node, runs, layout } = input;
  const metadata = node.textPathMetadata;
  const geometry = textPathGeometry(node.vectorPath, metadata);
  const primary = runs[0];
  const line = layout.lines[0];
  if (node.kind !== "textPath" || !metadata || !geometry || !primary || !line
    || layout.lines.length !== 1 || layout.unitsPerEm <= 0 || line.glyphs.length > 4_096
    || runs.length > 4_096 || runs.some((run) => !validRun(run))) return undefined;

  const metricScale = primary.fontSize / layout.unitsPerEm;
  const occupied = line.advance * metricScale;
  const placement = textPathPlacement(metadata, geometry.length, occupied, line.glyphs.length, primary.fontSize);
  if (!placement) return undefined;

  const projected: WebGpuTextGlyph[] = [];
  let pen = 0;
  for (let index = 0; index < line.glyphs.length; index += 1) {
    const glyph = line.glyphs[index]!;
    const run = runs[glyph.runIndex];
    const raster = run?.rasters.get(glyph.glyphId);
    if (!run || !raster || glyph.glyphId === 0) return undefined;
    const rasterScale = run.fontSize / run.pixelSize;
    const width = raster.width * rasterScale;
    const height = raster.height * rasterScale;
    const tangentCenter = placement.start + pen + glyph.xOffset * metricScale
      + raster.bearingX * rasterScale + width / 2 + index * placement.gap;
    const pose = textPathPoseAt(geometry.segments, tangentCenter);
    if (!pose) break;
    const normalOffset = placement.vertical - glyph.yOffset * metricScale
      - raster.bearingY * rasterScale + height / 2;
    const normalX = -Math.sin(pose.angle);
    const normalY = Math.cos(pose.angle);
    const centerX = pose.x + normalX * normalOffset;
    const centerY = pose.y + normalY * normalOffset;
    projected.push({
      textureKey: `${run.fontAssetId}:${run.faceIndex}:${run.variationAxesKey}:${run.syntheticStyleKey}:${glyph.glyphId}:${run.pixelSize}`,
      nodeId: node.id,
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      rotation: pose.angle * 180 / Math.PI,
      paintRunIndex: glyph.runIndex,
      fill: run.fill,
      // Canvas consumes local glyphs below renderNodePaint(), whose saved
      // context already carries the node opacity. Keep only run opacity here
      // so the Canvas fallback does not square a translucent TextPath.
      opacity: run.opacity,
      maskWidth: raster.width,
      maskHeight: raster.height,
      alphaMask: raster.alphaMask,
    });
    pen += glyph.xAdvance * metricScale;
  }
  return projected;
}

/** Converts local TextPath glyph poses into complete world-space unit-quad
 * affines, retaining skew, reflection and nested Relative-v1 ancestry. */
export function projectTextPathGpuGlyphs(input: TextPathGpuProjectionInput): WebGpuTextGlyph[] | undefined {
  const localGlyphs = projectTextPathLocalGlyphs(input);
  if (!localGlyphs) return undefined;
  const world = input.worldTransform ?? nodeRelativeTransform(input.node);
  if (!world) return undefined;
  return localGlyphs.map((glyph) => {
    const radians = glyph.rotation * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const centerX = glyph.width / 2;
    const centerY = glyph.height / 2;
    const localQuad: AffineMatrix = {
      a: cosine * glyph.width,
      b: sine * glyph.width,
      c: -sine * glyph.height,
      d: cosine * glyph.height,
      e: glyph.x + centerX - cosine * centerX + sine * centerY,
      f: glyph.y + centerY - sine * centerX - cosine * centerY,
    };
    const quadTransform = multiplyAffine(world, localQuad);
    const center = transformPoint(world, { x: glyph.x + glyph.width / 2, y: glyph.y + glyph.height / 2 });
    return {
      ...glyph,
      x: center.x - glyph.width / 2,
      y: center.y - glyph.height / 2,
      rotation: glyph.rotation + input.node.rotation,
      // WebGPU paints the glyph quad directly and does not pass through the
      // Canvas node wrapper, so it owns the complete node × run opacity.
      opacity: input.node.opacity * glyph.opacity,
      quadTransform,
    };
  });
}

function validRun(run: TextPathGpuProjectionRun) {
  return Boolean(run.fontAssetId && run.fill)
    && Number.isInteger(run.faceIndex) && run.faceIndex >= 0
    && Number.isFinite(run.fontSize) && run.fontSize > 0
    && Number.isInteger(run.pixelSize) && run.pixelSize > 0 && run.pixelSize <= 512
    && Number.isFinite(run.opacity) && run.opacity >= 0 && run.opacity <= 1;
}
