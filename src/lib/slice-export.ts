/** Browser-side safeguards for exporting a frozen Slice region. The limit is
 * deliberately lower than the editor's general Canvas surface ceiling: export
 * holds both a source image and a destination backing store at once. */
export const MAX_SLICE_EXPORT_DIMENSION = 16_384;
export const MAX_SLICE_EXPORT_PIXELS = 64 * 1024 * 1024;
export const MAX_SLICE_EXPORT_RGBA_BYTES = MAX_SLICE_EXPORT_PIXELS * 4;
export const MAX_SLICE_BATCH_EXPORTS = 32;

/** PNG can preserve alpha or receive the same opaque white backdrop used by
 * the PDF/JPEG fallback. SVG stays transparent by definition. */
export type SliceExportBackground = "transparent" | "white";

/** PDF's JPEG fallback must be opaque, but callers can choose the matte color
 * instead of silently forcing every rasterized page to white. */
export type PdfExportBackground = `#${string}`;

export function sliceExportBackgroundColor(background: SliceExportBackground): string | undefined {
  return background === "white" ? "#ffffff" : undefined;
}

export function pdfExportBackgroundColor(background: PdfExportBackground): string {
  return /^#[0-9a-fA-F]{6}$/.test(background) ? background.toLowerCase() : "#ffffff";
}

export type SliceRasterExportAdmission =
  | { accepted: true; width: number; height: number; pixelCount: number; rgbaBytes: number }
  | { accepted: false; reason: "INVALID_SIZE" | "RESOURCE_LIMIT" };

export function admitSliceRasterExport(width: number, height: number, scale = 1): SliceRasterExportAdmission {
  if (![width, height, scale].every(Number.isFinite) || width <= 0 || height <= 0 || scale <= 0 || scale > 8) {
    return { accepted: false, reason: "INVALID_SIZE" };
  }
  const rasterWidth = Math.ceil(width * scale);
  const rasterHeight = Math.ceil(height * scale);
  if (!Number.isSafeInteger(rasterWidth) || !Number.isSafeInteger(rasterHeight) || rasterWidth > MAX_SLICE_EXPORT_DIMENSION || rasterHeight > MAX_SLICE_EXPORT_DIMENSION) {
    return { accepted: false, reason: "RESOURCE_LIMIT" };
  }
  const pixelCount = rasterWidth * rasterHeight;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_SLICE_EXPORT_PIXELS) return { accepted: false, reason: "RESOURCE_LIMIT" };
  return { accepted: true, width: rasterWidth, height: rasterHeight, pixelCount, rgbaBytes: pixelCount * 4 };
}

/** Batch exports are processed sequentially, but their total frozen regions
 * stay within one backing-store budget so the final PDF cannot accumulate an
 * unbounded set of JPEG payloads in memory. */
export function admitSliceRasterBatch(regions: readonly Readonly<{ width: number; height: number; scale?: number }>[]): SliceRasterExportAdmission | { accepted: false; reason: "RESOURCE_LIMIT" | "INVALID_SIZE" } {
  if (!regions.length || regions.length > MAX_SLICE_BATCH_EXPORTS) return { accepted: false, reason: "RESOURCE_LIMIT" };
  let pixelCount = 0;
  let width = 0;
  let height = 0;
  for (const region of regions) {
    const admission = admitSliceRasterExport(region.width, region.height, region.scale);
    if (!admission.accepted) return admission;
    pixelCount += admission.pixelCount;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_SLICE_EXPORT_PIXELS) return { accepted: false, reason: "RESOURCE_LIMIT" };
    width = Math.max(width, admission.width);
    height = Math.max(height, admission.height);
  }
  return { accepted: true, width, height, pixelCount, rgbaBytes: pixelCount * 4 };
}

export async function rasterizeSvgToPng(svg: string, width: number, height: number, scale = 1, background: SliceExportBackground = "transparent"): Promise<Blob> {
  const admission = admitSliceRasterExport(width, height, scale);
  if (!admission.accepted) throw new SliceExportError(admission.reason);
  const canvas = await renderSvgToCanvas(svg, admission.width, admission.height, sliceExportBackgroundColor(background));
  const blob = await canvasBlob(canvas, "image/png");
  return blob;
}

export async function rasterizeSvgToJpeg(svg: string, width: number, height: number, scale = 1, background: PdfExportBackground = "#ffffff"): Promise<Blob> {
  const admission = admitSliceRasterExport(width, height, scale);
  if (!admission.accepted) throw new SliceExportError(admission.reason);
  const canvas = await renderSvgToCanvas(svg, admission.width, admission.height, pdfExportBackgroundColor(background));
  return canvasBlob(canvas, "image/jpeg", .92);
}

/** PDF 1.4 does not preserve browser canvas transparency consistently across
 * viewers. Its raster fallback therefore has an explicit opaque white page;
 * SVG/PNG remain the transparency-preserving Slice formats. */
export async function rasterizeSvgToPdf(svg: string, width: number, height: number, scale = 1, background: PdfExportBackground = "#ffffff"): Promise<Blob> {
  const admission = admitSliceRasterExport(width, height, scale);
  if (!admission.accepted) throw new SliceExportError(admission.reason);
  const jpeg = await rasterizeSvgToJpeg(svg, width, height, scale, background);
  return pdfFromJpegs([{ jpeg, pageWidth: width, pageHeight: height, imageWidth: admission.width, imageHeight: admission.height }]);
}

export class SliceExportError extends Error {
  constructor(public readonly code: "INVALID_SIZE" | "RESOURCE_LIMIT" | "RASTERIZATION_FAILED") {
    super(code);
    this.name = "SliceExportError";
  }
}

async function renderSvgToCanvas(svg: string, width: number, height: number, background?: string): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const value = new Image();
      value.onload = () => resolve(value);
      value.onerror = () => reject(new SliceExportError("RASTERIZATION_FAILED"));
      value.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: !background });
    if (!context) throw new SliceExportError("RASTERIZATION_FAILED");
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function canvasBlob(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new SliceExportError("RASTERIZATION_FAILED");
  return blob;
}

/** Creates a minimal, standards-compliant single-page PDF containing one JPEG
 * XObject. Keeping this dependency-free makes PDF export available in the same
 * offline editor runtime as SVG/PNG. */
export async function pdfFromJpeg(jpeg: Blob, pageWidth: number, pageHeight: number, imageWidth: number, imageHeight: number): Promise<Blob> {
  return pdfFromJpegs([{ jpeg, pageWidth, pageHeight, imageWidth, imageHeight }]);
}

export async function pdfFromJpegs(pages: readonly Readonly<{ jpeg: Blob; pageWidth: number; pageHeight: number; imageWidth: number; imageHeight: number }>[]): Promise<Blob> {
  if (!pages.length || pages.length > MAX_SLICE_BATCH_EXPORTS) throw new SliceExportError("RESOURCE_LIMIT");
  const decoded = await Promise.all(pages.map(async (page) => {
    if (![page.pageWidth, page.pageHeight, page.imageWidth, page.imageHeight].every(Number.isFinite) || page.pageWidth <= 0 || page.pageHeight <= 0 || page.imageWidth <= 0 || page.imageHeight <= 0) throw new SliceExportError("INVALID_SIZE");
    const image = new Uint8Array(await page.jpeg.arrayBuffer());
    if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) throw new SliceExportError("RASTERIZATION_FAILED");
    return { ...page, image };
  }));
  const totalPixels = decoded.reduce((total, page) => total + Math.ceil(page.imageWidth) * Math.ceil(page.imageHeight), 0);
  if (!Number.isSafeInteger(totalPixels) || totalPixels > MAX_SLICE_EXPORT_PIXELS) throw new SliceExportError("RESOURCE_LIMIT");
  const encoder = new TextEncoder();
  const objects: Uint8Array[] = [
    encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"),
    encoder.encode(`<< /Type /Pages /Kids [${decoded.map((_, index) => `${3 + index * 3} 0 R`).join(" ")}] /Count ${decoded.length} >>`),
  ];
  for (const [index, page] of decoded.entries()) {
    const pageObject = 3 + index * 3;
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    const content = `q\n${pdfNumber(page.pageWidth)} 0 0 ${pdfNumber(page.pageHeight)} 0 0 cm\n/Im0 Do\nQ\n`;
    objects.push(
      encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(page.pageWidth)} ${pdfNumber(page.pageHeight)}] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`),
      streamObject(encoder.encode(content)),
      concatBytes([encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${Math.round(page.imageWidth)} /Height ${Math.round(page.imageHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`), page.image, encoder.encode("\nendstream")]),
    );
  }
  const header = concatBytes([encoder.encode("%PDF-1.4\n%\xff\xff\xff\xff\n")]);
  const parts: Uint8Array[] = [header];
  const offsets = [0];
  let cursor = header.length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(cursor);
    const object = concatBytes([encoder.encode(`${index + 1} 0 obj\n`), objects[index], encoder.encode("\nendobj\n")]);
    parts.push(object);
    cursor += object.length;
  }
  const xrefOffset = cursor;
  parts.push(encoder.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return new Blob([concatBytes(parts)], { type: "application/pdf" });
}

function streamObject(content: Uint8Array) {
  return concatBytes([new TextEncoder().encode(`<< /Length ${content.length} >>\nstream\n`), content, new TextEncoder().encode("endstream")]);
}

function concatBytes(parts: readonly Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function pdfNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
