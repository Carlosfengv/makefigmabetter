import type { DocumentImagePaint } from "./editor-protocol";
import { multiplyAffine, type AffineMatrix } from "./scene-transform";

export type ImagePaintLayoutBox = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

function validImageRotation(image: DocumentImagePaint) {
  const rotation = image.rotationDegrees ?? 0;
  return [0, 90, 180, 270].includes(rotation) &&
    (image.scaleMode !== "crop" || rotation === 0)
    ? rotation
    : undefined;
}

/** Fill/Fit scale inside the inverse-rotated node bounds. A quarter-turn
 * swaps that layout box while preserving its centre. */
export function imagePaintLayoutBox(
  image: DocumentImagePaint,
  width: number,
  height: number,
): ImagePaintLayoutBox | undefined {
  if (![width, height].every(Number.isFinite) || width < 0 || height < 0)
    return undefined;
  const rotation = validImageRotation(image);
  if (rotation === undefined) return undefined;
  if (rotation === 90 || rotation === 270)
    return {
      x: (width - height) / 2,
      y: (height - width) / 2,
      width: height,
      height: width,
    };
  return { x: 0, y: 0, width, height };
}

/** Resolves the transform shared by Canvas, SVG and alpha hit testing.
 * Figma applies ImagePaint.rotation around the owning node's local centre,
 * after the paint's existing crop/tile transform. */
export function resolvedImagePaintTransform(
  image: DocumentImagePaint,
  width: number,
  height: number,
): AffineMatrix | undefined {
  if (!imagePaintLayoutBox(image, width, height)) return undefined;
  const rotation = image.rotationDegrees ?? 0;
  if (rotation === 0) return image.transform;
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  return multiplyAffine(image.transform, {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: centerX - cosine * centerX + sine * centerY,
    f: centerY - sine * centerX - cosine * centerY,
  });
}
