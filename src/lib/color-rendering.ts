import type { DocumentColor, DocumentLinearGradient } from "./editor-protocol";

/** Bounded approximation for CanvasGradient's encoded-sRGB interpolation. */
export const LINEAR_GRADIENT_SAMPLES_PER_SEGMENT = 64;

export interface CanvasGradientStop {
  position: number;
  color: string;
}

/**
 * Rendering-only conversion matching editor_core::Color::to_srgb_u8(). Canonical
 * values remain non-premultiplied and retain their original colour space; this
 * module is only the deterministic Canvas/CSS projection boundary.
 */
export function colorToSrgbCss(color: DocumentColor): string {
  const [red, green, blue] = colorToSrgbBytes(color);
  const alpha = quantize(color.alpha);
  const encoded = `#${hex(red)}${hex(green)}${hex(blue)}`;
  return alpha === 255 ? encoded : `${encoded}${hex(alpha)}`;
}

/** CSS <input type="color"> cannot preserve alpha, so expose the same RGB fallback. */
export function colorToOpaqueSrgbCss(color: DocumentColor): string {
  const [red, green, blue] = colorToSrgbBytes(color);
  return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

export function colorToSrgbBytes(color: DocumentColor): [number, number, number] {
  return colorToSrgbComponents(color).map(quantize) as [number, number, number];
}

/** Continuous encoded-sRGB projection for APIs whose RGB channels are floats. */
export function colorToSrgbComponents(color: DocumentColor): [number, number, number] {
  if (color.space === "srgb") return color.components.map(clamp) as [number, number, number];
  const linear = colorToLinearSrgbComponents(color);
  return linear.map((component) => clamp(encodeSrgb(component))) as [number, number, number];
}

/** Matches Rust Core's non-premultiplied Color::to_linear_srgb_components. */
export function colorToLinearSrgbComponents(color: DocumentColor): [number, number, number] {
  const [red, green, blue] = color.components.map(clamp);
  if (color.space === "linear-srgb") return [red, green, blue];
  const decoded = [red, green, blue].map(decodeSrgb) as [number, number, number];
  if (color.space === "srgb") return decoded;
  return [
    clamp(1.224_745_5 * decoded[0] - 0.224_904_45 * decoded[1]),
    clamp(-0.042_058_08 * decoded[0] + 1.042_081 * decoded[1]),
    clamp(-0.019_642_26 * decoded[0] - 0.078_654_88 * decoded[1] + 1.098_537_2 * decoded[2]),
  ];
}

/**
 * Creates a visible, editable baseline gradient without discarding the selected
 * solid fill. The second stop moves toward white for darker fills and toward
 * black for lighter fills, in linear light, so it remains perceptually useful
 * for every supported input colour space.
 */
export function createDefaultLinearGradient(color: DocumentColor): DocumentLinearGradient {
  const linear = colorToLinearSrgbComponents(color);
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const target = luminance > 0.7 ? 0 : 1;
  const amount = 0.32;
  const companion: DocumentColor = {
    space: "linear-srgb",
    components: linear.map((component) => component + (target - component) * amount) as [number, number, number],
    alpha: color.alpha,
  };
  return {
    start: [0, 0],
    end: [1, 0],
    stops: [
      { position: 0, color: structuredClone(color) },
      { position: 1, color: companion },
    ],
  };
}

/**
 * CanvasGradient interpolates encoded colours. Supply a bounded sequence of
 * linear-light samples so the native interpolation only happens over short,
 * deterministic segments. Exact stop positions (including legal hard stops)
 * remain present in the emitted sequence.
 */
export function sampleLinearGradientForCanvas(
  gradient: DocumentLinearGradient,
  samplesPerSegment = LINEAR_GRADIENT_SAMPLES_PER_SEGMENT,
): CanvasGradientStop[] {
  const samples = Math.max(1, Math.floor(samplesPerSegment));
  const result: CanvasGradientStop[] = [];
  gradient.stops.forEach((stop, index) => {
    if (index === 0) {
      result.push({ position: stop.position, color: colorToSrgbCss(stop.color) });
      return;
    }
    const previous = gradient.stops[index - 1];
    const span = stop.position - previous.position;
    if (span === 0) {
      result.push({ position: stop.position, color: colorToSrgbCss(stop.color) });
      return;
    }
    const left = colorToLinearSrgbComponents(previous.color);
    const right = colorToLinearSrgbComponents(stop.color);
    for (let sample = 1; sample <= samples; sample += 1) {
      const amount = sample / samples;
      result.push({
        position: previous.position + span * amount,
        color: colorToSrgbCss({
          space: "linear-srgb",
          components: [
            left[0] + (right[0] - left[0]) * amount,
            left[1] + (right[1] - left[1]) * amount,
            left[2] + (right[2] - left[2]) * amount,
          ],
          alpha: previous.color.alpha + (stop.color.alpha - previous.color.alpha) * amount,
        }),
      });
    }
  });
  return result;
}

function decodeSrgb(component: number): number { return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4; }
function encodeSrgb(component: number): number { const bounded = clamp(component); return bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055; }
function clamp(value: number): number { return Math.min(1, Math.max(0, value)); }
function quantize(value: number): number { return Math.round(clamp(value) * 255); }
function hex(value: number): string { return value.toString(16).padStart(2, "0"); }
