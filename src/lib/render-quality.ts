export type RenderQualityTier = "interactive" | "settled";

export interface RenderQualityState { tier: RenderQualityTier; zoomBucket: "far" | "normal" | "near"; }

/**
 * Pick a temporary backing-store scale. Zoom buckets have hysteresis so a gesture
 * near 50%/100% never repeatedly reallocates the render surface. Settled always
 * restores native DPR; only active input may trade transient sharpness for flow.
 */
export function resolveRenderQuality(previous: RenderQualityState, zoom: number, interacting: boolean): RenderQualityState {
  const current = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const zoomBucket = previous.zoomBucket === "far"
    ? current > .58 ? current >= 1.08 ? "near" : "normal" : "far"
    : previous.zoomBucket === "near"
      ? current < .92 ? current <= .42 ? "far" : "normal" : "near"
      : current <= .42 ? "far" : current >= 1.08 ? "near" : "normal";
  return { tier: interacting ? "interactive" : "settled", zoomBucket };
}

export function renderDpr(deviceDpr: number, state: RenderQualityState): number {
  const native = Math.max(.5, Number.isFinite(deviceDpr) ? deviceDpr : 1);
  if (state.tier === "settled") return native;
  // Canvas overlays (Mask/Clip/Effect) are the interactive hot path. A 50%
  // transient backing store keeps the professional composite below the Phase 2
  // input budget without changing the settled image; native DPR is restored
  // after the gesture has been idle for 160 ms.
  const factor = .5;
  return Math.max(.5, Math.min(native, native * factor));
}

const MAX_VECTOR_PRESENTATION_TOLERANCE = .25;
const MIN_VECTOR_PRESENTATION_TOLERANCE = .0025;

/**
 * Convert a quarter-device-pixel curve error budget into document units.
 * Power-of-two buckets keep zoom gestures from producing an unbounded mesh
 * cache while guaranteeing that the selected tolerance never exceeds the
 * current screen-space error budget.
 */
export function vectorPresentationTolerance(zoom: number, dpr: number): number {
  const scale = Math.max(.01, Number.isFinite(zoom) ? zoom : 1)
    * Math.max(.5, Number.isFinite(dpr) ? dpr : 1);
  const raw = Math.min(MAX_VECTOR_PRESENTATION_TOLERANCE, .25 / scale);
  if (raw >= MAX_VECTOR_PRESENTATION_TOLERANCE) return MAX_VECTOR_PRESENTATION_TOLERANCE;
  const bucket = MAX_VECTOR_PRESENTATION_TOLERANCE / 2 ** Math.ceil(Math.log2(MAX_VECTOR_PRESENTATION_TOLERANCE / raw));
  return Math.max(MIN_VECTOR_PRESENTATION_TOLERANCE, bucket);
}
