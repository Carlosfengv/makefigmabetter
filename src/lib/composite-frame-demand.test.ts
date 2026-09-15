import { describe, expect, it } from "vitest";
import { admitCompositeFrame, compositeFrameDemand } from "./composite-frame-demand";
import { createNode } from "./editor-protocol";
import { extensionsForNodeBlendMode } from "./node-blend-semantics";

describe("Canvas composite frame preflight", () => {
  it("counts effect, nested mask and isolated subtree pools at their live depths", () => {
    const root = { ...createNode("frame", 0, 0), id: "root", opacity: 0.5 };
    const mask = { ...createNode("rectangle", 0, 0), id: "mask", parentId: root.id, isMask: true };
    const nestedFrame = { ...createNode("frame", 0, 0), id: "nested", parentId: root.id, opacity: 0.5 };
    const nestedMask = { ...createNode("rectangle", 0, 0), id: "nested-mask", parentId: nestedFrame.id, isMask: true };
    const effected = {
      ...createNode("rectangle", 0, 0),
      id: "effected",
      parentId: nestedFrame.id,
      effectStack: [{ layerBlur: { radius: 4, visible: true } }],
    };

    expect(compositeFrameDemand([root, mask, nestedFrame, nestedMask, effected])).toEqual({
      effectPool: true,
      linearPaintPool: false,
      alphaMaskPools: 2,
      subtreePools: 2,
      surfaces: 13,
    });
  });

  it("charges one bounded three-buffer pool for linear paint layers", () => {
    const node = {
      ...createNode("rectangle", 0, 0),
      fillStack: { layers: [{ paint: { css: "#cc3333" }, visible: true, opacity: 1, blendMode: "linear-burn" as const }] },
    };
    expect(admitCompositeFrame(4096, 4096, [node], {
      linearPaintPool: { pixelWidth: 512, pixelHeight: 512 },
    })).toMatchObject({ accepted: true, demand: { linearPaintPool: true, surfaces: 3 } });
    expect(admitCompositeFrame(6144, 6144, [node])).toMatchObject({ accepted: false, reason: "frameLimit" });
  });

  it("charges a subtree pool for a marked NORMAL container", () => {
    const group = {
      ...createNode("group", 0, 0),
      id: "isolated",
      extensions: extensionsForNodeBlendMode(undefined, "normal"),
    };
    const child = { ...createNode("rectangle", 0, 0), id: "child", parentId: group.id };

    expect(compositeFrameDemand([group, child])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 0,
      subtreePools: 1,
      surfaces: 3,
    });
  });

  it("uses the alpha-mask pool without a redundant Repeat source surface", () => {
    const repeat = {
      ...createNode("transformGroup", 0, 0), id: "repeat",
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 2, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }],
    };
    const mask = { ...createNode("ellipse", 0, 0), id: "mask", parentId: repeat.id, isMask: true, positionId: "20000000000000000000000000000000:00000000000000000000000000000000" };
    const target = { ...createNode("rectangle", 0, 0), id: "target", parentId: repeat.id, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
    expect(compositeFrameDemand([repeat, mask, target])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 1,
      subtreePools: 0,
      surfaces: 2,
    });
    expect(compositeFrameDemand([
      repeat,
      { ...mask, effectStack: [{ backgroundBlur: { visible: true, radius: 8 } }] },
      target,
    ])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 1,
      subtreePools: 0,
      surfaces: 2,
    });
    expect(compositeFrameDemand([{ ...repeat, opacity: .5 }, mask, target])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 1,
      subtreePools: 1,
      surfaces: 5,
    });
  });

  it("does not reserve colour readback surfaces for linear paint blends in a mask alpha branch", () => {
    const linearPaint = {
      layers: [{
        paint: { css: "#cc3333" },
        visible: true,
        opacity: .6,
        blendMode: "linear-burn" as const,
      }],
    };
    const mask = {
      ...createNode("group", 0, 0),
      id: "linear-mask",
      isMask: true,
      fillStack: linearPaint,
    };
    const descendant = {
      ...createNode("rectangle", 0, 0),
      id: "linear-mask-child",
      parentId: mask.id,
      strokeStack: {
        layers: [{
          paint: { css: "#3366cc" },
          visible: true,
          opacity: .4,
          blendMode: "linear-dodge" as const,
        }],
      },
    };
    const target = { ...createNode("rectangle", 0, 0), id: "masked-target" };

    expect(compositeFrameDemand([mask, descendant, target])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 1,
      subtreePools: 0,
      surfaces: 2,
    });
  });

  it("reuses the one live alpha-mask depth through nested Repeats", () => {
    const modifier = [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }];
    const outer = { ...createNode("transformGroup", 0, 0), id: "outer", transformModifiers: modifier, positionId: "10000000000000000000000000000000:00000000000000000000000000000000" };
    const inner = { ...createNode("transformGroup", 0, 0), id: "inner", parentId: outer.id, transformModifiers: modifier, positionId: "20000000000000000000000000000000:00000000000000000000000000000000" };
    const mask = { ...createNode("ellipse", 0, 0), id: "mask", parentId: inner.id, isMask: true, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
    const target = { ...createNode("rectangle", 0, 0), id: "target", parentId: inner.id, positionId: "40000000000000000000000000000000:00000000000000000000000000000000" };
    expect(compositeFrameDemand([outer, inner, mask, target])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 1,
      subtreePools: 0,
      surfaces: 2,
    });
  });

  it("reserves an additional subtree pool for an effected translucent container mask inside Repeat", () => {
    const repeat = {
      ...createNode("transformGroup", 0, 0), id: "repeat",
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const mask = {
      ...createNode("group", 0, 0), id: "effect-mask", parentId: repeat.id, isMask: true,
      opacity: .5,
      extensions: extensionsForNodeBlendMode(undefined, "normal"),
      effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const alpha = { ...createNode("ellipse", 0, 0), id: "alpha", parentId: mask.id };
    const target = {
      ...createNode("rectangle", 0, 0), id: "target", parentId: repeat.id,
      positionId: "30000000000000000000000000000000:00000000000000000000000000000000",
    };
    expect(compositeFrameDemand([repeat, mask, alpha, target])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 1,
      subtreePools: 1,
      surfaces: 5,
    });
    expect(compositeFrameDemand([
      repeat,
      { ...mask, opacity: 1, blendMode: "multiply", extensions: undefined, effectStack: undefined },
      alpha,
      target,
    ])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 1,
      subtreePools: 1,
      surfaces: 5,
    });
  });

  it("reserves one subtree pool for an effected descendant-owning container inside Repeat", () => {
    const repeat = {
      ...createNode("transformGroup", 0, 0), id: "repeat-effect-container",
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const group = {
      ...createNode("group", 0, 0), id: "effect-container", parentId: repeat.id,
      effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const child = { ...createNode("ellipse", 0, 0), id: "effect-child", parentId: group.id };
    expect(compositeFrameDemand([repeat, group, child])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 0,
      subtreePools: 1,
      surfaces: 3,
    });
  });

  it("reserves the prepared ancestor and descendant effect pools for backdrop blur under owner presentation", () => {
    const repeat = {
      ...createNode("transformGroup", 0, 0), id: "repeat-presented-container",
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const group = {
      ...createNode("group", 0, 0), id: "presented-container", parentId: repeat.id,
      opacity: .65,
      blendMode: "multiply" as const,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const child = {
      ...createNode("rectangle", 0, 0), id: "backdrop-child", parentId: group.id,
      effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }],
    };

    expect(compositeFrameDemand([repeat, group, child])).toEqual({
      effectPool: true,
      linearPaintPool: false,
      alphaMaskPools: 0,
      subtreePools: 1,
      surfaces: 6,
    });
  });

  it("reuses only the standalone effect pool inside Repeat", () => {
    const repeat = {
      ...createNode("transformGroup", 0, 0), id: "repeat-effect-leaf",
      transformModifiers: [{ type: "REPEAT" as const, repeatType: "LINEAR" as const, count: 1, unitType: "PIXELS" as const, offset: 100, axis: "HORIZONTAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const leaf = {
      ...createNode("ellipse", 0, 0), id: "effect-leaf", parentId: repeat.id,
      effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    expect(compositeFrameDemand([repeat, leaf])).toEqual({
      effectPool: true,
      linearPaintPool: false,
      alphaMaskPools: 0,
      subtreePools: 0,
      surfaces: 3,
    });
  });

  it("reserves nested alpha pools inside a paint-owning container mask source", () => {
    const maskFrame = { ...createNode("frame", 0, 0), id: "mask-frame", isMask: true, positionId: "10000000000000000000000000000000:00000000000000000000000000000000" };
    const innerMask = { ...createNode("ellipse", 0, 0), id: "inner-mask", parentId: maskFrame.id, isMask: true, positionId: "10000000000000000000000000000000:00000000000000000000000000000000" };
    const innerTarget = { ...createNode("rectangle", 0, 0), id: "inner-target", parentId: maskFrame.id, positionId: "20000000000000000000000000000000:00000000000000000000000000000000" };
    const outerTarget = { ...createNode("rectangle", 0, 0), id: "outer-target", positionId: "20000000000000000000000000000000:00000000000000000000000000000000" };

    expect(compositeFrameDemand([maskFrame, innerMask, innerTarget, outerTarget])).toEqual({
      effectPool: false,
      linearPaintPool: false,
      alphaMaskPools: 2,
      subtreePools: 0,
      surfaces: 4,
    });
  });

  it("admits a bounded effect pool beside full-canvas structural pools", () => {
    const nodes = [
      { ...createNode("frame", 0, 0), id: "frame", opacity: .5 },
      { ...createNode("rectangle", 0, 0), id: "effect", parentId: "frame", effectStack: [{ layerBlur: { visible: true, radius: 4 } }] },
    ];
    expect(admitCompositeFrame(4096, 4096, nodes, { effectPool: { pixelWidth: 512, pixelHeight: 512 } })).toMatchObject({
      accepted: true,
      demand: { effectPool: true, subtreePools: 1, surfaces: 6 },
    });
    expect(admitCompositeFrame(4096, 4096, nodes)).toMatchObject({ accepted: false, reason: "frameLimit" });
  });

  it("rejects a 4K frame before painting when combined pools exceed 256 MiB", () => {
    const mask = { ...createNode("rectangle", 0, 0), id: "mask", isMask: true };
    const effected = {
      ...createNode("rectangle", 0, 0),
      id: "effected",
      effectStack: [{ layerBlur: { radius: 4, visible: true } }],
    };
    expect(admitCompositeFrame(4096, 4096, [mask, effected])).toMatchObject({
      accepted: false,
      reason: "frameLimit",
      demand: { effectPool: true, alphaMaskPools: 1, subtreePools: 0, surfaces: 5 },
    });
  });

  it("charges every structural depth from its planned local dimensions", () => {
    const root = { ...createNode("frame", 0, 0), id: "root", opacity: .5 };
    const mask = { ...createNode("rectangle", 0, 0), id: "mask", parentId: root.id, isMask: true };
    const target = { ...createNode("rectangle", 0, 0), id: "target", parentId: root.id };
    expect(admitCompositeFrame(4096, 4096, [root, mask, target], {
      alphaMaskPools: [{ pixelWidth: 512, pixelHeight: 512 }],
      subtreePools: [{ pixelWidth: 768, pixelHeight: 768 }],
    })).toMatchObject({ accepted: true, demand: { alphaMaskPools: 1, subtreePools: 1, surfaces: 5 } });
    expect(admitCompositeFrame(4096, 4096, [root, mask, target])).toMatchObject({ accepted: false, reason: "frameLimit" });
  });
});
