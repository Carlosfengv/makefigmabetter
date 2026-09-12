import { describe, expect, it } from "vitest";
import { compositePrototypeTransition, prototypeTransitionRenderPlan } from "./prototype-transition-compositor";

describe("prototype transition compositor", () => {
  it("creates deterministic eased cross-fade layers", () => {
    const plan = prototypeTransitionRenderPlan({ type: "DISSOLVE", duration: 300, easing: "EASE_IN" }, .5, { width: 320, height: 200 });
    expect(plan).toEqual({ progress: .5, easedProgress: .25, clip: { x: 0, y: 0, width: 320, height: 200 }, layers: [
      { source: "from", opacity: .75, translateX: 0, translateY: 0 },
      { source: "to", opacity: .25, translateX: 0, translateY: 0 },
    ] });
  });

  it("clips directional source and target surfaces at the frame boundary", () => {
    const plan = prototypeTransitionRenderPlan({ type: "DIRECTIONAL", direction: "LEFT", duration: 300 }, .25, { width: 200, height: 100 });
    expect(plan.layers).toEqual([
      { source: "from", opacity: 1, translateX: -50, translateY: 0 },
      { source: "to", opacity: 1, translateX: 150, translateY: 0 },
    ]);
    const calls: string[] = [];
    const context = { save: () => calls.push("save"), restore: () => calls.push("restore"), beginPath: () => calls.push("path"), rect: () => calls.push("rect"), clip: () => calls.push("clip"), translate: (x: number, y: number) => calls.push(`move:${x},${y}`), drawImage: () => calls.push("draw"), globalAlpha: 1 };
    compositePrototypeTransition(context, plan, {} as CanvasImageSource, {} as CanvasImageSource);
    expect(calls).toEqual(["save", "path", "rect", "clip", "save", "move:-50,0", "draw", "restore", "save", "move:150,0", "draw", "restore", "restore"]);
  });

  it("degrades no-motion plans to the target surface", () => {
    expect(prototypeTransitionRenderPlan({ type: "NONE" }, .2, { width: 10, height: 10 }).layers).toEqual([{ source: "to", opacity: 1, translateX: 0, translateY: 0 }]);
  });
});
