import { describe, expect, it } from "vitest";
import { createNode } from "./editor-protocol";
import { extensionsForNodeBlendMode } from "./node-blend-semantics";
import { affineScreenMatrix, affineSvgMatrix, canMaterializeTransformGroupRepeat, isBoundedTransformGroupRepeatForest, transformGroupRepeatDerivedBounds, transformGroupRepeatMatrices, transformGroupRepeatSubtree } from "./transform-group-repeat";
import { exportPageToSvg } from "./svg-export";

const pageId = "00000000-0000-4000-8000-00000000e001";

function group() {
  return {
    ...createNode("transformGroup", 20, 30), id: "00000000-0000-4000-8000-00000000e002", pageId, width: 100, height: 80,
    transformModifiers: [{ type: "REPEAT" as const, count: 2, unitType: "RELATIVE" as const, offset: 1.5, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const }],
  };
}

describe("M6 TransformGroup Repeat", () => {
  it("derives bounded linear copies in the group-local basis", () => {
    const source = group();
    expect(canMaterializeTransformGroupRepeat(source)).toBe(true);
    const matrices = transformGroupRepeatMatrices([source], source)!;
    expect(matrices).toHaveLength(2);
    expect(affineSvgMatrix(matrices[0]!, String)).toBe("matrix(1 0 0 1 150 0)");
    expect(affineSvgMatrix(matrices[1]!, String)).toBe("matrix(1 0 0 1 300 0)");
    expect(affineScreenMatrix({ a: 0, b: 1, c: -1, d: 0, e: 20, f: 10 }, { x: 200, y: 100 }, 2)).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 340, f: -80 });
    expect(canMaterializeTransformGroupRepeat({ ...source, transformModifiers: [{ type: "REPEAT", count: 2, unitType: "PIXELS", offset: 50, repeatType: "RADIAL" }] })).toBe(true);
    expect(canMaterializeTransformGroupRepeat({ ...source, transformModifiers: [source.transformModifiers![0]!, source.transformModifiers![0]!] })).toBe(true);
    expect(canMaterializeTransformGroupRepeat({
      ...source,
      transformModifiers: [
        { ...source.transformModifiers![0]!, count: 7 },
        { ...source.transformModifiers![0]!, count: 8 },
      ],
    })).toBe(false);
  });

  it("applies stacked modifiers in array order within one total instance budget", () => {
    const source = {
      ...group(),
      transformModifiers: [
        { type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 100, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const },
        { type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 80, repeatType: "LINEAR" as const, axis: "VERTICAL" as const },
      ],
    };
    expect(transformGroupRepeatMatrices([source], source)).toEqual([
      { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 },
      { a: 1, b: 0, c: 0, d: 1, e: 0, f: 80 },
      { a: 1, b: 0, c: 0, d: 1, e: 100, f: 80 },
    ]);
  });

  it("expands culling bounds to derived paint outside the authored source", () => {
    const parent = group();
    const child = { ...createNode("rectangle", 20, 30), id: "00000000-0000-4000-8000-00000000e006", pageId, parentId: parent.id, width: 20, height: 10 };
    expect(transformGroupRepeatDerivedBounds([parent, child], parent, [child])).toEqual({
      left: 170,
      top: 30,
      right: 340,
      bottom: 40,
    });
  });

  it("composes rotated source geometry before deriving radial selection bounds", () => {
    const parent = {
      ...createNode("transformGroup", 0, 0),
      id: "radial-rotated-bounds",
      pageId,
      width: 100,
      height: 100,
      transformModifiers: [{
        type: "REPEAT" as const,
        count: 2,
        unitType: "PIXELS" as const,
        offset: 0,
        repeatType: "RADIAL" as const,
      }],
    };
    const child = {
      ...createNode("rectangle", 20, 30),
      id: "rotated-bounds-source",
      pageId,
      parentId: parent.id,
      width: 40,
      height: 20,
      rotation: 30,
    };

    const bounds = transformGroupRepeatDerivedBounds(
      [parent, child],
      parent,
      [child],
    );
    expect(bounds?.left).toBeCloseTo(36.3397459622);
    expect(bounds?.top).toBeCloseTo(27.6794919243);
    expect(bounds?.right).toBeCloseTo(85.9807621135);
    expect(bounds?.bottom).toBeCloseTo(83.6602540378);
  });

  it("admits simple nested containers and retains their complete paint subtree", () => {
    const parent = group();
    const nested = { ...createNode("group", 20, 30), id: "nested", pageId, parentId: parent.id, positionId: "10000000000000000000000000000000:00000000000000000000000000000000" };
    const frame = { ...createNode("frame", 20, 30), id: "frame", pageId, parentId: nested.id, width: 60, height: 40, clipsContent: true, positionId: "20000000000000000000000000000000:00000000000000000000000000000000" };
    const leaf = { ...createNode("ellipse", 30, 35), id: "leaf", pageId, parentId: frame.id, width: 20, height: 10, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
    expect(transformGroupRepeatSubtree([parent, nested, frame, leaf], parent)).toEqual({
      sources: [nested],
      nodes: [nested, frame, leaf],
      hitNodes: [frame, leaf],
    });
  });

  it("admits nested Repeat groups under one Cartesian depth budget", () => {
    const outer = {
      ...group(),
      x: 0,
      y: 0,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 100, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const }],
    };
    const inner = {
      ...createNode("transformGroup", 0, 0), id: "inner-repeat", pageId, parentId: outer.id, width: 40, height: 40,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 40, repeatType: "LINEAR" as const, axis: "VERTICAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const leaf = {
      ...createNode("rectangle", 0, 0), id: "nested-repeat-leaf", pageId, parentId: inner.id, width: 10, height: 10,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    expect(transformGroupRepeatSubtree([outer, inner, leaf], outer)).toEqual({
      sources: [inner],
      nodes: [inner, leaf],
      hitNodes: [leaf],
    });
    expect(transformGroupRepeatDerivedBounds([outer, inner, leaf], outer, [inner])).toEqual({
      left: 100,
      top: 0,
      right: 110,
      bottom: 50,
    });
    expect(transformGroupRepeatSubtree([
      { ...outer, transformModifiers: [{ ...outer.transformModifiers[0]!, count: 8 }] },
      { ...inner, transformModifiers: [{ ...inner.transformModifiers[0]!, count: 7 }] },
      leaf,
    ], { ...outer, transformModifiers: [{ ...outer.transformModifiers[0]!, count: 8 }] })).toBeUndefined();
    expect(isBoundedTransformGroupRepeatForest([outer, inner, leaf])).toBe(true);
    expect(isBoundedTransformGroupRepeatForest([
      { ...outer, parentId: inner.id },
      { ...inner, parentId: outer.id },
      leaf,
    ])).toBe(false);
  });

  it("admits a valid Vector Boolean as one derived paint and hit outline", () => {
    const parent = group();
    const boolean = { ...createNode("booleanOperation", 20, 30), id: "boolean", pageId, parentId: parent.id, width: 60, height: 40, booleanOperation: "subtract" as const, positionId: "10000000000000000000000000000000:00000000000000000000000000000000" };
    const outer = { ...createNode("vector", 0, 0), id: "outer", pageId, parentId: boolean.id, width: 60, height: 40, vectorPath: { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 60, y: 0 }, { id: "c", x: 60, y: 40 }, { id: "d", x: 0, y: 40 }] }] }, positionId: "20000000000000000000000000000000:00000000000000000000000000000000" };
    const cutout = { ...createNode("vector", 10, 10), id: "cutout", pageId, parentId: boolean.id, width: 20, height: 20, vectorPath: { fillRule: "nonZero" as const, subpaths: [{ closed: true, points: [{ id: "e", x: 0, y: 0 }, { id: "f", x: 20, y: 0 }, { id: "g", x: 20, y: 20 }, { id: "h", x: 0, y: 20 }] }] }, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
    expect(transformGroupRepeatSubtree([parent, boolean, outer, cutout], parent)).toEqual({
      sources: [boolean],
      nodes: [boolean, outer, cutout],
      hitNodes: [boolean],
    });
    expect(transformGroupRepeatSubtree([
      parent,
      { ...boolean, opacity: .65 },
      outer,
      cutout,
    ], parent)).toBeUndefined();
    expect(transformGroupRepeatSubtree([parent, boolean, outer], parent)).toBeUndefined();
    expect(transformGroupRepeatSubtree([parent, boolean, outer, { ...cutout, kind: "rectangle", vectorPath: undefined }], parent)).toBeUndefined();
  });

  it("admits foreground effects, solitary Background Blur and linear node blends while rejecting unsafe subtree composition", () => {
    const parent = group();
    const nested = { ...createNode("group", 20, 30), id: "nested", pageId, parentId: parent.id, positionId: "10000000000000000000000000000000:00000000000000000000000000000000" };
    const leaf = { ...createNode("rectangle", 20, 30), id: "leaf", pageId, parentId: nested.id, width: 20, height: 10, positionId: "20000000000000000000000000000000:00000000000000000000000000000000" };
    const shadowColor = { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .4 };
    const layerBlurLeaf = { ...leaf, effectStack: [{ layerBlur: { visible: true, radius: 4 } }] };
    const dropShadowLeaf = { ...leaf, effectStack: [{ dropShadow: { visible: true, offsetX: 4, offsetY: 3, blurRadius: 6, spread: 1, color: shadowColor } }] };
    const innerShadowLeaf = { ...leaf, effectStack: [{ innerShadow: { visible: true, offsetX: -2, offsetY: 3, blurRadius: 4, spread: -1, color: shadowColor } }] };
    const expected = {
      sources: [nested],
      nodes: [nested, expect.any(Object)],
      hitNodes: [expect.any(Object)],
    };
    for (const effectLeaf of [layerBlurLeaf, dropShadowLeaf, innerShadowLeaf]) {
      expect(transformGroupRepeatSubtree([parent, nested, effectLeaf], parent)).toEqual(expected);
    }
    expect(transformGroupRepeatSubtree([parent, { ...nested, opacity: .5 }, leaf], parent)).toBeDefined();
    expect(transformGroupRepeatSubtree([parent, nested, { ...leaf, isMask: true }], parent)).toBeUndefined();
    expect(transformGroupRepeatSubtree([parent, nested, { ...leaf, blendMode: "linear-dodge" }], parent)).toBeDefined();
    const backgroundBlurLeaf = { ...leaf, effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }] };
    expect(transformGroupRepeatSubtree([parent, nested, backgroundBlurLeaf], parent)).toBeDefined();
    for (const preparedAncestor of [
      { ...nested, opacity: .5 },
      { ...nested, extensions: extensionsForNodeBlendMode(undefined, "normal") },
      { ...nested, blendMode: "multiply" as const },
      { ...nested, opacity: .65, blendMode: "multiply" as const },
    ]) {
      expect(transformGroupRepeatSubtree([parent, preparedAncestor, backgroundBlurLeaf], parent)).toEqual({
        sources: [preparedAncestor],
        nodes: [preparedAncestor, backgroundBlurLeaf],
        hitNodes: [backgroundBlurLeaf],
      });
    }
    expect(transformGroupRepeatSubtree([
      parent,
      nested,
      { ...leaf, effectStack: [
        { layerBlur: { visible: false, radius: 8 } },
        { backgroundBlur: { visible: true, radius: 4 } },
      ] },
    ], parent)).toBeDefined();
    for (const effectStack of [
      [
        { backgroundBlur: { visible: true, radius: 4 } },
        { layerBlur: { visible: true, radius: 2 } },
      ],
      [
        { dropShadow: { visible: true, offsetX: 3, offsetY: 2, blurRadius: 2, spread: 0, color: shadowColor } },
        { backgroundBlur: { visible: true, radius: 4 } },
        { innerShadow: { visible: true, offsetX: -2, offsetY: 1, blurRadius: 2, spread: 0, color: shadowColor } },
      ],
      [
        { backgroundBlur: { visible: true, radius: 4 } },
        { backgroundBlur: { visible: true, radius: 2 } },
      ],
    ]) {
      expect(transformGroupRepeatSubtree([parent, nested, { ...leaf, effectStack }], parent)).toBeDefined();
    }
    const isolatedAncestor = { ...nested, effectStack: [{ layerBlur: { visible: true, radius: 2 } }] };
    expect(transformGroupRepeatSubtree([parent, isolatedAncestor, backgroundBlurLeaf], parent)).toEqual({
      sources: [isolatedAncestor],
      nodes: [isolatedAncestor, backgroundBlurLeaf],
      hitNodes: [backgroundBlurLeaf],
    });
    const backgroundBlurContainer = { ...nested, effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }] };
    expect(transformGroupRepeatSubtree([parent, backgroundBlurContainer, leaf], parent)).toBeDefined();
    const target = { ...createNode("rectangle", 20, 30), id: "mask-target", pageId, parentId: parent.id, width: 40, height: 20, positionId: "30000000000000000000000000000000:00000000000000000000000000000000" };
    const foregroundMaskEffects = [
      [{ layerBlur: { visible: true, radius: 4 } }],
      [{ dropShadow: { visible: true, offsetX: 4, offsetY: 3, blurRadius: 6, spread: 1, color: shadowColor } }],
      [{ innerShadow: { visible: true, offsetX: -2, offsetY: 3, blurRadius: 4, spread: -1, color: shadowColor } }],
    ];
    for (const effectStack of foregroundMaskEffects) {
      const effectedMask = {
        ...nested,
        isMask: true,
        opacity: .5,
        extensions: extensionsForNodeBlendMode(undefined, "normal"),
        effectStack,
      };
      expect(transformGroupRepeatSubtree([parent, effectedMask, leaf, target], parent)).toEqual({
        sources: [effectedMask, target],
        nodes: [effectedMask, leaf, target],
        hitNodes: [target],
      });
    }
    for (const effectStack of foregroundMaskEffects) {
      const effectedContainer = { ...nested, effectStack };
      expect(transformGroupRepeatSubtree([parent, effectedContainer, leaf], parent)).toEqual({
        sources: [effectedContainer],
        nodes: [effectedContainer, leaf],
        hitNodes: [leaf],
      });
    }
    const backgroundBlurMask = { ...nested, isMask: true, effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }] };
    expect(transformGroupRepeatSubtree([parent, backgroundBlurMask, leaf, target], parent)).toEqual({
      sources: [backgroundBlurMask, target],
      nodes: [backgroundBlurMask, leaf, target],
      hitNodes: [target],
    });
    const backgroundBlurMaskChild = { ...leaf, effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }] };
    expect(transformGroupRepeatSubtree([parent, { ...nested, isMask: true }, backgroundBlurMaskChild, target], parent)).toEqual({
      sources: [{ ...nested, isMask: true }, target],
      nodes: [{ ...nested, isMask: true }, backgroundBlurMaskChild, target],
      hitNodes: [target],
    });
    for (const blendMode of ["multiply", "linear-dodge"] as const) {
      const blendedMask = { ...nested, isMask: true, blendMode };
      expect(transformGroupRepeatSubtree([parent, blendedMask, leaf, target], parent)).toEqual({
        sources: [blendedMask, target],
        nodes: [blendedMask, leaf, target],
        hitNodes: [target],
      });
    }
    expect(transformGroupRepeatSubtree([parent, nested, { ...leaf, kind: "transformGroup" }], parent)).toBeUndefined();
  });

  it("replays standard and transformed-readback blends beside effects and inside masked targets", () => {
    const parent = group();
    const effected = {
      ...createNode("group", 20, 30), id: "effected", pageId, parentId: parent.id,
      effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const child = {
      ...createNode("ellipse", 20, 30), id: "effect-child", pageId, parentId: effected.id,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const sibling = {
      ...createNode("rectangle", 60, 30), id: "backdrop-blend", pageId, parentId: parent.id,
      blendMode: "multiply" as const,
      positionId: "30000000000000000000000000000000:00000000000000000000000000000000",
    };
    const nodeBlendSource = [parent, effected, child, sibling];
    expect(transformGroupRepeatSubtree(nodeBlendSource, parent)).toBeDefined();
    const nodeBlendSvg = exportPageToSvg(nodeBlendSource, { pageId, defaultPageId: pageId, padding: 0 });
    expect(nodeBlendSvg.svg.match(/style="mix-blend-mode:multiply"/gu)).toHaveLength(3);
    expect(nodeBlendSvg.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: parent.id, capability: "transform-group-repeat" }),
    ]));
    expect(transformGroupRepeatSubtree([
      parent,
      effected,
      child,
      {
        ...sibling,
        blendMode: "normal",
        fillStack: { layers: [{ paint: { css: "#cc334d" }, visible: true, opacity: 1, blendMode: "screen" as const }] },
      },
    ], parent)).toBeDefined();
    expect(transformGroupRepeatSubtree([
      parent,
      effected,
      child,
      {
        ...sibling,
        blendMode: "normal",
        fillStack: { layers: [{ paint: { css: "#cc334d" }, visible: true, opacity: 1, blendMode: "linear-dodge" as const }] },
      },
    ], parent)).toBeDefined();

    const mask = {
      ...createNode("ellipse", 20, 30), id: "mask", pageId, parentId: parent.id, isMask: true, blendMode: "multiply" as const,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = { ...sibling, id: "mask-target", blendMode: "normal" as const };
    expect(transformGroupRepeatSubtree([parent, mask, target], parent)).toBeDefined();
    expect(transformGroupRepeatSubtree([parent, mask, { ...target, blendMode: "screen" }], parent)).toBeDefined();
    expect(transformGroupRepeatSubtree([
      parent,
      mask,
      { ...target, effectStack: [{ backgroundBlur: { visible: true, radius: 4 } }] },
    ], parent)).toBeDefined();
    expect(transformGroupRepeatSubtree([
      parent,
      mask,
      {
        ...target,
        fillStack: { layers: [{ paint: { css: "#cc334d" }, visible: true, opacity: 1, blendMode: "linear-burn" as const }] },
      },
    ], parent)).toBeDefined();
    expect(transformGroupRepeatSubtree([
      parent,
      { ...sibling, id: "pre-mask-blend" },
      { ...mask, positionId: "40000000000000000000000000000000:00000000000000000000000000000000" },
      { ...target, positionId: "50000000000000000000000000000000:00000000000000000000000000000000" },
    ], parent)).toBeDefined();
  });

  it("exports descendant-owning mask foreground effects and owner opacity in authored and derived Repeat occurrences", () => {
    const parent = group();
    const mask = {
      ...createNode("group", 20, 30), id: "blurred-group-mask", pageId, parentId: parent.id, isMask: true,
      opacity: .5,
      extensions: extensionsForNodeBlendMode(undefined, "normal"),
      effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const alpha = {
      ...createNode("ellipse", 20, 30), id: "blurred-group-alpha", pageId, parentId: mask.id, width: 30, height: 30,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = {
      ...createNode("rectangle", 20, 30), id: "blurred-group-target", pageId, parentId: parent.id, width: 60, height: 30,
      positionId: "30000000000000000000000000000000:00000000000000000000000000000000",
    };
    const result = exportPageToSvg([parent, mask, alpha, target], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<mask /gu)).toHaveLength(3);
    expect(result.svg.match(/<feGaussianBlur/gu)).toHaveLength(3);
    expect(result.svg.match(/opacity="0.5"/gu)).toHaveLength(3);
    expect(result.svg.match(/style="isolation:isolate"/gu)).toHaveLength(3);
    expect(result.svg).toContain('transform="matrix(1 0 0 1 150 0)"');
    expect(result.svg).toContain('transform="matrix(1 0 0 1 300 0)"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: parent.id, capability: "transform-group-repeat" }),
    ]));
    const blended = exportPageToSvg([parent, { ...mask, blendMode: "multiply", extensions: undefined }, alpha, target], { pageId, defaultPageId: pageId, padding: 0 });
    expect(blended.svg.match(/style="mix-blend-mode:multiply"/gu)).toHaveLength(3);
    expect(blended.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: parent.id, capability: "transform-group-repeat" }),
    ]));
  });

  it("exports descendant-owning Group foreground effects in authored and derived Repeat occurrences", () => {
    const parent = group();
    const container = {
      ...createNode("group", 20, 30), id: "blurred-group", pageId, parentId: parent.id,
      effectStack: [{ layerBlur: { visible: true, radius: 4 } }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const child = {
      ...createNode("ellipse", 20, 30), id: "blurred-group-child", pageId, parentId: container.id, width: 30, height: 30,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const result = exportPageToSvg([parent, container, child], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<feGaussianBlur/gu)).toHaveLength(3);
    expect(result.svg).toContain('transform="matrix(1 0 0 1 150 0)"');
    expect(result.svg).toContain('transform="matrix(1 0 0 1 300 0)"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: parent.id, capability: "transform-group-repeat" }),
    ]));
  });

  it("admits bounded primitive alpha-mask runs and excludes mask identity from derived hits", () => {
    const parent = group();
    const mask = {
      ...createNode("ellipse", 20, 30), id: "repeat-mask", pageId, parentId: parent.id, width: 20, height: 20, isMask: true,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = {
      ...createNode("rectangle", 20, 30), id: "repeat-mask-target", pageId, parentId: parent.id, width: 40, height: 20,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    expect(transformGroupRepeatSubtree([parent, mask, target], parent)).toEqual({
      sources: [mask, target],
      nodes: [mask, target],
      hitNodes: [target],
    });
    expect(transformGroupRepeatDerivedBounds([parent, mask, target], parent, [mask, target])).toEqual({
      left: 170,
      top: 30,
      right: 360,
      bottom: 50,
    });
    expect(transformGroupRepeatSubtree([parent, mask], parent)).toBeUndefined();
    expect(transformGroupRepeatSubtree([parent, mask, { ...target, isMask: true }], parent)).toBeUndefined();
    expect(transformGroupRepeatSubtree([parent, { ...mask, kind: "group" }, target], parent)).toBeUndefined();

  });

  it("admits a live Vector Boolean alpha-mask run without exposing its operands as hits", () => {
    const parent = group();
    const boolean = {
      ...createNode("booleanOperation", 20, 30), id: "boolean-mask", pageId, parentId: parent.id, width: 60, height: 40,
      booleanOperation: "subtract" as const, isMask: true,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const outer = {
      ...createNode("vector", 0, 0), id: "boolean-mask-outer", pageId, parentId: boolean.id, width: 60, height: 40,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const cutout = {
      ...createNode("vector", 10, 10), id: "boolean-mask-cutout", pageId, parentId: boolean.id, width: 20, height: 20,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = {
      ...createNode("rectangle", 20, 30), id: "boolean-mask-target", pageId, parentId: parent.id, width: 60, height: 40,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    expect(transformGroupRepeatSubtree([parent, boolean, outer, cutout, target], parent)).toEqual({
      sources: [boolean, target],
      nodes: [boolean, outer, cutout, target],
      hitNodes: [target],
    });
  });

  it("admits effect-free Frame and Group mask subtrees without exposing descendants as derived hits", () => {
    const parent = group();
    const maskFrame = {
      ...createNode("frame", 20, 30), id: "repeat-frame-mask", pageId, parentId: parent.id, width: 40, height: 40, isMask: true,
      fill: "transparent", stroke: "transparent", strokeWidth: 0,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const maskChild = {
      ...createNode("ellipse", 5, 5), id: "repeat-frame-mask-child", pageId, parentId: maskFrame.id, width: 20, height: 20,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = {
      ...createNode("rectangle", 20, 30), id: "repeat-frame-mask-target", pageId, parentId: parent.id, width: 60, height: 40,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const nodes = [parent, maskFrame, maskChild, target];

    expect(transformGroupRepeatSubtree(nodes, parent)).toEqual({
      sources: [maskFrame, target],
      nodes: [maskFrame, maskChild, target],
      hitNodes: [target],
    });

    const maskGroup = { ...maskFrame, id: "repeat-group-mask", kind: "group" as const };
    const groupMaskChild = { ...maskChild, id: "repeat-group-mask-child", parentId: maskGroup.id };
    const groupNodes = [parent, maskGroup, groupMaskChild, target];
    expect(transformGroupRepeatSubtree(groupNodes, parent)).toEqual({
      sources: [maskGroup, target],
      nodes: [maskGroup, groupMaskChild, target],
      hitNodes: [target],
    });
  });

  it("uses a bounded nested TransformGroup Repeat as one alpha-mask source", () => {
    const outer = {
      ...group(), x: 0, y: 0,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 100, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const }],
    };
    const mask = {
      ...createNode("transformGroup", 0, 0), id: "transform-repeat-mask", pageId, parentId: outer.id, width: 40, height: 80, isMask: true,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 40, repeatType: "LINEAR" as const, axis: "VERTICAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const maskChild = {
      ...createNode("ellipse", 0, 0), id: "transform-repeat-mask-child", pageId, parentId: mask.id, width: 20, height: 20,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = {
      ...createNode("rectangle", 0, 0), id: "transform-repeat-mask-target", pageId, parentId: outer.id, width: 40, height: 80,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const nodes = [outer, mask, maskChild, target];
    expect(transformGroupRepeatSubtree(nodes, outer)).toEqual({
      sources: [mask, target],
      nodes: [mask, maskChild, target],
      hitNodes: [target],
    });
    const result = exportPageToSvg(nodes, { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<mask /gu)).toHaveLength(2);
    // createNode's default ellipse has one fill and one visible stroke, so
    // every source/derived occurrence contributes two SVG ellipse elements.
    expect(result.svg.match(/<ellipse /gu)).toHaveLength(8);
    expect(result.svg.match(/transform="matrix\(1 0 0 1 0 40\)"/gu)).toHaveLength(2);
    expect(result.svg).toContain('transform="matrix(1 0 0 1 100 0)"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: outer.id, capability: "transform-group-repeat" }),
    ]));
  });

  it("composes a nested masked Repeat within the shared instance and surface bounds", () => {
    const outer = {
      ...group(), x: 0, y: 0,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 100, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const }],
    };
    const inner = {
      ...createNode("transformGroup", 0, 0), id: "nested-mask-repeat", pageId, parentId: outer.id, width: 40, height: 40,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 40, repeatType: "LINEAR" as const, axis: "VERTICAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const mask = {
      ...createNode("ellipse", 0, 0), id: "nested-repeat-mask", pageId, parentId: inner.id, width: 10, height: 10, isMask: true,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = {
      ...createNode("rectangle", 0, 0), id: "nested-repeat-target", pageId, parentId: inner.id, width: 30, height: 20,
      positionId: "30000000000000000000000000000000:00000000000000000000000000000000",
    };
    const nodes = [outer, inner, mask, target];
    expect(transformGroupRepeatSubtree(nodes, outer)).toEqual({
      sources: [inner],
      nodes: [inner, mask, target],
      hitNodes: [target],
    });
    expect(transformGroupRepeatDerivedBounds(nodes, outer, [inner])).toEqual({
      left: 100,
      top: 0,
      right: 130,
      bottom: 60,
    });
    const result = exportPageToSvg(nodes, { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<mask /gu)).toHaveLength(4);
    expect(result.svg.match(/transform="matrix\(1 0 0 1 0 40\)"/gu)).toHaveLength(2);
    expect(result.svg.match(/transform="matrix\(1 0 0 1 100 0\)"/gu)).toHaveLength(1);
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: outer.id, capability: "transform-group-repeat" }),
    ]));
  });

  it("exports source and derived alpha-mask runs without a Repeat fallback", () => {
    const parent = group();
    const mask = {
      ...createNode("ellipse", 20, 30), id: "svg-repeat-mask", pageId, parentId: parent.id, width: 20, height: 20, isMask: true,
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const target = {
      ...createNode("rectangle", 20, 30), id: "svg-repeat-mask-target", pageId, parentId: parent.id, width: 40, height: 20,
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const result = exportPageToSvg([parent, mask, target], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<mask /gu)).toHaveLength(3);
    expect(result.svg.match(/mask="url\(#makefigma-alpha-mask-/gu)).toHaveLength(3);
    expect(result.svg).toContain('transform="matrix(1 0 0 1 150 0)"');
    expect(result.svg).toContain('transform="matrix(1 0 0 1 300 0)"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: parent.id, capability: "transform-group-repeat" }),
    ]));
  });

  it("exports a repeated standalone Layer Blur without a Repeat fallback", () => {
    const parent = group();
    const child = {
      ...createNode("rectangle", 20, 30), id: "effect-leaf", pageId, parentId: parent.id, width: 40, height: 20,
      effectStack: [{ layerBlur: { visible: true, radius: 6 } }],
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const result = exportPageToSvg([parent, child], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg).toContain("<feGaussianBlur");
    expect(result.svg).toContain('transform="matrix(1 0 0 1 150 0)"');
    expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: parent.id, capability: "transform-group-repeat" }),
    ]));
  });

  it("exports repeated standalone Drop and Inner Shadows without a Repeat fallback", () => {
    const parent = group();
    const shadowColor = { space: "srgb" as const, components: [0, 0, 0] as [number, number, number], alpha: .4 };
    const effects = [
      { effectStack: [{ dropShadow: { visible: true, offsetX: 4, offsetY: 3, blurRadius: 6, spread: 1, color: shadowColor } }], marker: 'result="shadow"' },
      { effectStack: [{ innerShadow: { visible: true, offsetX: -2, offsetY: 3, blurRadius: 4, spread: -1, color: shadowColor } }], marker: 'result="innerMask"' },
    ];
    for (const [index, effect] of effects.entries()) {
      const child = {
        ...createNode("rectangle", 20, 30), id: `effect-leaf-${index}`, pageId, parentId: parent.id, width: 40, height: 20,
        effectStack: effect.effectStack,
        positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
      };
      const result = exportPageToSvg([parent, child], { pageId, defaultPageId: pageId, padding: 0 });
      expect(result.svg).toContain(effect.marker);
      expect(result.svg).toContain('transform="matrix(1 0 0 1 150 0)"');
      expect(result.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: parent.id, capability: "transform-group-repeat" }),
      ]));
    }
  });

  it("derives radial copies around the transformed group centre", () => {
    const source = {
      ...group(),
      transformModifiers: [{ type: "REPEAT" as const, count: 3, unitType: "PIXELS" as const, offset: 50, repeatType: "RADIAL" as const }],
    };
    const matrices = transformGroupRepeatMatrices([source], source)!;
    expect(matrices).toHaveLength(3);
    const expected = [
      { a: 0, b: 1, c: -1, d: 0, e: 140, f: 0 },
      { a: -1, b: 0, c: 0, d: -1, e: 140, f: 140 },
      { a: 0, b: -1, c: 1, d: 0, e: 0, f: 140 },
    ];
    matrices.forEach((matrix, index) => {
      Object.entries(expected[index]!).forEach(([key, value]) => {
        expect(matrix[key as keyof typeof matrix]).toBeCloseTo(value, 12);
      });
    });
  });

  it("exports each supported derived subtree without a special-node fallback", () => {
    const parent = group();
    const child = { ...createNode("rectangle", 0, 0), id: "00000000-0000-4000-8000-00000000e003", pageId, parentId: parent.id, width: 40, height: 20, fill: "#f97316" };
    const result = exportPageToSvg([parent, child], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<path /gu)).toHaveLength(6);
    expect(result.svg).toContain('transform="matrix(1 0 0 1 150 0)"');
    expect(result.compatibilityFallbacks.filter((fallback) => fallback.nodeId === parent.id && fallback.capability === "special-node")).toEqual([]);
  });

  it("exports a bounded radial source subtree as rotated instances", () => {
    const parent = {
      ...group(),
      transformModifiers: [{ type: "REPEAT" as const, count: 3, unitType: "PIXELS" as const, offset: 50, repeatType: "RADIAL" as const }],
    };
    const child = { ...createNode("rectangle", 20, 30), id: "00000000-0000-4000-8000-00000000e004", pageId, parentId: parent.id, width: 20, height: 10, fill: "#f97316" };
    const result = exportPageToSvg([parent, child], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/<path /gu)).toHaveLength(8);
    expect(result.svg).toContain('transform="matrix(0 1 -1 0 140 0)"');
    expect(result.svg).toContain('transform="matrix(-1 0 0 -1 140 140)"');
    expect(result.compatibilityFallbacks.filter((fallback) => fallback.nodeId === parent.id && fallback.capability === "special-node")).toEqual([]);
  });

  it("exports a stacked two-axis Repeat as one bounded derived grid", () => {
    const parent = {
      ...group(),
      transformModifiers: [
        { type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 100, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const },
        { type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 80, repeatType: "LINEAR" as const, axis: "VERTICAL" as const },
      ],
    };
    const child = { ...createNode("rectangle", 20, 30), id: "00000000-0000-4000-8000-00000000e005", pageId, parentId: parent.id, width: 20, height: 10, fill: "#f97316" };
    const result = exportPageToSvg([parent, child], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg).toContain('transform="matrix(1 0 0 1 100 0)"');
    expect(result.svg).toContain('transform="matrix(1 0 0 1 0 80)"');
    expect(result.svg).toContain('transform="matrix(1 0 0 1 100 80)"');
    expect(result.compatibilityFallbacks.filter((fallback) => fallback.nodeId === parent.id && fallback.capability === "special-node")).toEqual([]);
  });

  it("exports a bounded nested Repeat subtree recursively", () => {
    const outer = {
      ...group(),
      x: 0,
      y: 0,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 100, repeatType: "LINEAR" as const, axis: "HORIZONTAL" as const }],
    };
    const inner = {
      ...createNode("transformGroup", 0, 0), id: "svg-inner-repeat", pageId, parentId: outer.id, width: 40, height: 40,
      transformModifiers: [{ type: "REPEAT" as const, count: 1, unitType: "PIXELS" as const, offset: 40, repeatType: "LINEAR" as const, axis: "VERTICAL" as const }],
      positionId: "10000000000000000000000000000000:00000000000000000000000000000000",
    };
    const leaf = {
      ...createNode("rectangle", 0, 0), id: "svg-nested-repeat-leaf", pageId, parentId: inner.id, width: 10, height: 10, fill: "#f97316",
      positionId: "20000000000000000000000000000000:00000000000000000000000000000000",
    };
    const result = exportPageToSvg([outer, inner, leaf], { pageId, defaultPageId: pageId, padding: 0 });
    expect(result.svg.match(/transform="matrix\(1 0 0 1 100 0\)"/gu)).toHaveLength(1);
    expect(result.svg.match(/transform="matrix\(1 0 0 1 0 40\)"/gu)).toHaveLength(2);
    expect(result.compatibilityFallbacks.filter((fallback) => [outer.id, inner.id].includes(fallback.nodeId ?? "") && fallback.capability === "special-node")).toEqual([]);

    const overBudget = exportPageToSvg([
      { ...outer, transformModifiers: [{ ...outer.transformModifiers[0]!, count: 8 }] },
      { ...inner, transformModifiers: [{ ...inner.transformModifiers[0]!, count: 7 }] },
      leaf,
    ], { pageId, defaultPageId: pageId, padding: 0 });
    expect(overBudget.svg).not.toContain('transform="matrix(1 0 0 1 100 0)"');
    expect(overBudget.compatibilityFallbacks).toContainEqual(expect.objectContaining({
      nodeId: outer.id,
      capability: "transform-group-repeat",
    }));
  });
});
