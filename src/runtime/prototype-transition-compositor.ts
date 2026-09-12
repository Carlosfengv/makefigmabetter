import type { PrototypeTransition } from "./prototype-contract";

export type TransitionViewport = Readonly<{ width: number; height: number }>;
export type TransitionLayer = Readonly<{ source: "from" | "to"; opacity: number; translateX: number; translateY: number }>;
export type PrototypeTransitionRenderPlan = Readonly<{
  progress: number;
  easedProgress: number;
  clip: Readonly<{ x: number; y: number; width: number; height: number }>;
  layers: readonly TransitionLayer[];
}>;

/**
 * Converts the Player's immutable transition state into a two-surface plan.
 * Both Canvas and WebGPU can execute this exact plan without learning Player
 * navigation semantics. Coordinates are document pixels relative to a clipped
 * frame viewport; callers own allocation and lifecycle of the two surfaces.
 */
export function prototypeTransitionRenderPlan(
  transition: PrototypeTransition | undefined,
  progress: number,
  viewport: TransitionViewport,
): PrototypeTransitionRenderPlan {
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 0 || viewport.height < 0) throw new Error("Invalid transition viewport.");
  const normalizedProgress = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
  const easedProgress = easingFor(transition)(normalizedProgress);
  const clip = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (!transition || transition.type === "NONE") return { progress: normalizedProgress, easedProgress: 1, clip, layers: [{ source: "to", opacity: 1, translateX: 0, translateY: 0 }] };
  // Smart Animate owns matched layers in its dedicated plan. The two-surface
  // fallback remains a dissolve so unmatched layers never disappear while a
  // renderer is progressively adopting per-layer interpolation.
  if (transition.type === "DISSOLVE" || transition.type === "SMART_ANIMATE") {
    return { progress: normalizedProgress, easedProgress, clip, layers: [
      { source: "from", opacity: 1 - easedProgress, translateX: 0, translateY: 0 },
      { source: "to", opacity: easedProgress, translateX: 0, translateY: 0 },
    ] };
  }
  const distance = directionalDistance(transition.direction, viewport, easedProgress);
  return { progress: normalizedProgress, easedProgress, clip, layers: [
    { source: "from", opacity: 1, translateX: negate(distance.completedX), translateY: negate(distance.completedY) },
    { source: "to", opacity: 1, translateX: distance.remainingX, translateY: distance.remainingY },
  ] };
}

/** Canvas execution is intentionally tiny: callers render each frozen Scene
 * into the supplied surfaces before invoking this function. The clip prevents
 * directional translation from leaking outside the prototype frame. */
export function compositePrototypeTransition(
  context: Pick<CanvasRenderingContext2D, "save" | "restore" | "beginPath" | "rect" | "clip" | "translate" | "drawImage" | "globalAlpha">,
  plan: PrototypeTransitionRenderPlan,
  fromSurface: CanvasImageSource,
  toSurface: CanvasImageSource,
): void {
  context.save();
  context.beginPath(); context.rect(plan.clip.x, plan.clip.y, plan.clip.width, plan.clip.height); context.clip();
  for (const layer of plan.layers) {
    context.save();
    context.globalAlpha = layer.opacity;
    context.translate(layer.translateX, layer.translateY);
    context.drawImage(layer.source === "from" ? fromSurface : toSurface, 0, 0);
    context.restore();
  }
  context.restore();
}

function easingFor(transition: PrototypeTransition | undefined): (value: number) => number {
  if (!transition || transition.type === "NONE" || transition.easing === undefined || transition.easing === "LINEAR") return (value) => value;
  if (transition.easing === "EASE_IN") return (value) => value * value;
  if (transition.easing === "EASE_OUT") return (value) => 1 - (1 - value) * (1 - value);
  return (value) => value < .5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
}

function directionalDistance(direction: "LEFT" | "RIGHT" | "UP" | "DOWN", viewport: TransitionViewport, progress: number) {
  if (direction === "LEFT") return { completedX: viewport.width * progress, completedY: 0, remainingX: viewport.width * (1 - progress), remainingY: 0 };
  if (direction === "RIGHT") return { completedX: -viewport.width * progress, completedY: 0, remainingX: -viewport.width * (1 - progress), remainingY: 0 };
  if (direction === "UP") return { completedX: 0, completedY: viewport.height * progress, remainingX: 0, remainingY: viewport.height * (1 - progress) };
  return { completedX: 0, completedY: -viewport.height * progress, remainingX: 0, remainingY: -viewport.height * (1 - progress) };
}
function negate(value: number) { return value === 0 ? 0 : -value; }
