import { describe, expect, it, vi } from "vitest";
import { PrototypePlayer } from "./prototype-player";
import { RevisionLeasePool } from "./revision-lease";
import { encodePrototypeValue, PROTOTYPE_METADATA_EXTENSION, PROTOTYPE_REACTIONS_EXTENSION, validatePrototypeReactions } from "./prototype-contract";
import type { RuntimeProjection } from "./runtime-projection-store";

function projection(): RuntimeProjection {
  return {
    revision: 4,
    nodes: [
      { id: "document", type: "DOCUMENT", assets: [{ assetId: "asset", contentHash: "hash", byteLength: 8 }] },
      { id: "first", type: "FRAME", extensions: { [PROTOTYPE_METADATA_EXTENSION]: encodePrototypeValue({ startingPoint: true }) } },
      { id: "tap", type: "RECTANGLE", parentId: "first", extensions: { [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "second", transition: { type: "DISSOLVE", duration: 120 } }] }]) } },
      { id: "second", type: "FRAME", extensions: { [PROTOTYPE_METADATA_EXTENSION]: encodePrototypeValue({ overlay: { positionType: "CENTER", backgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" } }) } },
      { id: "open", type: "RECTANGLE", parentId: "second", extensions: { [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "ON_PRESS" }, actions: [{ type: "NODE", navigation: "OVERLAY", destinationId: "overlay", transition: { type: "DIRECTIONAL", direction: "DOWN", duration: 80 } }] }]) } },
      { id: "overlay", type: "FRAME", extensions: { [PROTOTYPE_METADATA_EXTENSION]: encodePrototypeValue({ overlay: { positionType: "MANUAL", relativePosition: { x: 12, y: 24 }, backgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE" } }) } },
      { id: "overlay-action", type: "RECTANGLE", parentId: "overlay", extensions: { [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CLOSE" }] }]) } },
      { id: "overlay-close", type: "RECTANGLE", parentId: "overlay" },
    ],
  };
}

function player(input = projection()) {
  return new PrototypePlayer({ leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }), now: () => 1_000 }, input);
}

function slidesProjection(): RuntimeProjection {
  return {
    revision: 8,
    nodes: [
      { id: "document", type: "DOCUMENT" },
      { id: "page", type: "PAGE", parentId: "document", siblingIndex: 0 },
      { id: "grid", type: "SLIDE_GRID", parentId: "page", siblingIndex: 0 },
      { id: "row-a", type: "SLIDE_ROW", parentId: "grid", siblingIndex: 0 },
      { id: "slide-1", type: "SLIDE", parentId: "row-a", siblingIndex: 0, slideMetadata: { isSkippedSlide: false, transition: { style: "DISSOLVE", duration: .2, curve: "EASE_IN", timing: { type: "ON_CLICK" } } } },
      { id: "slide-skipped", type: "SLIDE", parentId: "row-a", siblingIndex: 1, slideMetadata: { isSkippedSlide: true, transition: { style: "NONE", duration: 0, curve: "LINEAR", timing: { type: "ON_CLICK" } } } },
      { id: "slide-2", type: "SLIDE", parentId: "row-a", siblingIndex: 2, slideMetadata: { isSkippedSlide: false, transition: { style: "SLIDE_FROM_RIGHT", duration: .3, curve: "GENTLE", timing: { type: "AFTER_DELAY", delay: .01 } } } },
      { id: "row-b", type: "SLIDE_ROW", parentId: "grid", siblingIndex: 1 },
      { id: "slide-3", type: "SLIDE", parentId: "row-b", siblingIndex: 0, slideMetadata: { isSkippedSlide: false, transition: { style: "NONE", duration: 0, curve: "LINEAR", timing: { type: "ON_CLICK" } } } },
    ],
  };
}

describe("PrototypePlayer", () => {
  it("plays the frozen SlideGrid order, skips hidden slides and maps slide transitions", async () => {
    expect(() => new PrototypePlayer(
      { leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }) },
      slidesProjection(),
      "slide-skipped",
    )).toThrow();
    const subject = new PrototypePlayer(
      { leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }), now: () => 1_000 },
      slidesProjection(),
      "slide-1",
    );

    await subject.dispatch({ type: "CLICK", targetId: "slide-1" });
    expect(subject.state).toMatchObject({
      currentFrameId: "slide-2",
      navigationHistory: ["slide-1"],
      transition: { fromFrameId: "slide-1", toFrameId: "slide-2", transition: { type: "DISSOLVE", duration: 200, easing: "EASE_IN" } },
    });
    await subject.dispatchKeyboard({ key: "ARROW_RIGHT" });
    expect(subject.state).toMatchObject({
      currentFrameId: "slide-3",
      transition: { transition: { type: "DIRECTIONAL", direction: "RIGHT", duration: 300, easing: "EASE_IN_AND_OUT" } },
    });
    await subject.dispatchKeyboard({ key: "ARROW_LEFT" });
    expect(subject.state.currentFrameId).toBe("slide-2");
    expect(subject.state.transition).toBeUndefined();
    subject.close();
  });

  it("auto-advances AFTER_DELAY slides and cancels the timer when closed", async () => {
    vi.useFakeTimers();
    const subject = new PrototypePlayer(
      { leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }) },
      slidesProjection(),
      "slide-2",
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(subject.state.currentFrameId).toBe("slide-3");
    subject.close();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it("runs navigation, overlay close and history exclusively against the frozen lease", async () => {
    const source = projection();
    const subject = player(source);
    expect(subject.state.currentFrameId).toBe("first");
    await subject.dispatch({ type: "CLICK", targetId: "tap" });
    expect(subject.state).toMatchObject({ currentFrameId: "second", navigationHistory: ["first"], transition: { transition: { type: "DISSOLVE" } } });
    await subject.dispatch({ type: "PRESS", targetId: "open" });
    expect(subject.state.overlays[0]).toMatchObject({ frameId: "overlay", position: { x: 12, y: 24 }, dismissOnOutsideClick: true });
    await subject.dispatch({ type: "OUTSIDE_CLICK" });
    expect(subject.state.overlays).toEqual([]);
    source.nodes.find((node) => node.id === "tap")!.extensions = {};
    await subject.dispatch({ type: "CLICK", targetId: "tap" });
    expect(subject.state.currentFrameId).toBe("second");
    subject.notifyEditorRevision(5);
    expect(subject.state.stale).toBe(true);
    subject.close();
  });

  it("queues timeout reactions and reduces motion without changing navigation", async () => {
    vi.useFakeTimers();
    const source = projection();
    source.nodes.find((node) => node.id === "first")!.extensions = {
      [PROTOTYPE_METADATA_EXTENSION]: encodePrototypeValue({ startingPoint: true }),
      [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "AFTER_TIMEOUT", timeout: 10 }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "second", transition: { type: "DISSOLVE", duration: 100 } }] }]),
    };
    const subject = new PrototypePlayer({ leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }), reducedMotion: true }, source);
    await vi.advanceTimersByTimeAsync(10);
    expect(subject.state.currentFrameId).toBe("second");
    expect(subject.state.transition).toBeUndefined();
    subject.close();
    vi.useRealTimers();
  });

  it("uses only the same-lease hit test and applies Escape, Back and URL host rules", async () => {
    const opened: string[] = [];
    const source = projection();
    source.nodes.push(
      { id: "back", type: "RECTANGLE", parentId: "second", extensions: { [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }]) } },
      { id: "url", type: "RECTANGLE", parentId: "second", extensions: { [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "URL", url: "https://example.com" }] }]) } },
    );
    const subject = new PrototypePlayer({
      leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }),
      hitTest: ({ x }) => x === 10 ? "tap" : undefined,
      focusableNodeIds: (frameId) => frameId === "overlay" ? ["overlay-action", "overlay-close"] : frameId === "second" ? ["back", "url"] : ["tap"],
      openUrl: (url) => { opened.push(url); },
      now: () => 1_060,
    }, source);
    expect(subject.state.focusNodeId).toBe("tap");
    await subject.dispatchPointer({ type: "CLICK", x: 10, y: 10 });
    expect(subject.state.currentFrameId).toBe("second");
    await subject.dispatch({ type: "PRESS", targetId: "open" });
    expect(subject.state.overlays).toHaveLength(1);
    expect(subject.state.focusNodeId).toBe("overlay-action");
    await subject.dispatchKeyboard({ key: "TAB" });
    expect(subject.state.focusNodeId).toBe("overlay-close");
    await subject.dispatchKeyboard({ key: "TAB", shiftKey: true });
    expect(subject.state.focusNodeId).toBe("overlay-action");
    await subject.dispatchKeyboard({ key: "ENTER" });
    expect(subject.state.overlays).toHaveLength(0);
    await subject.dispatch({ type: "CLICK", targetId: "back" });
    expect(subject.state.currentFrameId).toBe("first");
    await subject.dispatch({ type: "CLICK", targetId: "tap" });
    expect(subject.transitionProgress()).toBeGreaterThanOrEqual(0);
    expect(subject.transitionRenderPlan({ width: 320, height: 200 }).layers).toHaveLength(2);
    // URL authorization remains host-mediated and never invokes browser navigation directly.
    await subject.dispatch({ type: "CLICK", targetId: "url" });
    expect(opened).toEqual(["https://example.com"]);
    subject.close();
  });

  it("rejects malformed or unresolved reaction targets before persistence", () => {
    expect(() => validatePrototypeReactions([{ trigger: { type: "ON_CLICK" }, actions: [] }])).toThrow();
    expect(() => validatePrototypeReactions([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "missing" }] }], new Set(["first"]))).toThrow();
    expect(validatePrototypeReactions([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CHANGE_TO", destinationId: "variant", transition: { type: "SMART_ANIMATE", duration: 100 } }] }], new Set(["variant"]))).toHaveLength(1);
  });

  it("exposes Smart Animate layer interpolation from the same frozen lease", async () => {
    const source = projection();
    source.nodes.push(
      { id: "first-card", type: "RECTANGLE", kind: "rectangle", parentId: "first", name: "Card", x: 0, y: 0, width: 80, height: 40, rotation: 0, opacity: 1, fill: "#000000" },
      { id: "second-card", type: "RECTANGLE", kind: "rectangle", parentId: "second", name: "Card", x: 100, y: 0, width: 80, height: 40, rotation: 0, opacity: .5, fill: "#ffffff" },
    );
    source.nodes.find((node) => node.id === "tap")!.extensions = {
      [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "second", transition: { type: "SMART_ANIMATE", duration: 100 } }] }]),
    };
    let now = 1_000;
    const subject = new PrototypePlayer({ leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }), now: () => now }, source);
    await subject.dispatch({ type: "CLICK", targetId: "tap" });
    now = 1_050;
    expect(subject.transitionRenderPlan({ width: 320, height: 200 }).layers).toHaveLength(2);
    expect(subject.smartAnimateRenderPlan()?.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interpolate", fromNodeId: "first-card", toNodeId: "second-card", properties: expect.objectContaining({ x: 50, opacity: .75 }) }),
    ]));
    subject.close();
  });

  it("switches an instance to a same-set variant and exposes its frozen Smart Animate plan", async () => {
    const source = projection();
    source.nodes.push(
      { id: "variants", type: "COMPONENT_SET" },
      { id: "default-variant", type: "COMPONENT", parentId: "variants", name: "State=Default" },
      { id: "hover-variant", type: "COMPONENT", parentId: "variants", name: "State=Hover" },
      { id: "default-layer", type: "RECTANGLE", kind: "rectangle", parentId: "default-variant", name: "Label", x: 0, y: 0, width: 80, height: 30, rotation: 0, opacity: 1, fill: "#000000" },
      { id: "hover-layer", type: "RECTANGLE", kind: "rectangle", parentId: "hover-variant", name: "Label", x: 40, y: 0, width: 80, height: 30, rotation: 0, opacity: 1, fill: "#ffffff" },
      { id: "instance", type: "INSTANCE", parentId: "first", instanceMetadata: { mainComponentId: "default-variant", componentProperties: { State: "Default" } } },
      { id: "instance-trigger", type: "RECTANGLE", parentId: "instance", extensions: { [PROTOTYPE_REACTIONS_EXTENSION]: encodePrototypeValue([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CHANGE_TO", destinationId: "hover-variant", transition: { type: "SMART_ANIMATE", duration: 100 } }] }]) } },
    );
    let now = 1_000;
    const subject = new PrototypePlayer({ leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }), now: () => now }, source);
    await subject.dispatch({ type: "CLICK", targetId: "instance-trigger" });
    now = 1_050;
    expect(subject.state.componentVariants).toEqual([{ instanceId: "instance", componentId: "hover-variant" }]);
    expect(subject.componentSmartAnimateRenderPlan()?.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interpolate", fromNodeId: "default-layer", toNodeId: "hover-layer", properties: expect.objectContaining({ x: 20 }) }),
    ]));
    subject.close();
  });

  it("cancels a live transition deterministically when a host requests it", async () => {
    let now = 1_000;
    const subject = new PrototypePlayer({ leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }), now: () => now }, projection());
    await subject.dispatch({ type: "CLICK", targetId: "tap" });
    now = 1_020;
    subject.cancelTransition();
    expect(subject.state.currentFrameId).toBe("second");
    expect(subject.state.transition).toBeUndefined();
    expect(subject.state.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRANSITION_CANCELLED", atMs: 1_020 })]));
    subject.close();
  });

  it("reports serialized input timings and recovers the queue after a rejected preparation", async () => {
    let now = 1_000;
    const source = projection();
    const subject = new PrototypePlayer({
      leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }),
      now: () => now,
      prepareFrame: async () => { now += 7; throw new Error("unavailable"); },
    }, source);
    await expect(subject.dispatch({ type: "CLICK", targetId: "tap" })).rejects.toThrow("unavailable");
    expect(subject.state.performance).toEqual({ queuedInputs: 0, completedInputs: 1, lastInputMs: 7, maxInputMs: 7 });
    now += 3;
    await expect(subject.dispatch({ type: "CLICK", targetId: "tap" })).rejects.toThrow("unavailable");
    expect(subject.state.performance).toMatchObject({ queuedInputs: 0, completedInputs: 2, lastInputMs: 7, maxInputMs: 7 });
    subject.close();
  });

  it("records a rapid follow-up interaction as an interruption and starts from the logical destination", async () => {
    const subject = new PrototypePlayer({ leasePool: new RevisionLeasePool({ maxLeases: 2, maxUniqueResourceBytes: 100 }), now: () => 1_000 }, projection());
    await subject.dispatch({ type: "CLICK", targetId: "tap" });
    await subject.dispatch({ type: "PRESS", targetId: "open" });
    expect(subject.state).toMatchObject({ currentFrameId: "second", overlays: [expect.objectContaining({ frameId: "overlay" })], transition: expect.objectContaining({ fromFrameId: "second", toFrameId: "overlay" }) });
    expect(subject.state.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRANSITION_INTERRUPTED" })]));
    subject.close();
  });
});
