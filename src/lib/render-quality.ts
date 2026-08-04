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
  const factor = state.zoomBucket === "far" ? .65 : .75;
  return Math.max(.5, Math.min(native, native * factor));
}
